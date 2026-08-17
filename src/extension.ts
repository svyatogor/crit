import * as vscode from 'vscode';
import * as path from 'path';
import { sendMessageToSocket } from './claude-messaging';
import { ClaudeSession, findSessionForWorkspace } from './claude-sessions';
import { registerTools } from './copilot-tools';
import { CRIT_DIAGNOSTIC_SOURCE } from './diagnostic-metadata';
import { getGitApi } from './git';
import { startIpcServer } from './ipc-server';
import { buildNudgeMessage, buildPrompt } from './prompts';
import {
    clearProjectRefCache,
    clearThreads,
    diagnosticCode,
    diagnosticMessage,
    findThreadForComment,
    isResolved,
    openThreads,
    requireTrackedThread,
    resolveThread,
    restoreState,
    ReviewComment,
    SerializedState,
    serializeState,
    setThreadsChangedHandler,
    threadLabel,
    threadMap,
    TrackedCommentThread,
    trackThread,
    unresolveThread,
    untrackThread,
} from './review-threads';

// --------------- Helpers ---------------

function getThreadsByFile(): Map<string, { id: number; thread: TrackedCommentThread }[]> {
    const byFile = new Map<string, { id: number; thread: TrackedCommentThread }[]>();
    for (const [id, thread] of threadMap) {
        const rel = vscode.workspace.asRelativePath(thread.uri);
        if (!byFile.has(rel)) byFile.set(rel, []);
        byFile.get(rel)!.push({ id, thread });
    }
    return byFile;
}

function threadPreview(thread: vscode.CommentThread): string {
    const first = thread.comments[0];
    const text = typeof first.body === 'string' ? first.body : first.body.value;
    return text.length > 55 ? text.substring(0, 52) + '...' : text;
}

function refreshDiagnostics() {
    if (!diagnosticCollection) return;

    const byUri = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
    for (const thread of threadMap.values()) {
        if (isResolved(thread)) continue;

        const uriKey = thread.uri.toString();
        let entry = byUri.get(uriKey);
        if (!entry) {
            entry = { uri: thread.uri, diagnostics: [] };
            byUri.set(uriKey, entry);
        }

        const diagnostic = new vscode.Diagnostic(
            thread.range,
            diagnosticMessage(thread),
            vscode.DiagnosticSeverity.Information,
        );
        diagnostic.source = CRIT_DIAGNOSTIC_SOURCE;
        // Must stay a plain string. The object form (`{value, target}`) renders
        // more nicely in the Problems view, but agents that read diagnostics
        // stringify this field and receive "[object Object]", losing both the
        // label and the routing code.
        //
        // The label leads so the Problems view is scannable ("R3 …"), and the
        // routing code follows so an agent reading the diagnostic can still
        // address the thread over MCP.
        diagnostic.code = `${threadLabel(thread)} ${diagnosticCode(thread)}`;
        entry.diagnostics.push(diagnostic);
    }

    diagnosticCollection.clear();
    for (const { uri, diagnostics } of byUri.values()) {
        diagnosticCollection.set(uri, diagnostics);
    }
}

// --------------- Status Bar ---------------

let statusBar: vscode.StatusBarItem;
let diagnosticCollection: vscode.DiagnosticCollection | undefined;

function refresh() {
    const n = threadMap.size;
    const open = openThreads().length;
    if (n > 0) {
        statusBar.text = `$(comment-discussion) ${open} open · ${n - open} resolved`;
        statusBar.show();
    } else {
        statusBar.hide();
    }
    refreshDiagnostics();
}

const REFRESH_DEBOUNCE_MS = 250;
let pendingRefresh: NodeJS.Timeout | undefined;

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
function scheduleRefresh() {
    if (pendingRefresh) clearTimeout(pendingRefresh);
    pendingRefresh = setTimeout(() => {
        pendingRefresh = undefined;
        refresh();
        saveState();
    }, REFRESH_DEBOUNCE_MS);
}

function flushPendingRefresh() {
    if (!pendingRefresh) return;
    clearTimeout(pendingRefresh);
    pendingRefresh = undefined;
    refresh();
    saveState();
}

// --------------- AI Provider ---------------

type AiProvider = 'copilot' | 'claudeCode';

