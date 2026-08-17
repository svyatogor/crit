import { randomUUID } from 'crypto';
import * as net from 'net';
import * as os from 'os';

/**
 * Client for Claude Code's cross-session messaging inbox socket.
 * https://code.claude.com/docs/en/cross-session-messaging
 *
 * Documented: each session binds a per-user inbox socket, and a client writes
 * newline-delimited JSON to it — the docs describe an auth frame as "the first
 * line of its connection". The envelope *inside* those lines is not documented;
 * the shape below was read out of Claude Code 2.1.233 and is version-specific.
 *
 * Fields this module deliberately does not send:
 *
 * - `session_id` — the receiver drops any message whose `session_id` disagrees
 *   with its own. Omitting it skips the check entirely.
 * - `msgV` — Claude Code writes it; nothing reads it.
 * - the `<cross-session-message>` wrapper that carries a sender display name.
 *   The receiver re-serializes it and requires byte-identical output, so a
 *   hand-built wrapper breaks on any change to their serializer — silently,
 *   by falling back to treating the whole wrapper as prompt text. Callers who
 *   want attribution should put it in the message text instead.
 * - an auth frame — auth is only required on Windows, where cross-session
 *   messaging is unavailable anyway.
 */

/**
 * `now` interrupts the receiver's running turn; `next` waits for the turn
 * boundary; `later` sits behind everything else. Claude Code's own sends use
 * `next`, and so does this client — a review batch is never worth aborting
 * work in flight.
 */
export type MessagePriority = 'now' | 'next' | 'later';

export interface SendMessageOptions {
    priority?: MessagePriority;
    /**
     * Reply address for delivery receipts, as `uds:<percent-encoded path>`.
     * Receipts only reach a `.sock` inside the receiver's own socket directory,
     * so a client that does not listen there gains nothing by setting this.
     */
    from?: string;
    timeoutMs?: number;
}

/**
 * The receiver drops any connection that exceeds 1 MiB without a newline. Stay
 * well short of it and fail with a clear error rather than having the socket
 * torn down mid-write.
 */
const MAX_FRAME_BYTES = 900_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/** Claude Code's own client waits this long on macOS before half-closing. */
const MACOS_FLUSH_DELAY_MS = 150;

/** Build the single NDJSON line that delivers `text` as a user turn. */
export function buildUserMessageFrame(text: string, options: SendMessageOptions = {}): string {
    if (typeof text !== 'string' || text.length === 0) {
        throw new Error('Cross-session message text must be a non-empty string.');
    }

    const frame: Record<string, unknown> = {
        type: 'user',
        message: { role: 'user', content: text },
        priority: options.priority ?? 'next',
        msg_id: randomUUID(),
        ...(options.from ? { from: options.from } : {}),
    };

    const line = JSON.stringify(frame);
    const bytes = Buffer.byteLength(line, 'utf-8');
    if (bytes > MAX_FRAME_BYTES) {
        throw new Error(
            `Cross-session message is too large to deliver (${bytes} bytes, limit ${MAX_FRAME_BYTES}). ` +
            'Send fewer comments at once.',
        );
    }
    return line;
}

/**
 * Deliver `text` to the session listening on `socketPath`.
 *
 * Resolving means the frame reached the socket and the connection closed
 * cleanly — NOT that Claude acted on it. The inbox never acks: every rejection
 * (rate limit, duplicate, `crossSessionInbound: refuse`, a receiver holding the
 * message for approval) is silent on this connection and surfaces only in the
 * receiving session. Treat success as "handed over", never as "delivered".
 */
export function sendMessageToSocket(
    socketPath: string,
    text: string,
    options: SendMessageOptions = {},
): Promise<void> {
    const line = buildUserMessageFrame(text, options) + '\n';
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath });
        let flushTimer: NodeJS.Timeout | undefined;
        let settled = false;

        const settle = (error?: Error) => {
            if (settled) return;
            settled = true;
            if (flushTimer) clearTimeout(flushTimer);
            socket.destroy();
            if (error) reject(error); else resolve();
        };

        socket.on('connect', () => {
            socket.write(line);
            // Closing immediately after the write can lose it on macOS
            if (os.platform() === 'darwin') {
                flushTimer = setTimeout(() => {
                    if (!socket.destroyed) socket.end();
                }, MACOS_FLUSH_DELAY_MS);
            } else {
                socket.end();
            }
        });

        socket.on('close', () => settle());

        socket.on('error', (error: Error) => settle(new Error(
            `Could not deliver a Crit message to ${socketPath}: ${error.message}. ` +
            'The Claude Code session may have exited.',
        )));

        socket.setTimeout(timeoutMs, () => settle(new Error(
            `Timed out after ${timeoutMs}ms delivering a Crit message to ${socketPath}.`,
        )));
    });
}
