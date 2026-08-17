/**
 * Lets the tests `require('../src/<module>.ts')` directly.
 *
 * Node strips TypeScript types natively, so the sources need no build step of
 * their own — but two things still have to be taught, and `module.registerHooks`
 * is the supported way to teach them:
 *
 *  - **Extensionless relative imports.** `src` is written for a bundler, where
 *    `./process-liveness` is a complete specifier. Loaded as real ESM it is not,
 *    so the resolve hook appends the extension the file actually has.
 *  - **`vscode`.** The module only exists inside the extension host and is never
 *    installed. Requests for it are redirected to `vscode-stub.mjs`, whose
 *    exports a test can reach through `vscodeStub`.
 *
 * Require this before requiring anything from `src`.
 */

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { registerHooks } = require('node:module')

const STUB_URL = pathToFileURL(path.join(__dirname, 'vscode-stub.mjs')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: STUB_URL, shortCircuit: true }

    if (specifier.startsWith('.') && !path.extname(specifier) && context.parentURL) {
      const resolved = path.resolve(path.dirname(fileFromUrl(context.parentURL)), specifier)
      if (fs.existsSync(`${resolved}.ts`)) {
        return nextResolve(`${specifier}.ts`, context)
      }
    }

    return nextResolve(specifier, context)
  },
})

function fileFromUrl(url) {
  return url.startsWith('file:') ? new URL(url).pathname : url
}

/** The stub `vscode` module, so a test can drive what the source sees. */
const vscodeStub = require('./vscode-stub.mjs')

module.exports = { vscodeStub }