function getAiProvider(): AiProvider {
    return vscode.workspace
        .getConfiguration('crit')
        .get<AiProvider>('aiProvider', 'copilot');
}

/**
 * The terminal Claude Code runs in, if it is running there.
 *
 * Claude Code creates its terminal as `Claude Code` (overridable via
 * CLAUDE_CODE_TERMINAL_TITLE), so match on that rather than grabbing whichever
 * terminal happens to be active — sending a review prompt into an unrelated
 * shell would execute it.
 */
function findClaudeCodeTerminal(): vscode.Terminal | undefined {
    const expected = process.env.CLAUDE_CODE_TERMINAL_TITLE || 'Claude Code';
    const matches = vscode.window.terminals.filter(t => t.name.includes(expected));
    if (matches.length === 0) return undefined;

    // Prefer the focused one when several are open.
    const active = vscode.window.activeTerminal;
    if (active && matches.includes(active)) return active;
    return matches[matches.length - 1];
}

/** The Claude Code session running in this workspace, if there is one. */
function findWorkspaceClaudeSession(): ClaudeSession | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return undefined;

    try {
        return findSessionForWorkspace(folder.uri.fsPath, {
            // Guards the case where VS Code itself was launched from a Claude
            // session: that session must not review its own comments.
            excludeSessionId: process.env.CLAUDE_CODE_SESSION_ID,
        });
    } catch {
        return undefined;
    }
}

/**
 * Deliver a prompt to Claude Code, preferring paths that keep the user in the
 * conversation they are already having.
 *
 *  1. Terminal — appends to the running CLI session.
 *  2. Live session — cross-session message into the running conversation.
 *  3. New conversation — last resort; the webview cannot be handed a prompt for
 *     a session it already hosts ("Your prompt was not applied").
 */
async function deliverToClaudeCode(
    threads: TrackedCommentThread[],
    prompt: string,
): Promise<void> {
    const terminal = findClaudeCodeTerminal();
    if (terminal) {
        terminal.show();
        terminal.sendText(buildNudgeMessage(threads, 'diagnostics'), true);
        return;
    }

    const session = findWorkspaceClaudeSession();
    if (session) {
        try {
            await sendMessageToSocket(
                session.messagingSocketPath,
                buildNudgeMessage(threads, 'mcp'),
            );
            // The inbox never acks, and the session may be off-screen, so say
            // where the comments went rather than leaving the send invisible.
            vscode.window.showInformationMessage(
                `Sent review comments to Claude Code session ${sessionLabel(session)}.`,
            );
            return;
        } catch (error: any) {
            // The session can exit between discovery and delivery; opening a
            // new conversation still gets the review in front of the user.
            outputLog.appendLine(
                `[Crit] Cross-session delivery failed, opening a new conversation: ${error.message}`,
            );
        }
    }

    await vscode.commands.executeCommand(
        'claude-vscode.primaryEditor.open',
        undefined,
        prompt,
    );
}

function sessionLabel(session: ClaudeSession): string {
    return session.name ?? session.sessionId.slice(0, 8);
}

async function sendThreadsToAi(threads: TrackedCommentThread[]): Promise<void> {
    if (threads.length === 0) return;

    const provider = getAiProvider();
    const prompt = await buildPrompt(threads, provider === 'claudeCode');

    try {
        if (provider === 'claudeCode') {
            await deliverToClaudeCode(threads, prompt);
        } else {
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt });
        }
    } catch {
        await vscode.env.clipboard.writeText(prompt);
        const providerName = provider === 'claudeCode' ? 'Claude Code' : 'GitHub Copilot';
        vscode.window.showWarningMessage(
            `Could not open ${providerName}. The prompt was copied to the clipboard.`,
        );
    }
}

// --------------- Persistence (branch-scoped) ---------------

let extensionContext: vscode.ExtensionContext;
let currentBranchKey: string = '_default';
let outputLog: vscode.OutputChannel;

function getBranchKey(): string {
    try {
        const git = getGitApi();
        if (!git) return '_default';
        const repos = git.repositories;
        if (!repos || repos.length === 0) return '_default';
        // Use first repo (most common case)
        const repo = repos[0];
        const repoName = path.basename(repo.rootUri.fsPath);
        const branch = repo.state?.HEAD?.name || '_detached';
        return `${repoName}.${branch}`;
    } catch {
        return '_default';
    }
}

