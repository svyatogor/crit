const assert = require('node:assert/strict')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs')

const { spawnSync } = require('node:child_process')

const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { createProjectRef, createThreadRef, encodeDiagnosticMetadata } = require('../src/diagnostic-metadata.ts')
const {
  IPC_PROTOCOL_VERSION,
  ipcRegistryDir,
  removeInstanceDescriptor,
  writeInstanceDescriptor,
} = require('../src/ipc-registry.ts')

/**
 * The MCP server runs as its own process and reads the real registry, so these
 * tests publish descriptors where it looks and remove them afterwards.
 */
function startFakeInstance(name, threadRef) {
  const requests = []
  const state = {
    version: 2,
    nextThreadId: 2,
    nextCommentId: 2,
    threads: [
      {
        id: 1,
        threadRef,
        uri: `file:///workspace/${name}.ts`,
        startLine: 4,
        endLine: 4,
        status: 'open',
        comments: [{ id: 1, role: 'user', body: `Review ${name}`, timestamp: new Date().toISOString() }],
      },
    ],
  }

  // `/comment` answers with the created thread's own code, the way the
  // extension does, so the tool has something to report back.
  const createdThreadRef = createThreadRef()

  function responseFor(method, url) {
    if (method === 'GET') return state
    if (url === '/comment') {
      return {
        ok: true,
        threadRef: createdThreadRef,
        code: `crit:v2;deadbeef;${createdThreadRef}`,
        file: `${name}.ts`,
        startLine: 12,
      }
    }
    return { ok: true }
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf-8')
      const body = bodyText ? JSON.parse(bodyText) : undefined
      requests.push({ method: req.method, url: req.url, body })
      res.setHeader('Content-Type', 'application/json')
      res.writeHead(200)
      res.end(JSON.stringify(responseFor(req.method, req.url)))
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Fake IPC server did not expose a TCP port.'))
        return
      }
      resolve({ server, port: address.port, requests, createdThreadRef })
    })
  })
}

/**
 * Publish a window holding `projectRef`, cleaned up when the test ends.
 *
 * Written through the real writer, so the tests exercise the layout the
 * extension actually produces.
 */
function publishWindow(t, { projectRef, port, pid = process.pid, projectPath = '/workspace', lastFocusedAt } = {}) {
  const now = new Date().toISOString()
  const descriptor = {
    protocolVersion: IPC_PROTOCOL_VERSION,
    projectRef,
    projectPath,
    port,
    pid,
    startedAt: now,
    lastFocusedAt: lastFocusedAt ?? now,
  }
  writeInstanceDescriptor(descriptor)
  t.after(() => removeInstanceDescriptor(descriptor))
  return descriptor
}

/** Pid of a process that has already exited, for stale-descriptor cases. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

function toolText(result) {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
}

/** Closes the fake instance when the test ends. */
async function fakeInstance(t, name, threadRef = createThreadRef()) {
  const instance = await startFakeInstance(name, threadRef)
  t.after(() => new Promise((resolve) => instance.server.close(resolve)))
  return instance
}

/** A client speaking to a real `out/mcp-server.js`, closed when the test ends. */
async function connectClient(t) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'out', 'mcp-server.js')],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'crit-routing-test', version: '1.0.0' })
  t.after(async () => {
    await client.close().catch(() => {})
  })
  await client.connect(transport)
  return client
}

