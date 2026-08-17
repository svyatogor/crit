import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
// Default import, not `* as which`: the package is plain CommonJS, so a real
// ESM namespace exposes only `default` and `sync` would be undefined.
import which from 'which';
import * as vscode from 'vscode';

/**
 * One-command registration of Crit's MCP server with Claude Code, at user scope.
 *
 * The problem this solves is the install path. The extension's own directory is
 * `.../svyatogor.crit-<version>/`, so every extension update moves
 * `out/mcp-server.js` and silently breaks an MCP entry that names it — the user
 * would have to re-run `claude mcp add` after each update.
 *
 * So the bundle is not registered where it ships. It is staged to a fixed path
 * outside the versioned directory, and that path is what Claude Code records.
 * Staging is refreshed on every activation, so an update replaces the staged
 * copy in place and the registration keeps working untouched.
 *
 * `~/.crit` rather than the extension's `globalStorageUri`: global storage is
 * per VS Code flavour (Code, Insiders, Cursor, Windsurf all differ), which would
 * make the one user-scope entry point at whichever flavour registered last and
 * break if that flavour were removed. The home directory is the one location
 * every flavour agrees on, and it is the same shape of assumption the IPC
 * registry already makes with `os.tmpdir()`.
 */

/** Server name under `mcpServers` in Claude Code's user config. */
export const MCP_SERVER_NAME = 'crit';

export function stagingDir(): string {
    return path.join(os.homedir(), '.crit', 'mcp');
}

/** The stable path registered with Claude Code. Must not vary by version. */
export function stagedServerPath(dir = stagingDir()): string {
    return path.join(dir, 'mcp-server.js');
}

/** Records what was staged, so activation can tell a stale copy from a current one. */
function stampPath(dir: string): string {
    return path.join(dir, 'installed.json');
}

interface Stamp {
    version: string;
    size: number;
    mtimeMs: number;
}

export interface StageResult {
    serverPath: string;
    /** False when the staged copy was already current and nothing was written. */
    updated: boolean;
}

/**
 * Copy the shipped MCP bundle to the stable path if what is there is not
 * already this build.
 *
 * The stamp carries the bundle's size and mtime alongside the extension
 * version, because during development the version stays put while the bundle is
 * rebuilt — comparing the version alone would pin the staged copy to whatever
 * was first installed.
 */
export function stageServer(context: vscode.ExtensionContext, dir = stagingDir()): StageResult {
    const source = vscode.Uri.joinPath(context.extensionUri, 'out', 'mcp-server.js').fsPath;
    const stat = fs.statSync(source);
    const current: Stamp = {
        version: context.extension.packageJSON.version ?? '0.0.0',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
    };

    const target = stagedServerPath(dir);
    if (fs.existsSync(target) && sameStamp(readStamp(dir), current)) {
        return { serverPath: target, updated: false };
    }

    const bundle = fs.readFileSync(source);

    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(target, bundle);
    writeAtomic(stampPath(dir), Buffer.from(JSON.stringify(current, null, 2)));
    return { serverPath: target, updated: true };
}

function readStamp(dir: string): Stamp | undefined {
    try {
        const parsed = JSON.parse(fs.readFileSync(stampPath(dir), 'utf-8'));
        if (typeof parsed?.version !== 'string') return undefined;
        if (typeof parsed?.size !== 'number' || typeof parsed?.mtimeMs !== 'number') return undefined;
        return parsed as Stamp;
    } catch {
        return undefined;
    }
}

function sameStamp(a: Stamp | undefined, b: Stamp): boolean {
    return !!a && a.version === b.version && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Write via a temp file in the same directory so a second VS Code window
 * staging the same build concurrently can never expose a half-written server.
 */
function writeAtomic(target: string, data: Buffer) {
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, target);
}


// --------------- Finding the `claude` CLI ---------------