function stateKey(branchKey?: string): string {
    return `crit.state.${branchKey ?? currentBranchKey}`;
}

function saveState() {
    extensionContext.workspaceState.update(stateKey(), serializeState());
}

function loadStateFromKey(controller: vscode.CommentController, key: string) {
    const data = extensionContext.workspaceState.get<SerializedState>(stateKey(key));
    if (!data || !data.threads) return;
    restoreState(controller, data);
}

function switchToBranch(controller: vscode.CommentController, newKey: string) {
    if (newKey === currentBranchKey) return;

    outputLog.appendLine(`[Crit] Branch switch: ${currentBranchKey} → ${newKey}`);

    // Persist any edit still inside the refresh debounce before the threads it
    // moved are cleared.
    flushPendingRefresh();

    // Save current branch's comments
    saveState();

    // Clear current threads from UI
    clearThreads();

    const oldKey = currentBranchKey;
    currentBranchKey = newKey;

    // Try loading saved state for the new branch
    const newData = extensionContext.workspaceState.get<SerializedState>(stateKey(newKey));

    if (newData && newData.threads && newData.threads.length > 0) {
        // New branch has its own saved comments — load them
        loadStateFromKey(controller, newKey);
        outputLog.appendLine(`[Crit] Loaded ${threadMap.size} comments for branch ${newKey}`);
    } else {
        // New branch has no saved comments — copy from the old branch (Option B)
        loadStateFromKey(controller, oldKey);
        if (threadMap.size > 0) {
            // Save the copied state under the new branch key
            saveState();
            outputLog.appendLine(`[Crit] Inherited ${threadMap.size} comments from ${oldKey} to ${newKey}`);
        } else {
            outputLog.appendLine(`[Crit] No comments to inherit — clean slate for ${newKey}`);
        }
    }

    refresh();
}

function setupBranchWatcher(context: vscode.ExtensionContext, controller: vscode.CommentController) {
    try {
        const git = getGitApi();
        if (!git) {
            outputLog.appendLine('[Crit] Git API not available — branch scoping disabled');
            return;
        }
        for (const repo of git.repositories) {
            repo.state.onDidChange(() => {
                const newKey = getBranchKey();
                if (newKey !== currentBranchKey) {
                    switchToBranch(controller, newKey);
                }
            });
        }
        // Also watch for new repos being opened
        git.onDidOpenRepository((repo: any) => {
            repo.state.onDidChange(() => {
                const newKey = getBranchKey();
                if (newKey !== currentBranchKey) {
                    switchToBranch(controller, newKey);
                }
            });
        });
        outputLog.appendLine(`[Crit] Branch watcher active, current: ${currentBranchKey}`);
    } catch (e: any) {
        outputLog.appendLine(`[Crit] Branch watcher setup failed: ${e.message}`);
    }
}

// --------------- Line Tracking ---------------

function setupLineTracking(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.contentChanges.length === 0) return;

            // Only track changes for documents that have comment threads
            const docUri = e.document.uri.toString();
            const affected: TrackedCommentThread[] = [];
            for (const thread of threadMap.values()) {
                if (thread.uri.toString() === docUri) affected.push(thread);
            }
            if (affected.length === 0) return;

            // Process content changes in reverse order (bottom-up) to avoid cascading shifts
            const changes = [...e.contentChanges].sort(
                (a, b) => b.range.start.line - a.range.start.line
            );

            for (const change of changes) {
                const startLine = change.range.start.line;
                const oldEndLine = change.range.end.line;
                // Normalize CRLF → LF before counting newlines
                const normalizedText = change.text.replace(/\r\n/g, '\n');
                const newLines = normalizedText.split('\n').length - 1;
                const oldLines = oldEndLine - startLine;
                const delta = newLines - oldLines;

                if (delta === 0) continue;

                for (const thread of affected) {
                    const threadLine = thread.range.start.line;
                    if (threadLine > oldEndLine) {
                        const newStart = threadLine + delta;
                        const newEnd = thread.range.end.line + delta;
                        if (newStart >= 0) {
                            thread.range = new vscode.Range(newStart, 0, newEnd, 0);
                        }
                    }
                }
            }

            scheduleRefresh();
        })
    );

    // Deactivation must not drop an edit that is still inside the debounce
    // window.
    context.subscriptions.push({ dispose: flushPendingRefresh });
}

