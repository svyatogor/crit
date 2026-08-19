const assert = require('node:assert/strict')
const test = require('node:test')

// Lets `src` be required as TypeScript, and stubs `vscode`.
const { vscodeStub } = require('./harness.cjs')

const { CommentsViewProvider } = require('../src/comments-view.ts')
const { clearThreads, resolveThread, ReviewComment, trackThread } = require('../src/review-threads.ts')

vscodeStub.setRelativePathRoot('/work')

/** A thread as the comment controller would have built it. */
function addThread(fsPath, line, text, role = 'user') {
  const thread = {
    uri: vscodeStub.Uri.file(fsPath),
    range: new vscodeStub.Range(line, 0, line, 0),
    comments: [new ReviewComment(text, role)],
    canReply: true,
    contextValue: 'open',
    dispose: () => {},
  }
  return trackThread(thread)
}

test.beforeEach(() => clearThreads())

test('threads group under their file, ordered by path then line', () => {
  addThread('/work/app/b.ts', 20, 'second file')
  addThread('/work/app/a.ts', 30, 'lower down')
  addThread('/work/app/a.ts', 5, 'higher up')

  const provider = new CommentsViewProvider()
  const files = provider.getChildren()

  assert.deepEqual(
    files.map((node) => node.relativePath),
    ['app/a.ts', 'app/b.ts'],
  )
  assert.deepEqual(
    provider.getChildren(files[0]).map((node) => node.thread.range.start.line),
    [5, 30],
  )
  // Threads are leaves.
  assert.deepEqual(provider.getChildren(provider.getChildren(files[0])[0]), [])
})

test('a file row gets a file icon, not a folder icon, and no decoration', () => {
  addThread('/work/app/config.ts', 20, 'first')

  const item = new CommentsViewProvider().getTreeItem(new CommentsViewProvider().getChildren()[0])

  // Collapsible + a plain `file:` resourceUri is what rendered these as folders,
  // and what let git colour the name by its working-tree status.
  assert.equal(item.collapsibleState, vscodeStub.TreeItemCollapsibleState.Expanded)
  assert.equal(item.iconPath, vscodeStub.ThemeIcon.File)
  assert.equal(item.resourceUri.scheme, 'crit-icon')
  assert.equal(item.resourceUri.fsPath, '/work/app/config.ts', 'the path is what resolves the icon')
})

test('an open thread renders its text, label and line', () => {
  const thread = addThread('/work/app/a.ts', 313, 'rename this variable')
  const provider = new CommentsViewProvider()

  const item = provider.getTreeItem({ kind: 'thread', thread })

  assert.equal(item.label, 'rename this variable')
  assert.match(item.description, /^R\d+ · L314$/, 'lines are shown 1-based, as every other surface reports them')
  assert.equal(item.contextValue, 'critThread.open')
  assert.equal(item.iconPath.id, 'comment')
})

test('an agent-authored thread is marked as such', () => {
  const thread = addThread('/work/app/a.ts', 1, 'this leaks a handle', 'agent')
  const provider = new CommentsViewProvider()

  assert.equal(provider.getTreeItem({ kind: 'thread', thread }).iconPath.id, 'sparkle')
})

test('resolved threads stay listed but muted', () => {
  const thread = addThread('/work/app/a.ts', 1, 'done with this')
  resolveThread(thread)
  const provider = new CommentsViewProvider()

  const item = provider.getTreeItem({ kind: 'thread', thread })

  assert.equal(item.contextValue, 'critThread.resolved')
  assert.equal(item.iconPath.id, 'check-all')
  assert.equal(item.iconPath.color.id, 'descriptionForeground', 'muted rather than removed')
  assert.equal(provider.getChildren().length, 1, 'the file is still listed')
})

