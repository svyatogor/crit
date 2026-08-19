import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import type * as vscode from 'vscode'

/**
 * Which files the reviewer has already read, and whether that still holds.
 *
 * Two mechanisms, doing two different jobs.
 *
 * **The bucket gives isolation.** Review progress is a per-feature statement —
 * "six of nine files read" — and a branch is the feature, the same reason
 * comment threads are branch-scoped. Park a review, take a hotfix branch, come
 * back to progress that is both intact and untainted. It also bounds growth: a
 * bucket dies with its branch.
 *
 * **The hash gives freshness.** A mark records the sha256 of the content it was
 * given. When the file no longer hashes to that, the mark goes `stale` rather
 * than disappearing — the reviewer still learns "you read this, and it has
 * changed since", and the snapshot taken at mark time makes that difference a
 * real diff. Deriving staleness from content rather than a timestamp means an
 * agent's edit invalidates a mark with no watcher involved, while a formatter
 * run or a `touch` that leaves the bytes alone correctly does not.
 *
 * **Size and mtime gate the read.** They are recorded alongside the hash and
 * checked first: unmoved, the file cannot have changed, so nothing is read at
 * all. They are never the answer on their own, because both move without the
 * content moving — a branch round trip rewrites exactly the files under review,
 * and lands them back byte-identical with a fresh mtime. The gate is only ever
 * allowed to *skip work*, so a false "moved" costs one hash and a false
 * "unmoved" cannot happen.
 *
 * **Two tiers, decided by one `stat`.** A file small enough to hold in memory
 * and made of text is tracked exactly: hashed, and snapshotted so "what changed
 * since I looked" can be a real diff. Anything larger than `MAX_HASH_BYTES`, or
 * holding a NUL byte, is tracked by size and mtime alone — no read, no
 * snapshot. That mark still says reviewed or stale correctly; what it cannot
 * offer is the diff, which is why it is worth having rather than refusing to
 * track the file. Its failure mode is a false `stale` after a touch, which is
 * the safe direction: claiming *less* than the reviewer earned, never more.
 *
 * Nothing here imports `vscode` at runtime — the only use is a type — so the
 * whole model is exercisable from a plain Node test.
 */

export type ReviewState = 'unreviewed' | 'reviewed' | 'stale'

/**
 * How a mark's freshness is decided.
 *
 * `hash` is exact and carries a snapshot. `stat` is the degraded tier for files
 * too large to read or not made of text.
 */
export type ReviewTier = 'hash' | 'stat'

export interface ReviewedEntry {
  /** sha256 of the raw bytes. Absent on the `stat` tier. */
  hash?: string
  /** ISO timestamp of the mark. */
  at: string
  /** Byte size at mark time — the cheap gate, and half the `stat` tier's identity. */
  size?: number
  /** Disk mtime at mark time. Absent when the mark was taken on an unsaved buffer. */
  mtimeMs?: number
  /** Defaults to `hash`, which is what every mark written before tiers existed was. */
  tier?: ReviewTier
}

/**
 * Above this, a file is tracked by size and mtime instead of by content.
 */
export const MAX_HASH_BYTES = 5 * 1024 * 1024

/** git's own test: a NUL byte near the start means this is not text. */
const BINARY_SNIFF_BYTES = 8192

export function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

/** What can be learned about a file without reading it. */
export interface FileProbe {
  size: number
  mtimeMs: number
  /**
   * An editor is holding unsaved edits.
   *
   * The disk facts then describe bytes nobody is looking at, so the gate must
   * not be allowed to answer — marking a file reviewed and typing into it
   * without saving has to go stale, and no `stat` can see that.
   */
  dirty: boolean
}

/** One branch's marks, keyed by absolute file path. */
export type ReviewedBucket = Record<string, ReviewedEntry>

/** The `workspaceState` surface this module needs; `vscode.Memento` satisfies it. */
export interface ReviewedStorage {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): unknown
  keys(): readonly string[]
}

/** Anything with an `fsPath`, which is all this module wants from a URI. */
type PathLike = Pick<vscode.Uri, 'fsPath'>

export const BUCKET_PREFIX = 'crit.reviewed.'

/** Files under no repository at all: one bucket, no branch to scope it by. */
export const NO_REPO_BUCKET = `${BUCKET_PREFIX}_norepo`

