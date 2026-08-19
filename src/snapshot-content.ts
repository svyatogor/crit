import * as vscode from 'vscode'
import { readSnapshot } from './reviewed-files'

/**
 * Serves the copy of a file taken when it was marked reviewed, so "what changed
 * since I looked" can open as an ordinary diff editor.
 *
 * A content provider rather than a path handed straight to `vscode.diff`: the
 * left-hand side of that diff is history and must not be editable, and a
 * virtual document is read-only for free. Keeping the original path in the URI —
 * only the scheme and query differ — means the editor still shows the file's
 * name and highlights it in the right language.
 */

export const SNAPSHOT_SCHEME = 'crit-snapshot'

/** The reviewed-at copy of `fileUri`, addressed by the content hash. */
export function snapshotUri(fileUri: vscode.Uri, hash: string): vscode.Uri {
  return fileUri.with({ scheme: SNAPSHOT_SCHEME, query: hash })
}

export function registerSnapshotProvider(snapshotDir: string | undefined): vscode.Disposable {
  const provider: vscode.TextDocumentContentProvider = {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      // A missing blob — collected, or the storage directory was cleared —
      // renders as an empty document, so the whole file shows as added. That
      // reads as "no baseline" rather than as an error dialog over a diff.
      return (await readSnapshot(snapshotDir, uri.query)) ?? ''
    },
  }
  return vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, provider)
}
