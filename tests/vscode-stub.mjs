/**
 * Enough of the `vscode` module for the parts of `src` under test.
 *
 * `settings` backs `workspace.getConfiguration()`, so a test can set a
 * configuration value the source will read.
 */

export const settings = new Map()

export const Uri = {
  joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
}

export const window = {}

export const env = {}

export const workspace = {
  workspaceFolders: [],
  getConfiguration: () => ({ get: (key) => settings.get(key) }),
}
