import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import type { API, Change, GitExtension, Repository, Status } from './vscode-git'

/**
 * Access to the built-in Git extension: the current branch (review state is
 * branch-scoped), which repository owns a file, the set of files changed
 * against HEAD, and the diff hunks quoted alongside a review comment.
 *
 * The Git extension publishes its API separately from `@types/vscode`; its
 * official 1.133 declaration is vendored in `vscode-git.d.ts`.
 */

export function getGitApi(): API | undefined {
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')
  if (!gitExtension?.isActive) return undefined
  return gitExtension.exports.getAPI(1)
}

/** Activate the Git extension if it has not started yet. */
async function activateGit(): Promise<boolean> {
  const gitExtension = vscode.extensions.getExtension('vscode.git')
  if (!gitExtension) return false
  try {
    if (!gitExtension.isActive) await gitExtension.activate()
    return true
  } catch {
    return false
  }
}

/**
 * Run `setup` with the Git API, now or once the Git extension activates.
 *
 * Crit can activate before the Git extension does. Reading `getGitApi()` once
 * at startup then finds nothing and wires up nothing until the window reloads:
 * the changed-file list stays empty, and branch-scoped state is read from the
 * wrong bucket.
 *
 * `setup` returns the array it keeps its subscriptions in. The array itself is
 * held, not a copy, because `setup` keeps adding to it as repositories open.
 */
export function whenGitReady(setup: (git: API) => vscode.Disposable[]): vscode.Disposable {
  let subscriptions: vscode.Disposable[] = []
  let disposed = false

  const run = (git: API) => {
    subscriptions = setup(git)
  }

  const git = getGitApi()
  if (git) {
    run(git)
  } else {
    void activateGit().then((ready) => {
      const api = ready ? getGitApi() : undefined
      if (!disposed && api) run(api)
    })
  }

  return new vscode.Disposable(() => {
    disposed = true
    for (const subscription of subscriptions) subscription.dispose()
  })
}

// --------------- Repository identity ---------------

/**
 * The repository containing `uri`, or undefined when the file is under none.
 *
 * Longest root wins. A first-match scan resolves a file inside a submodule or a
 * nested repository to the *outer* repository, which then reports the wrong
 * branch and the wrong diff for it.
 */
export function repoForUri(uri: vscode.Uri, git = getGitApi()): Repository | undefined {
  const repos = git?.repositories ?? []
  return repos.reduce<Repository | undefined>((best, repo) => {
    const root = repo.rootUri.fsPath
    if (!isInside(uri.fsPath, root)) return best

    const bestRoot = best?.rootUri.fsPath
    return !bestRoot || root.length > bestRoot.length ? repo : best
  }, undefined)
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Stable key for a repository: its folder name plus a hash of its real path.
 *
 * The name alone — what the original branch key used — collides whenever a
 * multi-root workspace holds two checkouts called `api`, silently merging their
 * review state. The hash disambiguates; the name keeps the key readable in the
 * output log.
 */
export function repoRef(repo: Repository): string {
  const root = repo.rootUri.fsPath
  let canonical: string
  try {
    canonical = fs.realpathSync.native(root)
  } catch {
    canonical = path.resolve(root)
  }
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8)
  return `${path.basename(root)}-${hash}`
}

/** The checked-out branch, or a stand-in when HEAD is detached. */
export function repoBranch(repo: Repository): string {
  return repo.state.HEAD?.name || '_detached'
}

/**
 * Key for the comment threads of the current branch, `<repo>.<branch>`, or
 * `_default` while no repository is known. Reads the first repository only.
 */
export function branchKey(git = getGitApi()): string {
  const repo = git?.repositories[0]
  if (!repo) return '_default'
  return `${path.basename(repo.rootUri.fsPath)}.${repoBranch(repo)}`
}

/**
 * Report `branchKey()` now, and again each time it changes.
 *
 * It is rechecked when the Git extension finishes activating, when a repository
 * opens, and when a repository's state changes. A repository can be announced
 * with HEAD already resolved, so no `state.onDidChange` follows it; checking on
 * open covers that case.
 */
