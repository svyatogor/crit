import * as http from 'http'
import * as vscode from 'vscode'
import { z } from 'zod'
import { resolveCommentFile, toDocumentLine } from './comment-targets'
// `IpcInstanceDescriptor` is imported as a type so that Node's type stripping
// leaves no runtime import of a name `ipc-registry` does not export — that is
// what lets the tests require this module directly.
import type { IpcInstanceDescriptor } from './ipc-registry'
import {
  IPC_PROTOCOL_VERSION,
  ipcRegistryDir,
  removeInstanceDescriptor,
  sweepIpcRegistry,
  writeInstanceDescriptor,
} from './ipc-registry'
import {
  createReviewThread,
  diagnosticCode,
  findThreadByRef,
  localProjects,
  projectFolderPaths,
  projectRefFor,
  resolveThread,
  ReviewComment,
  serializeState,
  threadsByRef,
  threadsChanged,
  unresolveThread,
  untrackThread,
} from './review-threads'

/**
 * Loopback HTTP server that lets the MCP server read and mutate this window's
 * review comments, plus the registry entry that makes the window findable.
 */

/**
 * This window's presence in the registry: one descriptor per project it holds,
 * all naming the same port.
 *
 * Held rather than written once because the set is not fixed for the life of the
 * activation. Adding or removing a workspace folder changes which projects this
 * window answers for, and gaining focus changes which window a project belongs
 * to when two of them hold it — so the descriptors are republished, and the ones
 * for projects the window no longer holds are withdrawn.
 */
interface IpcRegistration {
  port: number
  startedAt: string
  lastFocusedAt: string
  /** Published descriptors by projectRef, so dispose withdraws exactly these. */
  published: Map<string, IpcInstanceDescriptor>
  log: vscode.OutputChannel
}

function registerIpcInstance(port: number, log: vscode.OutputChannel): IpcRegistration {
  const startedAt = new Date().toISOString()
  // Descriptors are removed only on clean dispose, so every crashed window
  // leaks its set. Sweeping here bounds the registry to roughly the projects
  // open in live windows.
  const removed = sweepIpcRegistry()
  if (removed > 0) log.appendLine(`[Crit] Swept ${removed} stale IPC descriptor(s)`)

  const registration: IpcRegistration = {
    port,
    startedAt,
    lastFocusedAt: startedAt,
    published: new Map(),
    log,
  }
  // A single folder failing to publish leaves the others routable, so
  // `syncIpcRegistration` only logs it. Publishing *nothing* while holding
  // folders is different: the window is unreachable, and starting a server no
  // agent can find is worse than failing where the caller logs it.
  const held = syncIpcRegistration(registration)
  if (held > 0 && registration.published.size === 0) {
    throw new Error(`Could not publish any Crit IPC descriptor in ${ipcRegistryDir()}`)
  }
  return registration
}

/**
 * Bring the registry in line with the projects this window holds now.
 *
 * Writes are unconditional rather than diffed: a descriptor is a few hundred
 * bytes written through a temp file and a rename, and the alternative — deciding
 * whether the copy on disk is still ours — is the reasoning that atomic replace
 * exists to avoid.
 *
 * Returns how many projects this window holds, which is not the same as how many
 * were published.
 */
function syncIpcRegistration(registration: IpcRegistration): number {
  const projects = localProjects()

  for (const { projectRef, projectPath } of projects) {
    const descriptor: IpcInstanceDescriptor = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      projectRef,
      projectPath,
      port: registration.port,
      pid: process.pid,
      startedAt: registration.startedAt,
      lastFocusedAt: registration.lastFocusedAt,
    }
    try {
      writeInstanceDescriptor(descriptor)
      registration.published.set(projectRef, descriptor)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      registration.log.appendLine(`[Crit] Could not publish IPC descriptor for project ${projectRef}: ${detail}`)
    }
  }

  const held = new Set(projects.map((project) => project.projectRef))
  for (const [projectRef, descriptor] of registration.published) {
    if (held.has(projectRef)) continue
    removeInstanceDescriptor(descriptor)
    registration.published.delete(projectRef)
  }
  return projects.length
}

