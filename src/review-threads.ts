import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import {
  createProjectRef,
  createSessionRef,
  createThreadRef,
  CRIT_DIAGNOSTIC_VERSION,
  encodeDiagnosticMetadata,
} from './diagnostic-metadata'

/**
 * The review model: comment threads, the refs that address them, and the
 * serialized form persisted per branch.
 *
 * Everything that mutates review state — the extension's commands, the IPC
 * server, the Copilot tools — goes through here, so this module holds the maps
 * and the identity rules while the extension host keeps the UI, persistence,
 * and activation wiring.
 */

// --------------- Types ---------------

export type Role = 'user' | 'agent'

export interface SerializedComment {
  id: number
  role: Role
  body: string
  timestamp: string
}

export interface SerializedThread {
  id: number
  threadRef: string
  uri: string
  startLine: number
  endLine: number
  status: 'open' | 'resolved'
  comments: SerializedComment[]
}

export const STATE_VERSION = 2

export interface SerializedState {
  version: typeof STATE_VERSION
  nextThreadId: number
  nextCommentId: number
  threads: SerializedThread[]
}

export interface TrackedCommentThread extends vscode.CommentThread {
  range: vscode.Range
  /** Display only — see `threadLabel`. Address a thread by `threadRef`. */
  threadId: number
  threadRef: string
}

// --------------- Comment Model ---------------

let nextCommentId = 1

export class ReviewComment implements vscode.Comment {
  readonly id: number
  body: string | vscode.MarkdownString
  mode: vscode.CommentMode
  author: vscode.CommentAuthorInformation
  role: Role
  contextValue: string
  createdAt: string // ISO string for serialization
  timestamp: Date // vscode.Comment expects Date

  constructor(body: string, role: Role, id?: number, createdAt?: string) {
    this.id = id ?? nextCommentId++
    this.body = body
    this.role = role
    this.mode = vscode.CommentMode.Preview
    this.author = role === 'agent' ? { name: '🤖 Agent' } : { name: '👤 You' }
    this.contextValue = role === 'agent' ? 'agentComment' : 'userComment'
    this.createdAt = createdAt ?? new Date().toISOString()
    this.timestamp = new Date(this.createdAt)
  }
}

// --------------- Change Notification ---------------

let onThreadsChanged: () => void = () => {}

/**
 * Install the "re-render and persist" callback, once, during activation.
 *
 * Modules that only mutate threads stay clear of the status bar, the diagnostic
 * collection, and `workspaceState` — all of which live in the extension host —
 * by calling `threadsChanged()` instead.
 */
export function setThreadsChangedHandler(handler: () => void): void {
  onThreadsChanged = handler
}

export function threadsChanged(): void {
  onThreadsChanged()
}

// --------------- Thread Creation ---------------

/**
 * The controller new threads are created on, installed once during activation.
 *
 * Threads created by the user come in through a `CommentReply` that already
 * carries its thread, but a thread an agent asks for has no such handle — the
 * request arrives over IPC, in a module with no reason to know about the
 * extension host. Registering the controller here is the same arrangement
 * `setThreadsChangedHandler` uses, for the same reason.
 */
let commentController: vscode.CommentController | undefined

export function setCommentController(controller: vscode.CommentController): void {
  commentController = controller
}

export interface NewThreadRequest {
  uri: vscode.Uri
  /** 0-based, as VS Code counts lines. */
  startLine: number
  /** 0-based; defaults to `startLine`. */
  endLine?: number
  text: string
  /** Defaults to `agent` — a thread created through a tool is the agent's. */
  role?: Role
}

/** Create and track a thread, as `crit.createNote` does for the user. */
export function createReviewThread(request: NewThreadRequest): TrackedCommentThread {
  if (!commentController) {
    throw new Error('Crit is still starting up and cannot create review comments yet.')
  }

  const endLine = Math.max(request.startLine, request.endLine ?? request.startLine)
  const range = new vscode.Range(request.startLine, 0, endLine, 0)
  const thread = commentController.createCommentThread(request.uri, range, [])
  thread.comments = [new ReviewComment(request.text, request.role ?? 'agent')]
  thread.canReply = true
  unresolveThread(thread)
  return trackThread(thread)
}

// --------------- Thread Tracking ---------------