export function watchBranchKey(listener: (key: string) => void): vscode.Disposable {
  let current = branchKey()
  listener(current)

  return whenGitReady((git) => {
    const subscriptions: vscode.Disposable[] = []
    const report = () => {
      const key = branchKey(git)
      if (key === current) return
      current = key
      listener(key)
    }
    const watch = (repo: Repository) => subscriptions.push(repo.state.onDidChange(report))

    for (const repo of git.repositories) watch(repo)
    subscriptions.push(
      git.onDidOpenRepository((repo) => {
        watch(repo)
        report()
      }),
    )
    // Activation can land after the startup read above.
    report()
    return subscriptions
  })
}

// --------------- Changed files ---------------

export type StatusLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'U'
export interface ChangedFile {
  uri: vscode.Uri
  /** Workspace-relative, for display and sorting. */
  relativePath: string
  status: StatusLetter
  /** Where the file was before git recorded it as renamed. */
  renamedFrom?: vscode.Uri
  repo: Repository
}

/**
 * Every file that differs from HEAD, across every open repository.
 *
 * The union of four change lists, because one file can appear in several at
 * once — staged, then edited again — and a reviewer wants one row per file
 * either way. `untrackedChanges` is read defensively: older Git extension
 * versions fold untracked files into `workingTreeChanges`, and the
 * `git.untrackedChanges` setting moves them between the two.
 */