function unregisterIpcInstance(registration: IpcRegistration): void {
  for (const descriptor of registration.published.values()) removeInstanceDescriptor(descriptor)
  registration.published.clear()
}

/**
 * The body `POST /comment` accepts. Lines count from 1, as `/comments` reports
 * them and as every agent reads a file.
 *
 * A schema rather than a run of hand-written checks, because the caller is a
 * language model: zod collects every problem in one pass, so an agent that got
 * both the path and the line wrong is told both at once instead of learning one
 * per round trip. The MCP server declares the same bounds on its tool
 * parameters, so a client arriving through it is already well-formed — this is
 * the guard for anything speaking to the loopback port directly, which is also
 * why `file` is checked again against the project's folders below.
 */
export const addCommentRequestSchema = z.object({
  projectRef: z.string().min(1, 'must be the projectRef from the code addressing this project'),
  file: z.string().trim().min(1, 'must be a path to a file in that project'),
  startLine: z.number().int('must be a whole line number').min(1, 'must count from 1, not 0'),
  endLine: z.number().int('must be a whole line number').min(1, 'must count from 1, not 0').optional(),
  text: z.string().trim().min(1, 'must not be empty'),
})

/** What the agent is told about the comment it just left. */
interface CreatedComment {
  ok: true
  threadRef: string
  /** The new thread's own code, so a later reply needs no fresh listing. */
  code: string
  file: string
  startLine: number
}

interface AddCommentFailure {
  status: number
  error: string
}

/** Create the thread an agent asked for, or say why it could not be created. */
async function addComment(body: unknown): Promise<{ created: CreatedComment } | AddCommentFailure> {
  const parsed = addCommentRequestSchema.safeParse(body)
  if (!parsed.success) {
    return { status: 400, error: `Could not add the review comment — ${issues(parsed.error)}` }
  }
  const { projectRef, file, startLine, endLine, text } = parsed.data

  const resolved = resolveCommentFile(file, projectFolderPaths(projectRef))
  if ('error' in resolved) return { status: 404, error: resolved.error }

  const uri = vscode.Uri.file(resolved.path)
  let document: vscode.TextDocument
  try {
    document = await vscode.workspace.openTextDocument(uri)
  } catch (error: any) {
    return { status: 404, error: `Could not open ${resolved.path}: ${error.message}` }
  }

  const thread = createReviewThread({
    uri,
    startLine: toDocumentLine(startLine, document.lineCount),
    endLine: endLine === undefined ? undefined : toDocumentLine(endLine, document.lineCount),
    text,
    role: 'agent',
  })
  threadsChanged()

  return {
    created: {
      ok: true,
      threadRef: thread.threadRef,
      code: diagnosticCode(thread),
      file: vscode.workspace.asRelativePath(uri),
      // Echoed back because it may have been clamped to the file's length.
      startLine: thread.range.start.line + 1,
    },
  }
}

/** Every problem with a request, in one line, named field by field. */
function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')
}

function threadNotFoundMessage(threadRef: unknown): string {
  if (typeof threadRef !== 'string' || threadRef.length === 0) {
    return 'Thread not found: request must include a non-empty string threadRef.'
  }
  return (
    `Thread with threadRef "${threadRef}" not found in this window. It may have been deleted, ` +
    'or it may belong to another branch — comments are kept per branch.'
  )
}

