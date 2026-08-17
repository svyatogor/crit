const assert = require('node:assert/strict')
const test = require('node:test')

// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs')

const {
  createProjectRef,
  createSessionRef,
  createThreadRef,
  encodeDiagnosticMetadata,
  parseDiagnosticMetadata,
} = require('../src/diagnostic-metadata.ts')

test('diagnostic metadata round trips through the versioned code', () => {
  const metadata = {
    version: 1,
    sessionRef: createSessionRef(),
    projectRef: createProjectRef('file:///workspace/project'),
    threadRef: createThreadRef(),
  }

  const code = encodeDiagnosticMetadata(metadata)

  assert.match(code, /^crit:v1;[0-9a-f]{8};[0-9a-f]{8};[0-9a-f]{8}$/)
  // The code is rendered verbatim in the Problems view, so keep it short.
  assert.ok(code.length <= 45, `code too long for the Problems view: ${code.length}`)
  assert.deepEqual(parseDiagnosticMetadata(code), metadata)
})

test('a project code addresses a window and project with no thread', () => {
  // What a review request hands out: the agent is being asked to create the
  // threads, so there is no thread to name yet.
  const metadata = {
    version: 1,
    sessionRef: createSessionRef(),
    projectRef: createProjectRef('file:///workspace/project'),
  }

  const code = encodeDiagnosticMetadata(metadata)

  assert.match(code, /^crit:v1;[0-9a-f]{8};[0-9a-f]{8}$/)
  assert.deepEqual(parseDiagnosticMetadata(code), metadata)
  // Absent, not undefined — so a round trip compares equal and callers can
  // test for a thread with a plain `=== undefined`.
  assert.equal('threadRef' in parseDiagnosticMetadata(code), false)
})

test('parser rejects malformed and unsupported diagnostic codes', () => {
  assert.equal(parseDiagnosticMetadata('not-crit'), undefined)
  // A project code is two refs and a thread code is three; anything else is
  // a code from some other version of this format, not one to guess at.
  assert.equal(parseDiagnosticMetadata(`crit:v1;${createSessionRef()}`), undefined)
  assert.equal(parseDiagnosticMetadata(`crit:v1;${createSessionRef()};${createProjectRef('p')};`), undefined)
  assert.equal(
    parseDiagnosticMetadata(
      `crit:v1;${createSessionRef()};${createProjectRef('p')};${createThreadRef()};${createThreadRef()}`,
    ),
    undefined,
  )
  assert.equal(
    parseDiagnosticMetadata(`crit:v2;${createSessionRef()};${createProjectRef('project')};${createThreadRef()}`),
    undefined,
  )
  assert.equal(parseDiagnosticMetadata(`crit:v1;bad;${createProjectRef('project')};${createThreadRef()}`), undefined)
})

test('session and thread references are unique and well formed', () => {
  const sessionRefs = new Set(Array.from({ length: 100 }, createSessionRef))
  const threadRefs = new Set(Array.from({ length: 100 }, createThreadRef))

  assert.equal(sessionRefs.size, 100)
  assert.equal(threadRefs.size, 100)
  for (const ref of sessionRefs) assert.match(ref, /^[0-9a-f]{8}$/)
  for (const ref of threadRefs) assert.match(ref, /^[0-9a-f]{8}$/)
})

test('project references are deterministic without exposing their identity', () => {
  const identity = 'file:///Users/example/project'
  const first = createProjectRef(identity)

  assert.equal(createProjectRef(identity), first)
  assert.notEqual(createProjectRef('file:///Users/example/other-project'), first)
  assert.match(first, /^[0-9a-f]{8}$/)
  assert.equal(first.includes(identity), false)
})

test('the routing code survives a prompt round trip verbatim', () => {
  const metadata = {
    version: 1,
    sessionRef: createSessionRef(),
    projectRef: createProjectRef('file:///workspace/project'),
    threadRef: createThreadRef(),
  }
  const code = encodeDiagnosticMetadata(metadata)

  // The code travels in the generated prompt as literal text and comes back
  // through an MCP `code` argument. It must never be URI-escaped on the way:
  // `vscode.Uri.parse` percent-encodes `;` and `=`, which is why the code is
  // not stored in `Diagnostic.code.target`.
  assert.equal(code.includes('%3B'), false)
  assert.equal(code.includes('%3D'), false)
  assert.deepEqual(parseDiagnosticMetadata(code), metadata)
  assert.equal(parseDiagnosticMetadata(encodeURIComponent(code)), undefined)
})

test('a diagnostic code copied with its R-label still resolves', () => {
  const metadata = {
    version: 1,
    sessionRef: createSessionRef(),
    projectRef: createProjectRef('file:///workspace/project'),
    threadRef: createThreadRef(),
  }
  const code = encodeDiagnosticMetadata(metadata)

  // Diagnostic.code is published as `R3 crit:v1;…`; an agent that
  // copies the whole field must still route correctly.
  assert.deepEqual(parseDiagnosticMetadata(`R3 ${code}`), metadata)
  assert.deepEqual(parseDiagnosticMetadata(`R42  ${code}`), metadata)
  assert.equal(parseDiagnosticMetadata(`R3${code}`), undefined)
  assert.equal(parseDiagnosticMetadata(`X3 ${code}`), undefined)
})