// --------------- Activation ---------------

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    outputLog = vscode.window.createOutputChannel('Crit');
    outputLog.appendLine('[Crit] Activating...');

    setThreadsChangedHandler(() => {
        refresh();
        saveState();
    });

    diagnosticCollection = vscode.languages.createDiagnosticCollection('crit');
    context.subscriptions.push(diagnosticCollection);

    // A folder added or removed can change which project owns a thread's URI.
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            clearProjectRefCache();
            refresh();
        })
    );

    const controller = vscode.comments.createCommentController('crit', 'Crit');
    context.subscriptions.push(controller);

    controller.commentingRangeProvider = {
        provideCommentingRanges(document: vscode.TextDocument) {
            return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
        }
    };

    controller.options = {
        prompt: 'Add review comment',
        placeHolder: 'Describe the change you want (e.g. "rename this variable", "add error handling")'
    };

    // --- Status bar (MUST be created before loadState/refresh) ---
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBar.command = 'crit.showPanel';
    statusBar.tooltip = 'Click to view review comments';
    context.subscriptions.push(statusBar);

    // --- Detect current branch and load state ---
    currentBranchKey = getBranchKey();
    outputLog.appendLine(`[Crit] Current branch key: ${currentBranchKey}`);

    try {
        loadStateFromKey(controller, currentBranchKey);
        outputLog.appendLine(`[Crit] Loaded ${threadMap.size} persisted threads for ${currentBranchKey}`);
    } catch (e: any) {
        outputLog.appendLine(`[Crit] Error loading state: ${e.message}`);
    }
    refresh();

    // --- Line tracking ---
    setupLineTracking(context);

    // --- Branch watcher ---
    setupBranchWatcher(context, controller);

    // --- IPC Server ---
    startIpcServer(context, outputLog).then(port => {
        outputLog.appendLine(`[Crit] IPC server listening on 127.0.0.1:${port}`);
    }).catch(err => {
        outputLog.appendLine(`[Crit] Failed to start IPC server: ${err}`);
    });

    // --- Create comment (first comment in a new thread) ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.createNote', (reply: vscode.CommentReply) => {
            const thread = reply.thread;
            thread.comments = [new ReviewComment(reply.text, 'user')];
            thread.canReply = true;
            unresolveThread(thread);
            trackThread(thread);
            refresh();
            saveState();
        })
    );

    // --- Reply (additional comments in existing thread) ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.reply', (reply: vscode.CommentReply) => {
            const thread = reply.thread;
            const comment = new ReviewComment(reply.text, 'user');
            thread.comments = [...thread.comments, comment];
            refresh();
            saveState();
        })
    );

    // --- Edit comment ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.editComment', (comment: ReviewComment) => {
            setCommentMode(comment.id, vscode.CommentMode.Editing);
        })
    );

    // --- Save edited comment ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.saveEdit', (comment: ReviewComment) => {
            if (!setCommentMode(comment.id, vscode.CommentMode.Preview)) return;
            refresh();
            saveState();
        })
    );

    // --- Cancel edit ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.cancelEdit', (comment: ReviewComment) => {
            setCommentMode(comment.id, vscode.CommentMode.Preview);
        })
    );

    // --- Delete individual comment ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.deleteNote', (comment: ReviewComment) => {
            const thread = findThreadForComment(comment.id);
            if (!thread) return;
            if (thread.comments.length <= 1) {
                untrackThread(thread);
                thread.dispose();
            } else {
                thread.comments = thread.comments.filter(
                    c => (c as ReviewComment).id !== comment.id
                );
            }
            refresh();
            saveState();
        })
    );

    // --- Send single thread to configured AI provider ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.sendThread', async (thread: vscode.CommentThread) => {
            await sendThreadsToAi([requireTrackedThread(thread)]);
        })
    );

    // --- Resolve thread ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.resolve', (thread: vscode.CommentThread) => {
            resolveThread(thread);
            refresh();
            saveState();
        })
    );

    // --- Unresolve thread ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.unresolve', (thread: vscode.CommentThread) => {
            unresolveThread(thread);
            refresh();
            saveState();
        })
    );

    // --- Show comment panel ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.showPanel', () => showCommentPanel())
    );

    // --- Submit all open to configured AI provider ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.submitAll', () => submitAll())
    );

    // --- Resolve all ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.resolveAll', () => {
            const open = openThreads();
            for (const thread of open) resolveThread(thread);
            refresh();
            saveState();
            if (open.length > 0) {
                vscode.window.showInformationMessage(
                    `Resolved ${open.length} comment${open.length !== 1 ? 's' : ''}.`
                );
            }
        })
    );

    // --- Delete all resolved ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.deleteResolved', async () => {
            const resolved = [...threadMap.values()].filter(isResolved);
            if (resolved.length === 0) { vscode.window.showInformationMessage('No resolved comments to delete.'); return; }
            const answer = await vscode.window.showWarningMessage(
                `Delete ${resolved.length} resolved comment${resolved.length !== 1 ? 's' : ''}?`, { modal: true }, 'Delete'
            );
            if (answer !== 'Delete') return;
            for (const thread of resolved) { untrackThread(thread); thread.dispose(); }
            refresh();
            saveState();
        })
    );

    // --- Clear all ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.clearAll', async () => {
            if (threadMap.size === 0) return;
            const answer = await vscode.window.showWarningMessage(
                `Delete all ${threadMap.size} review comment${threadMap.size !== 1 ? 's' : ''}?`, { modal: true }, 'Delete All'
            );
            if (answer !== 'Delete All') return;
            clearThreads();
            refresh();
            saveState();
        })
    );

    // --- File-level batch: submit file ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.submitFile', async (fileKey: string) => {
            const open = openThreadsInFile(fileKey);
            if (!open) return;
            if (open.length === 0) { vscode.window.showInformationMessage('No open comments in this file.'); return; }
            await sendThreadsToAi(open);
        })
    );

    // --- File-level batch: resolve file ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.resolveFile', (fileKey: string) => {
            const open = openThreadsInFile(fileKey);
            if (!open) return;
            for (const thread of open) resolveThread(thread);
            refresh();
            saveState();
            if (open.length > 0) {
                vscode.window.showInformationMessage(
                    `Resolved ${open.length} comment${open.length !== 1 ? 's' : ''} in ${fileKey}.`
                );
            }
        })
    );

    // --- File-level batch: delete resolved in file ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.deleteResolvedFile', async (fileKey: string) => {
            const entries = getThreadsByFile().get(fileKey);
            if (!entries) return;
            const resolved = entries.map(e => e.thread).filter(isResolved);
            if (resolved.length === 0) { vscode.window.showInformationMessage('No resolved comments in this file.'); return; }
            const answer = await vscode.window.showWarningMessage(
                `Delete ${resolved.length} resolved comment${resolved.length !== 1 ? 's' : ''} in ${fileKey}?`, { modal: true }, 'Delete'
            );
            if (answer !== 'Delete') return;
            for (const thread of resolved) { untrackThread(thread); thread.dispose(); }
            refresh();
            saveState();
        })
    );

    // --- Copy single thread to clipboard ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.copyThread', async (thread: vscode.CommentThread) => {
            const prompt = await buildPrompt([requireTrackedThread(thread)]);
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage('Comment prompt copied to clipboard.');
        })
    );

    // --- Copy all open to clipboard ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.copyAll', async () => {
            const open = openThreads();
            if (open.length === 0) { vscode.window.showInformationMessage('No open comments to copy.'); return; }
            const prompt = await buildPrompt(open);
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(`${open.length} comment(s) copied to clipboard.`);
        })
    );

    // --- Copy file comments to clipboard ---
    context.subscriptions.push(
        vscode.commands.registerCommand('crit.copyFile', async (fileKey: string) => {
            const open = openThreadsInFile(fileKey);
            if (!open) return;
            if (open.length === 0) { vscode.window.showInformationMessage('No open comments in this file.'); return; }
            const prompt = await buildPrompt(open);
            await vscode.env.clipboard.writeText(prompt);
            vscode.window.showInformationMessage(`${open.length} comment(s) from ${fileKey} copied to clipboard.`);
        })
    );

    // --- Register Copilot tools ---
    registerTools(context);
}