/**
 * Every tracked thread, keyed by `threadRef` — the single index.
 *
 * `threadId` stays on the thread as a display field (see `threadLabel`), but it
 * is never an index: it is a per-branch sequence that repeats across branches,
 * so keying on it would let a stale number silently address whatever thread now
 * holds it.
 */
export const threadsByRef = new Map<string, TrackedCommentThread>()
let nextThreadId = 1

export function trackThread(
  thread: vscode.CommentThread,
  id?: number,
  persistedThreadRef?: string,
): TrackedCommentThread {
  if (!thread.range) {
    throw new Error('Crit threads must have a document range.')
  }
  const trackedThread = thread as TrackedCommentThread
  const tid = id ?? nextThreadId++
  let threadRef = persistedThreadRef ?? createThreadRef()
  while (threadsByRef.has(threadRef)) threadRef = createThreadRef()

  trackedThread.threadId = tid
  trackedThread.threadRef = threadRef
  threadsByRef.set(threadRef, trackedThread)
  return trackedThread
}

export function isTrackedThread(thread: vscode.CommentThread): thread is TrackedCommentThread {
  const candidate = thread as Partial<TrackedCommentThread>
  return (
    thread.range !== undefined &&
    typeof candidate.threadId === 'number' &&
    typeof candidate.threadRef === 'string' &&
    threadsByRef.get(candidate.threadRef) === thread
  )
}

export function requireTrackedThread(thread: vscode.CommentThread): TrackedCommentThread {
  if (!isTrackedThread(thread)) {
    throw new Error('Crit thread is not tracked.')
  }
  return thread
}

export function findThreadByRef(threadRef: unknown): TrackedCommentThread | undefined {
  return typeof threadRef === 'string' ? threadsByRef.get(threadRef) : undefined
}

export function untrackThread(thread: TrackedCommentThread): void {
  threadsByRef.delete(thread.threadRef)
}

export function findThreadForComment(commentId: number): TrackedCommentThread | undefined {
  for (const thread of threadsByRef.values()) {
    if (thread.comments.some((c) => (c as ReviewComment).id === commentId)) {
      return thread
    }
  }
  return undefined
}

export function clearThreads(): void {
  for (const thread of threadsByRef.values()) thread.dispose()
  threadsByRef.clear()
  nextThreadId = 1
  nextCommentId = 1
}

// --------------- Thread State ---------------

export function resolveThread(thread: vscode.CommentThread): void {
  thread.label = '✅ Resolved'
  thread.contextValue = 'resolved'
  // Drives the Comments panel's Show Resolved / Show Unresolved filter.
  thread.state = vscode.CommentThreadState.Resolved
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed
}

export function unresolveThread(thread: vscode.CommentThread): void {
  thread.label = 'Open'
  thread.contextValue = 'open'
  thread.state = vscode.CommentThreadState.Unresolved
  thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
}

export function isResolved(thread: vscode.CommentThread): boolean {
  return thread.contextValue === 'resolved'
}

export function openThreads(): TrackedCommentThread[] {
  return [...threadsByRef.values()].filter((thread) => !isResolved(thread))
}

export function commentText(comment: vscode.Comment): string {
  return typeof comment.body === 'string' ? comment.body : comment.body.value
}

/**
 * Short, human-readable label for a thread (R1, R2, …).
 *
 * This is a display/prompt affordance only — never an address. The wire
 * protocol keys on `threadRef`, because `threadId` is a per-branch sequence
 * and is reused across branches. Renumbering labels must stay harmless.
 */
export function threadLabel(thread: TrackedCommentThread): string {
  return `R${thread.threadId}`
}

export function diagnosticMessage(thread: vscode.CommentThread): string {
  const userMessages = thread.comments.filter((comment) => (comment as ReviewComment).role === 'user').map(commentText)
  if (userMessages.length > 0) return userMessages.join('\n\n')
  return thread.comments[0] ? commentText(thread.comments[0]) : 'Review comment'
}

// --------------- Refs ---------------

/** Regenerated on every activation; identifies this window to the MCP server. */
const sessionRef = createSessionRef()

export function getSessionRef(): string {
  return sessionRef
}

