/**
 * Read-only client for the tank's on-board controller (SCOPE.md §3). No adapter dependencies.
 *
 * Only `GET /measurements` and `GET /status` are ever requested. The controller also serves
 * unauthenticated `/connect`, `/disconnect` and `/rescanwifi` routes that can knock the tank
 * off the network, so no path here is built from configuration or payload data.
 */

import * as http from 'node:http';
import { LineSplitter, parseLocalLine, parseLocalStatus, type LocalMessage, type LocalStatus } from './parse';

const STATUS_TIMEOUT_MS = 5_000;

/** `host` or `host:port`, IPv4 address or hostname. */
const HOST_PATTERN = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;

/**
 * Validates a configured controller address.
 *
 * @param value - configured host
 * @returns the trimmed address, or null when it is not a bare host[:port]
 */
export function parseLocalHost(value: string): string | null {
    const host = value.trim();
    return HOST_PATTERN.test(host) ? host : null;
}

/**
 * Fetches `/status` once.
 *
 * @param host - validated host[:port]
 */
export async function fetchLocalStatus(host: string): Promise<LocalStatus> {
    const res = await fetch(`http://${host}/status`, {
        redirect: 'error',
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    return parseLocalStatus(await res.json());
}

/** Callbacks for a {@link LocalStream}. */
export interface LocalStreamHandlers {
    /** Called for every parsed message. */
    onMessage: (message: LocalMessage) => void;
    /** Called once per connection, after the stream has ended for any reason. */
    onClose: (reason: string) => void;
}

/**
 * One connection to the never-ending NDJSON `/measurements` stream. The stream pushes a
 * message every 100 ms, so a socket idle for `stallMs` is treated as a stalled controller.
 * Reconnecting is the caller's job: create a new instance.
 */
export class LocalStream {
    private request: http.ClientRequest | null = null;
    private finished = false;

    /**
     * @param host - validated host[:port]
     * @param handlers - event callbacks
     * @param stallMs - idle time before the connection is dropped
     */
    public constructor(
        private readonly host: string,
        private readonly handlers: LocalStreamHandlers,
        private readonly stallMs = 5_000,
    ) {}

    /** Opens the connection. */
    public start(): void {
        const [hostname, port] = this.host.split(':');
        const splitter = new LineSplitter();
        const req = http.get({ hostname, port: port ? Number(port) : 80, path: '/measurements' }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                req.destroy(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
                for (const line of splitter.push(chunk)) {
                    const message = parseLocalLine(line);
                    if (message) {
                        this.handlers.onMessage(message);
                    }
                }
            });
            res.on('end', () => this.finish('stream ended'));
            res.on('error', err => this.finish(err.message));
        });
        // Socket idle timeout: covers both a hung connect and a stalled stream
        req.setTimeout(this.stallMs, () => req.destroy(new Error(`no data for ${this.stallMs / 1000} s`)));
        req.on('error', err => this.finish(err.message));
        req.on('close', () => this.finish('connection closed'));
        this.request = req;
    }

    /** Closes the connection without reporting it to `onClose`. */
    public stop(): void {
        this.finished = true;
        this.request?.destroy();
        this.request = null;
    }

    private finish(reason: string): void {
        if (this.finished) {
            return;
        }
        this.finished = true;
        this.request?.destroy();
        this.request = null;
        this.handlers.onClose(reason);
    }
}
