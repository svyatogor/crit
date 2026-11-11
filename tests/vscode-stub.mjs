/**
 * Enough of the `vscode` module for the parts of `src` under test.
 *
 * Three seams let a test drive what the source sees: `settings` backs
 * `workspace.getConfiguration()`, `relativePathRoot` backs
 * `workspace.asRelativePath()`, and `setGitExtension()` backs the Git API that
 * the changed-file listing reads.
 */

export const settings = new Map()

export let relativePathRoot = ''

export function setRelativePathRoot(root) {
  relativePathRoot = root
}

let gitExtension

/**
 * Stand in for the built-in Git extension, as `getGitApi()` resolves it.
 *
 * `active: false` models the extension host starting Crit before Git: the API
 * is unreachable until something calls `activate()`, which settles once the
 * returned `finishActivation()` is called.
 */
export function setGitExtension(api, { active = true } = {}) {
  if (!api) {
    gitExtension = undefined
    return { finishActivation: () => {} }
  }
  const extension = { isActive: active, exports: { getAPI: () => api } }
  let finishActivation = () => {}
  const activated = new Promise((resolve) => {
    finishActivation = () => {
      extension.isActive = true
      resolve()
    }
  })
  extension.activate = () => activated
  gitExtension = extension
  return { finishActivation }
}

export const extensions = {
  getExtension: (id) => (id === 'vscode.git' ? gitExtension : undefined),
}

/**
 * Enough of `Uri` for the tree views: `with()` (re-scheming for icons) and
 * `toString()`. `joinPath` does not normalise `..`, which no test depends on.
 */
function makeUri(scheme, fsPath, query = '') {
  return {
    scheme,
    fsPath,
    path: fsPath,
    query,
    with: (change) => makeUri(change.scheme ?? scheme, change.path ?? fsPath, change.query ?? query),
    toString: () => `${scheme}://${fsPath}${query ? `?${query}` : ''}`,
  }
}

export const Uri = {
  file: (fsPath) => makeUri('file', fsPath),
  joinPath: (base, ...parts) => makeUri(base.scheme ?? 'file', [base.fsPath, ...parts].join('/')),
}

export const window = {}

export const env = {}

export class Disposable {
  constructor(callOnDispose) {
    this.dispose = callOnDispose ?? (() => {})
  }
}

export class EventEmitter {
  constructor() {
    this.listeners = []
    this.event = (listener) => {
      this.listeners.push(listener)
      return new Disposable(() => {
        this.listeners = this.listeners.filter((l) => l !== listener)
      })
    }
  }

  fire(value) {
    for (const listener of [...this.listeners]) listener(value)
  }

  dispose() {
    this.listeners = []
  }
}

// --- Tree view rendering primitives ---

export class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label
    this.collapsibleState = collapsibleState
  }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 }

export const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 }

export class ThemeIcon {
  constructor(id, color) {
    this.id = id
    this.color = color
  }
}

ThemeIcon.File = new ThemeIcon('file')
ThemeIcon.Folder = new ThemeIcon('folder')

export class ThemeColor {
  constructor(id) {
    this.id = id
  }
}

// --- Comment thread primitives ---

export class Position {
  constructor(line, character) {
    this.line = line
    this.character = character
  }
}

export class Range {
  constructor(startLine, startCharacter, endLine, endCharacter) {
    this.start = new Position(startLine, startCharacter)
    this.end = new Position(endLine, endCharacter)
  }
}

export const CommentMode = { Editing: 0, Preview: 1 }

export const CommentThreadState = { Unresolved: 0, Resolved: 1 }

export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 }

export const commands = {
  executed: [],
  executeCommand: (command, ...args) => {
    commands.executed.push([command, ...args])
    return Promise.resolve(undefined)
  },
}

export class MarkdownString {
  constructor(value = '') {
    this.value = value
  }

  appendMarkdown(text) {
    this.value += text
    return this
  }
}

export const workspace = {
  workspaceFolders: [],
  textDocuments: [],
  // The fallback matters: `get(key, default)` is how a setting with a shipped
  // default is read, and returning undefined for an unset key would make every
  // such read look like the user had turned the setting off.
  getConfiguration: () => ({ get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback) }),
  asRelativePath: (uri) => {
    const fsPath = typeof uri === 'string' ? uri : uri.fsPath
    if (relativePathRoot && fsPath.startsWith(`${relativePathRoot}/`)) {
      return fsPath.slice(relativePathRoot.length + 1)
    }
    return fsPath
  },
}
