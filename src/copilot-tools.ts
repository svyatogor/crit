import * as vscode from 'vscode';
import {
    commentText,
    findThreadByRef,
    isResolved,
    resolveThread,
    ReviewComment,
    threadLabel,
    threadsByRef,
    threadsChanged,
    untrackThread,
} from './review-threads';

/**
 * Language model tools for GitHub Copilot.
 *
 * Copilot addresses a comment by its `threadRef`, exactly as the MCP server
 * does — the display label (R1, R2, …) is a per-branch sequence, so keying on it
 * would let a stale number land on whatever thread now holds it. A stale
 * `threadRef` instead fails loudly.
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

function notFoundResult(threadRef: unknown): vscode.LanguageModelToolResult {
    return textResult(
        typeof threadRef === 'string' && threadRef.length > 0
            ? `Thread with threadRef "${threadRef}" not found. Call crit_listComments for current refs.`
            : 'Thread not found: threadRef must be a non-empty string.'
    );
}

class ListCommentsTool implements vscode.LanguageModelTool<{}> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<{}>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        if (threadsByRef.size === 0) return textResult('No review comments.');

        const lines: string[] = [];
        for (const thread of threadsByRef.values()) {
            const rel = vscode.workspace.asRelativePath(thread.uri);
            const line = thread.range.start.line + 1;
            const status = isResolved(thread) ? 'RESOLVED' : 'OPEN';
            const comments = thread.comments.map(c => {
                const role = (c as ReviewComment).role || 'user';
                return `  [${role}] ${commentText(c)}`;
            }).join('\n');
            lines.push(
                `${threadLabel(thread)} | ${rel}:${line} | ${status}` +
                `\nthreadRef: ${thread.threadRef}\n${comments}`
            );
        }
        return textResult(lines.join('\n\n'));
    }
}

interface ThreadRefParam { threadRef: string; }

interface ReplyParams extends ThreadRefParam { text: string; }

class ReplyToCommentTool implements vscode.LanguageModelTool<ReplyParams> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReplyParams>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { threadRef, text } = options.input;
        const thread = findThreadByRef(threadRef);
        if (!thread) return notFoundResult(threadRef);

        thread.comments = [...thread.comments, new ReviewComment(text, 'agent')];
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        threadsChanged();
        return textResult(`Replied to thread ${threadRef} as agent.`);
    }
}

class ResolveCommentTool implements vscode.LanguageModelTool<ThreadRefParam> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ThreadRefParam>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { threadRef } = options.input;
        const thread = findThreadByRef(threadRef);
        if (!thread) return notFoundResult(threadRef);

        resolveThread(thread);
        threadsChanged();
        return textResult(`Thread ${threadRef} resolved.`);
    }
}

class DeleteCommentTool implements vscode.LanguageModelTool<ThreadRefParam> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ThreadRefParam>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { threadRef } = options.input;
        const thread = findThreadByRef(threadRef);
        if (!thread) return notFoundResult(threadRef);

        untrackThread(thread);
        thread.dispose();
        threadsChanged();
        return textResult(`Thread ${threadRef} deleted.`);
    }
}
