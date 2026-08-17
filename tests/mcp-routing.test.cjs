const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const {
    createProjectRef,
    createSessionRef,
    createThreadRef,
    encodeDiagnosticMetadata,
} = require('../out/diagnostic-metadata.js');

const registryDir = path.join(os.tmpdir(), 'diff-review', 'instances');

function startFakeInstance(name, threadRef) {
    const requests = [];
    const state = {
        version: 2,
        nextThreadId: 2,
        nextCommentId: 2,
        threads: [{
            id: 1,
            threadRef,
            uri: `file:///workspace/${name}.ts`,
            startLine: 4,
            endLine: 4,
            status: 'open',
            comments: [{ id: 1, role: 'user', body: `Review ${name}`, timestamp: new Date().toISOString() }],
        }],
    };

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const bodyText = Buffer.concat(chunks).toString('utf-8');
            const body = bodyText ? JSON.parse(bodyText) : undefined;
            requests.push({ method: req.method, url: req.url, body });
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(200);
            res.end(JSON.stringify(req.method === 'GET' ? state : { ok: true }));
        });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Fake IPC server did not expose a TCP port.'));
                return;
            }
            resolve({ server, port: address.port, requests });
        });
    });
}

function writeDescriptor(sessionRef, port, pid = process.pid) {
    fs.mkdirSync(registryDir, { recursive: true });
    const descriptorPath = path.join(registryDir, `${sessionRef}.json`);
    fs.writeFileSync(descriptorPath, JSON.stringify({
        protocolVersion: 1,
        sessionRef,
        port,
        pid,
        startedAt: new Date().toISOString(),
    }));
    return descriptorPath;
}

/** Pid of a process that has already exited, for stale-descriptor cases. */
function deadPid() {
    return spawnSync(process.execPath, ['-e', '']).pid;
}

function toolText(result) {
    return result.content.map(part => part.type === 'text' ? part.text : '').join('\n');
}

test('diagnostic codes route MCP calls to the matching VS Code instance', async t => {
    const sessionA = createSessionRef();
    const sessionB = createSessionRef();
    const projectRef = createProjectRef('file:///workspace');
    const threadA = createThreadRef();
    const threadB = createThreadRef();
    const instanceA = await startFakeInstance('alpha', threadA);
    const instanceB = await startFakeInstance('beta', threadB);
    const descriptorA = writeDescriptor(sessionA, instanceA.port);
    const descriptorB = writeDescriptor(sessionB, instanceB.port);
    const descriptors = [descriptorA, descriptorB];

    const codeA = encodeDiagnosticMetadata({
        version: 1,
        sessionRef: sessionA,
        projectRef,
        threadRef: threadA,
    });
    const codeB = encodeDiagnosticMetadata({
        version: 1,
        sessionRef: sessionB,
        projectRef,
        threadRef: threadB,
    });

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(__dirname, '..', 'out', 'mcp-server.js')],
        env: Object.fromEntries(
            Object.entries(process.env).filter(([, value]) => typeof value === 'string')
        ),
        stderr: 'pipe',
    });
    const client = new Client({ name: 'diff-review-routing-test', version: '1.0.0' });

    t.after(async () => {
        await client.close().catch(() => {});
        await Promise.all([
            new Promise(resolve => instanceA.server.close(resolve)),
            new Promise(resolve => instanceB.server.close(resolve)),
        ]);
        for (const descriptorPath of descriptors) {
            try { fs.unlinkSync(descriptorPath); } catch {}
        }
    });

    await client.connect(transport);

    const listA = await client.callTool({ name: 'listDiffComments', arguments: { code: codeA } });
    const listB = await client.callTool({ name: 'listDiffComments', arguments: { code: codeB } });
    assert.match(toolText(listA), /alpha\.ts/);
    assert.doesNotMatch(toolText(listA), /beta\.ts/);
    assert.match(toolText(listA), new RegExp(sessionA));
    assert.match(toolText(listB), /beta\.ts/);
    assert.doesNotMatch(toolText(listB), /alpha\.ts/);
    assert.match(instanceA.requests[0].url, new RegExp(`projectRef=${projectRef}`));
    assert.match(instanceB.requests[0].url, new RegExp(`projectRef=${projectRef}`));

    const resolveResult = await client.callTool({
        name: 'resolveDiffComment',
        arguments: { code: codeB },
    });
    assert.match(toolText(resolveResult), new RegExp(threadB));
    assert.equal(instanceA.requests.filter(request => request.method === 'POST').length, 0);
    const betaMutation = instanceB.requests.find(request => request.method === 'POST');
    assert.deepEqual(betaMutation, {
        method: 'POST',
        url: '/resolve',
        body: { threadRef: threadB },
    });

    const requestCounts = [instanceA.requests.length, instanceB.requests.length];
    const staleCode = encodeDiagnosticMetadata({
        version: 1,
        sessionRef: createSessionRef(),
        projectRef,
        threadRef: createThreadRef(),
    });
    const staleResult = await client.callTool({
        name: 'listDiffComments',
        arguments: { code: staleCode },
    });
    assert.match(toolText(staleResult), /Missing or stale Diff Review instance descriptor/);
    assert.deepEqual(
        [instanceA.requests.length, instanceB.requests.length],
        requestCounts,
        'a stale code must not fall back to an active instance'
    );

    // A leaked descriptor names a port the OS is free to hand to an unrelated
    // process, so the descriptor alone must not authorise a request.
    const crashedSession = createSessionRef();
    descriptors.push(writeDescriptor(crashedSession, instanceA.port, deadPid()));
    const crashedResult = await client.callTool({
        name: 'listDiffComments',
        arguments: {
            code: encodeDiagnosticMetadata({
                version: 1,
                sessionRef: crashedSession,
                projectRef,
                threadRef: createThreadRef(),
            }),
        },
    });
    assert.match(toolText(crashedResult), /no longer running/);
    assert.deepEqual(
        [instanceA.requests.length, instanceB.requests.length],
        requestCounts,
        'a descriptor whose process has exited must not be routed to'
    );
});