test('a code routes to whichever window holds the project it names', async (t) => {
  const projectA = createProjectRef('file:///workspace/routing-alpha')
  const projectB = createProjectRef('file:///workspace/routing-beta')
  const threadA = createThreadRef()
  const threadB = createThreadRef()
  const instanceA = await fakeInstance(t, 'alpha', threadA)
  const instanceB = await fakeInstance(t, 'beta', threadB)
  publishWindow(t, { projectRef: projectA, port: instanceA.port })
  publishWindow(t, { projectRef: projectB, port: instanceB.port })

  const codeA = encodeDiagnosticMetadata({ version: 2, projectRef: projectA, threadRef: threadA })
  const codeB = encodeDiagnosticMetadata({ version: 2, projectRef: projectB, threadRef: threadB })

  const client = await connectClient(t)

  const listA = await client.callTool({ name: 'listDiffComments', arguments: { code: codeA } })
  const listB = await client.callTool({ name: 'listDiffComments', arguments: { code: codeB } })
  assert.match(toolText(listA), /alpha\.ts/)
  assert.doesNotMatch(toolText(listA), /beta\.ts/)
  assert.match(toolText(listB), /beta\.ts/)
  assert.doesNotMatch(toolText(listB), /alpha\.ts/)
  assert.match(instanceA.requests[0].url, new RegExp(`projectRef=${projectA}`))
  assert.match(instanceB.requests[0].url, new RegExp(`projectRef=${projectB}`))

  const resolveResult = await client.callTool({ name: 'resolveDiffComment', arguments: { code: codeB } })
  assert.match(toolText(resolveResult), new RegExp(threadB))
  assert.equal(instanceA.requests.filter((request) => request.method === 'POST').length, 0)
  assert.deepEqual(
    instanceB.requests.find((request) => request.method === 'POST'),
    { method: 'POST', url: '/resolve', body: { threadRef: threadB } },
  )
})

test('a code an agent is holding survives the window reloading under it', async (t) => {
  const projectRef = createProjectRef('file:///workspace/routing-reload')
  const threadRef = createThreadRef()
  const before = await fakeInstance(t, 'before', threadRef)
  const beforeWindow = publishWindow(t, { projectRef, port: before.port, pid: process.ppid })

  // The code is handed out once, at the start of the review, and the agent keeps
  // using it — a window reload in the middle must not invalidate it.
  const code = encodeDiagnosticMetadata({ version: 2, projectRef, threadRef })
  const client = await connectClient(t)
  assert.match(toolText(await client.callTool({ name: 'listDiffComments', arguments: { code } })), /before\.ts/)

  // Reload: the old extension host withdraws its descriptor and dies, and the
  // new one comes up on a fresh port with a fresh token.
  removeInstanceDescriptor(beforeWindow)
  await new Promise((resolve) => before.server.close(resolve))
  const after = await fakeInstance(t, 'after', threadRef)
  publishWindow(t, { projectRef, port: after.port })

  const listed = await client.callTool({ name: 'listDiffComments', arguments: { code } })
  assert.match(toolText(listed), /after\.ts/, 'the same code must reach the reloaded window')
})

test('one project in two windows routes to the one focused most recently', async (t) => {
  const projectRef = createProjectRef('file:///workspace/routing-duplicate')
  const threadRef = createThreadRef()
  const background = await fakeInstance(t, 'background', threadRef)
  const foreground = await fakeInstance(t, 'foreground', threadRef)
  publishWindow(t, {
    projectRef,
    port: background.port,
    pid: process.ppid,
    lastFocusedAt: '2026-08-19T09:00:00.000Z',
  })
  publishWindow(t, { projectRef, port: foreground.port, lastFocusedAt: '2026-08-19T12:00:00.000Z' })

  const client = await connectClient(t)
  const listed = await client.callTool({
    name: 'listDiffComments',
    arguments: { code: encodeDiagnosticMetadata({ version: 2, projectRef, threadRef }) },
  })

  assert.match(toolText(listed), /foreground\.ts/)
  assert.deepEqual(background.requests, [], 'the window the user left must not be written to')
})