test('hiding resolved threads drops them, and drops a file left with none', () => {
  const resolved = addThread('/work/app/done.ts', 1, 'already handled')
  resolveThread(resolved)
  addThread('/work/app/open.ts', 1, 'still open')

  const provider = new CommentsViewProvider()
  assert.equal(provider.getChildren().length, 2)

  provider.setHideResolved(true)

  const files = provider.getChildren()
  assert.deepEqual(
    files.map((node) => node.relativePath),
    ['app/open.ts'],
    'a file whose only thread is hidden has nothing left to show',
  )
  assert.equal(provider.isHidingResolved(), true)
  // The toggle's own menu visibility is driven by a context key.
  assert.ok(
    vscodeStub.commands.executed.some(
      ([command, key, value]) => command === 'setContext' && key === 'crit.hidingResolved' && value === true,
    ),
  )

  provider.setHideResolved(false)
  assert.equal(provider.getChildren().length, 2)
})

test('the file row counts open threads against the total', () => {
  const resolved = addThread('/work/app/a.ts', 1, 'handled')
  resolveThread(resolved)
  addThread('/work/app/a.ts', 2, 'open one')
  addThread('/work/app/a.ts', 3, 'open two')

  const provider = new CommentsViewProvider()
  const [file] = provider.getChildren()

  assert.equal(provider.getTreeItem(file).description, '2 open · 3')
  assert.equal(provider.getTreeItem(file).collapsibleState, vscodeStub.TreeItemCollapsibleState.Expanded)
})

test('the filter matches comment text, and the header says how much is hidden', () => {
  addThread('/work/app/a.ts', 1, 'rename this variable')
  addThread('/work/app/a.ts', 2, 'add error handling')
  addThread('/work/app/b.ts', 1, 'unrelated thought')

  const view = { description: undefined }
  const provider = new CommentsViewProvider()
  provider.attach(view)

  provider.setFilter('error')

  const files = provider.getChildren()
  assert.deepEqual(
    files.map((node) => node.relativePath),
    ['app/a.ts'],
    'a file with no matching thread drops out entirely',
  )
  assert.deepEqual(
    provider.getChildren(files[0]).map((node) => node.thread.comments[0].body),
    ['add error handling'],
  )
  assert.equal(view.description, '1 of 3 matching "error"')
  assert.equal(provider.currentFilter(), 'error')
})

test('a filter matching the file name keeps every thread in that file', () => {
  addThread('/work/app/parser.ts', 1, 'nothing about the name here')
  addThread('/work/app/parser.ts', 2, 'nor here')
  addThread('/work/app/other.ts', 1, 'nor here either')

  const provider = new CommentsViewProvider()
  provider.setFilter('parser')

  const files = provider.getChildren()
  assert.deepEqual(
    files.map((node) => node.relativePath),
    ['app/parser.ts'],
  )
  // Typing a filename asks for that file, not for comments quoting its name.
  assert.equal(provider.getChildren(files[0]).length, 2)
})

test('clearing the filter restores everything', () => {
  addThread('/work/app/a.ts', 1, 'one')
  addThread('/work/app/b.ts', 1, 'two')

  const provider = new CommentsViewProvider()
  provider.setFilter('one')
  assert.equal(provider.getChildren().length, 1)

  provider.setFilter('')
  assert.equal(provider.getChildren().length, 2)
  assert.equal(provider.currentFilter(), '')
  // Whitespace is not a filter.
  provider.setFilter('   ')
  assert.equal(provider.getChildren().length, 2)
})

test('the filter and the resolved toggle both apply', () => {
  const resolved = addThread('/work/app/a.ts', 1, 'handled the error')
  resolveThread(resolved)
  addThread('/work/app/a.ts', 2, 'another error to fix')

  const provider = new CommentsViewProvider()
  provider.setFilter('error')
  assert.equal(provider.getChildren(provider.getChildren()[0]).length, 2)

  provider.setHideResolved(true)
  assert.equal(provider.getChildren(provider.getChildren()[0]).length, 1)
})

test('the section header summarises open and resolved', () => {
  const resolved = addThread('/work/app/a.ts', 1, 'handled')
  resolveThread(resolved)
  addThread('/work/app/b.ts', 1, 'open one')

  const view = { description: undefined }
  const provider = new CommentsViewProvider()
  provider.attach(view)

  assert.equal(view.description, '1 open · 1 resolved')
})