/** Open threads in `fileKey`, or undefined when the file has no threads. */
function openThreadsInFile(fileKey: string): TrackedCommentThread[] | undefined {
    const entries = getThreadsByFile().get(fileKey);
    if (!entries) return undefined;
    return entries.map(e => e.thread).filter(thread => !isResolved(thread));
}

function setCommentMode(commentId: number, mode: vscode.CommentMode): boolean {
    const thread = findThreadForComment(commentId);
    if (!thread) return false;
    thread.comments = thread.comments.map(c => {
        if ((c as ReviewComment).id === commentId) (c as ReviewComment).mode = mode;
        return c;
    });
    return true;
}

// --------------- Interactive QuickPick Panel ---------------

async function showCommentPanel() {
    if (threadMap.size === 0) {
        vscode.window.showInformationMessage('No review comments.');
        return;
    }

    interface ActionItem extends vscode.QuickPickItem {
        action?: string;
        threadId?: number;
        fileKey?: string;
    }

    const qp = vscode.window.createQuickPick<ActionItem>();
    const openCount = openThreads().length;
    const resolvedCount = threadMap.size - openCount;
    qp.title = `Review Comments (${openCount} open, ${resolvedCount} resolved)`;
    qp.placeholder = 'Type to search comments… Select an action or comment.';
    qp.matchOnDescription = true;

    function buildItems(filter: string): ActionItem[] {
        const items: ActionItem[] = [];
        const lf = filter.toLowerCase();

        // Global actions (always shown)
        items.push(
            { label: '$(send) Send All Open to AI', description: `${openCount} open`, action: 'submitAll' },
            { label: '$(clippy) Copy All Open to Clipboard', description: `${openCount} open`, action: 'copyAll' },
            { label: '$(check-all) Resolve All', description: `${openCount} open`, action: 'resolveAll' },
            { label: '$(trash) Delete All Resolved', description: `${resolvedCount} resolved`, action: 'deleteResolved' },
            { label: '$(clear-all) Clear All', description: `${threadMap.size} total`, action: 'clearAll' },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
        );

        const byFile = getThreadsByFile();

        for (const [file, entries] of byFile) {
            const sorted = entries.sort((a, b) => a.thread.range.start.line - b.thread.range.start.line);

            // Filter: check if any comment in this file matches
            const matchingEntries = lf
                ? sorted.filter(({ thread }) => {
                    const texts = thread.comments.map(c =>
                        typeof c.body === 'string' ? c.body : c.body.value
                    ).join(' ').toLowerCase();
                    return file.toLowerCase().includes(lf) || texts.includes(lf);
                })
                : sorted;

            if (matchingEntries.length === 0) continue;

            const fileOpen = matchingEntries.filter(e => !isResolved(e.thread)).length;
            const fileResolved = matchingEntries.length - fileOpen;

            // File header with batch actions
            items.push({ label: `📁 ${file}  (${fileOpen} open, ${fileResolved} resolved)`, kind: vscode.QuickPickItemKind.Separator });
            items.push(
                { label: `  $(send) Send ${file} to AI`, description: `${fileOpen} open`, action: 'submitFile', fileKey: file },
                { label: `  $(clippy) Copy ${file}`, description: `${fileOpen} open`, action: 'copyFile', fileKey: file },
                { label: `  $(check-all) Resolve ${file}`, description: `${fileOpen} open`, action: 'resolveFile', fileKey: file },
                { label: `  $(trash) Delete Resolved in ${file}`, description: `${fileResolved} resolved`, action: 'deleteResolvedFile', fileKey: file },
            );

            // Individual comments
            for (const { id, thread } of matchingEntries) {
                const line = thread.range.start.line + 1;
                const preview = threadPreview(thread);
                const status = isResolved(thread) ? '✅' : '💬';
                const replyCount = thread.comments.length - 1;
                const replyInfo = replyCount > 0 ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : '';
                const roles = thread.comments.map(c => (c as ReviewComment).role === 'agent' ? '🤖' : '👤').join('');
                items.push({
                    label: `    ${status} L${line}: ${preview}`,
                    description: `${roles}${replyInfo ? '  ' + replyInfo : ''}`,
                    threadId: id,
                    action: 'commentAction',
                });
            }
        }

        return items;
    }

    qp.items = buildItems('');
    qp.onDidChangeValue(value => { qp.items = buildItems(value); });

    qp.onDidAccept(async () => {
        const pick = qp.selectedItems[0];
        if (!pick?.action) return;
        qp.hide();

        switch (pick.action) {
            case 'submitAll':
                await vscode.commands.executeCommand('crit.submitAll');
                break;
            case 'copyAll':
                await vscode.commands.executeCommand('crit.copyAll');
                break;
            case 'resolveAll':
                await vscode.commands.executeCommand('crit.resolveAll');
                break;
            case 'deleteResolved':
                await vscode.commands.executeCommand('crit.deleteResolved');
                break;
            case 'clearAll':
                await vscode.commands.executeCommand('crit.clearAll');
                break;
            case 'submitFile':
                if (pick.fileKey) await vscode.commands.executeCommand('crit.submitFile', pick.fileKey);
                break;
            case 'copyFile':
                if (pick.fileKey) await vscode.commands.executeCommand('crit.copyFile', pick.fileKey);
                break;
            case 'resolveFile':
                if (pick.fileKey) await vscode.commands.executeCommand('crit.resolveFile', pick.fileKey);
                break;
            case 'deleteResolvedFile':
                if (pick.fileKey) await vscode.commands.executeCommand('crit.deleteResolvedFile', pick.fileKey);
                break;
            case 'commentAction':
                if (pick.threadId !== undefined) await showCommentActions(pick.threadId);
                break;
        }
    });

    qp.show();
}

