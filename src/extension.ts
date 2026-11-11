import { debounce, orderBy } from 'es-toolkit'
import * as vscode from 'vscode'
import * as path from 'path'
import { type ChangesNode, ChangesViewProvider, type FileChangeNode } from './changes-view'
import { deliverToClaudeCode, sessionLabel } from './claude-delivery'
import { promptIfCommentsViewReveals } from './comments-view-reveal'
import { CommentsViewProvider } from './comments-view'
import { registerTools } from './copilot-tools'
import { CRIT_DIAGNOSTIC_SOURCE } from './diagnostic-metadata'
import { branchKey, getGitApi, headUri, isUntracked, onChangedFilesChanged, watchBranchKey } from './git'
import { startIpcServer } from './ipc-server'
import { installMcpServer, promptIfMcpMissing, stageServer } from './mcp-install'
import { buildNudgeMessage, buildPrompt } from './prompts'
import { createReviewProgress, type ReviewProgress, snapshotDirFor } from './review-progress'
import { requestReview, type ReviewTarget } from './review-request'
import {
  clearProjectRefCache,
  clearThreads,
  diagnosticCode,
  diagnosticMessage,
  findThreadByRef,
  findThreadForComment,
  getThreadsByFile,
  isResolved,
  openThreads,
  requireTrackedThread,
  resolveThread,
  restoreState,
  ReviewComment,
  type SerializedState,
  serializeState,
  setCommentController,
  setThreadsChangedHandler,
  threadLabel,
  threadsByRef,
  type TrackedCommentThread,
  trackThread,
  unresolveThread,
  untrackThread,
} from './review-threads'
import { registerSnapshotProvider, snapshotUri } from './snapshot-content'

// --------------- Diagnostics ---------------

function refreshDiagnostics() {
  if (!diagnosticCollection) return

  const byUri = Map.groupBy(openThreads(), (thread) => thread.uri.toString())

  diagnosticCollection.clear()
  for (const threads of byUri.values()) {
    const diagnostics = threads.map((thread) => {
      const diagnostic = new vscode.Diagnostic(
        thread.range,
        diagnosticMessage(thread),
        vscode.DiagnosticSeverity.Information,
      )
      diagnostic.source = CRIT_DIAGNOSTIC_SOURCE
      // Must stay a plain string. The object form (`{value, target}`) renders
      // more nicely in the Problems view, but agents that read diagnostics
      // stringify this field and receive "[object Object]", losing both the
      // label and the routing code.
      //
      // The label leads so the Problems view is scannable ("R3 …"), and the
      // routing code follows so an agent reading the diagnostic can still
      // address the thread over MCP.
      diagnostic.code = `${threadLabel(thread)} ${diagnosticCode(thread)}`
      return diagnostic
    })
    // Grouped by URI string, so every thread in the group shares one URI.
    diagnosticCollection.set(threads[0].uri, diagnostics)
  }
}

// --------------- Status Bar ---------------

let statusBar: vscode.StatusBarItem
let diagnosticCollection: vscode.DiagnosticCollection | undefined
let changesView: ChangesViewProvider | undefined
let commentsView: CommentsViewProvider | undefined
let progress: ReviewProgress | undefined

function refresh() {
  const n = threadsByRef.size
  const open = openThreads().length
  commentsView?.refresh()
  // The Changes rows carry each file's open-comment count, so they move with the
  // threads. Debounced, because re-listing re-reads every changed file.
  scheduleChangesRefresh()
  if (n > 0) {
    statusBar.text = `$(comment-discussion) ${open} open · ${n - open} resolved`
    statusBar.show()
  } else {
    statusBar.hide()
  }
  refreshDiagnostics()
}

const REFRESH_DEBOUNCE_MS = 250

/**
 * Coalesce the re-render that follows a document edit.
 *
 * Shifting thread ranges must stay synchronous — it consumes the edit's
 * `contentChanges` — but the status bar, the diagnostic rebuild, and the
 * `workspaceState` write are pure functions of state that is already correct in
 * memory. Running them per keystroke serialized every thread on the typing
 * path. Discrete user actions (add, reply, resolve, delete) still refresh
 * immediately; only typing is debounced.
 */
