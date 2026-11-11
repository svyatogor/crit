const assert = require('node:assert/strict')
const test = require('node:test')

// Lets `src` be required as TypeScript, and stubs `vscode`.
const { vscodeStub } = require('./harness.cjs')

const { onChangedFilesChanged, watchBranchKey } = require('../src/git.ts')

function repo(root, branch) {
  const onDidChange = new vscodeStub.EventEmitter()
  return {
    rootUri: { fsPath: root },
    state: { HEAD: branch === undefined ? undefined : { name: branch }, onDidChange: onDidChange.event },
    checkout(name) {
      this.state.HEAD = { name }
      onDidChange.fire()
    },
  }
}

function api(...repos) {
  const opened = new vscodeStub.EventEmitter()
  return {
    repositories: repos,
    onDidOpenRepository: opened.event,
    onDidCloseRepository: new vscodeStub.EventEmitter().event,
    open(repo) {
      this.repositories.push(repo)
      opened.fire(repo)
    },
  }
}

// Lets a pending `activate().then(...)` run before asserting.
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('the branch key is reported once a Git extension that started late activates', async (t) => {
  const git = api(repo('/work/app', 'feature'))
  const { finishActivation } = vscodeStub.setGitExtension(git, { active: false })
  t.after(() => vscodeStub.setGitExtension(undefined))

  const keys = []
  const watcher = watchBranchKey((key) => keys.push(key))
  t.after(() => watcher.dispose())

  assert.deepEqual(keys, ['_default'])

  finishActivation()
  await settle()

  assert.deepEqual(keys, ['_default', 'app.feature'])
})

test('a repository opened after activation reports its branch without waiting for a state change', (t) => {
  const git = api()
  vscodeStub.setGitExtension(git)
  t.after(() => vscodeStub.setGitExtension(undefined))

  const keys = []
  const watcher = watchBranchKey((key) => keys.push(key))
  t.after(() => watcher.dispose())

  // HEAD is already known when the repository is announced, so no
  // `state.onDidChange` follows to carry the branch.
  git.open(repo('/work/app', 'feature'))

  assert.deepEqual(keys, ['_default', 'app.feature'])
})

test('checking out another branch reports the new key', (t) => {
  const app = repo('/work/app', 'main')
  vscodeStub.setGitExtension(api(app))
  t.after(() => vscodeStub.setGitExtension(undefined))

  const keys = []
  const watcher = watchBranchKey((key) => keys.push(key))
  t.after(() => watcher.dispose())

  app.checkout('feature')

  assert.deepEqual(keys, ['app.main', 'app.feature'])
})

test('disposing also stops listening to repositories opened after the watcher started', (t) => {
  const git = api()
  vscodeStub.setGitExtension(git)
  t.after(() => vscodeStub.setGitExtension(undefined))

  const keys = []
  const watcher = watchBranchKey((key) => keys.push(key))
  const app = repo('/work/app', 'main')
  git.open(app)
  watcher.dispose()

  app.checkout('feature')

  assert.deepEqual(keys, ['_default', 'app.main'])
})

test('changed-file listening stops for repositories opened after it started', (t) => {
  const git = api()
  vscodeStub.setGitExtension(git)
  t.after(() => vscodeStub.setGitExtension(undefined))

  let calls = 0
  const watcher = onChangedFilesChanged(() => calls++)
  const app = repo('/work/app', 'main')
  git.open(app)
  watcher.dispose()

  app.checkout('feature')

  assert.equal(calls, 1)
})

test('disposing before Git finishes activating reports nothing more', async (t) => {
  const { finishActivation } = vscodeStub.setGitExtension(api(repo('/work/app', 'feature')), { active: false })
  t.after(() => vscodeStub.setGitExtension(undefined))

  const keys = []
  watchBranchKey((key) => keys.push(key)).dispose()

  finishActivation()
  await settle()

  assert.deepEqual(keys, ['_default'])
})
