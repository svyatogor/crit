import * as fs from 'fs'
import * as path from 'path'

/**
 * Turning the file an agent names into a path this window may comment on.
 *
 * An agent leaving a review comment knows a path the way it wrote it — usually
 * workspace-relative, sometimes absolute — while the IPC server needs an
 * absolute one it can hand to `vscode.Uri.file`. Resolution is deliberately
 * confined to the workspace folders belonging to the addressed project, so a
 * `projectRef` is a real restriction and not just a lookup key: the IPC server
 * listens on loopback, where any local process can reach it, and `../../..` in a
 * `file` argument must not be able to plant a comment outside the project the
 * caller named.
 *
 * The request's *shape* is not checked here — `addCommentRequestSchema` in
 * `ipc-server` owns that. This module answers the one question that needs the
 * filesystem and the folder list: which path, if any, the agent meant.
 *
 * Kept free of `vscode` so the rules can be tested directly.
 */

export type CommentTargetResolution = { path: string } | { error: string }

export interface ResolveOptions {
  /** Overridable so tests need no real files. */
  exists?: (candidate: string) => boolean
}

/**
 * The absolute path `file` names within `folders`, or why it cannot be one.
 *
 * Relative paths are tried against each folder in turn and the first hit wins,
 * which is the same first-match rule `vscode.workspace.asRelativePath` uses in
 * reverse — so a path this returns is the one that path would have been printed
 * as. Errors are agent-facing: each says what to send instead.
 */
export function resolveCommentFile(
  file: string,
  folders: string[],
  options: ResolveOptions = {},
): CommentTargetResolution {
  const exists = options.exists ?? defaultExists

  if (file.trim().length === 0) {
    return { error: 'A review comment needs a non-empty file path.' }
  }
  if (folders.length === 0) {
    return {
      error:
        'That project has no local workspace folder in this VS Code window, ' +
        'so there is nowhere to anchor a comment.',
    }
  }

  const requested = file.trim()
  const candidates = path.isAbsolute(requested)
    ? [path.normalize(requested)]
    : folders.map((folder) => path.resolve(folder, requested))

  const contained = candidates.filter((candidate) => folders.some((folder) => containsPath(folder, candidate)))
  if (contained.length === 0) {
    return {
      error:
        `${requested} is outside the workspace folders of the project that code ` +
        'addresses. Pass a path relative to the project root.',
    }
  }

  const found = contained.find(exists)
  if (!found) {
    return {
      error:
        `No file at ${requested} in that project. Pass a path relative to the ` +
        'project root, exactly as it appears on disk.',
    }
  }
  return { path: found }
}

/** Whether `target` is `folder` or sits underneath it. */
export function containsPath(folder: string, target: string): boolean {
  const relative = path.relative(path.resolve(folder), path.resolve(target))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * A 1-based line from an agent, as a 0-based line inside the document.
 *
 * Out-of-range is clamped rather than rejected: the agent is reading a diff or
 * an older revision of a file the user may have edited since, and a comment one
 * line off is far more useful than a refusal. `lineCount` of 0 cannot happen for
 * a document VS Code opened, but is handled so the result is never negative.
 */
export function toDocumentLine(line: number, lineCount: number): number {
  return Math.max(0, Math.min(line - 1, lineCount - 1))
}

function defaultExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}