/**
 * `claude` is looked up on the extension host's own PATH, not through a shell.
 *
 * VS Code has already done the shell work: a GUI-launched window resolves the
 * user's environment by running their login *and* interactive shell
 * (`-i -l -c`, per `shellEnv.ts` upstream) and hands the result to the
 * extension host as `process.env`. Interactive rc files are included, so
 * `mise activate zsh` in `.zshrc` is already reflected here — as is anything
 * mise-vscode has since written into `process.env`. Spawning another login
 * shell would repeat that work, and an interactive shell also prints rc noise
 * onto stdout.
 *
 * Lookup is therefore: an explicit setting, then PATH, then the handful of
 * locations a launcher lands in when PATH resolution has failed us.
 */

/** Setting that overrides discovery, in the shape every language extension offers. */
const CLAUDE_PATH_SETTING = 'crit.claudePath';

/**
 * Fallbacks for when `process.env.PATH` is not the user's real PATH — VS Code
 * gives up on shell resolution after a timeout, and remote/SSH windows build
 * the environment less reliably than local ones.
 */
function fallbackBinDirs(): string[] {
    const home = os.homedir();
    return [
        path.join(home, '.local', 'share', 'mise', 'shims'),
        path.join(home, '.local', 'bin'),
        path.join(home, '.claude', 'local'),
        path.join(home, '.bun', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
    ];
}

/**
 * Absolute path to the `claude` CLI, or undefined.
 *
 * Resolved on each use rather than cached: mise-vscode writes its PATH into the
 * shared `process.env` when it activates, and extension activation order is not
 * something either of us controls.
 */
export function findClaude(env = process.env): string | undefined {
    const configured = vscode.workspace.getConfiguration().get<string>(CLAUDE_PATH_SETTING);
    if (configured) return configured;

    const onPath = which.sync('claude', { nothrow: true, path: env.PATH });
    if (onPath) return onPath;

    return which.sync('claude', { nothrow: true, path: fallbackBinDirs().join(path.delimiter) }) ?? undefined;
}

interface RunResult {
    code: number;
    output: string;
}

/**
 * Run `claude` with `args`. Never rejects; the exit code carries failure.
 *
 * `cwd` is the workspace folder so that Claude Code resolves configuration the
 * same way it would for a session started there — a server registered at local
 * scope in this project is then visible to `mcp get`.
 */
function runClaude(claudePath: string, args: string[]): Promise<RunResult> {
    return new Promise(resolve => {
        execFile(claudePath, args, { cwd: workspaceCwd(), timeout: 30_000 }, (error, stdout, stderr) => {
            const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
            resolve({ code: error ? exitCode(error) : 0, output });
        });
    });
}

/** `error.code` is the exit status for a normal failure, but a string like `ENOENT` when the spawn itself failed. */
function exitCode(error: unknown): number {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return typeof code === 'number' ? code : 1;
}

function workspaceCwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// --------------- Registration ---------------

/** Single-quote for a POSIX shell; `'` is closed, escaped, and reopened. */
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The `claude mcp add` invocation, shown to the user when we cannot run it. */
export function installCommand(serverPath: string): string {
    return `claude mcp add -s user ${MCP_SERVER_NAME} -- node ${shellQuote(serverPath)}`;
}

/**
 * Whether Claude Code has a server registered under our name.
 *
 * `claude mcp get` is the authority here rather than a parse of
 * `~/.claude.json`: it already knows where the config lives, which scopes exist,
 * and which of them apply in this directory. Matching by name — not by the
 * command the entry runs — is deliberate, so that pointing the `crit` entry at a
 * different build is a supported thing to do and not something we overwrite or
 * warn about.
 */
export async function isMcpRegistered(claudePath: string): Promise<boolean> {
    const result = await runClaude(claudePath, ['mcp', 'get', MCP_SERVER_NAME]);
    return result.code === 0;
}

/**
 * Stage the server and register it with Claude Code at user scope.
 *
 * User scope (`-s user`) is deliberate: the default local scope registers the
 * server only for the directory `claude` happened to run in, so it appears to
 * vanish in every other project. The entry is removed before being added so
 * re-running the command repairs a stale or hand-edited entry instead of
 * failing on "already exists".
 */
export async function installMcpServer(context: vscode.ExtensionContext, log: vscode.OutputChannel) {
    let serverPath: string;
    try {
        serverPath = stageServer(context).serverPath;
    } catch (e: any) {
        vscode.window.showErrorMessage(`Crit: could not stage the MCP server — ${e.message}`);
        return;
    }

    const claudePath = findClaude();
    if (!claudePath) {
        await offerManualCommand(
            serverPath,
            'Crit could not find the `claude` CLI. Set `crit.claudePath` if it is installed somewhere unusual.',
        );
        return;
    }

    // Failure here is not fatal — there may be nothing registered to remove.
    await runClaude(claudePath, ['mcp', 'remove', '-s', 'user', MCP_SERVER_NAME]);
    const added = await runClaude(claudePath, ['mcp', 'add', '-s', 'user', MCP_SERVER_NAME, '--', 'node', serverPath]);
    log.appendLine(`[Crit] claude mcp add exited ${added.code}: ${added.output}`);

    if (added.code !== 0) {
        await offerManualCommand(serverPath, `Crit could not register the MCP server: ${added.output}`);
        return;
    }

    vscode.window.showInformationMessage(
        `Crit MCP server registered with Claude Code as "${MCP_SERVER_NAME}" (user scope). ` +
        'Restart any running Claude Code session to pick it up.'
    );
}

// --------------- Prompting when it was never installed ---------------

/** Set once the user asks not to be told again, on this machine. */
const DISMISSED_KEY = 'crit.mcpPromptDismissed';

/**
 * Whether this window has already run the check. It costs a `claude` subprocess
 * and the answer cannot change without the user acting on the notification, so
 * once per window is both enough and as much as anyone wants to be told.
 */
let checkedThisWindow = false;

/**
 * Warn, once, that Crit's MCP server is not registered with Claude Code.
 *
 * Called when comments are sent to Claude Code, because that is the moment the
 * missing half of the integration becomes relevant: the prompt itself arrives
 * fine over cross-session messaging, but every diagnostic code in it is an
 * address Claude cannot act on without the MCP tools.
 */
export async function promptIfMcpMissing(context: vscode.ExtensionContext, log: vscode.OutputChannel) {
    if (checkedThisWindow) return;
    checkedThisWindow = true;
    if (context.globalState.get<boolean>(DISMISSED_KEY)) return;

    const claudePath = findClaude();
    // Nothing to say: without the CLI we cannot tell whether it is registered,
    // and the user is evidently driving Claude Code some other way.
    if (!claudePath) return;

    if (await isMcpRegistered(claudePath)) {
        log.appendLine(`[Crit] MCP server "${MCP_SERVER_NAME}" is registered with Claude Code.`);
        return;
    }

    const install = 'Install';
    const never = "Don't Show Again";
    const choice = await vscode.window.showWarningMessage(
        `Crit's MCP server is not registered with Claude Code. Your comments were sent, but Claude ` +
        'cannot list, reply to, or resolve them until the server is installed.',
        install,
        never,
    );

    if (choice === install) {
        await installMcpServer(context, log);
    } else if (choice === never) {
        await context.globalState.update(DISMISSED_KEY, true);
    }
}

async function offerManualCommand(serverPath: string, reason: string) {
    const choice = await vscode.window.showWarningMessage(
        `${reason} Run this in a terminal instead.`,
        'Copy Command',
    );
    if (choice === 'Copy Command') {
        await vscode.env.clipboard.writeText(installCommand(serverPath));
        vscode.window.showInformationMessage('Install command copied to clipboard.');
    }
}