const scheduleRefresh = debounce(() => {
  refresh()
  saveState()
}, REFRESH_DEBOUNCE_MS)

/** Run a coalesced refresh now, or do nothing if none is waiting. */
function flushPendingRefresh() {
  scheduleRefresh.flush()
}

// --------------- AI Provider ---------------

type AiProvider = 'copilot' | 'claudeCode'

function getAiProvider(): AiProvider {
  return vscode.workspace.getConfiguration('crit').get<AiProvider>('aiProvider', 'copilot')
}

async function sendThreadsToAi(threads: TrackedCommentThread[]): Promise<void> {
  if (threads.length === 0) return

  const provider = getAiProvider()
  const prompt = await buildPrompt(threads, provider === 'claudeCode')

  try {
    if (provider === 'claudeCode') {
      const result = await deliverToClaudeCode(
        {
          terminal: buildNudgeMessage(threads, 'diagnostics'),
          message: buildNudgeMessage(threads, 'mcp'),
          editor: prompt,
        },
        outputLog,
      )
      if (result.path === 'session' && result.session) {
        // The inbox never acks, and the session may be off-screen, so
        // say where the comments went rather than leaving the send
        // invisible.
        vscode.window.showInformationMessage(
          `Sent review comments to Claude Code session ${sessionLabel(result.session)}.`,
        )
      }
      // Not awaited: the prompt is already delivered, and whether the MCP
      // tools are wired up must not hold up the send.
      void promptIfMcpMissing(extensionContext, outputLog)
    } else {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt })
    }
  } catch {
    await vscode.env.clipboard.writeText(prompt)
    const providerName = provider === 'claudeCode' ? 'Claude Code' : 'GitHub Copilot'
    vscode.window.showWarningMessage(`Could not open ${providerName}. The prompt was copied to the clipboard.`)
  }
}

// --------------- Persistence (branch-scoped) ---------------

let extensionContext: vscode.ExtensionContext
let currentBranchKey: string = '_default'
let outputLog: vscode.OutputChannel

function stateKey(branchKey?: string): string {
  return `crit.state.${branchKey ?? currentBranchKey}`
}

function saveState() {
  extensionContext.workspaceState.update(stateKey(), serializeState())
}

function loadStateFromKey(controller: vscode.CommentController, key: string) {
  const data = extensionContext.workspaceState.get<SerializedState>(stateKey(key))
  if (!data || !data.threads) return
  restoreState(controller, data)
}

function switchToBranch(controller: vscode.CommentController, newKey: string) {
  if (newKey === currentBranchKey) return

  outputLog.appendLine(`[Crit] Branch switch: ${currentBranchKey} → ${newKey}`)

  // Persist any edit still inside the refresh debounce before the threads it
  // moved are cleared.
  flushPendingRefresh()

  // Save current branch's comments
  saveState()

  // Clear current threads from UI
  clearThreads()

  const oldKey = currentBranchKey
  currentBranchKey = newKey

  // Try loading saved state for the new branch
  const newData = extensionContext.workspaceState.get<SerializedState>(stateKey(newKey))

  if (newData && newData.threads && newData.threads.length > 0) {
    // New branch has its own saved comments — load them
    loadStateFromKey(controller, newKey)
    outputLog.appendLine(`[Crit] Loaded ${threadsByRef.size} comments for branch ${newKey}`)
  } else {
    // New branch has no saved comments — copy from the old branch (Option B)
    loadStateFromKey(controller, oldKey)
    if (threadsByRef.size > 0) {
      // Save the copied state under the new branch key
      saveState()
      outputLog.appendLine(`[Crit] Inherited ${threadsByRef.size} comments from ${oldKey} to ${newKey}`)
    } else {
      outputLog.appendLine(`[Crit] No comments to inherit — clean slate for ${newKey}`)
    }
  }

  refresh()
}

