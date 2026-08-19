const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs')

const { spawnSync } = require('node:child_process')

const {
  IPC_PROTOCOL_VERSION,
  ipcDescriptorPath,
  listLiveInstances,
  projectRegistryDir,
  readDescriptor,
  removeInstanceDescriptor,
  resolveLiveInstance,
  sweepIpcRegistry,
  writeInstanceDescriptor,
} = require('../src/ipc-registry.ts')

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const PROJECT = 'aaaaaaaa'
const OTHER_PROJECT = 'bbbbbbbb'

/** Pid of a process that has already exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

function registryDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-registry-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function descriptor(overrides = {}) {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    projectRef: PROJECT,
    projectPath: '/workspace/project',
    port: 40000,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    lastFocusedAt: new Date().toISOString(),
    ...overrides,
  }
}

/** A descriptor on disk, as a window publishes it. */
function publish(dir, overrides = {}) {
  const written = descriptor(overrides)
  const descriptorPath = writeInstanceDescriptor(written, dir)
  return { descriptor: written, path: descriptorPath }
}

/** A file on disk that no descriptor writer would produce. */
function publishRaw(dir, projectRef, pid, contents) {
  const projectDir = projectRegistryDir(projectRef, dir)
  fs.mkdirSync(projectDir, { recursive: true })
  const descriptorPath = path.join(projectDir, `${pid}.json`)
  fs.writeFileSync(descriptorPath, contents)
  return descriptorPath
}

/** Backdate a file so the sweep's age thresholds are exercised for real. */
function age(filePath, byMs) {
  const when = new Date(Date.now() - byMs)
  fs.utimesSync(filePath, when, when)
  return filePath
}

test('a descriptor is published under its project, keyed by the window pid', (t) => {
  const dir = registryDir(t)
  const { descriptor: written, path: writtenPath } = publish(dir, { port: 4321, pid: 77 })

  assert.equal(writtenPath, ipcDescriptorPath(PROJECT, 77, dir))
  assert.deepEqual(readDescriptor(writtenPath), written)
  // No temp file left behind by the atomic write.
  assert.deepEqual(fs.readdirSync(projectRegistryDir(PROJECT, dir)), ['77.json'])
})

test('republishing replaces this window descriptor in place', (t) => {
  const dir = registryDir(t)
  const startedAt = new Date().toISOString()
  publish(dir, { startedAt, lastFocusedAt: '2026-08-19T10:00:00.000Z' })
  publish(dir, { startedAt, lastFocusedAt: '2026-08-19T11:00:00.000Z' })

  const entries = fs.readdirSync(projectRegistryDir(PROJECT, dir))
  assert.deepEqual(entries, [`${process.pid}.json`])
  assert.equal(resolveLiveInstance(PROJECT, dir).lastFocusedAt, '2026-08-19T11:00:00.000Z')
})

test('resolving a project yields the live window that was focused last', (t) => {
  const dir = registryDir(t)
  publish(dir, { pid: process.pid, port: 5001, lastFocusedAt: '2026-08-19T09:00:00.000Z' })
  publish(dir, { pid: process.ppid, port: 5002, lastFocusedAt: '2026-08-19T12:00:00.000Z' })

  // One project open in two windows is legal, so the tiebreak is policy, not
  // luck: comments go where the user was last working.
  assert.equal(resolveLiveInstance(PROJECT, dir).port, 5002)
  assert.deepEqual(
    listLiveInstances(PROJECT, dir).map((instance) => instance.port),
    [5002, 5001],
  )
})

test('windows that have never been focused are ordered by activation', (t) => {
  const dir = registryDir(t)
  const focused = '2026-08-19T09:00:00.000Z'
  publish(dir, { pid: process.pid, port: 5001, startedAt: '2026-08-19T08:00:00.000Z', lastFocusedAt: focused })
  publish(dir, { pid: process.ppid, port: 5002, startedAt: '2026-08-19T08:30:00.000Z', lastFocusedAt: focused })

  assert.equal(resolveLiveInstance(PROJECT, dir).port, 5002)
})

test('a dead window is passed over for a live one holding the same project', (t) => {
  const dir = registryDir(t)
  // The most recently focused window, but its process is gone — routing there
  // would reach a port the OS is free to have reassigned.
  publish(dir, { pid: deadPid(), port: 5001, lastFocusedAt: '2026-08-19T12:00:00.000Z' })
  publish(dir, { pid: process.pid, port: 5002, lastFocusedAt: '2026-08-19T09:00:00.000Z' })

  assert.equal(resolveLiveInstance(PROJECT, dir).port, 5002)
  assert.equal(listLiveInstances(PROJECT, dir).length, 1)
})

test('resolving explains why a project cannot be reached', (t) => {
  const dir = registryDir(t)

  assert.throws(() => resolveLiveInstance(PROJECT, dir), /No running VS Code window has the project/)

  // A descriptor left behind by a window that has exited still names the folder,
  // which the ref alone cannot: it is a hash.
  publish(dir, { projectRef: OTHER_PROJECT, projectPath: '/workspace/other', pid: deadPid() })
  assert.throws(() => resolveLiveInstance(OTHER_PROJECT, dir), /No running VS Code window has \/workspace\/other open/)

  // A descriptor too damaged to parse is a window that cannot be reached, which
  // is the same answer as a project no window ever held.
  publishRaw(dir, 'cccccccc', 4242, JSON.stringify({ ...descriptor({ projectRef: 'cccccccc' }), port: 0 }))
  assert.throws(() => resolveLiveInstance('cccccccc', dir), /No running VS Code window has the project/)
})

