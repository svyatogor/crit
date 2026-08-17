#!/usr/bin/env node
/**
 * MCP Server for Diff Review.
 * Connects to the VS Code extension's IPC HTTP server to list, reply, resolve,
 * and delete inline review comments.
 *
 * Usage: node mcp-server.js
 * The target extension instance is selected by a Diff Review diagnostic code.
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
            'Malformed Diff Review diagnostic code. Expected the full code ' +
            '`diff-review:v1;<session>;<project>;<thread>`, each an 8-character hex ref. ' +
            'Copy a current code from a Diff Review diagnostic and try again.'
        );
    }

    return { metadata, port: resolveLiveInstance(metadata.sessionRef).port };
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
                `Diff Review IPC ${method} ${endpoint} failed with HTTP ${response.status}: ` +
                (responseText || errorMessage(error))
            );
        }
        throw new Error(
            `Diff Review IPC protocol error: ${method} ${endpoint} returned invalid JSON ` +
            `(${errorMessage(error)}).`
        );
    }

    if (!response.ok) {
        throw responseError(
            result,
            `Diff Review IPC ${method} ${endpoint} failed with HTTP ${response.status}`
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
        `Diff Review IPC request timed out after ${IPC_TIMEOUT_MS / 1000} seconds for session ` +
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
        `Could not connect to Diff Review session ${route.metadata.sessionRef} on ` +
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
    name: 'diff-review',
    version: '0.1.0',
});

// Avoid excessive type instantiation in the MCP SDK's Zod schema overloads.
const registerTool: any = server.tool.bind(server);

// Tool 1: List comments
registerTool(
    'listDiffComments',
    'List inline review comments for the project identified by a Diff Review diagnostic code',
    {
        code: z.string().describe('Full Diff Review diagnostic code used to select the VS Code instance and project'),
    },
    async ({ code }: { code: string }) => {
        try {
            const route = resolveIpcRoute(code);
            const endpoint = `/comments?projectRef=${encodeURIComponent(route.metadata.projectRef)}`;
            const state = await ipcGet(route, endpoint);
            if (!state || !Array.isArray(state.threads)) {
                throw new Error('Diff Review IPC protocol error: comments response is missing the threads array.');
            }
            if (state.threads.length === 0) {
                return { content: [{ type: 'text' as const, text: 'No review comments.' }] };
            }
            const lines = state.threads.map((thread: any, index: number) => {
                if (!thread || typeof thread.threadRef !== 'string') {
                    throw new Error(
                        `Diff Review IPC protocol error: returned thread at index ${index} is missing a valid threadRef.`
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
                        `Diff Review IPC protocol error: returned thread at index ${index} has invalid ` +
                        `threadRef ${JSON.stringify(thread.threadRef)}.`
                    );
                }

                if (!Array.isArray(thread.comments)) {
                    throw new Error(
                        `Diff Review IPC protocol error: thread ${thread.threadRef} is missing the comments array.`
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

// Tool 2: Reply to comment
registerTool(
    'replyToDiffComment',
    'Reply to an existing inline review comment thread as the agent role',
    {
        code: z.string().describe('Full Diff Review diagnostic code for the target thread'),
        text: z.string().describe('The reply text'),
    },
    async ({ code, text }: { code: string; text: string }) => {
        try {
            const route = resolveIpcRoute(code);
            await ipcPost(route, '/reply', { threadRef: route.metadata.threadRef, text });
            return { content: [{ type: 'text' as const, text: `Replied to thread ${route.metadata.threadRef}.` }] };
        } catch (error: unknown) {
            return { content: [{ type: 'text' as const, text: `Error: ${errorMessage(error)}` }] };
        }
    }
);

// Tool 3: Resolve comment
registerTool(
    'resolveDiffComment',
    'Mark an inline review comment as resolved/done',
    {
        code: z.string().describe('Full Diff Review diagnostic code for the target thread'),
    },
    async ({ code }: { code: string }) => {
        try {
            const route = resolveIpcRoute(code);
            await ipcPost(route, '/resolve', { threadRef: route.metadata.threadRef });
            return { content: [{ type: 'text' as const, text: `Thread ${route.metadata.threadRef} resolved.` }] };
        } catch (error: unknown) {
            return { content: [{ type: 'text' as const, text: `Error: ${errorMessage(error)}` }] };
        }
    }
);

// Tool 4: Delete comment
registerTool(
    'deleteDiffComment',
    'Delete an inline review comment thread entirely',
    {
        code: z.string().describe('Full Diff Review diagnostic code for the target thread'),
    },
    async ({ code }: { code: string }) => {
        try {
            const route = resolveIpcRoute(code);
            await ipcPost(route, '/delete', { threadRef: route.metadata.threadRef });
            return { content: [{ type: 'text' as const, text: `Thread ${route.metadata.threadRef} deleted.` }] };
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