function setupBranchWatcher(context: vscode.ExtensionContext, controller: vscode.CommentController) {
  try {
    // Registered on `context.subscriptions`: a listener that outlives the
    // extension host keeps firing `switchToBranch` against threads that have
    // been disposed.
    context.subscriptions.push(
      watchBranchKey((newKey) => {
        if (newKey !== currentBranchKey) switchToBranch(controller, newKey)
      }),
    )
    if (!getGitApi()) outputLog.appendLine('[Crit] Git API not ready — branch scoping waits for it to activate')
    outputLog.appendLine(`[Crit] Branch watcher active, current: ${currentBranchKey}`)
  } catch (e: any) {
    outputLog.appendLine(`[Crit] Branch watcher setup failed: ${e.message}`)
  }
}

// --------------- Line Tracking ---------------

function setupLineTracking(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return

      // Only track changes for documents that have comment threads
      const docUri = e.document.uri.toString()
      const affected: TrackedCommentThread[] = []
      for (const thread of threadsByRef.values()) {
        if (thread.uri.toString() === docUri) affected.push(thread)
      }
      if (affected.length === 0) return

      // Process content changes in reverse order (bottom-up) to avoid cascading shifts
      const changes = orderBy(e.contentChanges, [(change) => change.range.start.line], ['desc'])

      for (const change of changes) {
        const startLine = change.range.start.line
        const oldEndLine = change.range.end.line
        // Normalize CRLF → LF before counting newlines
        const normalizedText = change.text.replace(/\r\n/g, '\n')
        const newLines = normalizedText.split('\n').length - 1
        const oldLines = oldEndLine - startLine
        const delta = newLines - oldLines

        if (delta === 0) continue

        for (const thread of affected) {
          const threadLine = thread.range.start.line
          if (threadLine > oldEndLine) {
            const newStart = threadLine + delta
            const newEnd = thread.range.end.line + delta
            if (newStart >= 0) {
              thread.range = new vscode.Range(newStart, 0, newEnd, 0)
            }
          }
        }
      }

      scheduleRefresh()
    }),
  )

  // Deactivation must not drop an edit that is still inside the debounce
  // window.
  context.subscriptions.push({ dispose: flushPendingRefresh })
}

// --------------- Sidebar Views ---------------

const CHANGES_DEBOUNCE_MS = 200

/**
 * Re-list the changed files, coalescing the burst of notifications a single
 * save produces — the Git extension fires `onDidChange` several times per write,
 * and each refresh re-reads and re-hashes every changed file.
 */
const scheduleChangesRefresh = debounce(() => changesView?.refresh(), CHANGES_DEBOUNCE_MS)