export function bucketKey(repoRef: string | undefined, branch: string): string {
  return repoRef ? `${BUCKET_PREFIX}${repoRef}.${branch}` : NO_REPO_BUCKET
}

/**
 * Hash used for both marking and freshness checks.
 *
 * Raw bytes, with no normalization of any kind: the hash names exactly the
 * content the snapshot holds, so a mark and its baseline can never disagree
 * about what was reviewed, and two files that differ at all get two blobs.
 */
export function hashContent(content: string | Buffer): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return createHash('sha256').update(bytes).digest('hex')
}

export interface ReviewedFilesDeps {
  storage: ReviewedStorage
  /** The bucket a file belongs to — its repository's ref and current branch. */
  bucketKeyFor(uri: PathLike): string
  /** Current bytes: the unsaved editor buffer when there is one, else disk. */
  readContent(uri: PathLike): Promise<Buffer | undefined>
  /** Size, mtime and dirtiness — everything decided before a read is considered. */
  probe(uri: PathLike): Promise<FileProbe | undefined>
  /** Directory holding snapshot blobs; absent in a window with no workspace storage. */
  snapshotDir?: string
  /** Overridable so a test can drive the tier boundary without a huge fixture. */
  maxHashBytes?: number
  log?: (message: string) => void
}

export class ReviewedFiles {
  private readonly deps: ReviewedFilesDeps

  constructor(deps: ReviewedFilesDeps) {
    this.deps = deps
  }

  // --------------- Reading ---------------

  entry(uri: PathLike): ReviewedEntry | undefined {
    return this.bucket(this.deps.bucketKeyFor(uri))[uri.fsPath]
  }

  /**
   * The mark's standing against the file as it is right now.
   *
   * Ordered so the expensive step is the last resort. An unmarked file is the
   * overwhelming majority of any sizeable diff and answers with no I/O at all —
   * its content was never going to be consulted, because `unreviewed` does not
   * depend on it. Of the rest, most answer from `stat` alone. Only a file that
   * is marked *and* has moved is ever read.
   */
  async currentState(uri: PathLike): Promise<ReviewState> {
    const entry = this.entry(uri)
    if (!entry) return 'unreviewed'

    const probe = await this.deps.probe(uri)
    // Deleted, or no longer readable. A mark on it can only be stale.
    if (!probe) return 'stale'
    if (this.stillMatches(entry, probe)) return 'reviewed'

    // Nothing was hashed for this file, so the gate was the whole answer.
    if (entry.tier === 'stat') return 'stale'

    const bytes = await this.deps.readContent(uri)
    if (bytes === undefined) return 'stale'
    return hashContent(bytes) === entry.hash ? 'reviewed' : 'stale'
  }

  /**
   * Whether the gate can answer on its own.
   *
   * Deliberately conservative on every unknown: an unsaved buffer, a mark taken
   * before sizes were recorded, or a mark taken on a dirty buffer all fall
   * through to the real comparison rather than being waved past.
   */
  private stillMatches(entry: ReviewedEntry, probe: FileProbe): boolean {
    if (probe.dirty) return false
    if (entry.size === undefined || entry.mtimeMs === undefined) return false
    return entry.size === probe.size && entry.mtimeMs === probe.mtimeMs
  }

  // --------------- Marking ---------------

  /**
   * Record the file as reviewed at its current content, and keep a copy.
   *
   * The copy is what makes a stale mark useful later, so on the `hash` tier a
   * failure to write it cancels the mark rather than leaving one that cannot
   * explain itself. The `stat` tier has no copy to fail at — the mark is the
   * whole of what it promises.
   */
  async mark(uri: PathLike): Promise<ReviewedEntry | undefined> {
    const probe = await this.deps.probe(uri)
    if (!probe) return undefined
    const at = new Date().toISOString()

    // Too big to hold in memory, and far too big to keep a copy of per mark.
    if (probe.size > (this.deps.maxHashBytes ?? MAX_HASH_BYTES)) {
      return this.store(uri, { at, size: probe.size, mtimeMs: probe.mtimeMs, tier: 'stat' })
    }

    const bytes = await this.deps.readContent(uri)
    if (bytes === undefined) return undefined

    // Hashing bytes would be perfectly correct here; it is the snapshot that
    // cannot survive — a blob written as text comes back corrupted, and a diff
    // of it would be noise. Both halves degrade together, so this is one tier.
    if (looksBinary(bytes)) {
      return this.store(uri, { at, size: probe.size, mtimeMs: probe.mtimeMs, tier: 'stat' })
    }

    const hash = hashContent(bytes)
    try {
      await this.writeSnapshot(hash, bytes)
    } catch (e) {
      this.deps.log?.(`[Crit] Could not snapshot ${uri.fsPath}: ${String(e)}`)
      return undefined
    }

    // An unsaved buffer was just hashed, so the disk mtime describes different
    // bytes. Recording it would let the gate wave through a file whose editor
    // content never matched; leaving it out costs one hash on the next check.
    const disk = probe.dirty ? {} : { size: probe.size, mtimeMs: probe.mtimeMs }
    return this.store(uri, { hash, at, ...disk, tier: 'hash' })
  }

