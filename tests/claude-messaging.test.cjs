const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs');

const {
    buildUserMessageFrame,
    sendMessageToSocket,
} = require('../src/claude-messaging.ts');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A stand-in inbox. Mirrors the parts of Claude Code's socket that matter to
 * this client: newline-delimited framing, and never acking.
 */
function startInbox({ allowHalfOpen = false, silent = false } = {}) {
    // Unix socket paths are length-limited, so stay directly under tmpdir
    // rather than nesting inside a long mkdtemp path.
    const socketPath = path.join(os.tmpdir(), `dr-inbox-${process.pid}-${Date.now()}.sock`);
    const lines = [];
    const connections = new Set();

    const server = net.createServer({ allowHalfOpen }, socket => {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
        // A client that gives up destroys its socket, resetting this one.
        socket.on('error', () => {});
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk.toString('utf-8');
            let index;
            while ((index = buffer.indexOf('\n')) !== -1) {
                lines.push(buffer.slice(0, index));
                buffer = buffer.slice(index + 1);
            }
        });
        // The real inbox half-closes and writes nothing back.
        socket.on('end', () => { if (!silent) socket.end(); });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve({
            socketPath,
            lines,
            close: () => new Promise(done => {
                // server.close() only stops listening; a half-open connection
                // would keep its callback pending forever.
                for (const socket of connections) socket.destroy();
                server.close(() => {
                    try { fs.unlinkSync(socketPath); } catch {}
                    done();
                });
            }),
        }));
    });
}

test('builds a user frame the receiver will accept', () => {
    const frame = JSON.parse(buildUserMessageFrame('apply the review comments'));

    assert.equal(frame.type, 'user');
    assert.deepEqual(frame.message, { role: 'user', content: 'apply the review comments' });
    assert.equal(frame.priority, 'next');
    assert.match(frame.msg_id, UUID_V4);

    // A mismatched session_id makes the receiver drop the message, so it must
    // never be sent; msgV is written by Claude Code but never read.
    assert.equal('session_id' in frame, false);
    assert.equal('msgV' in frame, false);
    // Without an inbox of our own, a reply address would only invite receipts
    // we cannot receive.
    assert.equal('from' in frame, false);
});

test('honours priority and reply address when asked', () => {
    const withOptions = JSON.parse(buildUserMessageFrame('text', {
        priority: 'later',
        from: 'uds:/tmp/cc-socks/1234.sock',
    }));

    assert.equal(withOptions.priority, 'later');
    assert.equal(withOptions.from, 'uds:/tmp/cc-socks/1234.sock');
});

test('frames stay on one line so the receiver splits them correctly', () => {
    const frame = buildUserMessageFrame('line one\nline two\r\nline three');

    assert.equal(frame.includes('\n'), false);
    assert.equal(JSON.parse(frame).message.content, 'line one\nline two\r\nline three');
});

test('rejects empty text and frames too large to deliver', () => {
    assert.throws(() => buildUserMessageFrame(''), /non-empty string/);
    assert.throws(() => buildUserMessageFrame('a'.repeat(1_000_000)), /too large to deliver/);
});

test('delivers exactly one newline-terminated frame to the inbox', async t => {
    const inbox = await startInbox();
    t.after(inbox.close);

    await sendMessageToSocket(inbox.socketPath, 'review comments are ready');

    assert.equal(inbox.lines.length, 1);
    const frame = JSON.parse(inbox.lines[0]);
    assert.equal(frame.type, 'user');
    assert.equal(frame.message.content, 'review comments are ready');
});

test('delivers a large frame intact', async t => {
    const inbox = await startInbox();
    t.after(inbox.close);

    const text = 'x'.repeat(200_000);
    await sendMessageToSocket(inbox.socketPath, text);

    assert.equal(inbox.lines.length, 1);
    assert.equal(JSON.parse(inbox.lines[0]).message.content, text);
});

test('reports a session that is no longer listening', async () => {
    const missing = path.join(os.tmpdir(), `dr-inbox-missing-${process.pid}.sock`);

    await assert.rejects(
        () => sendMessageToSocket(missing, 'anyone there?'),
        /may have exited/,
    );
});

test('times out instead of hanging on a socket that never closes', async t => {
    const inbox = await startInbox({ allowHalfOpen: true, silent: true });
    t.after(inbox.close);

    await assert.rejects(
        () => sendMessageToSocket(inbox.socketPath, 'hello', { timeoutMs: 250 }),
        /Timed out after 250ms/,
    );
});
