import * as vscode from 'vscode';
import { deliverToClaudeCode, sessionLabel } from './claude-delivery';
import { promptIfMcpMissing } from './mcp-install';
import { buildReviewRequest, ReviewScope } from './prompts';
import { projectCode } from './review-threads';

/**
 * Asking the AI to review the code and comment on it — the reverse of every
 * other Crit flow, where the user comments and the AI answers.
 *
 * Claude Code only for now. Copilot's review runs inside its own UI and would
 * need a separate integration to land findings as Crit comments, so a Copilot
 * user is told plainly rather than handed a prompt that goes nowhere.
 */

export type ReviewTarget =
    | { kind: 'project' }
    | { kind: 'file'; uri: vscode.Uri };

export async function requestReview(
    target: ReviewTarget,
    context: vscode.ExtensionContext,
    log: vscode.OutputChannel,
): Promise<void> {
    const provider = vscode.workspace
        .getConfiguration('crit')
        .get<string>('aiProvider', 'copilot');
    if (provider !== 'claudeCode') {
        await offerProviderSwitch();
        return;
    }

    const scope = reviewScope(target);
    if (!scope) return;

    const request = buildReviewRequest(scope);
    try {
        const result = await deliverToClaudeCode(request, log);
        if (result.path === 'session' && result.session) {
            // The inbox never acks and the session may be off-screen, so say
            // where the request went rather than leaving the send invisible.
            vscode.window.showInformationMessage(
                `Asked Claude Code session ${sessionLabel(result.session)} to review ${scope.label}.`,
            );
        }
    } catch {
        await vscode.env.clipboard.writeText(request.editor);
        vscode.window.showWarningMessage(
            'Could not reach Claude Code. The review request was copied to the clipboard.',
        );
        return;
    }

    // Not awaited: the request is already delivered, and whether the MCP tools
    // are wired up must not hold up the send. Without them the agent has
    // nowhere to put its findings, which is worth saying — once.
    void promptIfMcpMissing(context, log);
}

/**
 * What to review, and the code that says where to put the comments.
 *
 * The `projectCode` is derived from the reviewed file's own project so a
 * multi-root window addresses the right one; for a project-wide review that is
 * the first folder, which is the same assumption `buildNudgeMessage` makes.
 */
function reviewScope(target: ReviewTarget): ReviewScope | undefined {
    if (target.kind === 'file') {
        const folder = vscode.workspace.getWorkspaceFolder(target.uri);
        if (!folder) {
            vscode.window.showWarningMessage(
                'Crit can only ask for a review of a file inside an open workspace folder.',
            );
            return undefined;
        }
        const relative = vscode.workspace.asRelativePath(target.uri);
        return {
            kind: 'file',
            label: relative,
            args: ` ${relative}`,
            code: projectCode(target.uri),
        };
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        vscode.window.showWarningMessage('Crit needs an open workspace folder to request a review.');
        return undefined;
    }
    return {
        kind: 'project',
        label: 'this workspace',
        // No argument: `/code-review` defaults to the current diff, which is
        // exactly the scope a project-wide request wants.
        args: '',
        code: projectCode(folder.uri),
    };
}

async function offerProviderSwitch(): Promise<void> {
    const openSettings = 'Open Settings';
    const choice = await vscode.window.showWarningMessage(
        'Asking the AI for a review needs the Claude Code provider — Copilot is not supported yet. ' +
        'Set Crit: AI Provider to Claude Code.',
        openSettings,
    );
    if (choice === openSettings) {
        await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'crit.aiProvider',
        );
    }
}
