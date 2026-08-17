import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    IPC_PROTOCOL_VERSION,
    IpcInstanceDescriptor,
    ipcDescriptorPath,
    ipcRegistryDir,
    ipcTempDescriptorName,
    readDescriptor,
    sweepIpcRegistry,
} from './ipc-registry';
import {
    findThreadByRef,
    getSessionRef,
    projectRefFor,
    resolveThread,
    ReviewComment,
    serializeState,
    threadMap,
    threadsChanged,
    unresolveThread,
    untrackThread,
} from './review-threads';

/**
 * Loopback HTTP server that lets the MCP server read and mutate this window's
 * review comments, plus the registry entry that makes the window findable.
 */

interface RegisteredIpcInstance {
    descriptorPath: string;
    descriptor: IpcInstanceDescriptor;
}

function registerIpcInstance(port: number, log: vscode.OutputChannel): RegisteredIpcInstance {
    const sessionRef = getSessionRef();
    const registryDir = ipcRegistryDir();
    const descriptorPath = ipcDescriptorPath(sessionRef, registryDir);
    const tempPath = path.join(
        registryDir,
        ipcTempDescriptorName(sessionRef, process.pid),
    );
    const descriptor: IpcInstanceDescriptor = {
        protocolVersion: IPC_PROTOCOL_VERSION,
        sessionRef,
        port,
        pid: process.pid,
        startedAt: new Date().toISOString(),
    };

    try {
        fs.mkdirSync(registryDir, { recursive: true });
        // Descriptors are keyed by a per-activation `sessionRef` and removed
        // only on clean dispose, so every crashed window leaks one. Sweeping
        // here bounds the directory to roughly the number of live windows.
        const removed = sweepIpcRegistry(registryDir);
        if (removed > 0) {
            log.appendLine(`[Diff Review] Swept ${removed} stale IPC descriptor(s)`);
        }
        fs.writeFileSync(tempPath, JSON.stringify(descriptor), { encoding: 'utf-8', flag: 'wx' });
        fs.renameSync(tempPath, descriptorPath);
        return { descriptorPath, descriptor };
    } catch (error) {
        try { fs.unlinkSync(tempPath); } catch {}
        throw error;
    }
}

function unregisterIpcInstance(registration: RegisteredIpcInstance): void {
    try {
        const current = readDescriptor(registration.descriptorPath);
        const expected = registration.descriptor;
        const isOwnedDescriptor =
            current !== undefined &&
            current.sessionRef === expected.sessionRef &&
            current.port === expected.port &&
            current.pid === expected.pid &&
            current.startedAt === expected.startedAt;

        if (isOwnedDescriptor) fs.unlinkSync(registration.descriptorPath);
    } catch {
        // Missing, unreadable, or replaced descriptors must not be removed.
    }
}

function threadNotFoundMessage(threadRef: unknown): string {
    if (typeof threadRef !== 'string' || threadRef.length === 0) {
        return 'Thread not found: request must include a non-empty string threadRef.';
    }
    return `Thread with threadRef "${threadRef}" not found in session ${getSessionRef()}.`;
}

export function startIpcServer(
    context: vscode.ExtensionContext,
    log: vscode.OutputChannel,
): Promise<number> {
    return new Promise((resolve, reject) => {
        let registration: RegisteredIpcInstance | undefined;
        const server = http.createServer(async (req, res) => {
            // CORS headers for local use
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', 'localhost');

            const url = new URL(req.url || '/', `http://localhost`);
            const method = req.method || 'GET';

            try {
                if (method === 'GET' && url.pathname === '/comments') {
                    const projectRef = url.searchParams.get('projectRef');
                    const result = serializeState(projectRef === null
                        ? undefined
                        : thread => projectRefFor(thread.uri) === projectRef
                    );
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                } else if (method === 'POST' && url.pathname === '/reply') {
                    const { threadRef, text } = JSON.parse(await readBody(req));
                    const thread = findThreadByRef(threadRef);
                    if (!thread) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: threadNotFoundMessage(threadRef) }));
                        return;
                    }
                    const reply = new ReviewComment(text, 'agent');
                    thread.comments = [...thread.comments, reply];
                    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
                    threadsChanged();
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true, commentId: reply.id }));
                } else if (method === 'POST' && url.pathname === '/resolve') {
                    const { threadRef } = JSON.parse(await readBody(req));
                    const thread = findThreadByRef(threadRef);
                    if (!thread) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: threadNotFoundMessage(threadRef) }));
                        return;
                    }
                    resolveThread(thread);
                    threadsChanged();
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                } else if (method === 'POST' && url.pathname === '/unresolve') {
                    const { threadRef } = JSON.parse(await readBody(req));
                    const thread = findThreadByRef(threadRef);
                    if (!thread) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: threadNotFoundMessage(threadRef) }));
                        return;
                    }
                    unresolveThread(thread);
                    threadsChanged();
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                } else if (method === 'POST' && url.pathname === '/delete') {
                    const { threadRef } = JSON.parse(await readBody(req));
                    const thread = findThreadByRef(threadRef);
                    if (!thread) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: threadNotFoundMessage(threadRef) }));
                        return;
                    }
                    untrackThread(thread);
                    thread.dispose();
                    threadsChanged();
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                } else if (method === 'GET' && url.pathname === '/health') {
                    res.writeHead(200);
                    res.end(JSON.stringify({
                        ok: true,
                        comments: threadMap.size,
                        sessionRef: getSessionRef(),
                    }));
                } else {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Not found' }));
                }
            } catch (err: any) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: err.message }));
            }
        });

        // Listen on random available port
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (addr && typeof addr !== 'string') {
                try {
                    registration = registerIpcInstance(addr.port, log);
                    resolve(addr.port);
                } catch (error) {
                    server.close();
                    reject(error);
                }
            } else {
                server.close();
                reject(new Error('Failed to get server address'));
            }
        });

        server.on('error', reject);
        context.subscriptions.push({
            dispose: () => {
                server.close();
                if (registration) unregisterIpcInstance(registration);
            },
        });
    });
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
    });
}