function setupViews(context: vscode.ExtensionContext) {
  progress = createReviewProgress(context, outputLog)
  context.subscriptions.push(progress)
  context.subscriptions.push(registerSnapshotProvider(snapshotDirFor(context)))

  const changes = new ChangesViewProvider(progress.reviewed, context.workspaceState)
  const comments = new CommentsViewProvider()
  changesView = changes
  commentsView = comments
  context.subscriptions.push(changes, comments)

  const changesTree = vscode.window.createTreeView('crit.changes', {
    treeDataProvider: changes,
    manageCheckboxStateManually: true,
  })
  changes.attach(changesTree)
  context.subscriptions.push(changesTree)

  const commentsTree = vscode.window.createTreeView('crit.comments', { treeDataProvider: comments })
  comments.attach(commentsTree)
  context.subscriptions.push(commentsTree)

  // --- Follow the active editor, the way the Explorer view does ---
  //
  // Silent on anything not tracked as a change (an untouched file, the output
  // panel) and never steals focus — it only moves the selection, the same
  // restraint `explorer.autoReveal` uses.
  const revealActiveFile = async (editor: vscode.TextEditor | undefined) => {
    const node = editor && changes.findFile(editor.document.uri)
    if (!node) return
    try {
      await changesTree.reveal(node, { select: true, focus: false, expand: true })
    } catch {
      // Reveal can lose a race with an in-flight refresh rebuilding the tree
      // out from under it; the next editor switch tries again.
    }
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(revealActiveFile))
  context.subscriptions.push(
    changesTree.onDidChangeVisibility((e) => {
      if (e.visible) void revealActiveFile(vscode.window.activeTextEditor)
    }),
  )

  // The checkbox is the primary way in and out of a mark; the context-menu
  // commands go through the same two calls. Ticking a folder acts on every file
  // beneath it.
  context.subscriptions.push(
    changesTree.onDidChangeCheckboxState(async (event) => {
      for (const [node, state] of event.items) {
        if (changes.checkboxIntent(node, state) === 'mark') await markReviewed(node)
        else unmarkReviewed(node)
      }
    }),
  )

  // A mark's freshness is a function of file content, so anything that can
  // change content has to re-list: git's own notifications (which cover an
  // agent writing a file nobody has open), plus saves and unsaved edits.
  context.subscriptions.push(onChangedFilesChanged(scheduleChangesRefresh))
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(scheduleChangesRefresh))
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(scheduleChangesRefresh))
  context.subscriptions.push(progress.onDidChange(scheduleChangesRefresh))
  // The tree layout follows `scm.compactFolders`, which nothing else would
  // redraw — the changed files have not moved, only how they are grouped.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('scm.compactFolders')) changes.refresh()
    }),
  )
  context.subscriptions.push({ dispose: () => scheduleChangesRefresh.cancel() })
}

async function markReviewed(node: ChangesNode) {
  if (!progress || !changesView) return
  const failed: string[] = []
  for (const file of changesView.filesOf(node)) {
    // Re-marking an already-fresh file would only rewrite the same hash.
    if (file.state === 'reviewed') continue
    if (!(await progress.reviewed.mark(file.file.uri))) failed.push(file.file.relativePath)
  }
  if (failed.length > 0) {
    vscode.window.showWarningMessage(`Could not mark ${failed.join(', ')} as reviewed — the content is unreadable.`)
  }
  changesView.refresh()
}

function unmarkReviewed(node: ChangesNode) {
  if (!progress || !changesView) return
  for (const file of changesView.filesOf(node)) progress.reviewed.unmark(file.file.uri)
  changesView.refresh()
}

/**
 * The diff a stale mark exists to make possible: the file as it was when it was
 * marked reviewed, against the file now. Deliberately narrower than the HEAD
 * diff — it shows only what arrived after the reviewer looked away.
 */
async function showChangesSinceReviewed(node: FileChangeNode) {
  const entry = progress?.reviewed.entry(node.file.uri)
  if (!entry) {
    vscode.window.showInformationMessage(`${node.file.relativePath} has not been marked reviewed.`)
    return
  }
  if (!entry.hash) {
    // A `stat`-tier mark: too large to copy, or not text. Tracking it still
    // works — there is simply no baseline to put on the left of a diff.
    vscode.window.showInformationMessage(
      `${node.file.relativePath} is tracked by size and timestamp, so there is no reviewed-at copy to compare against.`,
    )
    return
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    snapshotUri(node.file.uri, entry.hash),
    node.file.uri,
    `${path.basename(node.file.relativePath)} — since you reviewed`,
  )
}

async function openChange(node: ChangesNode) {
  if (node.kind === 'folder') return
  // An added or untracked file has no HEAD side, so a diff against nothing
  // would just be the file with every line marked new.
  const left = isUntracked(node.file) ? undefined : headUri(node.file.uri)
  if (!left) {
    await vscode.window.showTextDocument(node.file.uri)
    return
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    left,
    node.file.uri,
    `${path.basename(node.file.relativePath)} — working tree ↔ HEAD`,
  )
}

async function revealThread(thread: TrackedCommentThread) {
  const doc = await vscode.workspace.openTextDocument(thread.uri)
  const editor = await vscode.window.showTextDocument(doc)
  const pos = thread.range.start
  editor.selection = new vscode.Selection(pos, pos)
  editor.revealRange(thread.range, vscode.TextEditorRevealType.InCenter)
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
}

