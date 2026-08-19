import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { z } from 'zod'
import { isProcessAlive } from './process-liveness'

/**
 * On-disk registry of running Crit IPC servers, indexed by project.
 *
 * A Crit code names a project, never a window (see `diagnostic-metadata`), so
 * the question this module answers is "which live window holds this project
 * *now*". The `projectRef` is therefore the lookup key rather than a field: each
 * window writes one descriptor per workspace folder it holds, at
 * `projects/<projectRef>/<pid>.json`, and a reader resolving a code needs a
 * single directory listing — no fan-out over every window, no round trips to
 * ports that may since have been recycled.
 *
 * A window that dies without disposing its subscriptions leaves its descriptors
 * behind, so this module sweeps the registry on activation and checks a
 * descriptor's `pid` for liveness before trusting it as a route. That is the
 * whole of the staleness defence, and it is enough: a recycled port would need
 * the dead pid to have been reused by a live process that also happens to be
 * listening on it, and even then the window endpoints validate `projectRef`
 * against their own folders and address threads by refs they hold.
 */

export const IPC_PROTOCOL_VERSION = 2

const instanceDescriptorSchema = z.object({
  protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
  projectRef: z.string().min(1),
  /** The folder `projectRef` hashes, so a failure can name it. */
  projectPath: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  /**
   * When the owning window last had focus, or its activation time if it has not
   * had focus since. The tiebreak when one project is open in several windows:
   * the window the user was last in is the one that "has" the project.
   */
  lastFocusedAt: z.string().min(1),
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
  return path.join(os.tmpdir(), 'crit', 'projects')
}

/** The directory holding every live window's descriptor for one project. */
export function projectRegistryDir(projectRef: string, registryDir = ipcRegistryDir()): string {
  return path.join(registryDir, projectRef)
}

export function ipcDescriptorPath(projectRef: string, pid: number, registryDir = ipcRegistryDir()): string {
  return path.join(projectRegistryDir(projectRef, registryDir), `${pid}.json`)
}

/**
 * Publish `descriptor`, replacing this window's previous one for that project.
 *
 * Written to a temp name and renamed, so a reader never sees half a file, and
 * so republishing on focus change cannot leave a project momentarily
 * unroutable.
 */
export function writeInstanceDescriptor(descriptor: IpcInstanceDescriptor, registryDir = ipcRegistryDir()): string {
  const projectDir = projectRegistryDir(descriptor.projectRef, registryDir)
  const descriptorPath = path.join(projectDir, `${descriptor.pid}.json`)
  // One temp name per process, reused on every republish, and matched by
  // `isTempName` so the sweep ages an abandoned one out by mtime.
  const tempPath = path.join(projectDir, `.${descriptor.pid}.tmp`)

  fs.mkdirSync(projectDir, { recursive: true })
  try {
    // Plain create-or-truncate: the name carries our pid, so no other process
    // writes it, and every write here is synchronous, so this window cannot
    // race itself.
    fs.writeFileSync(tempPath, JSON.stringify(descriptor), 'utf-8')
    fs.renameSync(tempPath, descriptorPath)
  } catch (error) {
    try {
      fs.unlinkSync(tempPath)
    } catch {
      /* best-effort cleanup */
    }
    throw error
  }
  return descriptorPath
}

/**
 * Withdraw a descriptor this window published.
 *
 * The file is removed only while it still holds what we wrote — matched on the
 * activation's own `startedAt` and port: a window restarted fast enough to have
 * republished under the same pid must not have its live descriptor deleted by
 * the outgoing activation's dispose.
 */
export function removeInstanceDescriptor(descriptor: IpcInstanceDescriptor, registryDir = ipcRegistryDir()): void {
  const descriptorPath = ipcDescriptorPath(descriptor.projectRef, descriptor.pid, registryDir)
  try {
    const current = readDescriptor(descriptorPath)
    if (current?.startedAt !== descriptor.startedAt || current.port !== descriptor.port) return
    fs.unlinkSync(descriptorPath)
  } catch {
    // Missing, unreadable, or replaced descriptors must not be removed.
    return
  }
  removeIfEmpty(projectRegistryDir(descriptor.projectRef, registryDir))
}

/**
 * Delete descriptors whose owning process is gone, plus abandoned temp files
 * and the project directories left empty by both.
 *
 * Best-effort throughout: another window may be writing or unlinking the same
 * files concurrently, and losing that race only means the entry survives until
 * the next sweep. Returns the number of files removed, for logging.
 */
export function sweepIpcRegistry(registryDir = ipcRegistryDir()): number {
  let projectRefs: string[]
  try {
    projectRefs = fs
      .readdirSync(registryDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return 0
  }

  const now = Date.now()
  let removed = 0
  for (const projectRef of projectRefs) {
    const projectDir = path.join(registryDir, projectRef)
    removed += sweepProjectDir(projectDir, now)
    removeIfEmpty(projectDir)
  }
  return removed
}

function sweepProjectDir(projectDir: string, now: number): number {
  let entries: string[]
  try {
    entries = fs.readdirSync(projectDir)
  } catch {
    return 0
  }

  let removed = 0
  for (const entry of entries) {
    const entryPath = path.join(projectDir, entry)
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

function isTempName(entry: string): boolean {
  return entry.startsWith('.') && entry.endsWith('.tmp')
}

/**
 * Parse a descriptor, or undefined when the file is missing, unreadable, or is
 * not a descriptor this protocol version recognises.
 *
 * The reasons are deliberately not distinguished: no caller can act on them
 * differently, since a descriptor that cannot be parsed cannot be routed to —
 * which from the agent's side is the same as a window that is not there. The
 * sweep ages out a file that never becomes readable.
 */
export function readDescriptor(descriptorPath: string): IpcInstanceDescriptor | undefined {
  let json: unknown
  try {
    json = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8'))
  } catch {
    return undefined
  }
  const parsed = instanceDescriptorSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

/**
 * Every live window holding `projectRef`, the one that had focus most recently
 * first.
 *
 * More than one is unusual but legal — the same folder opened twice, or shared
 * between a single-root and a multi-root workspace — so the order is the policy
 * for which of them a code reaches, and it is "wherever the user was last".
 * Activation time breaks a tie between windows that have never been focused,
 * and pid breaks a tie between those.
 */
export function listLiveInstances(projectRef: string, registryDir = ipcRegistryDir()): IpcInstanceDescriptor[] {
  return scanProject(projectRef, registryDir).live
}

/**
 * The window to route a code for `projectRef` to.
 *
 * Throws instead of returning undefined: every caller is answering an agent that
 * named this project, so the failure is the message that agent needs — which
 * folder is missing, or that nothing on disk has ever heard of this ref.
 */
export function resolveLiveInstance(projectRef: string, registryDir = ipcRegistryDir()): IpcInstanceDescriptor {
  const scan = scanProject(projectRef, registryDir)
  const [instance] = scan.live
  if (instance) return instance

  // Naming the folder is the point: `projectRef` is a hash, and an agent can act
  // on a path — reopen it, or tell the user which window to bring back.
  if (scan.projectPath !== undefined) {
    throw new Error(
      `No running VS Code window has ${scan.projectPath} open. Reopen the project in VS Code and try again.`,
    )
  }
  throw new Error(
    `No running VS Code window has the project this Crit code names (${projectRef}). ` +
      'Open the project in a VS Code window with the Crit extension active, then try again.',
  )
}

interface ProjectScan {
  live: IpcInstanceDescriptor[]
  /** The folder this ref hashes, from any descriptor that named it. */
  projectPath: string | undefined
}

function scanProject(projectRef: string, registryDir: string): ProjectScan {
  const projectDir = projectRegistryDir(projectRef, registryDir)
  const descriptors = descriptorEntries(projectDir)
    .flatMap((entry) => readDescriptor(path.join(projectDir, entry)) ?? [])
    // A descriptor filed under the wrong project would route a mutation into an
    // unrelated workspace, which is worse than not routing it at all.
    .filter((descriptor) => descriptor.projectRef === projectRef)

  return {
    live: descriptors.filter((descriptor) => isProcessAlive(descriptor.pid)).sort(byRecentFocus),
    // Every descriptor under one ref names the same folder, so the first will
    // do — including one left behind by a window that has since exited, which
    // is the case worth describing when nothing is live.
    projectPath: descriptors[0]?.projectPath,
  }
}

/** Descriptor file names in a project directory, or none when it has none. */
function descriptorEntries(projectDir: string): string[] {
  try {
    return fs.readdirSync(projectDir).filter((entry) => !isTempName(entry) && entry.endsWith('.json'))
  } catch {
    return []
  }
}

function byRecentFocus(a: IpcInstanceDescriptor, b: IpcInstanceDescriptor): number {
  return b.lastFocusedAt.localeCompare(a.lastFocusedAt) || b.startedAt.localeCompare(a.startedAt) || a.pid - b.pid
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

/** Leaves the registry as it found it when a project has no windows left. */
function removeIfEmpty(dir: string): void {
  try {
    fs.rmdirSync(dir)
  } catch {
    // Not empty, gone already, or being written to — all fine.
  }
}
