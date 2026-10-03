/**
 * Mixergy cloud API v2 client. No adapter dependencies.
 *
 * Only the API root is a fixed path; every other endpoint is discovered through `_links`
 * (SCOPE.md §2). Discovered links are validated before a bearer token is sent to them, and
 * redirects are never followed, so a bad upstream link cannot leak the token.
 */

import { Mutex } from './mutex';
import { asObject, hasPvDiverter } from './parse';

export const API_ROOT = 'https://www.mixergy.io/api/v2';
const API_ORIGIN = 'https://www.mixergy.io';

const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;
const DEFAULT_TOKEN_TTL_S = 3600;

/** Any failure talking to the cloud API. */
export class MixergyApiError extends Error {
    /**
     * @param message - error text
     * @param status - HTTP status, when there was a response
     */
    public constructor(
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'MixergyApiError';
    }
}

/** Login rejected, or a request still rejected after a fresh login. */
export class MixergyAuthError extends MixergyApiError {
    /**
     * @param message - error text
     * @param status - HTTP status, when there was a response
     */
    public constructor(message: string, status?: number) {
        super(message, status);
        this.name = 'MixergyAuthError';
    }
}

/** A tank as listed on the account. */
export interface CloudTank {
    /** Upper-case serial number. */
    serial: string;
    /** Firmware version from the tank list. */
    firmwareVersion: string;
    /** The tank's detail endpoint. */
    selfUrl: string;
}

/** Static tank details and its endpoints. */
export interface TankDetail {
    /** Tank model code. */
    modelCode: string;
    /** Whether a PV diverter is configured. */
    hasPvDiverter: boolean;
    /** `latest_measurement` endpoint. */
    measurementUrl: string;
    /** `control` endpoint. */
    controlUrl: string;
    /** `settings` endpoint. */
    settingsUrl: string;
    /** `schedule` endpoint. */
    scheduleUrl: string;
}

/** Client configuration. */
export interface CloudOptions {
    /** Account email. */
    username: string;
    /** Account password. */
    password: string;
    /** Injected for tests. */
    fetch?: typeof fetch;
    /** Injected for tests. */
    now?: () => number;
}

/**
 * Accepts only HTTPS links on the Mixergy API origin, without embedded credentials.
 *
 * @param href - the discovered link
 * @param name - link name, for the error message
 */
export function requireSafeLink(href: unknown, name: string): string {
    if (typeof href !== 'string' || href === '') {
        throw new MixergyApiError(`Missing "${name}" link in API response`);
    }
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        throw new MixergyApiError(`Invalid "${name}" link in API response`);
    }
    if (url.protocol !== 'https:' || url.origin !== API_ORIGIN || url.username || url.password) {
        throw new MixergyApiError(`Refusing "${name}" link outside ${API_ORIGIN}: ${url.origin}`);
    }
    return url.toString();
}

function linkOf(body: unknown, name: string): string {
    const href = asObject(asObject(asObject(body)?._links)?.[name])?.href;
    return requireSafeLink(href, name);
}

/** Client for one Mixergy account. */
export class MixergyCloud {
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;

    private token: string | null = null;
    private tokenExpiry = 0;
    private loginUrl: string | null = null;
    private tanks: CloudTank[] | null = null;
    private readonly details = new Map<string, TankDetail>();

    private readonly authLock = new Mutex();
    private readonly discoveryLock = new Mutex();
    private readonly scheduleLock = new Mutex();

    /** @param options - account credentials and test hooks */
    public constructor(private readonly options: CloudOptions) {
        this.fetchImpl = options.fetch ?? fetch;
        this.now = options.now ?? Date.now;
    }

    /** Lists the tanks on the account. Cached until a stale link forces re-discovery. */
    public async listTanks(): Promise<CloudTank[]> {
        return this.discoveryLock.run(async () => {
            if (this.tanks) {
                return this.tanks;
            }
            const root = await this.request('GET', API_ROOT);
            const list = await this.request('GET', linkOf(root, 'tanks'));
            const entries = asObject(asObject(list)?._embedded)?.tankList;
            if (!Array.isArray(entries)) {
                throw new MixergyApiError('Tank list missing from API response');
            }
            const tanks: CloudTank[] = [];
            for (const entry of entries) {
                const serial = asObject(entry)?.serialNumber;
                if (typeof serial !== 'string' || serial === '') {
                    continue;
                }
                const firmware = asObject(entry)?.firmwareVersion;
                tanks.push({
                    serial: serial.toUpperCase(),
                    firmwareVersion: typeof firmware === 'string' ? firmware : '',
                    selfUrl: linkOf(entry, 'self'),
                });
            }
            this.tanks = tanks;
            return tanks;
        });
    }

    /**
     * Static details and endpoints for a tank. Cached until a stale link forces re-discovery.
     *
     * @param serial - tank serial number
     */
    public async getDetail(serial: string): Promise<TankDetail> {
        const cached = this.details.get(serial);
        if (cached) {
            return cached;
        }
        const tank = (await this.listTanks()).find(t => t.serial === serial);
        if (!tank) {
            throw new MixergyApiError(`Tank ${serial} is not on this account`);
        }
        const body = await this.request('GET', tank.selfUrl);
        const model = asObject(body)?.tankModelCode;
        const detail: TankDetail = {
            modelCode: typeof model === 'string' ? model : '',
            hasPvDiverter: hasPvDiverter(asObject(body)?.configuration),
            measurementUrl: linkOf(body, 'latest_measurement'),
            controlUrl: linkOf(body, 'control'),
            settingsUrl: linkOf(body, 'settings'),
            scheduleUrl: linkOf(body, 'schedule'),
        };
        this.details.set(serial, detail);
        return detail;
    }

