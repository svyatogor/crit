const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs');

const { spawnSync } = require('node:child_process');

const {
    IPC_PROTOCOL_VERSION,
    ipcDescriptorPath,
    ipcTempDescriptorName,
    readDescriptor,
    resolveLiveInstance,
    sweepIpcRegistry,
} = require('../src/ipc-registry.ts');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Pid of a process that has already exited. */
function deadPid() {
    return spawnSync(process.execPath, ['-e', '']).pid;
}

function registryDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-registry-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeDescriptor(dir, sessionRef, overrides = {}) {
    const descriptorPath = ipcDescriptorPath(sessionRef, dir);
    fs.writeFileSync(descriptorPath, JSON.stringify({
        protocolVersion: IPC_PROTOCOL_VERSION,
        sessionRef,
        port: 40000,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        ...overrides,
    }));
    return descriptorPath;
}

/** Backdate a file so the sweep's age thresholds are exercised for real. */
function age(filePath, byMs) {
    const when = new Date(Date.now() - byMs);
    fs.utimesSync(filePath, when, when);
    return filePath;
}

test('sweeping removes descriptors whose owning process is gone', t => {
    const dir = registryDir(t);
    const dead = writeDescriptor(dir, 'aaaaaaaa', { pid: deadPid() });
    const live = writeDescriptor(dir, 'bbbbbbbb', { pid: process.pid });

    assert.equal(sweepIpcRegistry(dir), 1);
    assert.equal(fs.existsSync(dead), false);
    assert.equal(fs.existsSync(live), true);
});

test('sweeping keeps every descriptor while its process is alive', t => {
    const dir = registryDir(t);
    writeDescriptor(dir, 'aaaaaaaa');
    writeDescriptor(dir, 'bbbbbbbb');

    assert.equal(sweepIpcRegistry(dir), 0);
    assert.equal(fs.readdirSync(dir).length, 2);
});

test('a descriptor of an unknown protocol version is not trusted or kept', t => {
    const dir = registryDir(t);
    const future = writeDescriptor(dir, 'aaaaaaaa', { protocolVersion: 99 });

    assert.equal(readDescriptor(future), undefined);
    // Unparseable as a descriptor, so it is aged out rather than removed now.
    assert.equal(sweepIpcRegistry(dir), 0);

    age(future, 2 * DAY_MS);
    assert.equal(sweepIpcRegistry(dir), 1);
    assert.equal(fs.existsSync(future), false);
});

test('an unreadable file survives until no in-flight write could explain it', t => {
    const dir = registryDir(t);
    const partial = path.join(dir, 'cccccccc.json');
    fs.writeFileSync(partial, '{"protocolVersion":1,"sessi');

    assert.equal(sweepIpcRegistry(dir), 0);
    assert.equal(fs.existsSync(partial), true);

    age(partial, 2 * DAY_MS);
    assert.equal(sweepIpcRegistry(dir), 1);
    assert.equal(fs.existsSync(partial), false);
});

test('temp files abandoned by a crashed write are aged out', t => {
    const dir = registryDir(t);
    const tempPath = path.join(dir, ipcTempDescriptorName('dddddddd', 4242));
    fs.writeFileSync(tempPath, '{}');

    assert.equal(sweepIpcRegistry(dir), 0);
    assert.equal(fs.existsSync(tempPath), true);

    age(tempPath, 2 * HOUR_MS);
    assert.equal(sweepIpcRegistry(dir), 1);
    assert.equal(fs.existsSync(tempPath), false);
});

test('sweeping ignores unrelated files and a missing registry', t => {
    const dir = registryDir(t);
    const unrelated = path.join(dir, 'notes.txt');
    fs.writeFileSync(unrelated, 'not a descriptor');
    age(unrelated, 30 * DAY_MS);

    assert.equal(sweepIpcRegistry(dir), 0);
    assert.equal(fs.existsSync(unrelated), true);
    assert.equal(sweepIpcRegistry(path.join(dir, 'absent')), 0);
});

test('descriptors are validated field by field before they are trusted', t => {
    const dir = registryDir(t);

    assert.equal(readDescriptor(path.join(dir, 'missing.json')), undefined);
    assert.equal(readDescriptor(writeDescriptor(dir, 'e1', { port: 0 })), undefined);
    assert.equal(readDescriptor(writeDescriptor(dir, 'e2', { port: 70000 })), undefined);
    assert.equal(readDescriptor(writeDescriptor(dir, 'e3', { pid: -1 })), undefined);
    assert.equal(readDescriptor(writeDescriptor(dir, 'e4', { sessionRef: '' })), undefined);
    assert.equal(readDescriptor(writeDescriptor(dir, 'e5', { startedAt: 17 })), undefined);

    assert.deepEqual(readDescriptor(writeDescriptor(dir, 'ffffffff', { port: 1234, pid: 77 })), {
        protocolVersion: IPC_PROTOCOL_VERSION,
        sessionRef: 'ffffffff',
        port: 1234,
        pid: 77,
        startedAt: readDescriptor(ipcDescriptorPath('ffffffff', dir)).startedAt,
    });
});

test('resolving an instance yields the live descriptor', t => {
    const dir = registryDir(t);
    writeDescriptor(dir, 'aaaaaaaa', { port: 4321 });

    assert.equal(resolveLiveInstance('aaaaaaaa', dir).port, 4321);
});

test('resolving explains why an instance cannot be reached', t => {
    const dir = registryDir(t);

    assert.throws(
        () => resolveLiveInstance('aaaaaaaa', dir),
        /Missing or stale Crit instance descriptor/
    );

    writeDescriptor(dir, 'bbbbbbbb', { pid: deadPid() });
    assert.throws(() => resolveLiveInstance('bbbbbbbb', dir), /no longer running/);

    writeDescriptor(dir, 'cccccccc', { port: 0 });
    assert.throws(() => resolveLiveInstance('cccccccc', dir), /Malformed .*port/);

    // A descriptor naming a different session must never be routed to.
    writeDescriptor(dir, 'dddddddd', { sessionRef: 'eeeeeeee' });
    assert.throws(() => resolveLiveInstance('dddddddd', dir), /sessionRef must match dddddddd/);
});
