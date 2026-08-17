import * as vscode from 'vscode'
import { sendMessageToSocket } from './claude-messaging'
import { type ClaudeSession, findSessionForWorkspace } from './claude-sessions'

/**
 * Getting a message in front of Claude Code, wherever it happens to be running.
 *
 * There are three ways in and they take different text, which is why callers
 * hand over all three up front rather than one string:
 *
 *  - **terminal** — `Terminal.sendText` into the running CLI, which reads the
 *    whole send as a paste; line breaks are fine, but a long one arrives
 *    collapsed, so the user sees only how many lines it was.
 *  - **message** — the cross-session inbox delivers a user turn; markdown is
 *    fine, but the panel never renders it, so the text has to make sense as
 *    something the user did not see.
 *  - **editor** — a brand-new conversation, which can be handed the full prompt.
 */

export interface ClaudeDelivery {
  terminal: string
  message: string
  editor: string
}

export type DeliveryPath = 'terminal' | 'session' | 'editor'

export interface DeliveryResult {
  path: DeliveryPath
  /** Set on the `session` path, for callers that name where the text went. */
  session?: ClaudeSession
}

/**
 * The terminal Claude Code runs in, if it is running there.
 *
 * Claude Code creates its terminal as `Claude Code` (overridable via
 * CLAUDE_CODE_TERMINAL_TITLE), so match on that rather than grabbing whichever
 * terminal happens to be active — sending a review prompt into an unrelated
 * shell would execute it.
 */
export function findClaudeCodeTerminal(): vscode.Terminal | undefined {
  const expected = process.env.CLAUDE_CODE_TERMINAL_TITLE || 'Claude Code'
  const matches = vscode.window.terminals.filter((t) => t.name.includes(expected) || t.name.startsWith('✳ '))
  if (matches.length === 0) return undefined

  // Prefer the focused one when several are open.
  const active = vscode.window.activeTerminal
  if (active && matches.includes(active)) return active
  return matches[matches.length - 1]
}

/** The Claude Code session running in this workspace, if there is one. */
export function findWorkspaceClaudeSession(): ClaudeSession | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder || folder.uri.scheme !== 'file') return undefined

  try {
    return findSessionForWorkspace(folder.uri.fsPath, {
      // Guards the case where VS Code itself was launched from a Claude
      // session: that session must not review its own comments.
      excludeSessionId: process.env.CLAUDE_CODE_SESSION_ID,
    })
  } catch {
    return undefined
  }
}

export function sessionLabel(session: ClaudeSession): string {
  return session.name ?? session.sessionId.slice(0, 8)
}

/**
 * Deliver to Claude Code, preferring paths that keep the user in the
 * conversation they are already having.
 *
 *  1. Terminal — appends to the running CLI session.
 *  2. Live session — cross-session message into the running conversation.
 *  3. New conversation — last resort; the webview cannot be handed a prompt for
 *     a session it already hosts ("Your prompt was not applied").
 */
export async function deliverToClaudeCode(
  delivery: ClaudeDelivery,
  log: vscode.OutputChannel,
): Promise<DeliveryResult> {
  const terminal = findClaudeCodeTerminal()
  if (terminal) {
    terminal.show()
    terminal.sendText(delivery.terminal, true)
    return { path: 'terminal' }
  }

  const session = findWorkspaceClaudeSession()
  if (session) {
    try {
      await sendMessageToSocket(session.messagingSocketPath, delivery.message)
      return { path: 'session', session }
    } catch (error: any) {
      // The session can exit between discovery and delivery; opening a
      // new conversation still gets the text in front of the user.
      log.appendLine(`[Crit] Cross-session delivery failed, opening a new conversation: ${error.message}`)
    }
  }

  await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', undefined, delivery.editor)
  return { path: 'editor' }
}
