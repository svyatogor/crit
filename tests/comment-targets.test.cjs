const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')

// Lets `src` be required as TypeScript, and stubs `vscode`.
require('./harness.cjs')

const { containsPath, resolveCommentFile, toDocumentLine } = require('../src/comment-targets.ts')

const project = path.resolve('/workspace/project')
const other = path.resolve('/workspace/other')

/** Resolution against a fixed set of files, so the tests touch no disk. */
function withFiles(...files) {
  const present = new Set(files.map((file) => path.resolve(file)))
  return { exists: (candidate) => present.has(candidate) }
}

test('a workspace-relative path resolves inside the project', () => {
  const target = path.join(project, 'src/git.ts')

  assert.deepEqual(resolveCommentFile('src/git.ts', [project], withFiles(target)), { path: target })
  // Agents quote paths inconsistently; leading and trailing space is not an
  // error worth failing a review finding over.
  assert.deepEqual(resolveCommentFile('  src/git.ts  ', [project], withFiles(target)), { path: target })
})

test('an absolute path inside the project resolves to itself', () => {
  const target = path.join(project, 'src/git.ts')

  assert.deepEqual(resolveCommentFile(target, [project], withFiles(target)), { path: target })
})

test('a path outside the addressed project is refused', () => {
  const outside = path.join(other, 'secrets.ts')

  // The IPC server listens on loopback, so `file` is untrusted input: a
  // projectRef has to bound where a comment can land, not just name a lookup.
  const absolute = resolveCommentFile(outside, [project], withFiles(outside))
  assert.ok('error' in absolute)
  assert.match(absolute.error, /outside the workspace folders/)

  const traversal = resolveCommentFile('../other/secrets.ts', [project], withFiles(outside))
  assert.ok('error' in traversal)
  assert.match(traversal.error, /outside the workspace folders/)
})

test('a multi-root window resolves against the folder that has the file', () => {
  const target = path.join(other, 'lib/util.ts')

  assert.deepEqual(resolveCommentFile('lib/util.ts', [project, other], withFiles(target)), { path: target })
})

test('resolution explains what the agent should send instead', () => {
  const missing = resolveCommentFile('src/nope.ts', [project], withFiles())
  assert.ok('error' in missing)
  assert.match(missing.error, /No file at src\/nope\.ts/)

  const noFolder = resolveCommentFile('src/git.ts', [], withFiles())
  assert.ok('error' in noFolder)
  assert.match(noFolder.error, /no local workspace folder/)

  // Shape — types, missing fields — is `addCommentRequestSchema`'s job; this
  // is only the last guard on a path that reached here empty.
  for (const bad of ['', '   ']) {
    const result = resolveCommentFile(bad, [project], withFiles())
    assert.ok('error' in result, `${JSON.stringify(bad)} must not resolve`)
    assert.match(result.error, /non-empty file path/)
  }
})

test('containment treats the folder itself as inside it', () => {
  assert.equal(containsPath(project, project), true)
  assert.equal(containsPath(project, path.join(project, 'a/b.ts')), true)
  assert.equal(containsPath(project, other), false)
  assert.equal(containsPath(project, `${project}-sibling`), false)
})

test('a 1-based line from an agent becomes a 0-based line in the document', () => {
  assert.equal(toDocumentLine(1, 10), 0)
  assert.equal(toDocumentLine(7, 10), 6)
})

test('a line past the end of the file is clamped, not refused', () => {
  // The agent may be reading a diff or a revision the user has since edited.
  // A comment one line off is worth far more than a rejection.
  assert.equal(toDocumentLine(99, 10), 9)
  assert.equal(toDocumentLine(1, 0), 0)
})