/**
 * Narrow the Comments section by comment text or filename.
 *
 * A tree view cannot host a filter box of its own — the built-in Comments view's
 * one comes from an internal `FilterViewPane` — so this is an input box that
 * filters as you type, the way the old quick-pick's search did. Dismissing it
 * keeps the filter; the title bar then offers to clear it.
 */
function filterComments() {
  const view = commentsView
  if (!view) return

  const input = vscode.window.createInputBox()
  input.title = 'Filter Review Comments'
  input.placeholder = 'Comment text or file name'
  input.value = view.currentFilter()
  input.onDidChangeValue((value) => view.setFilter(value))
  input.onDidAccept(() => input.hide())
  input.onDidHide(() => input.dispose())
  input.show()
}

/**
 * A tree menu hands the command its node, while the gutter and the QuickPick
 * hand over the thread itself. Both arrive here.
 */
function asThread(arg: unknown): TrackedCommentThread | undefined {
  const candidate = arg as { kind?: string; thread?: TrackedCommentThread } | undefined
  const thread = candidate?.kind === 'thread' ? candidate.thread : (arg as TrackedCommentThread | undefined)
  return thread && findThreadByRef(thread.threadRef) ? thread : undefined
}

/** Same for the file-level batch commands, which are addressed by relative path. */
function asFileKey(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg
  const node = arg as { kind?: string; relativePath?: string } | undefined
  return node?.kind === 'file' ? node.relativePath : undefined
}

