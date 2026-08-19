import { sortBy } from 'es-toolkit'
import * as vscode from 'vscode'
import { type ClaudeDelivery } from './claude-delivery'
import { findRelevantHunk, getFileDiffHunks } from './git'
import {
  commentText,
  diagnosticCode,
  type ReviewComment,
  threadLabel,
  type TrackedCommentThread,
} from './review-threads'
import { render } from './templates'
import nudgeDiagnosticsTemplate from './prompts/nudge-diagnostics.md'
import nudgeMcpTemplate from './prompts/nudge-mcp.md'
import reviewIntro from './prompts/review-intro.md'
import reviewIntroCodes from './prompts/review-intro-codes.md'
import reviewOutroMcp from './prompts/review-outro-mcp.md'
import reviewOutroTools from './prompts/review-outro-tools.md'
import reviewRequest from './prompts/review-request.md'

/**
 * Everything this extension says to an agent.
 *
 * Two shapes, for two delivery paths: the full prompt, which inlines the
 * comments and their code context, and the nudge, which points at them.
 *
 * The prose lives in markdown templates under `src/prompts/`, so wording can be
 * edited without touching the assembly code; this file only fills in the
 * per-review values (codes, files, diff hunks).
 */

/**
 * A short message pointing an agent at the review comments instead of inlining
 * them.
 *
 * Inlining the full prompt fails on both live-delivery paths. A cross-session
 * message is never rendered by the Claude Code panel — its webview has no
 * renderer for peer messages and the text is not persisted as a transcript
 * entry — so the user cannot see what was sent. On the terminal the CLI folds a
 * multi-line send into a collapsed paste, so a long prompt is just as invisible.
 * A nudge sidesteps both: the agent fetches the comments itself, and that fetch
 * is a tool call the user can see.
 *
 * `source` selects how the agent discovers the comments:
 *  - `diagnostics` — VS Code's own diagnostics, which the Claude Code CLI can
 *    reach through its IDE integration but the panel cannot.
 *  - `mcp` — this extension's MCP server, reachable from both.
 *
 * Either way the agent is told to read the threads through `listDiffComments`:
 * a diagnostic carries only the request text (see `diagnosticMessage`), so an
 * agent working from diagnostics alone would miss earlier replies and a
 * thread's resolved state.
 */
export function buildNudgeMessage(threads: TrackedCommentThread[], source: 'diagnostics' | 'mcp'): string {
  const count = threads.length
  const subject = `${count} Crit review comment${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} ready in this workspace.`
  // Comments spread across several workspace roots would need one code per
  // root; the first thread's code covers the usual single-root case.
  const code = diagnosticCode(threads[0])

  if (source === 'diagnostics') {
    return render(nudgeDiagnosticsTemplate, {
      subject,
      label: threadLabel(threads[0]),
      code,
    })
  }

  return render(nudgeMcpTemplate, { subject, code })
}

/** What a review request asks for, in the wording the template needs. */
export interface ReviewScope {
  kind: 'project' | 'file'
  /** For messages to the user, e.g. `src/git.ts` or `this workspace`. */
  label: string
  /** Argument for `/code-review`, with its leading space, or empty. */
  args: string
  /** Project code the findings are posted against. */
  code: string
}

/**
 * The review request, in the shape each delivery path needs.
 *
 * All three send the `/code-review` slash command — it expands on the terminal,
 * in a cross-session message, and in a new conversation alike — and all three
 * take the same text: the CLI reads a multi-line send as a paste, so the
 * template's line breaks survive the terminal too.
 */
export function buildReviewRequest(scope: ReviewScope): ClaudeDelivery {
  const request = render(reviewRequest, { args: scope.args, code: scope.code })
  return {
    terminal: request,
    message: request,
    editor: request,
  }
}

export async function buildPrompt(
  targetThreads: TrackedCommentThread[],
  includeDiagnosticCodes = false,
): Promise<string> {
  const byFile = Map.groupBy(targetThreads, (thread) => thread.uri.toString())

  const parts: string[] = []
  parts.push(render(reviewIntro) + '\n')
  if (includeDiagnosticCodes) {
    parts.push(render(reviewIntroCodes) + '\n')
  }

  for (const [uriStr, fileThreads] of byFile) {
    const uri = vscode.Uri.parse(uriStr)
    const rel = vscode.workspace.asRelativePath(uri)
    parts.push(`## ${rel}\n`)

    // Get diff hunks for this file (once per file)
    const hunks = await getFileDiffHunks(uri)

    const sorted = sortBy(fileThreads, [(thread) => thread.range.start.line])

    for (const thread of sorted) {
      const line = thread.range.start.line + 1

      // Format comment thread with roles
      const body = thread.comments
        .map((c) => {
          const role = (c as ReviewComment).role || 'user'
          const text = commentText(c)
          return thread.comments.length > 1 ? `[${role}]: ${text}` : text
        })
        .join('\n')

      const codeContext = await surroundingCode(uri, thread)

      // Find relevant diff hunk for this line
      const diffHunk = findRelevantHunk(hunks, line)

      parts.push(`### ${threadLabel(thread)} — Line ${line}`)
      if (codeContext) {
        parts.push('```')
        parts.push(codeContext)
        parts.push('```')
      }
      if (diffHunk) {
        parts.push('**Git diff:**')
        parts.push('```diff')
        parts.push(diffHunk)
        parts.push('```')
      }
      if (includeDiagnosticCodes) {
        parts.push(`**Diagnostic code:** \`${diagnosticCode(thread)}\``)
      }
      parts.push(`**Comment:** ${body}\n`)
    }
  }

  parts.push(render(includeDiagnosticCodes ? reviewOutroMcp : reviewOutroTools))
  return parts.join('\n')
}

/** ~5 lines around the commented line, with the line itself marked. */
async function surroundingCode(uri: vscode.Uri, thread: TrackedCommentThread): Promise<string> {
  try {
    const uriStr = uri.toString()
    const doc =
      vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr) ??
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath) ??
      (await vscode.workspace.openTextDocument(uri))

    const s = Math.max(0, thread.range.start.line - 2)
    const e = Math.min(doc.lineCount - 1, thread.range.end.line + 2)
    const lines: string[] = []
    for (let i = s; i <= e; i++) {
      const marker = i === thread.range.start.line ? '→' : ' '
      lines.push(`${marker} ${i + 1} | ${doc.lineAt(i).text}`)
    }
    return lines.join('\n')
  } catch {
    // Proceed without context
    return ''
  }
}
