const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

// Lets `src` be required as TypeScript, and stubs `vscode`.
const { vscodeStub } = require('./harness.cjs')

const { ChangesViewProvider } = require('../src/changes-view.ts')
const { bucketKey, ReviewedFiles } = require('../src/reviewed-files.ts')
const { clearThreads, resolveThread, ReviewComment, trackThread } = require('../src/review-threads.ts')

vscodeStub.setRelativePathRoot('/work')

// Threads live in a module-level map, so each test starts from an empty one.
test.beforeEach(() => clearThreads())

/** A comment thread on `fsPath`, as the comment controller would have built it. */
function addThread(fsPath, line, text) {
  return trackThread({
    uri: vscodeStub.Uri.file(fsPath),
    range: new vscodeStub.Range(line, 0, line, 0),
    comments: [new ReviewComment(text, 'user')],
    canReply: true,
    contextValue: 'open',
    dispose: () => {},
  })
}

const MODIFIED = 5
const UNTRACKED = 7

/**
 * The provider reading a real listing: a stubbed Git API supplies the changed
 * files, and the reviewed model supplies the marks, so the states the tree
 * renders are computed rather than asserted from a fixture.
 */
function harness(changedPaths) {
  const contents = new Map()
  const store = new Map()
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crit-view-'))

  const repo = {
    rootUri: vscodeStub.Uri.file('/work/app'),
    state: {
      workingTreeChanges: changedPaths.map((fsPath) => ({
        uri: vscodeStub.Uri.file(fsPath),
        status: fsPath.endsWith('.new.ts') ? UNTRACKED : MODIFIED,
      })),
    },
  }
  vscodeStub.setGitExtension({ repositories: [repo] })

  const mtimes = new Map()
  let clock = 1000
  const reviewed = new ReviewedFiles({
    storage: {
      get: (key) => store.get(key),
      update: (key, value) => store.set(key, value),
      keys: () => [...store.keys()],
    },
    bucketKeyFor: () => bucketKey('app-11111111', 'main'),
    readContent: async (uri) => {
      const text = contents.get(uri.fsPath)
      return text === undefined ? undefined : Buffer.from(text, 'utf8')
    },
    probe: async (uri) => {
      const text = contents.get(uri.fsPath)
      if (text === undefined) return undefined
      return { size: Buffer.byteLength(text), mtimeMs: mtimes.get(uri.fsPath), dirty: false }
    },
    snapshotDir,
  })

  const layout = new Map()
  const view = { description: undefined }
  const provider = new ChangesViewProvider(reviewed, {
    get: (key, fallback) => (layout.has(key) ? layout.get(key) : fallback),
    update: (key, value) => layout.set(key, value),
  })
  provider.attach(view)

  return {
    provider,
    reviewed,
    view,
    write: (fsPath, text) => {
      contents.set(fsPath, text)
      mtimes.set(fsPath, (clock += 1000))
    },
    uri: (fsPath) => vscodeStub.Uri.file(fsPath),
    async rows() {
      const rows = await provider.getChildren()
      return Object.fromEntries(rows.map((row) => [row.file.relativePath, row]))
    },
  }
}

test('the tree reports one row per changed file, in path order', async () => {
  const h = harness(['/work/app/src/b.ts', '/work/app/src/a.ts', '/work/app/src/c.new.ts'])
  for (const p of ['/work/app/src/b.ts', '/work/app/src/a.ts', '/work/app/src/c.new.ts']) h.write(p, 'x\n')

  const rows = await h.provider.getChildren()

  assert.deepEqual(
    rows.map((row) => row.file.relativePath),
    ['app/src/a.ts', 'app/src/b.ts', 'app/src/c.new.ts'],
  )
  // A file node has no children of its own.
  assert.deepEqual(await h.provider.getChildren(rows[0]), [])
})

