#!/usr/bin/env node
/**
 * MCP Server for Crit.
 * Connects to the VS Code extension's IPC HTTP server to list, add, reply to,
 * resolve, and delete inline review comments.
 *
 * Usage: node mcp-server.js
 * The target extension instance is selected by a Crit code.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { encodeDiagnosticMetadata, parseDiagnosticMetadata } from './diagnostic-metadata';
import { resolveLiveInstance } from './ipc-registry';

// ---------- IPC Client ----------

type DiagnosticMetadata = NonNullable<ReturnType<typeof parseDiagnosticMetadata>>;

interface IpcRoute {
    metadata: DiagnosticMetadata;
    port: number;
}

const IPC_TIMEOUT_MS = 5000;

/**
 * The instance a diagnostic code addresses.
 *
 * Everything about descriptor layout, validity, and liveness belongs to
 * `ipc-registry`; this only turns the code into a session ref and asks for the
 * port.
 */
function resolveIpcRoute(code: string): IpcRoute {
    const metadata = parseDiagnosticMetadata(code);
    if (!metadata) {
        throw new Error(
            'Malformed Crit code. Expected `crit:v1;<session>;<project>;<thread>` or, for a ' +
            'whole project, `crit:v1;<session>;<project>` — each ref an 8-character hex ref. ' +
            'Copy a current code from a Crit diagnostic or review request and try again.'
        );
    }

    return { metadata, port: resolveLiveInstance(metadata.sessionRef).port };
}

/**
 * The thread a code names, for the tools that mutate exactly one.
 *
 * A project code is a legitimate thing to be holding — it is what a review
 * request hands out — so the failure has to say how to get from one to the other
 * rather than just calling the code malformed.
 */
function requireThreadRef(route: IpcRoute): string {
    const { threadRef } = route.metadata;
    if (threadRef === undefined) {
        throw new Error(
            'This tool acts on one comment thread, so it needs that thread\'s own code ' +
            '(`crit:v1;<session>;<project>;<thread>`). The code you passed names only a window ' +
            'and a project. Call listDiffComments with it to read the threads — the listing ' +
            'prints each one\'s code.'
        );
    }
    return threadRef;
}

function ipcGet(route: IpcRoute, endpoint: string): Promise<any> {
    return ipcRequest(route, 'GET', endpoint);
}

function ipcPost(route: IpcRoute, endpoint: string, data: any): Promise<any> {
    return ipcRequest(route, 'POST', endpoint, data);
}

async function ipcRequest(
    route: IpcRoute,
    method: 'GET' | 'POST',
    endpoint: string,
    data?: any,
): Promise<any> {
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
        response = await fetch(`http://127.0.0.1:${route.port}${endpoint}`, {
            method,
            signal: AbortSignal.timeout(IPC_TIMEOUT_MS),
            ...(data === undefined ? {} : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            }),
        });
    } catch (error: unknown) {
        throw isTimeout(error) ? timeoutError(route) : connectionError(route, error);
    }

    const responseText = await response.text();
    let result: any;
    try {
        result = JSON.parse(responseText);
    } catch (error: unknown) {
        if (!response.ok) {
            throw new Error(
                `Crit IPC ${method} ${endpoint} failed with HTTP ${response.status}: ` +
                (responseText || errorMessage(error))
            );
        }
        throw new Error(
            `Crit IPC protocol error: ${method} ${endpoint} returned invalid JSON ` +
            `(${errorMessage(error)}).`
        );
    }

    if (!response.ok) {
        throw responseError(
            result,
            `Crit IPC ${method} ${endpoint} failed with HTTP ${response.status}`
        );
    }
    return result;
}

/** `AbortSignal.timeout` aborts with a `TimeoutError`, which fetch may wrap. */
function isTimeout(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const cause: unknown = (error as { cause?: unknown }).cause;
    return error.name === 'TimeoutError'
        || (cause instanceof Error && cause.name === 'TimeoutError');
}

function timeoutError(route: IpcRoute): Error {
    return new Error(
        `Crit IPC request timed out after ${IPC_TIMEOUT_MS / 1000} seconds for session ` +
        `${route.metadata.sessionRef}. The instance descriptor may be stale; ensure that the ` +
        'matching VS Code window is running.'
    );
}

function connectionError(route: IpcRoute, error: unknown): Error {
    // `fetch` reports every transport failure as "fetch failed"; the cause
    // carries the part worth reading (ECONNREFUSED, EHOSTUNREACH, …).
    const cause: unknown = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const detail = cause instanceof Error
        ? `${errorMessage(error)} (${cause.message})`
        : errorMessage(error);
    return new Error(
        `Could not connect to Crit session ${route.metadata.sessionRef} on ` +
        `127.0.0.1:${route.port}: ${detail}. The instance descriptor may be stale; ` +
        'ensure that the matching VS Code window is running.'
    );
}