// --------------- Activation ---------------

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context
  outputLog = vscode.window.createOutputChannel('Crit')
  outputLog.appendLine('[Crit] Activating...')

  setThreadsChangedHandler(() => {
    refresh()
    saveState()
  })

  diagnosticCollection = vscode.languages.createDiagnosticCollection('crit')
  context.subscriptions.push(diagnosticCollection)

  // A folder added or removed can change which project owns a thread's URI.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearProjectRefCache()
      refresh()
    }),
  )

  const controller = vscode.comments.createCommentController('crit', 'Crit')
  context.subscriptions.push(controller)
  // Lets the IPC server create threads for comments an agent leaves.
  setCommentController(controller)

  controller.commentingRangeProvider = {
    provideCommentingRanges(document: vscode.TextDocument) {
      return [new vscode.Range(0, 0, document.lineCount - 1, 0)]
    },
  }

  controller.options = {
    prompt: 'Add review comment',
    placeHolder: 'Describe the change you want (e.g. "rename this variable", "add error handling")',
  }

  // --- Status bar (MUST be created before loadState/refresh) ---
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50)
  // Reveals the sidebar, which is now the only place comments are listed.
  statusBar.command = 'crit.comments.focus'
  statusBar.tooltip = 'Click to show review comments'
  context.subscriptions.push(statusBar)

  // --- Detect current branch and load state ---
  currentBranchKey = branchKey()
  outputLog.appendLine(`[Crit] Current branch key: ${currentBranchKey}`)

  try {
    loadStateFromKey(controller, currentBranchKey)
    outputLog.appendLine(`[Crit] Loaded ${threadsByRef.size} persisted threads for ${currentBranchKey}`)
  } catch (e: any) {
    outputLog.appendLine(`[Crit] Error loading state: ${e.message}`)
  }
  refresh()

  // --- Line tracking ---
  setupLineTracking(context)

  // --- Branch watcher ---
  setupBranchWatcher(context, controller)

  // --- Sidebar: changed files and their review marks, plus the comment tree ---
  setupViews(context)

  try {
    const staged = stageServer(context)
    if (staged.updated) outputLog.appendLine(`[Crit] Staged MCP server at ${staged.serverPath}`)
  } catch (e: any) {
    outputLog.appendLine(`[Crit] Could not stage MCP server: ${e.message}`)
  }

  // --- IPC Server ---
  startIpcServer(context, outputLog)
    .then((port) => {
      outputLog.appendLine(`[Crit] IPC server listening on 127.0.0.1:${port}`)
    })
    .catch((err) => {
      outputLog.appendLine(`[Crit] Failed to start IPC server: ${err}`)
    })

  // --- Create comment (first comment in a new thread) ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.createNote', (reply: vscode.CommentReply) => {
      const thread = reply.thread
      thread.comments = [new ReviewComment(reply.text, 'user')]
      thread.canReply = true
      unresolveThread(thread)
      trackThread(thread)
      refresh()
      saveState()
      // Not awaited: the comment is saved, and the offer is about the editor's
      // own view stealing the sidebar — which has just happened, right here.
      void promptIfCommentsViewReveals(context, outputLog)
    }),
  )

  // --- Reply (additional comments in existing thread) ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.reply', (reply: vscode.CommentReply) => {
      const thread = reply.thread
      const comment = new ReviewComment(reply.text, 'user')
      thread.comments = [...thread.comments, comment]
      refresh()
      saveState()
    }),
  )

  // --- Edit comment ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.editComment', (comment: ReviewComment) => {
      setCommentMode(comment.id, vscode.CommentMode.Editing)
    }),
  )

  // --- Save edited comment ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.saveEdit', (comment: ReviewComment) => {
      if (!setCommentMode(comment.id, vscode.CommentMode.Preview)) return
      refresh()
      saveState()
    }),
  )

  // --- Cancel edit ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.cancelEdit', (comment: ReviewComment) => {
      setCommentMode(comment.id, vscode.CommentMode.Preview)
    }),
  )

  // --- Delete individual comment ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.deleteNote', (comment: ReviewComment) => {
      const thread = findThreadForComment(comment.id)
      if (!thread) return
      if (thread.comments.length <= 1) {
        untrackThread(thread)
        thread.dispose()
      } else {
        thread.comments = thread.comments.filter((c) => (c as ReviewComment).id !== comment.id)
      }
      refresh()
      saveState()
    }),
  )

  // --- Send single thread to configured AI provider ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.sendThread', async (arg: unknown) => {
      const thread = asThread(arg) ?? requireTrackedThread(arg as vscode.CommentThread)
      await sendThreadsToAi([thread])
    }),
  )

  // --- Resolve thread ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.resolve', (arg: unknown) => {
      resolveThread(asThread(arg) ?? (arg as vscode.CommentThread))
      refresh()
      saveState()
    }),
  )

  // --- Unresolve thread ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.unresolve', (arg: unknown) => {
      unresolveThread(asThread(arg) ?? (arg as vscode.CommentThread))
      refresh()
      saveState()
    }),
  )

  // --- Submit all open to configured AI provider ---
  context.subscriptions.push(vscode.commands.registerCommand('crit.submitAll', () => submitAll()))

  // --- Resolve all ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.resolveAll', () => {
      const open = openThreads()
      for (const thread of open) resolveThread(thread)
      refresh()
      saveState()
      if (open.length > 0) {
        vscode.window.showInformationMessage(`Resolved ${open.length} comment${open.length !== 1 ? 's' : ''}.`)
      }
    }),
  )

  // --- Delete all resolved ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.deleteResolved', async () => {
      const resolved = [...threadsByRef.values()].filter(isResolved)
      if (resolved.length === 0) {
        vscode.window.showInformationMessage('No resolved comments to delete.')
        return
      }
      const answer = await vscode.window.showWarningMessage(
        `Delete ${resolved.length} resolved comment${resolved.length !== 1 ? 's' : ''}?`,
        { modal: true },
        'Delete',
      )
      if (answer !== 'Delete') return
      for (const thread of resolved) {
        untrackThread(thread)
        thread.dispose()
      }
      refresh()
      saveState()
    }),
  )

  // --- Clear all ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.clearAll', async () => {
      if (threadsByRef.size === 0) return
      const answer = await vscode.window.showWarningMessage(
        `Delete all ${threadsByRef.size} review comment${threadsByRef.size !== 1 ? 's' : ''}?`,
        { modal: true },
        'Delete All',
      )
      if (answer !== 'Delete All') return
      clearThreads()
      refresh()
      saveState()
    }),
  )

  // --- File-level batch: submit file ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.submitFile', async (arg: unknown) => {
      const fileKey = asFileKey(arg)
      if (fileKey === undefined) return
      const open = openThreadsInFile(fileKey)
      if (!open) return
      if (open.length === 0) {
        vscode.window.showInformationMessage('No open comments in this file.')
        return
      }
      await sendThreadsToAi(open)
    }),
  )

  // --- File-level batch: resolve file ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.resolveFile', (arg: unknown) => {
      const fileKey = asFileKey(arg)
      if (fileKey === undefined) return
      const open = openThreadsInFile(fileKey)
      if (!open) return
      for (const thread of open) resolveThread(thread)
      refresh()
      saveState()
      if (open.length > 0) {
        vscode.window.showInformationMessage(
          `Resolved ${open.length} comment${open.length !== 1 ? 's' : ''} in ${fileKey}.`,
        )
      }
    }),
  )

  // --- File-level batch: delete resolved in file ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.deleteResolvedFile', async (arg: unknown) => {
      const fileKey = asFileKey(arg)
      if (fileKey === undefined) return
      const threads = getThreadsByFile().get(fileKey)
      if (!threads) return
      const resolved = threads.filter(isResolved)
      if (resolved.length === 0) {
        vscode.window.showInformationMessage('No resolved comments in this file.')
        return
      }
      const answer = await vscode.window.showWarningMessage(
        `Delete ${resolved.length} resolved comment${resolved.length !== 1 ? 's' : ''} in ${fileKey}?`,
        { modal: true },
        'Delete',
      )
      if (answer !== 'Delete') return
      for (const thread of resolved) {
        untrackThread(thread)
        thread.dispose()
      }
      refresh()
      saveState()
    }),
  )

  // --- Copy single thread to clipboard ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.copyThread', async (arg: unknown) => {
      const thread = asThread(arg) ?? requireTrackedThread(arg as vscode.CommentThread)
      const prompt = await buildPrompt([thread], getAiProvider() === 'claudeCode')
      await vscode.env.clipboard.writeText(prompt)
      vscode.window.showInformationMessage('Comment prompt copied to clipboard.')
    }),
  )

  // --- Copy all open to clipboard ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.copyAll', async () => {
      const open = openThreads()
      if (open.length === 0) {
        vscode.window.showInformationMessage('No open comments to copy.')
        return
      }
      const prompt = await buildPrompt(open, getAiProvider() === 'claudeCode')
      await vscode.env.clipboard.writeText(prompt)
      vscode.window.showInformationMessage(`${open.length} comment(s) copied to clipboard.`)
    }),
  )

  // --- Copy file comments to clipboard ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.copyFile', async (arg: unknown) => {
      const fileKey = asFileKey(arg)
      if (fileKey === undefined) return
      const open = openThreadsInFile(fileKey)
      if (!open) return
      if (open.length === 0) {
        vscode.window.showInformationMessage('No open comments in this file.')
        return
      }
      const prompt = await buildPrompt(open, getAiProvider() === 'claudeCode')
      await vscode.env.clipboard.writeText(prompt)
      vscode.window.showInformationMessage(`${open.length} comment(s) from ${fileKey} copied to clipboard.`)
    }),
  )

  // --- Ask the AI to review the code and leave its own comments ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.requestReview', () => requestReview({ kind: 'project' }, context, outputLog)),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'crit.requestReviewFile',
      (arg?: vscode.Uri | vscode.SourceControlResourceState) => {
        const target = fileReviewTarget(arg)
        if (!target) {
          vscode.window.showInformationMessage('Open a file to have the AI review it.')
          return
        }
        return requestReview(target, context, outputLog)
      },
    ),
  )

  // --- Install the MCP server into Claude Code's user config ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.installMcpServer', () => installMcpServer(context, outputLog)),
  )

  // --- Changes section: open, mark, and the since-I-reviewed diff ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.openChange', (node: ChangesNode) => openChange(node)),
    vscode.commands.registerCommand('crit.markReviewed', (node: ChangesNode) => markReviewed(node)),
    vscode.commands.registerCommand('crit.unmarkReviewed', (node: ChangesNode) => unmarkReviewed(node)),
    vscode.commands.registerCommand('crit.showChangesSinceReviewed', (node: FileChangeNode) =>
      showChangesSinceReviewed(node),
    ),
    vscode.commands.registerCommand('crit.refreshChanges', () => changesView?.refresh()),
    vscode.commands.registerCommand('crit.changesAsTree', () => changesView?.setTreeLayout(true)),
    vscode.commands.registerCommand('crit.changesAsList', () => changesView?.setTreeLayout(false)),
    vscode.commands.registerCommand('crit.markAllReviewed', async () => {
      const rows = changesView?.currentRows() ?? []
      for (const row of rows) {
        if (row.state !== 'reviewed') await markReviewed(row)
      }
    }),
    vscode.commands.registerCommand('crit.clearReviewed', () => {
      for (const row of changesView?.currentRows() ?? []) unmarkReviewed(row)
    }),
  )

  // --- Comments section ---
  context.subscriptions.push(
    vscode.commands.registerCommand('crit.goToThread', async (arg: unknown) => {
      const thread = asThread(arg)
      if (thread) await revealThread(thread)
    }),
    vscode.commands.registerCommand('crit.deleteThread', async (arg: unknown) => {
      const thread = asThread(arg)
      if (!thread) return
      const answer = await vscode.window.showWarningMessage('Delete this comment thread?', { modal: true }, 'Delete')
      if (answer !== 'Delete') return
      untrackThread(thread)
      thread.dispose()
      refresh()
      saveState()
    }),
    vscode.commands.registerCommand('crit.hideResolvedComments', () => commentsView?.setHideResolved(true)),
    vscode.commands.registerCommand('crit.showResolvedComments', () => commentsView?.setHideResolved(false)),
    vscode.commands.registerCommand('crit.filterComments', () => filterComments()),
    vscode.commands.registerCommand('crit.clearCommentsFilter', () => commentsView?.setFilter('')),
  )

  // --- Register Copilot tools ---
  registerTools(context)
}

