const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs');

const {
    findSessionForWorkspace,
    listClaudeSessions,
} = require('../src/claude-sessions.ts');

/**
 * Build an isolated registry: descriptor files, real workspace directories (so
 * the realpath comparison is exercised rather than the lexical fallback), and
 * placeholder socket files, since discovery only checks that the socket exists.
 */
function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-sessions-'));
    const registryDir = path.join(root, 'sessions');
    const socketDir = path.join(root, 'socks');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.mkdirSync(socketDir, { recursive: true });

    const alivePids = new Set();

    function workspace(name) {
        const dir = path.join(root, name);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    function addSession(overrides = {}) {
        const pid = overrides.pid ?? 1000 + alivePids.size + 1;
        const socketPath = overrides.messagingSocketPath ?? path.join(socketDir, `${pid}.sock`);
        if (overrides.bindSocket !== false) fs.writeFileSync(socketPath, '');
        if (overrides.alive !== false) alivePids.add(pid);

        const descriptor = {
            pid,
            sessionId: overrides.sessionId ?? `session-${pid}`,
            cwd: overrides.cwd ?? workspace('default'),
            entrypoint: overrides.entrypoint ?? 'claude-vscode',
            kind: 'interactive',
            peerProtocol: 1,
            messagingSocketPath: socketPath,
            startedAt: overrides.startedAt ?? 1_786_908_000_000 + pid,
            version: '2.1.233',
            ...(overrides.name ? { name: overrides.name } : {}),
        };
        for (const key of overrides.omit ?? []) delete descriptor[key];
        Object.assign(descriptor, overrides.raw ?? {});

        fs.writeFileSync(
            path.join(registryDir, `${overrides.fileName ?? pid}.json`),
            typeof overrides.body === 'string' ? overrides.body : JSON.stringify(descriptor),
        );
        return descriptor;
    }

    return {
        root,
        registryDir,
        workspace,
        addSession,
        options: () => ({ registryDir, isProcessAlive: pid => alivePids.has(pid) }),
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

test('lists only sessions that are alive and still bound to a socket', t => {
    const fx = createFixture();
    t.after(fx.cleanup);

    const live = fx.addSession({ pid: 2001 });
    fx.addSession({ pid: 2002, alive: false });
    fx.addSession({ pid: 2003, bindSocket: false });

    const sessions = listClaudeSessions(fx.options());
    assert.deepEqual(sessions.map(s => s.pid), [live.pid]);
});

test('skips descriptors that are malformed or missing required fields', t => {
    const fx = createFixture();
    t.after(fx.cleanup);

    const good = fx.addSession({ pid: 3001 });
    fx.addSession({ pid: 3002, body: 'not json at all' });
    fx.addSession({ pid: 3003, body: '["an","array"]' });
    fx.addSession({ pid: 3004, omit: ['messagingSocketPath'] });
    fx.addSession({ pid: 3005, omit: ['sessionId'] });
    fx.addSession({ pid: 3006, omit: ['startedAt'] });
    fx.addSession({ pid: 3007, raw: { pid: 'not-a-number' } });

    const sessions = listClaudeSessions(fx.options());
    assert.deepEqual(sessions.map(s => s.pid), [good.pid]);
});

test('a descriptor without status or updatedAt is still valid', t => {
    const fx = createFixture();
    t.after(fx.cleanup);

    // Sessions launched from the VS Code extension omit both fields, so
    // requiring either would discard exactly the sessions we want to reach.
    fx.addSession({ pid: 4001, omit: ['status', 'updatedAt', 'statusUpdatedAt'] });

    assert.equal(listClaudeSessions(fx.options()).length, 1);
});

test('returns sessions newest first', t => {
    const fx = createFixture();
    t.after(fx.cleanup);

    fx.addSession({ pid: 5001, startedAt: 1000 });
    fx.addSession({ pid: 5002, startedAt: 3000 });
    fx.addSession({ pid: 5003, startedAt: 2000 });

    assert.deepEqual(listClaudeSessions(fx.options()).map(s => s.pid), [5002, 5003, 5001]);
});

test('finds the session running in a workspace', t => {
    const fx = createFixture();
    t.after(fx.cleanup);

    const wanted = fx.workspace('project-a');
    const other = fx.workspace('project-b');
    fx.addSession({ pid: 6001, cwd: other });
    fx.addSession({ pid: 6002, cwd: wanted });

    assert.equal(findSessionForWorkspace(wanted, fx.options())?.pid, 6002);
    assert.equal(findSessionForWorkspace(fx.workspace('project-c'), fx.options()), undefined);
});

test('a resumed conversation resolves to its most recent process', t => {
    const fx = createFixture();
    t.after(fx.cleanup);

    // Resuming leaves two live pids sharing one sessionId; the newer process is
    // the one actually serving the conversation.
    const cwd = fx.workspace('resumed');
    fx.addSession({ pid: 7001, cwd, sessionId: 'shared-session', startedAt: 1000 });
    fx.addSession({ pid: 7002, cwd, sessionId: 'shared-session', startedAt: 5000 });

    assert.equal(findSessionForWorkspace(cwd, fx.options())?.pid, 7002);
});

test('filters by entrypoint and excludes a named session', t => {
    const fx = createFixture();
    t.after(fx.cleanup);

    const cwd = fx.workspace('mixed');
    fx.addSession({ pid: 8001, cwd, entrypoint: 'cli', sessionId: 'cli-session' });
    fx.addSession({ pid: 8002, cwd, entrypoint: 'claude-vscode', sessionId: 'panel-session' });

    const panels = listClaudeSessions({ ...fx.options(), entrypoint: 'claude-vscode' });
    assert.deepEqual(panels.map(s => s.sessionId), ['panel-session']);

    // A session must never message itself.
    const others = listClaudeSessions({ ...fx.options(), excludeSessionId: 'panel-session' });
    assert.deepEqual(others.map(s => s.sessionId), ['cli-session']);
});

test('a missing registry directory yields no sessions instead of throwing', () => {
    const missing = path.join(os.tmpdir(), 'crit-no-such-registry-dir');
    assert.deepEqual(listClaudeSessions({ registryDir: missing }), []);
    assert.equal(findSessionForWorkspace(os.tmpdir(), { registryDir: missing }), undefined);
});
