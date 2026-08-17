const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// The module under test imports `vscode`, which only exists inside the
// extension host; the harness redirects it to a stub. `settings` backs the
// stub's `getConfiguration`, so a test can set `crit.claudePath`.
const { vscodeStub } = require('./harness.cjs');
const settings = vscodeStub.settings;

const {
    MCP_SERVER_NAME,
    findClaude,
    installCommand,
    shellQuote,
    stageServer,
    stagedServerPath,
} = require('../src/mcp-install.ts');

function tempDir(t, prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** An extension install directory holding `out/mcp-server.js` with `body`. */
function fakeExtension(t, version, body) {
    const root = tempDir(t, `crit-ext-${version}-`);
    fs.mkdirSync(path.join(root, 'out'));
    fs.writeFileSync(path.join(root, 'out', 'mcp-server.js'), body);
    return {
        extensionUri: { fsPath: root },
        extension: { packageJSON: { version } },
    };
}

test('stages the shipped bundle to the stable path', (t) => {
    const staging = tempDir(t, 'crit-staging-');
    const result = stageServer(fakeExtension(t, '0.3.0', 'v1'), staging);

    assert.equal(result.updated, true);
    assert.equal(result.serverPath, stagedServerPath(staging));
    assert.equal(fs.readFileSync(result.serverPath, 'utf-8'), 'v1');
});

test('re-staging the same build is a no-op', (t) => {
    const staging = tempDir(t, 'crit-staging-');
    const context = fakeExtension(t, '0.3.0', 'v1');

    stageServer(context, staging);
    assert.equal(stageServer(context, staging).updated, false);
});

test('a new extension version replaces the staged copy at the same path', (t) => {
    const staging = tempDir(t, 'crit-staging-');
    const first = stageServer(fakeExtension(t, '0.3.0', 'v1'), staging);
    const second = stageServer(fakeExtension(t, '0.4.0', 'v2'), staging);

    // The path must not move — it is what Claude Code's config records.
    assert.equal(second.serverPath, first.serverPath);
    assert.equal(second.updated, true);
    assert.equal(fs.readFileSync(second.serverPath, 'utf-8'), 'v2');
});

test('a rebuilt bundle at the same version is re-staged', (t) => {
    const staging = tempDir(t, 'crit-staging-');
    stageServer(fakeExtension(t, '0.3.0', 'v1'), staging);
    const rebuilt = stageServer(fakeExtension(t, '0.3.0', 'rebuilt-longer'), staging);

    assert.equal(rebuilt.updated, true);
    assert.equal(fs.readFileSync(rebuilt.serverPath, 'utf-8'), 'rebuilt-longer');
});

test('a deleted staged copy is restored', (t) => {
    const staging = tempDir(t, 'crit-staging-');
    const context = fakeExtension(t, '0.3.0', 'v1');
    const staged = stageServer(context, staging).serverPath;
    fs.unlinkSync(staged);

    assert.equal(stageServer(context, staging).updated, true);
    assert.equal(fs.readFileSync(staged, 'utf-8'), 'v1');
});

test('quotes paths that would otherwise be split or expanded by the shell', () => {
    assert.equal(shellQuote('/Users/a b/.crit'), `'/Users/a b/.crit'`);
    assert.equal(shellQuote("/it's/here"), `'/it'\\''s/here'`);
});

/** A directory holding an executable named `claude`. */
function binWithClaude(t) {
    const dir = tempDir(t, 'crit-bin-');
    const exe = path.join(dir, 'claude');
    fs.writeFileSync(exe, '#!/bin/sh\n');
    fs.chmodSync(exe, 0o755);
    return { dir, exe };
}

test('finds claude on the PATH the extension host was given', (t) => {
    if (process.platform === 'win32') return;
    const { dir, exe } = binWithClaude(t);

    // VS Code already resolved the login+interactive shell env into process.env,
    // so PATH is the whole lookup — no shell of our own.
    assert.equal(findClaude({ PATH: dir }), exe);
});

test('an explicit crit.claudePath setting wins over PATH', (t) => {
    if (process.platform === 'win32') return;
    const { dir } = binWithClaude(t);
    settings.set('crit.claudePath', '/opt/custom/claude');
    t.after(() => settings.clear());

    assert.equal(findClaude({ PATH: dir }), '/opt/custom/claude');
});

test('registers at user scope and leaves node for the shell to resolve', () => {
    const command = installCommand('/Users/a b/.crit/mcp/mcp-server.js');

    assert.equal(command, `claude mcp add -s user ${MCP_SERVER_NAME} -- node '/Users/a b/.crit/mcp/mcp-server.js'`);
    // An absolute interpreter path would pin the server to one toolchain version.
    assert.doesNotMatch(command, /\/node\b/);
});
