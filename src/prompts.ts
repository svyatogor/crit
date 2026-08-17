import * as vscode from 'vscode';
import { findRelevantHunk, getFileDiffHunks } from './git';
import {
    commentText,
    diagnosticCode,
    ReviewComment,
    threadLabel,
    TrackedCommentThread,
} from './review-threads';

/**
 * Everything this extension says to an agent.
 *
 * Two shapes, for two delivery paths: the full prompt, which inlines the
 * comments and their code context, and the nudge, which points at them.
 */

/**
 * A short message pointing an agent at the review comments instead of inlining
 * them.
 *
 * Inlining the full prompt fails on both live-delivery paths, for different
 * reasons. A cross-session message is never rendered by the Claude Code panel —
 * its webview has no renderer for peer messages and the text is not persisted
 * as a transcript entry — so the user cannot see what was sent. And
 * `Terminal.sendText` submits on every newline, so markdown would arrive as
 * dozens of fragments. A nudge sidesteps both: the agent fetches the comments
 * itself, and that fetch is a tool call the user can see.
 *
 * `source` selects how the agent should read them:
 *  - `diagnostics` — VS Code's own diagnostics, which the Claude Code CLI can
 *    reach through its IDE integration but the panel cannot.
 *  - `mcp` — this extension's MCP server, reachable from both.
 */
export function buildNudgeMessage(
    threads: TrackedCommentThread[],
    source: 'diagnostics' | 'mcp',
): string {
    const count = threads.length;
    const subject = `${count} Crit comment${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} ready`;
    // Comments spread across several workspace roots would need one code per
    // root; the first thread's code covers the usual single-root case.
    const code = diagnosticCode(threads[0]);
    const followUp =
        'Apply each requested change, then use replyToDiffComment to explain what you changed ' +
        'and resolveDiffComment to mark it done, passing that comment\'s exact code.';

    if (source === 'diagnostics') {
        // Show the code exactly as it appears on the diagnostic — label and all
        // — so the agent matches what it actually reads. Must stay one line:
        // sendText submits on every newline.
        return `${subject} in this workspace. Call getDiagnostics and look for diagnostics whose ` +
            `source is "Crit" — each one's code field looks like ` +
            `"${threadLabel(threads[0])} ${code}", where the leading label names the comment and ` +
            `the rest routes it. ${followUp}`;
    }

    return [
        `${subject} in this workspace.`,
        '',
        'Read them with listDiffComments from the crit MCP server, using this code:',
        code,
        '',
        `The listing gives each comment its own code. ${followUp}`,
    ].join('\n');
}

export async function buildPrompt(
    targetThreads: TrackedCommentThread[],
    includeDiagnosticCodes = false,
): Promise<string> {
    const byFile = new Map<string, TrackedCommentThread[]>();
    for (const thread of targetThreads) {
        const key = thread.uri.toString();
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key)!.push(thread);
    }

    const parts: string[] = [];
    parts.push(
        'Apply the following review comments to the code. Each comment includes ' +
        'the file, line number, surrounding code context, the git diff (if available), and the requested change.\n'
    );
    if (includeDiagnosticCodes) {
        parts.push(
            'Each comment is labelled with a short review id (R1, R2, …) and its Crit ' +
            'diagnostic code. Pass the exact code — not the label — to Crit MCP tools; ' +
            'the label is only for referring to a comment in your own explanations.\n'
        );
    }

    for (const [uriStr, fileThreads] of byFile) {
        const uri = vscode.Uri.parse(uriStr);
        const rel = vscode.workspace.asRelativePath(uri);
        parts.push(`## ${rel}\n`);

        // Get diff hunks for this file (once per file)
        const hunks = await getFileDiffHunks(uri);

        const sorted = [...fileThreads].sort(
            (a, b) => a.range.start.line - b.range.start.line
        );

        for (const thread of sorted) {
            const line = thread.range.start.line + 1;

            // Format comment thread with roles
            const body = thread.comments
                .map(c => {
                    const role = (c as ReviewComment).role || 'user';
                    const text = commentText(c);
                    return thread.comments.length > 1 ? `[${role}]: ${text}` : text;
                })
                .join('\n');

            const codeContext = await surroundingCode(uri, thread);

            // Find relevant diff hunk for this line
            const diffHunk = findRelevantHunk(hunks, line);

            parts.push(`### ${threadLabel(thread)} — Line ${line}`);
            if (codeContext) {
                parts.push('```');
                parts.push(codeContext);
                parts.push('```');
            }
            if (diffHunk) {
                parts.push('**Git diff:**');
                parts.push('```diff');
                parts.push(diffHunk);
                parts.push('```');
            }
            if (includeDiagnosticCodes) {
                parts.push(`**Diagnostic code:** \`${diagnosticCode(thread)}\``);
            }
            parts.push(`**Comment:** ${body}\n`);
        }
    }

    parts.push('---');
    parts.push('Apply every change above. Keep all other code unchanged.');
    parts.push('');
    if (includeDiagnosticCodes) {
        parts.push('After making the changes, respond via the `crit` MCP server:');
        parts.push('- `mcp__crit__replyToDiffComment({ code, text })` — explain what you changed for each comment');
        parts.push('- `mcp__crit__resolveDiffComment({ code })` — mark each comment as done');
        parts.push('');
        parts.push('Pass the exact **Diagnostic code** shown with each comment above as `code`. Do not pass the R-label — it is only a display name. If a tool reports a stale or unknown code, call `mcp__crit__listDiffComments({ code })` with any current code to re-read the live threads.');
    } else {
        parts.push('After making the changes, use the review tools to respond:');
        parts.push('- Use #replyToDiffComment (with the comment id shown after R, and text) to explain what you changed for each comment');
        parts.push('- Use #resolveDiffComment (with the comment id shown after R) to mark each comment as done');
    }
    return parts.join('\n');
}

/** ~5 lines around the commented line, with the line itself marked. */
async function surroundingCode(
    uri: vscode.Uri,
    thread: TrackedCommentThread,
): Promise<string> {
    try {
        const uriStr = uri.toString();
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uriStr)
            ?? vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath)
            ?? await vscode.workspace.openTextDocument(uri);

        const s = Math.max(0, thread.range.start.line - 2);
        const e = Math.min(doc.lineCount - 1, thread.range.end.line + 2);
        const lines: string[] = [];
        for (let i = s; i <= e; i++) {
            const marker = i === thread.range.start.line ? '→' : ' ';
            lines.push(`${marker} ${i + 1} | ${doc.lineAt(i).text}`);
        }
        return lines.join('\n');
    } catch {
        // Proceed without context
        return '';
    }
}