test('stale is a third state: the tick stays, with a dot and a reason beside it', async () => {
  const h = harness(['/work/app/src/a.ts'])
  const file = h.uri('/work/app/src/a.ts')
  h.write(file.fsPath, 'original\n')

  let row = (await h.rows())['app/src/a.ts']
  assert.equal(row.state, 'unreviewed')
  assert.equal(h.provider.getTreeItem(row).checkboxState.state, vscodeStub.TreeItemCheckboxState.Unchecked)

  await h.reviewed.mark(file)
  row = (await h.rows())['app/src/a.ts']
  assert.equal(row.state, 'reviewed')
  let item = h.provider.getTreeItem(row)
  assert.equal(item.checkboxState.state, vscodeStub.TreeItemCheckboxState.Checked)
  assert.match(item.description, /^M · reviewed /)
  assert.equal(item.contextValue, 'critChange.reviewed')

  // What the agent writing to the file looks like from the tree's side.
  h.write(file.fsPath, 'original\nand more\n')
  row = (await h.rows())['app/src/a.ts']
  assert.equal(row.state, 'stale')
  item = h.provider.getTreeItem(row)
  assert.equal(
    item.checkboxState.state,
    vscodeStub.TreeItemCheckboxState.Checked,
    'you did read this file — clearing the tick would deny it',
  )
  assert.match(item.checkboxState.tooltip, /click to mark reviewed again/)
  assert.equal(item.description, 'M · changed since you reviewed')
  assert.equal(item.contextValue, 'critChange.stale', 'the since-I-reviewed action keys off this')
  // A dot, as an editor shows for an unsaved file — not a warning sign, since
  // nothing is wrong. The icon carries the state the checkbox cannot.
  assert.equal(item.iconPath.id, 'circle-filled')
  assert.equal(item.iconPath.color.id, 'gitDecoration.modifiedResourceForeground')
})

test('clicking a stale checkbox re-reviews instead of clearing the mark', async () => {
  const h = harness(['/work/app/a.ts'])
  const file = h.uri('/work/app/a.ts')
  h.write(file.fsPath, 'v1\n')

  const unchecked = vscodeStub.TreeItemCheckboxState.Unchecked
  const checked = vscodeStub.TreeItemCheckboxState.Checked

  // Unreviewed: the box is empty, so a click is a plain mark.
  let row = (await h.rows())['app/a.ts']
  assert.equal(h.provider.checkboxIntent(row, checked), 'mark')

  // Reviewed: the box is ticked, so a click clears it.
  await h.reviewed.mark(file)
  row = (await h.rows())['app/a.ts']
  assert.equal(h.provider.checkboxIntent(row, unchecked), 'unmark')

  // Stale: the box is ticked too, so VS Code proposes the same unchecking —
  // but here it means "I have looked again", which took two clicks before.
  h.write(file.fsPath, 'v2\n')
  row = (await h.rows())['app/a.ts']
  assert.equal(row.state, 'stale')
  assert.equal(h.provider.checkboxIntent(row, unchecked), 'mark')
})

test('a folder holding anything stale re-reviews on click', async () => {
  const paths = ['/work/app/src/a.ts', '/work/app/src/b.ts']
  const h = harness(paths)
  for (const p of paths) h.write(p, 'v1\n')
  h.provider.setTreeLayout(true)

  const unchecked = vscodeStub.TreeItemCheckboxState.Unchecked
  for (const p of paths) await h.reviewed.mark(h.uri(p))

  let folder = (await h.provider.getChildren())[0]
  assert.equal(h.provider.checkboxIntent(folder, unchecked), 'unmark', 'all fresh: clearing is what it looks like')

  h.write(paths[1], 'v2\n')
  folder = (await h.provider.getChildren())[0]
  assert.equal(h.provider.checkboxIntent(folder, unchecked), 'mark', 'one stale file is enough')
  assert.match(h.provider.getTreeItem(folder).checkboxState.tooltip, /click to mark all reviewed/)
})

test('an unreviewed row shows its status and folder rather than a mark', async () => {
  const h = harness(['/work/app/src/a.ts'])
  h.write('/work/app/src/a.ts', 'x\n')

  const item = h.provider.getTreeItem((await h.rows())['app/src/a.ts'])

  assert.equal(item.description, 'M · app/src')
  assert.equal(item.contextValue, 'critChange.unreviewed')
  assert.equal(item.command.command, 'crit.openChange')
  // The file-type icon comes from the icon theme, and the URI it resolves from
  // is re-schemed so no file-decoration provider claims the row.
  assert.equal(item.iconPath, vscodeStub.ThemeIcon.File)
  assert.equal(item.resourceUri.scheme, 'crit-icon')
  assert.equal(item.resourceUri.fsPath, '/work/app/src/a.ts', 'the path is what resolves the icon')
})

