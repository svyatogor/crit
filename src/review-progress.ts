import * as fs from 'fs/promises'
import * as path from 'path'
import * as vscode from 'vscode'
import { getChangedFiles, getGitApi, repoBranch, repoForUri, repoRef } from './git'
import type { Repository } from './vscode-git'
import { bucketKey, type FileProbe, NO_REPO_BUCKET, ReviewedFiles } from './reviewed-files'

/**
 * Wires the reviewed-file model to this window: where its buckets live, how a
 * file's current content is read, and what happens to a bucket when the branch
 * moves under it.
 *
 * Kept apart from `reviewed-files.ts` so the model itself stays free of
 * `vscode` and can be tested as plain Node. Everything here is the part that
 * genuinely needs the editor and the Git extension.
 */

export interface ReviewProgress {
  reviewed: ReviewedFiles
  /** Fires when marks changed for a reason the user did not trigger directly. */
  onDidChange: vscode.Event<void>
  dispose(): void
}

interface HeadPosition {
  branch: string
  commit: string | undefined
}

export function createReviewProgress(context: vscode.ExtensionContext, log: vscode.OutputChannel): ReviewProgress {
  const snapshotDir = snapshotDirFor(context)

  const reviewed = new ReviewedFiles({
    storage: context.workspaceState,
    bucketKeyFor,
    readContent,
    probe,
    snapshotDir,
    log: (message) => log.appendLine(message),
  })

  const emitter = new vscode.EventEmitter<void>()
  const heads = new Map<string, HeadPosition>()
  const subscriptions: vscode.Disposable[] = [emitter]

  /**
   * Follow each repository's HEAD separately.
   *
   * A branch switch in one repository of a multi-root workspace must not touch
   * another's marks, which a single global branch key cannot express — so the
   * position is tracked per repository ref rather than derived from
   * `repositories[0]`.
   */
  function trackRepo(repo: Repository): void {
    const ref = repoRef(repo)
    heads.set(ref, headPosition(repo))
    subscriptions.push(
      repo.state.onDidChange(() => {
        const previous = heads.get(ref)
        const current = headPosition(repo)
        if (previous?.branch === current.branch && previous.commit === current.commit) return
        heads.set(ref, current)

        if (previous && previous.branch !== current.branch) {
          // Cutting a branch mid-review should carry progress over, the same
          // trade `switchToBranch` makes for comment threads. A mark that does
          // not belong on the new branch meets different content there and
          // shows as stale, so the cost of guessing wrong is bounded.
          const from = bucketKey(ref, previous.branch)
          const to = bucketKey(ref, current.branch)
          if (reviewed.inherit(from, to)) {
            log.appendLine(`[Crit] Inherited reviewed marks ${previous.branch} → ${current.branch} (${ref})`)
          }
        } else if (previous) {
          // Same branch, new commit: whatever just got committed is no longer
          // under review, so its mark has done its job.
          pruneRepo(repo, ref, current.branch)
        }

        emitter.fire()
      }),
    )
  }

  function pruneRepo(repo: Repository, ref: string, branch: string): void {
    const keep = new Set(
      getChangedFiles()
        .filter((file) => file.repo === repo)
        .map((file) => file.uri.fsPath),
    )
    // An empty list here is ambiguous: everything really was committed, or the
    // Git extension has not recomputed the working tree yet. Pruning on the
    // second reading would throw away a whole branch's progress, and keeping
    // marks a moment too long costs nothing — the next commit prunes them.
    if (keep.size === 0) {
      log.appendLine(`[Crit] Skipped pruning ${branch} (${ref}) — no changed files reported yet`)
      return
    }
    if (reviewed.prune(bucketKey(ref, branch), keep)) {
      log.appendLine(`[Crit] Pruned reviewed marks retired by a commit on ${branch} (${ref})`)
      void collect()
    }
  }

  async function collect(): Promise<void> {
    try {
      const removed = await reviewed.collectGarbage()
      if (removed > 0) log.appendLine(`[Crit] Collected ${removed} unreferenced review snapshot(s)`)
    } catch (e) {
      log.appendLine(`[Crit] Snapshot collection failed: ${String(e)}`)
    }
  }

  const git = getGitApi()
  if (git) {
    for (const repo of git.repositories) trackRepo(repo)
    subscriptions.push(git.onDidOpenRepository(trackRepo))
  } else {
    log.appendLine('[Crit] Git API not available — reviewed marks fall back to a single unbranched bucket')
  }

  void collect()

  return {
    reviewed,
    onDidChange: emitter.event,
    dispose() {
      for (const subscription of subscriptions) subscription.dispose()
    },
  }
}

function headPosition(repo: Repository): HeadPosition {
  return { branch: repoBranch(repo), commit: repo.state.HEAD?.commit }
}

/** `crit.reviewed.<repo>-<hash>.<branch>`, or the unbranched bucket. */
function bucketKeyFor(uri: Pick<vscode.Uri, 'fsPath'>): string {
  const repo = repoForUri(uri as vscode.Uri)
  if (!repo) return NO_REPO_BUCKET
  return bucketKey(repoRef(repo), repoBranch(repo))
}

/** The unsaved buffer for a path, if an editor is holding one. */
function dirtyDocument(uri: Pick<vscode.Uri, 'fsPath'>): vscode.TextDocument | undefined {
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === uri.fsPath)
  return open?.isDirty ? open : undefined
}

/**
 * What can be known about a file for the price of a `stat`.
 *
 * Every freshness check starts here, and most of them end here: the model reads
 * a file only when this says it moved. A directory reports as absent rather
 * than as a zero-byte file, so a path that turned into one cannot read as
 * unchanged.
 */
async function probe(uri: Pick<vscode.Uri, 'fsPath'>): Promise<FileProbe | undefined> {
  try {
    const stats = await fs.stat(uri.fsPath)
    if (!stats.isFile()) return undefined
    return { size: stats.size, mtimeMs: stats.mtimeMs, dirty: dirtyDocument(uri) !== undefined }
  } catch {
    return undefined
  }
}

/**
 * What the reviewer is actually looking at.
 *
 * An open editor with unsaved edits is the truth on screen, so it wins over the
 * copy on disk — marking a file reviewed and then typing in it has to turn the
 * mark stale, which it would not if only saved bytes were ever hashed.
 *
 * Bytes rather than text: decoding as UTF-8 quietly replaces anything that is
 * not, which both corrupts a snapshot written back out and lets two different
 * files hash alike. Only the buffer, which is text by construction, is encoded.
 */
async function readContent(uri: Pick<vscode.Uri, 'fsPath'>): Promise<Buffer | undefined> {
  const dirty = dirtyDocument(uri)
  if (dirty) return Buffer.from(dirty.getText(), 'utf8')
  try {
    return await fs.readFile(uri.fsPath)
  } catch {
    // Deleted, or not a file we can read. A mark on it can only be stale.
    return undefined
  }
}

/**
 * Where snapshot blobs live: this window's own workspace storage.
 *
 * A window with no folder open has none — and needs none, since every mark
 * comes from a changed file, every changed file from an open repository, and
 * such a window has neither. Falling back to global storage would only put two
 * of them in one directory, where `collectGarbage` reads the marks of a single
 * window and would happily delete blobs belonging to the other.
 */
export function snapshotDirFor(context: Pick<vscode.ExtensionContext, 'storageUri'>): string | undefined {
  const root = context.storageUri
  return root ? path.join(root.fsPath, 'snapshots') : undefined
}