// --------------- Per-Comment Action Submenu ---------------

async function showCommentActions(threadId: number) {
    const thread = threadMap.get(threadId);
    if (!thread) return;

    const rel = vscode.workspace.asRelativePath(thread.uri);
    const line = thread.range.start.line + 1;
    const preview = threadPreview(thread);
    const resolved = isResolved(thread);

    interface ActionItem extends vscode.QuickPickItem { action: string; }

    const items: ActionItem[] = [
        { label: '$(eye) Go to Comment', description: `${rel}:${line}`, action: 'goto' },
        { label: '$(send) Send to AI', description: 'Send this comment to the configured AI provider', action: 'send' },
        { label: '$(clippy) Copy to Clipboard', description: 'Copy this comment as a prompt', action: 'copy' },
        { label: resolved ? '$(debug-restart) Reopen' : '$(check) Resolve', action: resolved ? 'unresolve' : 'resolve' },
        { label: '$(trash) Delete', action: 'delete' },
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: `${resolved ? '✅' : '💬'} L${line}: ${preview}`,
        placeHolder: 'Choose an action',
    });

    if (!pick) return;

    switch (pick.action) {
        case 'goto': {
            const doc = await vscode.workspace.openTextDocument(thread.uri);
            const editor = await vscode.window.showTextDocument(doc);
            const pos = thread.range.start;
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(thread.range, vscode.TextEditorRevealType.InCenter);
            thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
            break;
        }
        case 'send':
            await vscode.commands.executeCommand('crit.sendThread', thread);
            break;
        case 'copy':
            await vscode.commands.executeCommand('crit.copyThread', thread);
            break;
        case 'resolve':
            resolveThread(thread);
            refresh();
            saveState();
            break;
        case 'unresolve':
            unresolveThread(thread);
            refresh();
            saveState();
            break;
        case 'delete': {
            const answer = await vscode.window.showWarningMessage(
                'Delete this comment thread?', { modal: true }, 'Delete'
            );
            if (answer !== 'Delete') break;
            untrackThread(thread);
            thread.dispose();
            refresh();
            saveState();
            break;
        }
    }
}

// --------------- Submit All ---------------

async function submitAll() {
    const open = openThreads();
    if (open.length === 0) {
        vscode.window.showInformationMessage('No open review comments to submit.');
        return;
    }
    await sendThreadsToAi(open);
}

export function deactivate() {}