export function getChangedFiles(git = getGitApi()): ChangedFile[] {
  const repos = git?.repositories ?? []
  const byPath = repos
    .flatMap((repo) =>
      [
        ...(repo.state?.mergeChanges ?? []),
        ...(repo.state?.indexChanges ?? []),
        ...(repo.state?.workingTreeChanges ?? []),
        ...(repo.state?.untrackedChanges ?? []),
      ].map((change) => ({ change, repo })),
    )
    .reduce<Record<string, ChangedFile>>((files, { change, repo }) => {
      const uri = change.uri

      const existing = files[uri.fsPath]
      const status = statusLetter(change)
      const renamedFrom = renameSource(change, status)
      if (existing) {
        // A file staged as added and then edited again is still an add, so a
        // plain modification never overwrites a more specific status. The old
        // path travels with the status that carried it.
        if (existing.status === 'M') {
          existing.status = status
          existing.renamedFrom = renamedFrom
        }
      } else {
        files[uri.fsPath] = {
          uri,
          relativePath: vscode.workspace.asRelativePath(uri),
          status,
          renamedFrom,
          repo,
        }
      }
      return files
    }, {})

  return Object.values(byPath).sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

/**
 * The Git API status enum collapses into the labels Crit shows in its sidebar.
 */
const STATUS_LETTERS: Partial<Record<Status, StatusLetter>> = {
  0: 'M', // INDEX_MODIFIED
  1: 'A', // INDEX_ADDED
  2: 'D', // INDEX_DELETED
  3: 'R', // INDEX_RENAMED
  4: 'C', // INDEX_COPIED
  5: 'M', // MODIFIED
  6: 'D', // DELETED
  7: 'U', // UNTRACKED
  8: 'U', // IGNORED
  9: 'A', // INTENT_TO_ADD
  10: 'R', // INTENT_TO_RENAME
  11: 'M', // TYPE_CHANGED
} as const

function statusLetter({ status }: Change): StatusLetter {
  return STATUS_LETTERS[status] ?? 'M'
}

/**
 * The path a renamed file came from, when git is the one saying it moved.
 *
 * `originalUri` is populated for every change — it is the HEAD-side path — so
 * the status is what makes it a rename rather than just the same path again.
 */
function renameSource(change: Change, status: StatusLetter): vscode.Uri | undefined {
  if (status !== 'R') return undefined
  return change.originalUri?.fsPath === change.uri.fsPath ? undefined : change.originalUri
}

/** True when the file has no HEAD side to diff against. */
export function isUntracked(file: ChangedFile): boolean {
  return file.status === 'U' || file.status === 'A'
}

/**
 * The file as HEAD has it, for the left-hand side of a diff.
 *
 * `toGitUri` is the Git extension's own virtual-document scheme, so the editor
 * that opens is the same read-only one the Source Control view uses.
 */
export function headUri(uri: vscode.Uri): vscode.Uri | undefined {
  const git = getGitApi()
  try {
    return git?.toGitUri(uri, 'HEAD')
  } catch {
    return undefined
  }
}

/**
 * Fire `listener` whenever any repository's state changes, including
 * repositories opened later.
 *
 * The Git extension repeats `onDidChange` liberally — several times for one
 * file save — so callers are expected to debounce.
 */
export function onChangedFilesChanged(listener: () => void): vscode.Disposable {
  // Until the Git extension activates, the changed-file list is empty with
  // nothing to refill it. Firing once it is ready is the difference between a
  // sidebar that fills itself in and one that looks broken until the user finds
  // the refresh button.
  const startedLate = !getGitApi()

  return whenGitReady((git) => {
    const subscriptions: vscode.Disposable[] = []
    const watch = (repo: Repository) => subscriptions.push(repo.state.onDidChange(listener))
    for (const repo of git.repositories) watch(repo)
    subscriptions.push(
      git.onDidOpenRepository((repo) => {
        watch(repo)
        listener()
      }),
    )
    subscriptions.push(git.onDidCloseRepository(listener))
    if (startedLate) listener()
    return subscriptions
  })
}

// --------------- Diff hunks ---------------

export interface DiffHunk {
  header: string
  lines: string[]
}

export async function getFileDiffHunks(uri: vscode.Uri): Promise<DiffHunk[]> {
  try {
    const git = getGitApi()
    if (!git) return []
    const repo = repoForUri(uri, git)
    if (!repo) return []

    // Get unstaged diff (working tree vs index)
    const unstaged = (await repo.diff(false)) || ''
    // Get staged diff (index vs HEAD)
    const staged = (await repo.diff(true)) || ''
    // Combine — unstaged first since it reflects current file state
    const fullDiff = unstaged + '\n' + staged

    if (!fullDiff.trim()) return []

    const rel = path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/')

    // Split diff into per-file sections
    const fileSections = fullDiff.split(/^(?=diff --git )/m)
    const targetPrefix = `diff --git a/${rel} b/${rel}`
    const fileSection = fileSections.find((s) => s.startsWith(targetPrefix))
    if (!fileSection) return []

    // Split into hunks by @@ markers
    const hunkParts = fileSection.split(/^(?=@@)/m)
    const hunks: DiffHunk[] = []

    for (const part of hunkParts) {
      if (!part.startsWith('@@')) continue
      const lines = part.split('\n')
      const header = lines[0]
      const body = lines.slice(1).filter((l) => l !== '' || lines.indexOf(l) < lines.length - 1)
      hunks.push({ header, lines: body })
    }

    return hunks
  } catch {
    return []
  }
}

export function findRelevantHunk(hunks: DiffHunk[], targetLine: number): string | undefined {
  for (const hunk of hunks) {
    // Parse @@ -oldStart,oldCount +newStart,newCount @@
    const m = hunk.header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (!m) continue

    const newStart = parseInt(m[3], 10)
    const newCount = parseInt(m[4] ?? '1', 10)
    const newEnd = newStart + newCount - 1

    // Target line is 1-based
    if (targetLine >= newStart && targetLine <= newEnd) {
      // Return the hunk with limited context (max 15 lines around comment)
      const allLines = [hunk.header, ...hunk.lines]
      if (allLines.length <= 20) return allLines.join('\n')
      // Find the approximate position in the hunk
      let newLineCounter = newStart
      let bestIndex = 1 // skip header
      for (let i = 1; i < allLines.length; i++) {
        const line = allLines[i]
        if (!line.startsWith('-')) {
          if (newLineCounter === targetLine) {
            bestIndex = i
            break
          }
          newLineCounter++
        }
      }
      const start = Math.max(1, bestIndex - 7)
      const end = Math.min(allLines.length, bestIndex + 7)
      return [hunk.header, ...allLines.slice(start, end)].join('\n')
    }
  }
  return undefined
}
