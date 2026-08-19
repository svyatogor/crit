const assert = require('node:assert/strict')
const test = require('node:test')

// Lets `src` be required as TypeScript, and stubs `vscode`.
const { vscodeStub } = require('./harness.cjs')

const { getChangedFiles, isUntracked, repoForUri, repoRef } = require('../src/git.ts')

vscodeStub.setRelativePathRoot('/work')

// The Git API's `Status` enum, which extensions cannot reach without vendoring
// its types — the values the source maps from.
const STATUS = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  INTENT_TO_ADD: 9,
}

const uri = (fsPath) => ({ fsPath })
const change = (fsPath, status) => ({ uri: uri(fsPath), status })

function repo(root, state = {}) {
  return { rootUri: uri(root), state }
}

function api(...repos) {
  return { repositories: repos }
}

test('one file changed two ways is listed once, keeping the more specific status', () => {
  const files = getChangedFiles(
    api(
      repo('/work/app', {
        indexChanges: [change('/work/app/src/new.ts', STATUS.INDEX_ADDED)],
        // Staged as an add, then edited again — still an add, not a plain edit.
        workingTreeChanges: [change('/work/app/src/new.ts', STATUS.MODIFIED)],
      }),
    ),
  )

  assert.equal(files.length, 1)
  assert.equal(files[0].status, 'A')
  assert.equal(files[0].relativePath, 'app/src/new.ts')
})

test('untracked files are found whether or not the API separates them', () => {
  const separated = getChangedFiles(
    api(repo('/work/app', { untrackedChanges: [change('/work/app/fresh.ts', STATUS.UNTRACKED)] })),
  )
  const folded = getChangedFiles(
    api(repo('/work/app', { workingTreeChanges: [change('/work/app/fresh.ts', STATUS.UNTRACKED)] })),
  )

  assert.deepEqual(
    separated.map((f) => [f.relativePath, f.status]),
    [['app/fresh.ts', 'U']],
  )
  assert.deepEqual(
    folded.map((f) => [f.relativePath, f.status]),
    [['app/fresh.ts', 'U']],
  )
})

test('every repository contributes, and the list is sorted by path', () => {
  const front = repo('/work/front', { workingTreeChanges: [change('/work/front/b.ts', STATUS.MODIFIED)] })
  const back = repo('/work/back', {
    indexChanges: [change('/work/back/a.ts', STATUS.INDEX_DELETED)],
    mergeChanges: [change('/work/back/c.ts', STATUS.MODIFIED)],
  })

  const files = getChangedFiles(api(front, back))

  assert.deepEqual(
    files.map((f) => f.relativePath),
    ['back/a.ts', 'back/c.ts', 'front/b.ts'],
  )
  // Each row carries its own repository, which is what selects the bucket its
  // reviewed mark belongs to.
  assert.equal(files[0].repo, back)
  assert.equal(files[2].repo, front)
})

test('statuses map to the letters the tree renders', () => {
  const files = getChangedFiles(
    api(
      repo('/work/app', {
        workingTreeChanges: [
          change('/work/app/m.ts', STATUS.MODIFIED),
          change('/work/app/d.ts', STATUS.DELETED),
          change('/work/app/r.ts', STATUS.INDEX_RENAMED),
          change('/work/app/i.ts', STATUS.INTENT_TO_ADD),
          change('/work/app/x.ts', undefined),
        ],
      }),
    ),
  )

  const letters = Object.fromEntries(files.map((f) => [f.relativePath, f.status]))
  assert.deepEqual(letters, {
    'app/m.ts': 'M',
    'app/d.ts': 'D',
    'app/r.ts': 'R',
    // `git add -N` announces a file that is on its way to being added.
    'app/i.ts': 'A',
    // An unknown status is a modification rather than a dropped row.
    'app/x.ts': 'M',
  })
  assert.equal(
    isUntracked(files.find((f) => f.relativePath === 'app/i.ts')),
    true,
    'an added file has no HEAD side to diff against',
  )
})

test('a file in a nested repository belongs to the nested one', () => {
  const outer = repo('/work/app')
  const inner = repo('/work/app/vendor/lib')
  const git = api(outer, inner)

  // First match would hand this to the outer repository, which reports the
  // wrong branch and the wrong diff for it.
  assert.equal(repoForUri(uri('/work/app/vendor/lib/src/a.ts'), git), inner)
  assert.equal(repoForUri(uri('/work/app/src/a.ts'), git), outer)
  assert.equal(repoForUri(uri('/elsewhere/a.ts'), git), undefined)
})

test('a path that merely shares a prefix with a repository root is outside it', () => {
  const git = api(repo('/work/app'))
  assert.equal(repoForUri(uri('/work/app-notes/a.ts'), git), undefined)
})

test('two checkouts with the same folder name get different refs', () => {
  const first = repoRef(repo('/work/api'))
  const second = repoRef(repo('/side/api'))

  assert.match(first, /^api-[0-9a-f]{8}$/)
  assert.match(second, /^api-[0-9a-f]{8}$/)
  assert.notEqual(first, second, 'the basename alone would merge these two repositories')
  assert.equal(repoRef(repo('/work/api')), first, 'the ref must be stable')
})