export function startIpcServer(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<number> {
  return new Promise((resolve, reject) => {
    let registration: IpcRegistration | undefined
    const server = http.createServer(async (req, res) => {
      // CORS headers for local use
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Access-Control-Allow-Origin', 'localhost')

      const url = new URL(req.url || '/', `http://localhost`)
      const method = req.method || 'GET'

      try {
        if (method === 'GET' && url.pathname === '/comments') {
          const projectRef = url.searchParams.get('projectRef')
          const result = serializeState(
            projectRef === null ? undefined : (thread) => projectRefFor(thread.uri) === projectRef,
          )
          res.writeHead(200)
          res.end(JSON.stringify(result))
        } else if (method === 'POST' && url.pathname === '/comment') {
          const result = await addComment(JSON.parse(await readBody(req)))
          if ('error' in result) {
            res.writeHead(result.status)
            res.end(JSON.stringify({ error: result.error }))
            return
          }
          res.writeHead(200)
          res.end(JSON.stringify(result.created))
        } else if (method === 'POST' && url.pathname === '/reply') {
          const { threadRef, text } = JSON.parse(await readBody(req))
          const thread = findThreadByRef(threadRef)
          if (!thread) {
            res.writeHead(404)
            res.end(JSON.stringify({ error: threadNotFoundMessage(threadRef) }))
            return
          }
          const reply = new ReviewComment(text, 'agent')
          thread.comments = [...thread.comments, reply]
          thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
          threadsChanged()
          res.writeHead(200)
          res.end(JSON.stringify({ ok: true, commentId: reply.id }))
        } else if (method === 'POST' && url.pathname === '/resolve') {
          const { threadRef } = JSON.parse(await readBody(req))
          const thread = findThreadByRef(threadRef)
          if (!thread) {
            res.writeHead(404)
            res.end(JSON.stringify({ error: threadNotFoundMessage(threadRef) }))
            return
          }
          resolveThread(thread)
          threadsChanged()
          res.writeHead(200)
          res.end(JSON.stringify({ ok: true }))
        } else if (method === 'POST' && url.pathname === '/unresolve') {
          const { threadRef } = JSON.parse(await readBody(req))
          const thread = findThreadByRef(threadRef)
          if (!thread) {
            res.writeHead(404)
            res.end(JSON.stringify({ error: threadNotFoundMessage(threadRef) }))
            return
          }
          unresolveThread(thread)
          threadsChanged()
          res.writeHead(200)
          res.end(JSON.stringify({ ok: true }))
        } else if (method === 'POST' && url.pathname === '/delete') {
          const { threadRef } = JSON.parse(await readBody(req))
          const thread = findThreadByRef(threadRef)
          if (!thread) {
            res.writeHead(404)
            res.end(JSON.stringify({ error: threadNotFoundMessage(threadRef) }))
            return
          }
          untrackThread(thread)
          thread.dispose()
          threadsChanged()
          res.writeHead(200)
          res.end(JSON.stringify({ ok: true }))
        } else if (method === 'GET' && url.pathname === '/health') {
          res.writeHead(200)
          res.end(
            JSON.stringify({
              ok: true,
              comments: threadsByRef.size,
              projects: [...(registration?.published.keys() ?? [])],
            }),
          )
        } else {
          res.writeHead(404)
          res.end(JSON.stringify({ error: 'Not found' }))
        }
      } catch (err: any) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: err.message }))
      }
    })

    // Listen on random available port
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr !== 'string') {
        try {
          const started = registerIpcInstance(addr.port, log)
          registration = started

          // Which projects this window answers for, and which window a project
          // belongs to when several hold it, both change while the window is
          // open — so neither is decided once at activation.
          context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => syncIpcRegistration(started)),
            vscode.window.onDidChangeWindowState((state) => {
              if (!state.focused) return
              started.lastFocusedAt = new Date().toISOString()
              syncIpcRegistration(started)
            }),
          )
          resolve(addr.port)
        } catch (error) {
          server.close()
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      } else {
        server.close()
        reject(new Error('Failed to get server address'))
      }
    })

    server.on('error', reject)
    context.subscriptions.push({
      dispose: () => {
        server.close()
        if (registration) unregisterIpcInstance(registration)
      },
    })
  })
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}