    /** @param serial - tank serial number */
    public async getMeasurement(serial: string): Promise<unknown> {
        return this.request('GET', (await this.getDetail(serial)).measurementUrl);
    }

    /** @param serial - tank serial number */
    public async getSettings(serial: string): Promise<unknown> {
        return this.request('GET', (await this.getDetail(serial)).settingsUrl);
    }

    /** @param serial - tank serial number */
    public async getSchedule(serial: string): Promise<unknown> {
        return this.request('GET', (await this.getDetail(serial)).scheduleUrl);
    }

    /**
     * @param serial - tank serial number
     * @param charge - target charge, % (caller clamps)
     */
    public async setTargetCharge(serial: string, charge: number): Promise<void> {
        await this.request('PUT', (await this.getDetail(serial)).controlUrl, { charge });
    }

    /**
     * @param serial - tank serial number
     * @param patch - settings fields to change (caller clamps)
     */
    public async putSettings(serial: string, patch: Record<string, number | boolean>): Promise<void> {
        await this.request('PUT', (await this.getDetail(serial)).settingsUrl, patch);
    }

    /**
     * Read-modify-write of the whole schedule document. The API has no field-level update, so
     * writes are serialised to stop two near-simultaneous changes overwriting each other.
     *
     * @param serial - tank serial number
     * @param mutate - changes the fetched document in place
     */
    public async mutateSchedule(serial: string, mutate: (schedule: Record<string, unknown>) => void): Promise<void> {
        await this.scheduleLock.run(async () => {
            const url = (await this.getDetail(serial)).scheduleUrl;
            const current = asObject(await this.request('GET', url));
            if (!current) {
                throw new MixergyApiError('Schedule missing from API response');
            }
            const next = structuredClone(current);
            mutate(next);
            await this.request('PUT', url, next);
        });
    }

    /** Forgets every discovered link, so the next call walks the API again. */
    public clearDiscovery(): void {
        this.loginUrl = null;
        this.tanks = null;
        this.details.clear();
    }

    private async ensureToken(): Promise<string> {
        return this.authLock.run(async () => {
            if (this.token && this.now() < this.tokenExpiry - TOKEN_REFRESH_BUFFER_MS) {
                return this.token;
            }
            this.token = null;
            if (!this.loginUrl) {
                const root = await this.request('GET', API_ROOT, undefined, false);
                const account = await this.request('GET', linkOf(root, 'account'), undefined, false);
                this.loginUrl = linkOf(account, 'login');
            }
            const body = asObject(
                await this.request(
                    'POST',
                    this.loginUrl,
                    { username: this.options.username, password: this.options.password },
                    false,
                ),
            );
            const token = body?.token;
            if (typeof token !== 'string' || token === '') {
                throw new MixergyAuthError('Login response contained no token');
            }
            // Don't trust the TTL blindly: a tiny or missing value would force a login per request
            const ttl =
                typeof body?.ttl === 'number' && Number.isFinite(body.ttl) && body.ttl > 0
                    ? body.ttl
                    : DEFAULT_TOKEN_TTL_S;
            this.token = token;
            this.tokenExpiry = this.now() + Math.max(ttl * 1000, TOKEN_REFRESH_BUFFER_MS * 2);
            return token;
        });
    }

    private async request(
        method: 'GET' | 'PUT' | 'POST',
        url: string,
        body?: unknown,
        auth = true,
        retried = false,
    ): Promise<unknown> {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }
        if (auth) {
            headers.Authorization = `Bearer ${await this.ensureToken()}`;
        }

        let status: number;
        let text: string;
        try {
            const res = await this.fetchImpl(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'manual',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            status = res.status;
            text = await res.text();
        } catch (err) {
            throw new MixergyApiError(`${method} ${new URL(url).pathname} failed: ${(err as Error).message}`);
        }

        if (status === 401 || status === 403) {
            if (auth && status === 401 && !retried) {
                this.token = null;
                return this.request(method, url, body, auth, true);
            }
            this.token = null;
            throw new MixergyAuthError(`Mixergy rejected the credentials (HTTP ${status})`, status);
        }
        if (status === 404 || status === 410 || (status >= 300 && status < 400)) {
            // The endpoint moved: re-discover on the next call instead of hitting a dead link forever
            this.clearDiscovery();
            throw new MixergyApiError(`${method} ${new URL(url).pathname} returned HTTP ${status}`, status);
        }
        if (status < 200 || status >= 300) {
            throw new MixergyApiError(`${method} ${new URL(url).pathname} returned HTTP ${status}`, status);
        }

        // settings and schedule are served as text/plain, so never trust the content type
        if (text.trim() === '') {
            return null;
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new MixergyApiError(`${method} ${new URL(url).pathname} returned invalid JSON`, status);
        }
    }
}