test('the section header counts progress and calls out stale files', async () => {
  const paths = ['/work/app/a.ts', '/work/app/b.ts', '/work/app/c.ts']
  const h = harness(paths)
  for (const p of paths) h.write(p, 'v1\n')

  await h.rows()
  assert.equal(h.view.description, '0/3 reviewed')

  await h.reviewed.mark(h.uri(paths[0]))
  await h.reviewed.mark(h.uri(paths[1]))
  await h.rows()
  assert.equal(h.view.description, '2/3 reviewed')

  h.write(paths[1], 'v2\n')
  await h.rows()
  assert.equal(h.view.description, '1/3 reviewed, 1 stale')
})

test('the tree layout groups by folder and collapses single-child chains', async () => {
  const paths = ['/work/app/src/views/a.ts', '/work/app/src/views/b.ts', '/work/app/README.md']
  const h = harness(paths)
  for (const p of paths) h.write(p, 'x\n')

  h.provider.setTreeLayout(true)
  const roots = await h.provider.getChildren()

  // `app` has two children, so it stays its own row; `src/views` is a chain of
  // single-child folders and collapses into one.
  assert.deepEqual(
    roots.map((node) => node.label ?? node.file.relativePath),
    ['app'],
  )
  const app = roots[0]
  assert.deepEqual(
    (await h.provider.getChildren(app)).map((node) => node.label ?? path.basename(node.file.relativePath)),
    ['src/views', 'README.md'],
  )

  const views = (await h.provider.getChildren(app))[0]
  assert.deepEqual(
    (await h.provider.getChildren(views)).map((node) => path.basename(node.file.relativePath)),
    ['a.ts', 'b.ts'],
  )
  // Folders are leaves for the file-level commands but carry their descendants.
  assert.equal(h.provider.filesOf(views).length, 2)
  assert.equal(h.provider.filesOf(app).length, 3)
})

test('a file with open comments is marked, and resolving one drops the count', async () => {
  const h = harness(['/work/app/a.ts', '/work/app/b.ts'])
  h.write('/work/app/a.ts', 'x\n')
  h.write('/work/app/b.ts', 'x\n')
  addThread('/work/app/a.ts', 5, 'rename this')
  const second = addThread('/work/app/a.ts', 9, 'and handle the error')

  let rows = await h.rows()
  assert.equal(rows['app/a.ts'].comments, 2)
  assert.equal(rows['app/b.ts'].comments, 0)
  assert.equal(h.provider.getTreeItem(rows['app/a.ts']).description, 'M · 💬 2 · app')
  assert.equal(h.provider.getTreeItem(rows['app/b.ts']).description, 'M · app', 'no marker with nothing to deal with')
  assert.match(h.provider.getTreeItem(rows['app/a.ts']).tooltip, /2 open review comments/)

  // A resolved thread is dealt with, so it stops marking the file.
  resolveThread(second)
  rows = await h.rows()
  assert.equal(rows['app/a.ts'].comments, 1)
  assert.equal(h.provider.getTreeItem(rows['app/a.ts']).description, 'M · 💬 1 · app')
})

test('the comment marker survives the review state and reaches folder rows', async () => {
  const h = harness(['/work/app/src/a.ts', '/work/app/src/b.ts'])
  h.write('/work/app/src/a.ts', 'v1\n')
  h.write('/work/app/src/b.ts', 'v1\n')
  addThread('/work/app/src/a.ts', 1, 'look again')

  await h.reviewed.mark(h.uri('/work/app/src/a.ts'))
  let item = h.provider.getTreeItem((await h.rows())['app/src/a.ts'])
  assert.match(item.description, /^M · 💬 1 · reviewed /, 'the count leads the timestamp')

  h.write('/work/app/src/a.ts', 'v2\n')
  item = h.provider.getTreeItem((await h.rows())['app/src/a.ts'])
  assert.equal(item.description, 'M · 💬 1 · changed since you reviewed')

  h.provider.setTreeLayout(true)
  const folder = (await h.provider.getChildren())[0]
  assert.equal(h.provider.getTreeItem(folder).description, '0/2 · 💬 1 · 1 stale')
})

