import { expect } from 'chai';
import { API_ROOT, MixergyApiError, MixergyAuthError, MixergyCloud, requireSafeLink } from './cloud';

// A fake Mixergy API shaped after the community integrations (SCOPE.md §2) — not captured.
const BASE = 'https://www.mixergy.io/api/v2';
const link = (href: string): { href: string } => ({ href });

interface Call {
    method: string;
    url: string;
    auth: string | undefined;
    body: unknown;
}

type Handler = (call: Call) => { status: number; body?: unknown; text?: string };

function fakeApi(overrides: Record<string, Handler> = {}): {
    fetch: typeof fetch;
    calls: Call[];
    state: { logins: number };
} {
    const calls: Call[] = [];
    const state = { logins: 0 };
    const routes: Record<string, Handler> = {
        [`GET ${API_ROOT}`]: c =>
            c.auth
                ? { status: 200, body: { _links: { tanks: link(`${BASE}/tanks`) } } }
                : { status: 200, body: { _links: { account: link(`${BASE}/account`) } } },
        [`GET ${BASE}/account`]: () => ({ status: 200, body: { _links: { login: link(`${BASE}/account/login`) } } }),
        [`POST ${BASE}/account/login`]: () => {
            state.logins++;
            return { status: 201, body: { token: `tok${state.logins}`, ttl: 3600 } };
        },
        [`GET ${BASE}/tanks`]: () => ({
            status: 200,
            body: {
                _embedded: {
                    tankList: [
                        {
                            serialNumber: 'mx001234',
                            firmwareVersion: '1.2.3',
                            _links: { self: link(`${BASE}/tanks/1`) },
                        },
                    ],
                },
            },
        }),
        [`GET ${BASE}/tanks/1`]: () => ({
            status: 200,
            body: {
                tankModelCode: 'MX-180',
                configuration: '{"mixergyPvType":"NO_INVERTER"}',
                _links: {
                    latest_measurement: link(`${BASE}/tanks/1/measurements/latest`),
                    control: link(`${BASE}/tanks/1/control`),
                    settings: link(`${BASE}/tanks/1/settings`),
                    schedule: link(`${BASE}/tanks/1/schedule`),
                },
            },
        }),
        [`GET ${BASE}/tanks/1/measurements/latest`]: () => ({ status: 200, body: { charge: 50 } }),
        // settings and schedule are served as text/plain
        [`GET ${BASE}/tanks/1/settings`]: () => ({ status: 200, text: '{"max_temp":60}' }),
        [`GET ${BASE}/tanks/1/schedule`]: () => ({
            status: 200,
            text: '{"defaultHeatSource":"electric","schedule":{"keep":"me"}}',
        }),
        [`PUT ${BASE}/tanks/1/control`]: () => ({ status: 200 }),
        [`PUT ${BASE}/tanks/1/settings`]: () => ({ status: 200 }),
        [`PUT ${BASE}/tanks/1/schedule`]: () => ({ status: 200 }),
        ...overrides,
    };
    const fake = ((input: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const call: Call = {
            method: init?.method ?? 'GET',
            url: input instanceof Request ? input.url : input.toString(),
            auth: headers.Authorization,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        expect(init?.redirect).to.equal('manual');
        expect(init?.signal).to.be.instanceOf(AbortSignal);
        const route = routes[`${call.method} ${call.url}`];
        const res = route ? route(call) : { status: 404 };
        const text = res.text ?? (res.body === undefined ? '' : JSON.stringify(res.body));
        return Promise.resolve(new Response(text === '' ? null : text, { status: res.status }));
    }) as typeof fetch;
    return { fetch: fake, calls, state };
}

describe('requireSafeLink', () => {
    it('accepts HTTPS links on the API origin', () => {
        expect(requireSafeLink(`${BASE}/tanks`, 'tanks')).to.equal(`${BASE}/tanks`);
    });

    it('refuses links that would leak the bearer token', () => {
        for (const bad of [
            'http://www.mixergy.io/api/v2/tanks',
            'https://evil.example/api/v2/tanks',
            'https://www.mixergy.io.evil.example/x',
            'https://user:pw@www.mixergy.io/x',
            'https://www.mixergy.io:8443/x',
            '',
            undefined,
        ]) {
            expect(() => requireSafeLink(bad, 'tanks')).to.throw(MixergyApiError);
        }
    });
});

describe('MixergyCloud', () => {
    const credentials = { username: 'user@example.com', password: 'secret' };

    it('logs in, discovers the tank and parses text/plain bodies', async () => {
        const api = fakeApi();
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch });
        const tanks = await cloud.listTanks();
        expect(tanks).to.deep.equal([{ serial: 'MX001234', firmwareVersion: '1.2.3', selfUrl: `${BASE}/tanks/1` }]);
        const detail = await cloud.getDetail('MX001234');
        expect(detail.modelCode).to.equal('MX-180');
        expect(detail.hasPvDiverter).to.equal(false);
        expect(await cloud.getSettings('MX001234')).to.deep.equal({ max_temp: 60 });

        const login = api.calls.find(c => c.method === 'POST')!;
        expect(login.auth).to.equal(undefined);
        expect(login.body).to.deep.equal(credentials);
        expect(api.calls.filter(c => c.url.includes('/tanks')).every(c => c.auth === 'Bearer tok1')).to.equal(true);
    });

    it('caches discovery and the token across polls', async () => {
        const api = fakeApi();
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch });
        await Promise.all([cloud.getMeasurement('MX001234'), cloud.getMeasurement('MX001234')]);
        api.calls.length = 0;
        await cloud.getMeasurement('MX001234');
        expect(api.calls.map(c => c.url)).to.deep.equal([`${BASE}/tanks/1/measurements/latest`]);
        expect(api.state.logins).to.equal(1);
    });

    it('refreshes the token before it expires', async () => {
        let now = 1_000_000;
        const api = fakeApi();
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch, now: () => now });
        await cloud.getMeasurement('MX001234');
        now += 3600_000 - 4 * 60_000; // inside the 5 min refresh window
        await cloud.getMeasurement('MX001234');
        expect(api.state.logins).to.equal(2);
    });

    it('retries a 401 once after a fresh login', async () => {
        let rejected = false;
        const api = fakeApi({
            [`GET ${BASE}/tanks/1/measurements/latest`]: () => {
                if (!rejected) {
                    rejected = true;
                    return { status: 401 };
                }
                return { status: 200, body: { charge: 51 } };
            },
        });
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch });
        expect(await cloud.getMeasurement('MX001234')).to.deep.equal({ charge: 51 });
        expect(api.state.logins).to.equal(2);
    });

    it('raises MixergyAuthError when the login is rejected', async () => {
        const api = fakeApi({ [`POST ${BASE}/account/login`]: () => ({ status: 401 }) });
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch });
        await expect(cloud.listTanks()).to.be.rejectedWith(MixergyAuthError);
    });

    it('raises MixergyAuthError when a request is still rejected after re-login', async () => {
        const api = fakeApi({ [`GET ${BASE}/tanks`]: () => ({ status: 401 }) });
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch });
        await expect(cloud.listTanks()).to.be.rejectedWith(MixergyAuthError);
        expect(api.state.logins).to.equal(2);
    });

    it('refuses to follow an off-origin link', async () => {
        const api = fakeApi({
            [`GET ${BASE}/tanks`]: () => ({
                status: 200,
                body: {
                    _embedded: { tankList: [{ serialNumber: 'X', _links: { self: link('http://evil.example/t') } }] },
                },
            }),
        });
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch });
        await expect(cloud.listTanks()).to.be.rejectedWith(MixergyApiError, /Refusing/);
        expect(api.calls.some(c => c.url.includes('evil'))).to.equal(false);
    });

    it('re-discovers after a 404 on a cached link', async () => {
        let gone = true;
        const api = fakeApi({
            [`GET ${BASE}/tanks/1/measurements/latest`]: () => {
                if (gone) {
                    gone = false;
                    return { status: 404 };
                }
                return { status: 200, body: { charge: 52 } };
            },
        });
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch });
        await expect(cloud.getMeasurement('MX001234')).to.be.rejectedWith(MixergyApiError, /404/);
        api.calls.length = 0;
        expect(await cloud.getMeasurement('MX001234')).to.deep.equal({ charge: 52 });
        expect(api.calls.some(c => c.url === `${BASE}/tanks`)).to.equal(true);
    });

    it('treats a redirect as an error instead of following it', async () => {
        const api = fakeApi({ [`GET ${BASE}/tanks`]: () => ({ status: 302 }) });
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch });
        await expect(cloud.listTanks()).to.be.rejectedWith(MixergyApiError, /302/);
    });

    it('wraps network failures', async () => {
        const failing = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
        const cloud = new MixergyCloud({ ...credentials, fetch: failing });
        await expect(cloud.listTanks()).to.be.rejectedWith(MixergyApiError, /fetch failed/);
    });

    it('writes control and settings', async () => {
        const api = fakeApi();
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch });
        await cloud.setTargetCharge('MX001234', 100);
        await cloud.putSettings('MX001234', { max_temp: 55 });
        const puts = api.calls.filter(c => c.method === 'PUT');
        expect(puts.map(c => [c.url, c.body])).to.deep.equal([
            [`${BASE}/tanks/1/control`, { charge: 100 }],
            [`${BASE}/tanks/1/settings`, { max_temp: 55 }],
        ]);
    });

    it('serialises schedule read-modify-write so concurrent changes both survive', async () => {
        let stored: Record<string, unknown> = { defaultHeatSource: 'electric', schedule: { keep: 'me' } };
        const api = fakeApi({
            [`GET ${BASE}/tanks/1/schedule`]: () => ({ status: 200, text: JSON.stringify(stored) }),
            [`PUT ${BASE}/tanks/1/schedule`]: c => {
                stored = c.body as Record<string, unknown>;
                return { status: 200 };
            },
        });
        const cloud = new MixergyCloud({ ...credentials, fetch: api.fetch });
        await Promise.all([
            cloud.mutateSchedule('MX001234', s => {
                s.defaultHeatSource = 'indirect';
            }),
            cloud.mutateSchedule('MX001234', s => {
                s.holiday = { departDate: 1, returnDate: 2 };
            }),
        ]);
        expect(stored).to.deep.equal({
            defaultHeatSource: 'indirect',
            schedule: { keep: 'me' },
            holiday: { departDate: 1, returnDate: 2 },
        });
    });
});