/**
 * The file a review request names: the URI a menu passed us, else whatever is
 * in the active editor — the command palette passes nothing.
 *
 * The Source Control view hands over a resource state rather than a URI, so
 * both shapes are accepted.
 */
function fileReviewTarget(arg?: vscode.Uri | vscode.SourceControlResourceState): ReviewTarget | undefined {
  const uri = menuUri(arg) ?? vscode.window.activeTextEditor?.document.uri
  if (!uri || uri.scheme !== 'file') return undefined
  return { kind: 'file', uri }
}

function menuUri(arg?: vscode.Uri | vscode.SourceControlResourceState): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg
  const resourceUri = arg?.resourceUri
  return resourceUri instanceof vscode.Uri ? resourceUri : undefined
}

/** Open threads in `fileKey`, or undefined when the file has no threads. */
function openThreadsInFile(fileKey: string): TrackedCommentThread[] | undefined {
  const threads = getThreadsByFile().get(fileKey)
  if (!threads) return undefined
  return threads.filter((thread) => !isResolved(thread))
}

function setCommentMode(commentId: number, mode: vscode.CommentMode): boolean {
  const thread = findThreadForComment(commentId)
  if (!thread) return false
  thread.comments = thread.comments.map((c) => {
    if ((c as ReviewComment).id === commentId) (c as ReviewComment).mode = mode
    return c
  })
  return true
}

// --------------- Submit All ---------------

async function submitAll() {
  const open = openThreads()
  if (open.length === 0) {
    vscode.window.showInformationMessage('No open review comments to submit.')
    return
  }
  await sendThreadsToAi(open)
}

export function deactivate() {}
