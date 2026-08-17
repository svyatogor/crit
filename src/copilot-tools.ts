import * as vscode from 'vscode';
import {
    commentText,
    isResolved,
    resolveThread,
    ReviewComment,
    threadLabel,
    threadMap,
    threadsChanged,
    untrackThread,
} from './review-threads';

/**
 * Language model tools for GitHub Copilot.
 *
 * Copilot addresses a comment by its display id (the number in R1, R2, …)
 * rather than by `threadRef`: the ids are what the prompt shows it, and the
 * tools run inside this window, so the cross-window routing the MCP server
 * needs does not apply here.
 */

export function registerTools(context: vscode.ExtensionContext) {
    if (!vscode.lm || !vscode.lm.registerTool) return;

    context.subscriptions.push(
        vscode.lm.registerTool('crit_listComments', new ListCommentsTool()),
        vscode.lm.registerTool('crit_replyToComment', new ReplyToCommentTool()),
        vscode.lm.registerTool('crit_resolveComment', new ResolveCommentTool()),
        vscode.lm.registerTool('crit_deleteComment', new DeleteCommentTool()),
    );
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

class ListCommentsTool implements vscode.LanguageModelTool<{}> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<{}>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (threadMap.size === 0) return textResult('No review comments.');

        const lines: string[] = [];
        for (const [id, thread] of threadMap) {
            const rel = vscode.workspace.asRelativePath(thread.uri);
            const line = thread.range.start.line + 1;
            const status = isResolved(thread) ? 'RESOLVED' : 'OPEN';
            const comments = thread.comments.map(c => {
                const role = (c as ReviewComment).role || 'user';
                return `  [${role}] ${commentText(c)}`;
            }).join('\n');
            lines.push(`${threadLabel(thread)} (id ${id}) | ${rel}:${line} | ${status}\n${comments}`);
        }
        return textResult(lines.join('\n\n'));
    }
}

interface ReplyParams { commentId: number; text: string; }

class ReplyToCommentTool implements vscode.LanguageModelTool<ReplyParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReplyParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { commentId, text } = options.input;
        const thread = threadMap.get(commentId);
        if (!thread) return textResult(`Comment #${commentId} not found.`);

        thread.comments = [...thread.comments, new ReviewComment(text, 'agent')];
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        threadsChanged();
        return textResult(`Replied to comment #${commentId} as agent.`);
    }
}

interface CommentIdParam { commentId: number; }

class ResolveCommentTool implements vscode.LanguageModelTool<CommentIdParam> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CommentIdParam>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { commentId } = options.input;
        const thread = threadMap.get(commentId);
        if (!thread) return textResult(`Comment #${commentId} not found.`);

        resolveThread(thread);
        threadsChanged();
        return textResult(`Comment #${commentId} resolved.`);
    }
}

class DeleteCommentTool implements vscode.LanguageModelTool<CommentIdParam> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CommentIdParam>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { commentId } = options.input;
        const thread = threadMap.get(commentId);
        if (!thread) return textResult(`Comment #${commentId} not found.`);

        untrackThread(thread);
        thread.dispose();
        threadsChanged();
        return textResult(`Comment #${commentId} deleted.`);
    }
}