test('a project code routes a new comment to the window holding the project', async (t) => {
  const projectRef = createProjectRef('file:///workspace/routing-request')
  const bystanderRef = createProjectRef('file:///workspace/routing-bystander')
  const instance = await fakeInstance(t, 'gamma')
  const bystander = await fakeInstance(t, 'delta')
  publishWindow(t, { projectRef, port: instance.port })
  publishWindow(t, { projectRef: bystanderRef, port: bystander.port })

  // The code a review request hands out: no thread part, because the agent is
  // being asked to create the threads.
  const projectCode = encodeDiagnosticMetadata({ version: 2, projectRef })
  assert.match(projectCode, /^crit:v2;[0-9a-f]{8}$/)

  const client = await connectClient(t)

  const added = await client.callTool({
    name: 'addDiffComment',
    arguments: {
      code: projectCode,
      file: 'src/git.ts',
      line: 12,
      text: 'This swallows the error — log it or let it propagate.',
    },
  })

  assert.match(toolText(added), /Added a review comment at gamma\.ts:12/)
  // The new thread's own code comes back, so a follow-up reply or resolve
  // needs no second listing.
  assert.match(toolText(added), new RegExp(instance.createdThreadRef))
  assert.deepEqual(instance.requests, [
    {
      method: 'POST',
      url: '/comment',
      body: {
        projectRef,
        file: 'src/git.ts',
        // 1-based on the wire; the extension converts at the boundary.
        startLine: 12,
        text: 'This swallows the error — log it or let it propagate.',
      },
    },
  ])
  assert.deepEqual(bystander.requests, [], 'a project code must reach only its own project')

  // Listing takes either code shape, since it only ever needed the project.
  const listed = await client.callTool({ name: 'listDiffComments', arguments: { code: projectCode } })
  assert.match(toolText(listed), /gamma\.ts/)
  assert.match(instance.requests[1].url, new RegExp(`projectRef=${projectRef}`))

  // But a tool that mutates one thread must not guess which one.
  const requestCount = instance.requests.length
  for (const name of ['replyToDiffComment', 'resolveDiffComment', 'deleteDiffComment']) {
    const result = await client.callTool({ name, arguments: { code: projectCode, text: 'ignored' } })
    assert.match(toolText(result), /needs that thread's own code/, name)
    assert.match(toolText(result), /listDiffComments/, `${name} must say how to recover`)
  }
  assert.equal(instance.requests.length, requestCount, 'a code with no thread must not reach the extension at all')
})

test('a code for a project no window holds reaches no window at all', async (t) => {
  const projectRef = createProjectRef('file:///workspace/routing-unheld')
  const closedRef = createProjectRef('file:///workspace/routing-closed')
  const instance = await fakeInstance(t, 'epsilon')
  publishWindow(t, { projectRef: createProjectRef('file:///workspace/routing-other'), port: instance.port })
  // A leaked descriptor names a port the OS is free to hand to an unrelated
  // process, so the descriptor alone must not authorise a request.
  publishWindow(t, {
    projectRef: closedRef,
    port: instance.port,
    pid: deadPid(),
    projectPath: '/workspace/routing-closed',
  })

  const client = await connectClient(t)

  const unheld = await client.callTool({
    name: 'listDiffComments',
    arguments: { code: encodeDiagnosticMetadata({ version: 2, projectRef }) },
  })
  assert.match(toolText(unheld), /No running VS Code window has the project/)

  const closed = await client.callTool({
    name: 'listDiffComments',
    arguments: { code: encodeDiagnosticMetadata({ version: 2, projectRef: closedRef }) },
  })
  assert.match(toolText(closed), /No running VS Code window has \/workspace\/routing-closed open/)
  assert.deepEqual(instance.requests, [], 'neither failure may fall back to an unrelated window')
})

test('a v1 code, from before routing dropped the session ref, is refused', async (t) => {
  const projectRef = createProjectRef('file:///workspace/routing-legacy')
  const instance = await fakeInstance(t, 'zeta')
  publishWindow(t, { projectRef, port: instance.port })

  const client = await connectClient(t)
  const result = await client.callTool({
    name: 'listDiffComments',
    // The shape Crit issued until the session ref was dropped: its middle ref is
    // the project, so guessing at the shape would route by a stale session ref.
    arguments: { code: `crit:v1;abcdef01;${projectRef};${createThreadRef()}` },
  })

  assert.match(toolText(result), /Malformed Crit code/)
  assert.match(toolText(result), /crit:v2;<project>;<thread>/)
  assert.deepEqual(instance.requests, [])
})

test('the registry lives where both processes can find it', () => {
  // The MCP server is a plain Node process with no VS Code API, so the path has
  // to be derivable without a handshake — and the descriptors these tests
  // published were read by a real one, which is the proof.
  assert.equal(ipcRegistryDir(), path.join(os.tmpdir(), 'crit', 'projects'))
})