function responseError(result: any, fallback: string): Error {
    const message = result && typeof result === 'object' && typeof result.error === 'string'
        ? result.error
        : fallback;
    return new Error(message);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ---------- MCP Server ----------

const server = new McpServer({
    name: 'crit',
    version: '0.1.0',
});

// Avoid excessive type instantiation in the MCP SDK's Zod schema overloads.
const registerTool: any = server.tool.bind(server);

// Tool 1: List comments
registerTool(
    'listDiffComments',
    'List inline review comments for the project identified by a Crit code',
    {
        code: z.string().describe('Any Crit code for the project — a thread code from a diagnostic, or the project code from a review request'),
    },
    async ({ code }: { code: string }) => {
        try {
            const route = resolveIpcRoute(code);
            const endpoint = `/comments?projectRef=${encodeURIComponent(route.metadata.projectRef)}`;
            const state = await ipcGet(route, endpoint);
            if (!state || !Array.isArray(state.threads)) {
                throw new Error('Crit IPC protocol error: comments response is missing the threads array.');
            }
            if (state.threads.length === 0) {
                return { content: [{ type: 'text' as const, text: 'No review comments.' }] };
            }
            const lines = state.threads.map((thread: any, index: number) => {
                if (!thread || typeof thread.threadRef !== 'string') {
                    throw new Error(
                        `Crit IPC protocol error: returned thread at index ${index} is missing a valid threadRef.`
                    );
                }

                let threadCode: string;
                try {
                    threadCode = encodeDiagnosticMetadata({
                        version: route.metadata.version,
                        sessionRef: route.metadata.sessionRef,
                        projectRef: route.metadata.projectRef,
                        threadRef: thread.threadRef,
                    });
                } catch {
                    throw new Error(
                        `Crit IPC protocol error: returned thread at index ${index} has invalid ` +
                        `threadRef ${JSON.stringify(thread.threadRef)}.`
                    );
                }

                if (!Array.isArray(thread.comments)) {
                    throw new Error(
                        `Crit IPC protocol error: thread ${thread.threadRef} is missing the comments array.`
                    );
                }
                const comments = thread.comments
                    .map((comment: any) => `  [${comment.role}] ${comment.body}`)
                    .join('\n');
                return `R${thread.id} | ${thread.uri}:${thread.startLine + 1} | ${String(thread.status).toUpperCase()}` +
                    `\nCode: ${threadCode}\n${comments}`;
            });
            return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
        } catch (error: unknown) {
            return { content: [{ type: 'text' as const, text: `Error: ${errorMessage(error)}` }] };
        }
    }
);

// Tool 2: Add a comment
registerTool(
    'addDiffComment',
    'Leave a new inline review comment on a line of code, as the reviewing agent. ' +
    'Use this to report a review finding where the reader can act on it, instead of ' +
    'printing it in chat.',
    {
        code: z.string().describe('Crit code selecting the VS Code window and project — the project code from a review request, or any thread code from the same project'),
        file: z.string().describe('The file to comment on, relative to the project root (an absolute path inside the project also works)'),
        line: z.number().int().min(1).describe('Line the comment is anchored to, counting from 1'),
        endLine: z.number().int().min(1).optional().describe('Last line, counting from 1, when the finding spans a range'),
        text: z.string().describe('The comment: what is wrong and what to change. One finding per comment.'),
    },
    async (
        { code, file, line, endLine, text }:
        { code: string; file: string; line: number; endLine?: number; text: string },
    ) => {
        try {
            const route = resolveIpcRoute(code);
            const created = await ipcPost(route, '/comment', {
                projectRef: route.metadata.projectRef,
                file,
                startLine: line,
                endLine,
                text,
            });
            if (!created || typeof created.code !== 'string') {
                throw new Error('Crit IPC protocol error: the created comment has no code.');
            }
            return {
                content: [{
                    type: 'text' as const,
                    // The new thread's own code, so a follow-up reply or resolve
                    // has an address without another listing.
                    text: `Added a review comment at ${created.file}:${created.startLine}. ` +
                        `Its code is ${created.code}.`,
                }],
            };
        } catch (error: unknown) {
            return { content: [{ type: 'text' as const, text: `Error: ${errorMessage(error)}` }] };
        }
    }
);

// Tool 3: Reply to comment
registerTool(
    'replyToDiffComment',
    'Reply to an existing inline review comment thread as the agent role',
    {
        code: z.string().describe('Full Crit diagnostic code for the target thread'),
        text: z.string().describe('The reply text'),
    },
    async ({ code, text }: { code: string; text: string }) => {
        try {
            const route = resolveIpcRoute(code);
            const threadRef = requireThreadRef(route);
            await ipcPost(route, '/reply', { threadRef, text });
            return { content: [{ type: 'text' as const, text: `Replied to thread ${threadRef}.` }] };
        } catch (error: unknown) {
            return { content: [{ type: 'text' as const, text: `Error: ${errorMessage(error)}` }] };
        }
    }
);

// Tool 4: Resolve comment
registerTool(
    'resolveDiffComment',
    'Mark an inline review comment as resolved/done',
    {
        code: z.string().describe('Full Crit diagnostic code for the target thread'),
    },
    async ({ code }: { code: string }) => {
        try {
            const route = resolveIpcRoute(code);
            const threadRef = requireThreadRef(route);
            await ipcPost(route, '/resolve', { threadRef });
            return { content: [{ type: 'text' as const, text: `Thread ${threadRef} resolved.` }] };
        } catch (error: unknown) {
            return { content: [{ type: 'text' as const, text: `Error: ${errorMessage(error)}` }] };
        }
    }
);

// Tool 5: Delete comment
registerTool(
    'deleteDiffComment',
    'Delete an inline review comment thread entirely',
    {
        code: z.string().describe('Full Crit diagnostic code for the target thread'),
    },
    async ({ code }: { code: string }) => {
        try {
            const route = resolveIpcRoute(code);
            const threadRef = requireThreadRef(route);
            await ipcPost(route, '/delete', { threadRef });
            return { content: [{ type: 'text' as const, text: `Thread ${threadRef} deleted.` }] };
        } catch (error: unknown) {
            return { content: [{ type: 'text' as const, text: `Error: ${errorMessage(error)}` }] };
        }
    }
);

// ---------- Start ----------

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(console.error);
