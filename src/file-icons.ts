import * as vscode from 'vscode'

/**
 * File-type icons in Crit's trees, without file decorations.
 *
 * `TreeItem.resourceUri` is the only way to get the icon theme's real
 * per-extension icon — with `iconPath` set to `ThemeIcon.File`, the icon is
 * "derived from the current file icon theme" using that URI. But the same field
 * opts the row into every registered `FileDecorationProvider`, and git's colours
 * a filename by its working-tree status. In the Comments section that is simply
 * wrong information — a name turning green because the file is untracked says
 * nothing about its comments — and in Changes the status letter already says it,
 * more precisely than a colour can.
 *
 * The two behaviours split cleanly on scheme. The icon theme resolves from the
 * *path*, so it does not care; git's decoration provider looks its entries up by
 * the whole URI string and its ignore provider returns early for any scheme
 * other than `file`, so neither matches. Re-scheming the URI keeps the icon and
 * drops the colour.
 *
 * Nothing ever opens these URIs — every row sets its own `command` and
 * `tooltip` — so the scheme needs no content provider behind it.
 */

export const ICON_SCHEME = 'crit-icon'

export function iconResource(uri: vscode.Uri): vscode.Uri {
  return uri.with({ scheme: ICON_SCHEME })
}