test('a descriptor filed under the wrong project is never routed to', (t) => {
  const dir = registryDir(t)
  // Would otherwise send a mutation into an unrelated workspace.
  publishRaw(dir, PROJECT, process.pid, JSON.stringify(descriptor({ projectRef: OTHER_PROJECT })))

  assert.deepEqual(listLiveInstances(PROJECT, dir), [])
  assert.throws(() => resolveLiveInstance(PROJECT, dir), /No running VS Code window has the project/)
})

test('descriptors are validated field by field before they are trusted', (t) => {
  const dir = registryDir(t)
  const invalid = (overrides) => readDescriptor(publishRaw(dir, PROJECT, 4242, JSON.stringify(descriptor(overrides))))

  assert.equal(readDescriptor(path.join(dir, 'missing.json')), undefined)
  assert.equal(invalid({ port: 0 }), undefined)
  assert.equal(invalid({ port: 70000 }), undefined)
  assert.equal(invalid({ pid: -1 }), undefined)
  assert.equal(invalid({ projectRef: '' }), undefined)
  assert.equal(invalid({ projectPath: '' }), undefined)
  assert.equal(invalid({ startedAt: 17 }), undefined)
  assert.equal(invalid({ lastFocusedAt: 17 }), undefined)
  assert.equal(invalid({ protocolVersion: 99 }), undefined)
})

test('withdrawing a descriptor removes only this window own entry', (t) => {
  const dir = registryDir(t)
  const mine = publish(dir, { port: 5001 })
  // The same pid republished by a newer activation, on a new port: the outgoing
  // dispose must leave it alone.
  const replaced = publish(dir, { port: 5002 })

  removeInstanceDescriptor(mine.descriptor, dir)
  assert.equal(readDescriptor(replaced.path).port, 5002)

  removeInstanceDescriptor(replaced.descriptor, dir)
  assert.equal(fs.existsSync(replaced.path), false)
  // The project directory goes with the last window holding it.
  assert.equal(fs.existsSync(projectRegistryDir(PROJECT, dir)), false)
})

test('sweeping removes descriptors whose owning process is gone', (t) => {
  const dir = registryDir(t)
  const dead = publish(dir, { pid: deadPid() })
  const live = publish(dir, { projectRef: OTHER_PROJECT, pid: process.pid })

  assert.equal(sweepIpcRegistry(dir), 1)
  assert.equal(fs.existsSync(dead.path), false)
  assert.equal(fs.existsSync(live.path), true)
  // An emptied project leaves no directory behind either.
  assert.equal(fs.existsSync(projectRegistryDir(PROJECT, dir)), false)
  assert.equal(fs.existsSync(projectRegistryDir(OTHER_PROJECT, dir)), true)
})

test('sweeping keeps every descriptor while its process is alive', (t) => {
  const dir = registryDir(t)
  publish(dir, { pid: process.pid })
  publish(dir, { pid: process.ppid })
  publish(dir, { projectRef: OTHER_PROJECT, pid: process.pid })

  assert.equal(sweepIpcRegistry(dir), 0)
  assert.equal(fs.readdirSync(projectRegistryDir(PROJECT, dir)).length, 2)
  assert.equal(fs.readdirSync(projectRegistryDir(OTHER_PROJECT, dir)).length, 1)
})

test('a descriptor of an unknown protocol version is not trusted or kept', (t) => {
  const dir = registryDir(t)
  const future = publishRaw(dir, PROJECT, 4242, JSON.stringify(descriptor({ protocolVersion: 99 })))

  assert.equal(readDescriptor(future), undefined)
  // Unparseable as a descriptor, so it is aged out rather than removed now.
  assert.equal(sweepIpcRegistry(dir), 0)

  age(future, 2 * DAY_MS)
  assert.equal(sweepIpcRegistry(dir), 1)
  assert.equal(fs.existsSync(future), false)
})

test('an unreadable file survives until no in-flight write could explain it', (t) => {
  const dir = registryDir(t)
  const partial = publishRaw(dir, PROJECT, 4242, '{"protocolVersion":2,"projec')

  assert.equal(sweepIpcRegistry(dir), 0)
  assert.equal(fs.existsSync(partial), true)

  age(partial, 2 * DAY_MS)
  assert.equal(sweepIpcRegistry(dir), 1)
  assert.equal(fs.existsSync(partial), false)
})

test('temp files abandoned by a crashed write are aged out', (t) => {
  const dir = registryDir(t)
  const projectDir = projectRegistryDir(PROJECT, dir)
  fs.mkdirSync(projectDir, { recursive: true })
  const tempPath = path.join(projectDir, '.4242.tmp')
  fs.writeFileSync(tempPath, '{}')

  assert.equal(sweepIpcRegistry(dir), 0)
  assert.equal(fs.existsSync(tempPath), true)
  // Never mistaken for a descriptor while it waits.
  assert.deepEqual(listLiveInstances(PROJECT, dir), [])

  age(tempPath, 2 * HOUR_MS)
  assert.equal(sweepIpcRegistry(dir), 1)
  assert.equal(fs.existsSync(tempPath), false)
})

test('sweeping ignores unrelated files and a missing registry', (t) => {
  const dir = registryDir(t)
  const unrelated = path.join(dir, 'notes.txt')
  fs.writeFileSync(unrelated, 'not a descriptor')
  age(unrelated, 30 * DAY_MS)

  assert.equal(sweepIpcRegistry(dir), 0)
  assert.equal(fs.existsSync(unrelated), true)
  assert.equal(sweepIpcRegistry(path.join(dir, 'absent')), 0)
})
