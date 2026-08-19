import * as vscode from 'vscode'

/**
 * Offers, once, to stop VS Code revealing its built-in Comments view every time
 * a comment is written.
 *
 * VS Code's `commentsController` calls `openCommentsView()` whenever a thread
 * gains a comment — on creation *and* on every later reply — and then consults
 * `comments.openView`. At its default `firstFile` the reveal is gated only on
 * whether that view currently has a rendered tree, which is a far weaker gate
 * than "once": it comes back after the view is hidden or the window reloads. So
 * writing a comment repeatedly swaps the sidebar out from under Crit's own view.
 *
 * Nothing on `CommentController` or `CommentThread` suppresses this — it is
 * workbench behaviour, and the one contribution point that reaches that view's
 * rows (`commentsView/commentThread/context`) is proposed API, unusable in a
 * published extension. The setting is the only lever.
 *
 * It is a *global* setting and not scoped per extension, so turning it off also
 * stops other comment providers (GitHub Pull Requests, say) from revealing that
 * view. That is the user's call to make, which is why this asks instead of
 * quietly writing it.
 */

const DISMISSED_KEY = 'crit.commentsViewRevealDismissed'
const SECTION = 'comments'
const SETTING = 'openView'
const NEVER = 'never'

/** Once per window, like the MCP nudge — a second ask is nagging. */
let askedThisWindow = false

export async function promptIfCommentsViewReveals(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): Promise<void> {
  if (askedThisWindow) return
  askedThisWindow = true
  if (context.globalState.get<boolean>(DISMISSED_KEY)) return

  const config = vscode.workspace.getConfiguration(SECTION)
  if (config.get<string>(SETTING) === NEVER) return

  const turnOff = 'Turn It Off'
  const never = "Don't Show Again"
  const choice = await vscode.window.showInformationMessage(
    "VS Code reveals its own Comments view whenever you write a comment, which takes the sidebar away from Crit's. " +
      'Set `comments.openView` to `never` to stop it? This is a global VS Code setting, so it also stops other ' +
      'extensions revealing that view.',
    turnOff,
    never,
  )

  if (choice === turnOff) {
    try {
      await config.update(SETTING, NEVER, vscode.ConfigurationTarget.Global)
      log.appendLine(`[Crit] Set ${SECTION}.${SETTING} to "${NEVER}"`)
      vscode.window.showInformationMessage(
        'The built-in Comments view will no longer open on its own. It is still available from the command palette.',
      )
    } catch (e) {
      log.appendLine(`[Crit] Could not set ${SECTION}.${SETTING}: ${String(e)}`)
      vscode.window.showWarningMessage(
        `Crit could not change that setting. Set "${SECTION}.${SETTING}" to "${NEVER}" in your settings to stop it.`,
      )
    }
  } else if (choice === never) {
    await context.globalState.update(DISMISSED_KEY, true)
  }
}