  private store(uri: PathLike, entry: ReviewedEntry): ReviewedEntry {
    const key = this.deps.bucketKeyFor(uri)
    this.deps.storage.update(key, { ...this.bucket(key), [uri.fsPath]: entry })
    return entry
  }

  unmark(uri: PathLike): void {
    const key = this.deps.bucketKeyFor(uri)
    const bucket = { ...this.bucket(key) }
    if (!(uri.fsPath in bucket)) return
    delete bucket[uri.fsPath]
    this.deps.storage.update(key, bucket)
  }

  // --------------- Renames ---------------

  /**
   * Carry a mark from one path to another, snapshot and all.
   *
   * For a rename git has already detected, where both paths are known and no
   * content needs examining. The entry moves unchanged on purpose: an exact
   * rename still hashes to its snapshot and stays `reviewed`, while a rename
   * that also edited the file goes `stale` with a snapshot to diff against,
   * which is exactly what a mark is worth keeping for.
   *
   * A mark already sitting on the destination wins — it was made against the
   * file that is actually there.
   */
  moveMark(from: PathLike, to: PathLike): boolean {
    const entry = this.entry(from)
    if (!entry || this.entry(to)) return false
    this.unmark(from)
    this.store(to, entry)
    return true
  }

  /**
   * Follow marks across a rename git did not record.
   *
   * git names both sides of a rename only once it has been staged. An unstaged
   * `mv` reaches us as a deletion plus an untracked file, and a rename of a file
   * git never tracked reaches us as nothing at all — the old path simply stops
   * being mentioned. So the old path is taken from the marks rather than from
   * git, which is the one place that knows every file the reviewer has read.
   *
   * Only an exact content match counts. A move that also edited the file is
   * indistinguishable from an unrelated new file, and guessing wrong would carry
   * someone's review onto code they never read; guessing wrong the other way
   * just asks them to tick a box again.
   *
   * Ordered so the common case is nearly free. Sizes recorded at mark time cost
   * nothing to consult, and a rename cannot change one — so a diff whose new
   * files match no mark's size settles for the price of one `stat` each, and
   * reads nothing.
   */
  async reanchorRenames(arrived: readonly PathLike[]): Promise<number> {
    const fresh = arrived.filter((uri) => !this.entry(uri))
    if (fresh.length === 0) return 0

    let moved = 0
    for (const [key, targets] of Map.groupBy(fresh, (uri) => this.deps.bucketKeyFor(uri))) {
      moved += await this.reanchorBucket(key, targets)
    }
    return moved
  }

  private async reanchorBucket(key: string, targets: readonly PathLike[]): Promise<number> {
    const marks = Object.entries(this.bucket(key)).filter(([, entry]) => entry.hash)
    if (marks.length === 0) return 0

    const sizes = new Map<string, number | undefined>()
    for (const uri of targets) sizes.set(uri.fsPath, (await this.deps.probe(uri))?.size)

    const hashes = new Map<string, string | undefined>()
    const hashOf = async (uri: PathLike): Promise<string | undefined> => {
      if (!hashes.has(uri.fsPath)) {
        const bytes = await this.deps.readContent(uri)
        hashes.set(uri.fsPath, bytes && hashContent(bytes))
      }
      return hashes.get(uri.fsPath)
    }

    let moved = 0
    const claimed = new Set<string>()
    for (const [markedPath, entry] of marks) {
      // A mark made against an unsaved buffer has no size to compare, so it
      // cannot be ruled out this cheaply and goes to the content check.
      const plausible = targets.filter(
        (uri) => !claimed.has(uri.fsPath) && (entry.size === undefined || sizes.get(uri.fsPath) === entry.size),
      )
      if (plausible.length === 0) continue

      // Only now is the marked file itself touched: nothing moved away from a
      // path that still has a file on it.
      const source = { fsPath: markedPath }
      if (await this.deps.probe(source)) continue

      for (const target of plausible) {
        if ((await hashOf(target)) !== entry.hash) continue
        claimed.add(target.fsPath)
        if (this.moveMark(source, target)) moved++
        break
      }
    }
    return moved
  }