function canonicalProjectIdentity(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
  const ownerUri =
    workspaceFolder?.uri ??
    (uri.scheme === 'file'
      ? vscode.Uri.file(path.dirname(uri.fsPath))
      : uri.with({ path: path.posix.dirname(uri.path), query: '', fragment: '' }))

  if (ownerUri.scheme === 'file') {
    try {
      return vscode.Uri.file(fs.realpathSync.native(ownerUri.fsPath)).toString(true)
    } catch {
      return vscode.Uri.file(path.resolve(ownerUri.fsPath)).toString(true)
    }
  }

  return ownerUri.toString(true)
}

/**
 * `projectRef` for the project owning `uri`, memoized per owner.
 *
 * Deriving one costs a `realpathSync` plus a SHA-256, and it is derived once
 * per thread on every diagnostic refresh — which now runs after every document
 * edit. The inputs are stable for the life of the window: a workspace folder's
 * real path does not change while it is open, and a thread's URI never changes.
 * The cache is cleared when the folder set does.
 */
const projectRefCache = new Map<string, string>()

export function projectRefFor(uri: vscode.Uri): string {
  const ownerKey = (vscode.workspace.getWorkspaceFolder(uri)?.uri ?? uri).toString(true)
  let projectRef = projectRefCache.get(ownerKey)
  if (projectRef === undefined) {
    projectRef = createProjectRef(canonicalProjectIdentity(uri))
    projectRefCache.set(ownerKey, projectRef)
  }
  return projectRef
}

export function clearProjectRefCache(): void {
  projectRefCache.clear()
}

export function diagnosticCode(thread: TrackedCommentThread): string {
  return encodeDiagnosticMetadata({
    version: CRIT_DIAGNOSTIC_VERSION,
    sessionRef,
    projectRef: projectRefFor(thread.uri),
    threadRef: thread.threadRef,
  })
}

/**
 * The code addressing this window and the project owning `uri`, with no thread.
 *
 * What a review request is handed: the agent is being asked to create the
 * threads, so there is no thread to name yet.
 */
export function projectCode(uri: vscode.Uri): string {
  return encodeDiagnosticMetadata({
    version: CRIT_DIAGNOSTIC_VERSION,
    sessionRef,
    projectRef: projectRefFor(uri),
  })
}

/**
 * Local workspace folders belonging to `projectRef`.
 *
 * The search space for a file path an agent sends. Non-`file` folders are
 * excluded because a comment has to be anchored at a real path on this machine.
 */
export function projectFolderPaths(projectRef: string): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file' && projectRefFor(folder.uri) === projectRef)
    .map((folder) => folder.uri.fsPath)
}

// --------------- Serialization ---------------

export function serializeState(includeThread: (thread: TrackedCommentThread) => boolean = () => true): SerializedState {
  const threads: SerializedThread[] = []
  for (const thread of threadsByRef.values()) {
    if (!includeThread(thread)) continue
    threads.push({
      id: thread.threadId,
      threadRef: thread.threadRef,
      uri: thread.uri.toString(),
      startLine: thread.range.start.line,
      endLine: thread.range.end.line,
      status: isResolved(thread) ? 'resolved' : 'open',
      comments: thread.comments.map((c) => {
        const rc = c as ReviewComment
        return {
          id: rc.id,
          role: rc.role,
          body: commentText(rc),
          timestamp: rc.createdAt,
        }
      }),
    })
  }
  return { version: STATE_VERSION, nextThreadId, nextCommentId, threads }
}

/** Recreate threads from persisted state onto `controller`. */
export function restoreState(controller: vscode.CommentController, data: SerializedState): void {
  nextThreadId = data.nextThreadId || 1
  nextCommentId = data.nextCommentId || 1

  for (const st of data.threads) {
    const uri = vscode.Uri.parse(st.uri)
    const range = new vscode.Range(st.startLine, 0, st.endLine, 0)
    const thread = controller.createCommentThread(uri, range, [])
    thread.comments = st.comments.map(
      (sc) => new ReviewComment(sc.body, sc.role, sc.id, sc.timestamp || new Date().toISOString()),
    )
    thread.canReply = true
    if (st.status === 'resolved') resolveThread(thread)
    else unresolveThread(thread)
    trackThread(thread, st.id, st.threadRef)
  }
}