test('a file row drops the directory in tree layout, where the row above says it', async () => {
  const h = harness(['/work/app/src/views/a.ts'])
  h.write('/work/app/src/views/a.ts', 'x\n')

  let row = (await h.rows())['app/src/views/a.ts']
  assert.equal(h.provider.getTreeItem(row).description, 'M · app/src/views', 'flat layout has nothing else to say it')

  h.provider.setTreeLayout(true)
  const folder = (await h.provider.getChildren())[0]
  row = h.provider.filesOf(folder)[0]
  assert.equal(h.provider.getTreeItem(row).description, 'M', 'the status letter alone')
})

test('the layout choice is persisted, and the list layout stays flat', async () => {
  const h = harness(['/work/app/src/a.ts'])
  h.write('/work/app/src/a.ts', 'x\n')

  assert.equal(h.provider.isTreeLayout(), false, 'flat by default')
  assert.deepEqual(
    (await h.provider.getChildren()).map((node) => node.kind),
    ['file'],
  )

  h.provider.setTreeLayout(true)
  assert.equal(h.provider.isTreeLayout(), true)
  assert.deepEqual(
    (await h.provider.getChildren()).map((node) => node.kind),
    ['folder'],
  )

  h.provider.setTreeLayout(false)
  assert.equal(h.provider.isTreeLayout(), false)
})

test("a folder's checkbox reflects and reports its files", async () => {
  const paths = ['/work/app/src/a.ts', '/work/app/src/b.ts']
  const h = harness(paths)
  for (const p of paths) h.write(p, 'x\n')
  h.provider.setTreeLayout(true)

  let folder = (await h.provider.getChildren())[0]
  assert.equal(h.provider.getTreeItem(folder).checkboxState.state, vscodeStub.TreeItemCheckboxState.Unchecked)
  assert.equal(h.provider.getTreeItem(folder).description, '0/2')

  await h.reviewed.mark(h.uri(paths[0]))
  folder = (await h.provider.getChildren())[0]
  assert.equal(
    h.provider.getTreeItem(folder).checkboxState.state,
    vscodeStub.TreeItemCheckboxState.Unchecked,
    'a partly-read folder is not read',
  )
  assert.equal(h.provider.getTreeItem(folder).description, '1/2')

  await h.reviewed.mark(h.uri(paths[1]))
  folder = (await h.provider.getChildren())[0]
  assert.equal(h.provider.getTreeItem(folder).checkboxState.state, vscodeStub.TreeItemCheckboxState.Checked)

  // A stale file still counts as marked, so the folder stays ticked and says why.
  h.write(paths[1], 'changed\n')
  folder = (await h.provider.getChildren())[0]
  assert.equal(h.provider.getTreeItem(folder).checkboxState.state, vscodeStub.TreeItemCheckboxState.Checked)
  assert.equal(h.provider.getTreeItem(folder).description, '1/2 · 1 stale')
})

test('a node carries a resourceUri, so the file-scoped review command accepts it', async () => {
  const h = harness(['/work/app/src/a.ts'])
  h.write('/work/app/src/a.ts', 'x\n')

  const row = (await h.rows())['app/src/a.ts']

  // `menuUri` in the extension host reads exactly this field.
  assert.equal(row.resourceUri, row.file.uri)
})

test('turning off scm.compactFolders leaves each folder its own row', async () => {
  const paths = ['/work/app/src/views/a.ts', '/work/app/src/views/b.ts', '/work/app/README.md']
  const h = harness(paths)
  for (const p of paths) h.write(p, 'x\n')
  vscodeStub.settings.set('compactFolders', false)

  try {
    h.provider.setTreeLayout(true)
    const [app] = await h.provider.getChildren()
    const appChildren = await h.provider.getChildren(app)
    assert.deepEqual(
      appChildren.map((node) => node.label ?? path.basename(node.file.relativePath)),
      ['src', 'README.md'],
      'the src → views chain must stay two rows',
    )

    const views = await h.provider.getChildren(appChildren[0])
    assert.deepEqual(
      views.map((node) => node.label),
      ['views'],
    )
  } finally {
    vscodeStub.settings.delete('compactFolders')
  }
})

test('an unset scm.compactFolders reads as on, the way VS Code ships it', async () => {
  const paths = ['/work/app/src/views/a.ts', '/work/app/src/views/b.ts']
  const h = harness(paths)
  for (const p of paths) h.write(p, 'x\n')
  assert.equal(vscodeStub.settings.has('compactFolders'), false)

  h.provider.setTreeLayout(true)
  const [root] = await h.provider.getChildren()
  assert.equal(root.label, 'app/src/views')
})