  // --------------- Snapshots ---------------

  private async writeSnapshot(hash: string, bytes: Buffer): Promise<void> {
    const dir = this.deps.snapshotDir
    // Nowhere to keep it, so there is nothing to promise: `mark` treats this
    // like any other snapshot failure and declines to leave a mark behind.
    if (!dir) throw new Error('this window has no storage for review snapshots')
    await fs.mkdir(dir, { recursive: true })
    // Written as bytes, so the blob is the file rather than a decode of it.
    await fs.writeFile(path.join(dir, hash), bytes)
  }

  /** The content this file was marked reviewed at, if it is still on disk. */
  async snapshotContent(uri: PathLike): Promise<string | undefined> {
    const entry = this.entry(uri)
    if (!entry?.hash) return undefined
    return readSnapshot(this.deps.snapshotDir, entry.hash)
  }

  // --------------- Housekeeping ---------------

  /**
   * Drop marks for files that are no longer under review.
   *
   * `keepPaths` is the set of paths still changed against HEAD in that bucket,
   * so committing a reviewed file retires its mark. Bounded on purpose: without
   * this, a long-lived branch accumulates an entry for every file it ever
   * touched.
   */
  prune(key: string, keepPaths: Set<string>): boolean {
    const bucket = this.bucket(key)
    const survivors: ReviewedBucket = {}
    let dropped = false
    for (const [filePath, entry] of Object.entries(bucket)) {
      if (keepPaths.has(filePath)) survivors[filePath] = entry
      else dropped = true
    }
    if (dropped) this.deps.storage.update(key, survivors)
    return dropped
  }

  /**
   * Copy another branch's marks into an unseen branch.
   * Cutting a branch mid-review should carry progress over.
   */
  inherit(fromKey: string, toKey: string): boolean {
    if (fromKey === toKey) return false
    if (Object.keys(this.bucket(toKey)).length > 0) return false
    const source = this.bucket(fromKey)
    if (Object.keys(source).length === 0) return false
    this.deps.storage.update(toKey, { ...source })
    return true
  }

  /**
   * Delete snapshot blobs no bucket refers to any more.
   *
   * The reference set spans *every* bucket, not just the active one — blobs are
   * shared by content, so collecting against one branch alone would delete the
   * copy another branch still needs to show its diff.
   */
  async collectGarbage(): Promise<number> {
    if (!this.deps.snapshotDir) return 0
    const referenced = new Set<string>()
    for (const key of this.deps.storage.keys()) {
      if (!key.startsWith(BUCKET_PREFIX)) continue
      // A `stat`-tier mark holds no blob, so it keeps nothing alive.
      for (const entry of Object.values(this.bucket(key))) if (entry.hash) referenced.add(entry.hash)
    }

    let removed = 0
    let entries: string[]
    try {
      entries = await fs.readdir(this.deps.snapshotDir)
    } catch {
      return 0
    }
    for (const name of entries) {
      if (referenced.has(name)) continue
      try {
        await fs.rm(path.join(this.deps.snapshotDir, name), { force: true })
        removed++
      } catch (e) {
        this.deps.log?.(`[Crit] Could not remove snapshot ${name}: ${String(e)}`)
      }
    }
    return removed
  }

  bucket(key: string): ReviewedBucket {
    return this.deps.storage.get<ReviewedBucket>(key) ?? {}
  }
}

export async function readSnapshot(snapshotDir: string | undefined, hash: string): Promise<string | undefined> {
  if (!snapshotDir) return undefined
  try {
    return await fs.readFile(path.join(snapshotDir, hash), 'utf8')
  } catch {
    // Collected, or written by a version that named blobs after the file.
    return undefined
  }
}
