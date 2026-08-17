import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { z } from 'zod'
import { isProcessAlive } from './process-liveness'

/**
 * Discovery of Claude Code sessions running on this machine.
 *
 * Claude Code's cross-session messaging binds an "inbox socket" per session and
 * registers each session in a file on disk:
 * https://code.claude.com/docs/en/cross-session-messaging
 */

const sessionDescriptorSchema = z.object({
  /** OS process id. Also the descriptor's file name. */
  pid: z.number().int().positive(),
  /** Stable conversation id; survives resume. */
  sessionId: z.string().min(1),
  /** Directory the session runs in. */
  cwd: z.string().min(1),
  /** How the session was launched, e.g. `cli` or `claude-vscode`. */
  entrypoint: z.string().min(1),
  /** Unix socket accepting cross-session messages for this session. */
  messagingSocketPath: z.string().min(1),
  /** Epoch milliseconds the session started; orders duplicates. */
  startedAt: z.number().finite(),
  /** Display name — the address cross-session messaging uses. */
  name: z.string().min(1).optional().catch(undefined),
})

/**
 * A running Claude Code session that can receive cross-session messages. `cwd`
 * is resolved through symlinks; every other field is as written on disk.
 */
export type ClaudeSession = z.infer<typeof sessionDescriptorSchema>

export interface SessionLookupOptions {
  /** Registry directory. Overridable so tests run against fixtures. */
  registryDir?: string
  /** Liveness probe. Overridable so tests avoid real processes. */
  isProcessAlive?: (pid: number) => boolean
  /** Keep only sessions launched this way, e.g. `claude-vscode`. */
  entrypoint?: string
  /** Drop this session — used to stop a session messaging itself. */
  excludeSessionId?: string
}

/**
 * Every live, messageable session, newest first.
 *
 * A session is included only when its descriptor parses, its process is alive,
 * and its inbox socket still exists. Sessions started in bare mode bind no
 * socket and are absent by design.
 */
export function listClaudeSessions(options: SessionLookupOptions = {}): ClaudeSession[] {
  const dir = options.registryDir ?? sessionRegistryDir()
  const alive = options.isProcessAlive ?? isProcessAlive

  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }

  const sessions: ClaudeSession[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue

    const session = readSessionDescriptor(path.join(dir, entry))
    if (!session) continue
    if (options.entrypoint && session.entrypoint !== options.entrypoint) continue
    if (options.excludeSessionId && session.sessionId === options.excludeSessionId) continue
    if (!alive(session.pid)) continue
    if (!fs.existsSync(session.messagingSocketPath)) continue

    sessions.push(session)
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * The session running in `workspacePath`, or undefined.
 *
 * Resuming a conversation leaves two live processes sharing one `sessionId`, so
 * results are de-duplicated by `sessionId` keeping the most recently started —
 * that is the process actually serving the conversation.
 */
export function findSessionForWorkspace(
  workspacePath: string,
  options: SessionLookupOptions = {},
): ClaudeSession | undefined {
  const target = canonicalPath(workspacePath)
  if (!target) return undefined

  const seen = new Set<string>()
  for (const session of listClaudeSessions(options)) {
    if (session.cwd !== target) continue
    if (seen.has(session.sessionId)) continue
    seen.add(session.sessionId)
    return session
  }
  return undefined
}

/**
 * Registry directory. `CLAUDE_CONFIG_DIR` relocates Claude Code's whole config
 * tree, so honour it rather than assuming `~/.claude`.
 */
export function sessionRegistryDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'sessions')
}

function readSessionDescriptor(file: string): ClaudeSession | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return undefined
  }

  const result = sessionDescriptorSchema.safeParse(parsed)
  if (!result.success) return undefined

  const cwd = canonicalPath(result.data.cwd)
  if (!cwd) return undefined

  return { ...result.data, cwd }
}

/**
 * Resolve a path for comparison: through symlinks (macOS reports `/tmp` as
 * `/private/tmp`) and NFC-normalised, since a path carrying accents can reach
 * us decomposed from one source and composed from another.
 */
function canonicalPath(value: string): string | undefined {
  if (!value) return undefined
  try {
    return fs.realpathSync.native(value).normalize('NFC')
  } catch {
    // The directory may have been removed while the session still runs;
    // fall back to a lexical resolve so the session stays addressable.
    return path.resolve(value).normalize('NFC')
  }
}
