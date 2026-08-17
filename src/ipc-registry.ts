import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { z } from 'zod'
import { isProcessAlive } from './process-liveness'

/**
 * On-disk registry of running Crit IPC servers.
 *
 * Each VS Code window writes one descriptor naming the loopback port its IPC
 * server listens on; the MCP server reads the descriptor named by a diagnostic
 * code to find the window that owns that comment. Descriptors are keyed by
 * `sessionRef`, which is regenerated on every activation, so a window that dies
 * without disposing its subscriptions leaves a file behind forever.
 *
 * Two things follow from that, and this module owns both: the registry is swept
 * on activation, and a descriptor's `pid` is checked for liveness before it is
 * trusted as a route. The pid check is the load-bearing one — sweeping alone
 * still leaves a window in which a crashed instance's port has been recycled by
 * an unrelated process.
 */

export const IPC_PROTOCOL_VERSION = 1

const instanceDescriptorSchema = z.object({
  protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
  sessionRef: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
})

export type IpcInstanceDescriptor = z.infer<typeof instanceDescriptorSchema>

/** Abandoned temp file from a write that crashed between create and rename. */
const TEMP_FILE_TTL_MS = 60 * 60 * 1000

/**
 * Grace period before an unreadable descriptor is removed. A descriptor that
 * fails to parse is far more likely to be another window's in-flight write than
 * real garbage, so it is left alone until it is old enough that no write could
 * still be in progress.
 */
const UNREADABLE_FILE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Where descriptors live.
 *
 * Deliberately not the extension's `globalStorageUri`: the reader is the MCP
 * server, a plain Node process spawned by the agent's client with no VS Code
 * API and no way to derive that path — it varies by installation, platform, and
 * portable-mode setup. `os.tmpdir()` is the one location both processes can
 * agree on without a handshake, and nothing here outlives the machine's uptime.
 */
export function ipcRegistryDir(): string {
  return path.join(os.tmpdir(), 'crit', 'instances')
}

export function ipcDescriptorPath(sessionRef: string, registryDir = ipcRegistryDir()): string {
  return path.join(registryDir, `${sessionRef}.json`)
}

/**
 * Delete descriptors whose owning process is gone, plus abandoned temp files.
 *
 * Best-effort throughout: another window may be writing or unlinking the same
 * files concurrently, and losing that race only means the entry survives until
 * the next sweep. Returns the number of files removed, for logging.
 */
export function sweepIpcRegistry(registryDir = ipcRegistryDir()): number {
  let entries: string[]
  try {
    entries = fs.readdirSync(registryDir)
  } catch {
    return 0
  }

  const now = Date.now()
  let removed = 0
  for (const entry of entries) {
    const entryPath = path.join(registryDir, entry)
    try {
      if (isTempName(entry)) {
        if (olderThan(entryPath, TEMP_FILE_TTL_MS, now) && unlink(entryPath)) removed++
        continue
      }
      if (!entry.endsWith('.json')) continue

      const descriptor = readDescriptor(entryPath)
      if (!descriptor) {
        if (olderThan(entryPath, UNREADABLE_FILE_TTL_MS, now) && unlink(entryPath)) removed++
        continue
      }
      if (!isProcessAlive(descriptor.pid) && unlink(entryPath)) removed++
    } catch {
      // Racing with another window; leave the entry for the next sweep.
    }
  }
  return removed
}

/** Descriptor file name written before the atomic rename into place. */
export function ipcTempDescriptorName(sessionRef: string, pid: number, now = Date.now()): string {
  return `.${sessionRef}.${pid}.${now}.tmp`
}

function isTempName(entry: string): boolean {
  return entry.startsWith('.') && entry.endsWith('.tmp')
}

/**
 * Parse a descriptor, or undefined when the file is unreadable or is not a
 * descriptor this protocol version recognises.
 */
export function readDescriptor(descriptorPath: string): IpcInstanceDescriptor | undefined {
  const parsed = parseDescriptorFile(descriptorPath)
  return 'descriptor' in parsed ? parsed.descriptor : undefined
}

/**
 * The descriptor of the live instance owning `sessionRef`.
 *
 * Throws instead of returning undefined: every caller is answering an agent
 * that named this session, and which failure happened — never registered, left
 * behind by a crash, written by a newer protocol — is exactly what that agent
 * has to be told in order to recover.
 */
export function resolveLiveInstance(sessionRef: string, registryDir = ipcRegistryDir()): IpcInstanceDescriptor {
  const descriptorPath = ipcDescriptorPath(sessionRef, registryDir)
  const parsed = parseDescriptorFile(descriptorPath)

  if ('missing' in parsed) {
    throw new Error(
      `Missing or stale Crit instance descriptor for session ${sessionRef}. ` +
        'Ensure that the matching VS Code window is running, then copy a current diagnostic code and try again.',
    )
  }
  if ('unreadable' in parsed) {
    throw new Error(`Could not read Crit instance descriptor ${descriptorPath}: ${parsed.unreadable}`)
  }
  if ('invalid' in parsed) {
    throw malformedDescriptorError(descriptorPath, parsed.invalid)
  }
  if (parsed.descriptor.sessionRef !== sessionRef) {
    throw malformedDescriptorError(descriptorPath, `sessionRef must match ${sessionRef}`)
  }

  // A window that crashed leaves its descriptor behind, and the loopback port
  // it names is then free for any other process to bind. Routing a mutation
  // on the strength of the file alone can therefore POST /resolve at an
  // unrelated server, so the owning process must still be alive.
  if (!isProcessAlive(parsed.descriptor.pid)) {
    throw new Error(
      `Stale Crit instance descriptor for session ${sessionRef}: ` +
        `the VS Code window that registered it (process ${parsed.descriptor.pid}) is no longer running. ` +
        'Copy a current diagnostic code from a running window and try again.',
    )
  }

  return parsed.descriptor
}

type ParsedDescriptor =
  { descriptor: IpcInstanceDescriptor } | { missing: true } | { unreadable: string } | { invalid: string }

function parseDescriptorFile(descriptorPath: string): ParsedDescriptor {
  let text: string
  try {
    text = fs.readFileSync(descriptorPath, 'utf-8')
  } catch (error: unknown) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT') return { missing: true }
    return { unreadable: error instanceof Error ? error.message : String(error) }
  }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error: unknown) {
    return { invalid: `invalid JSON (${error instanceof Error ? error.message : String(error)})` }
  }

  const result = instanceDescriptorSchema.safeParse(json)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'descriptor'}: ${issue.message}`)
      .join('; ')
    return { invalid: detail }
  }
  return { descriptor: result.data }
}

function malformedDescriptorError(descriptorPath: string, detail: string): Error {
  return new Error(
    `Malformed Crit instance descriptor ${descriptorPath}: ${detail}. ` +
      'Reload the matching VS Code window to recreate it.',
  )
}

function olderThan(filePath: string, ttlMs: number, now: number): boolean {
  try {
    return now - fs.statSync(filePath).mtimeMs > ttlMs
  } catch {
    return false
  }
}

function unlink(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}
