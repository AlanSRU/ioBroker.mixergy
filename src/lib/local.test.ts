import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { fetchLocalStatus, LocalStream, parseLocalHost } from './local';
import type { LocalMessage } from './parse';

const captures = join(__dirname, '..', '..', 'docs', 'captures');
const measurements = readFileSync(join(captures, 'measurements.raw'), 'utf8');
const status = readFileSync(join(captures, 'status.json'), 'utf8');

/**
 * Replays the captures on 127.0.0.1, mimicking the controller (chunked, no content type).
 *
 * @param handler - request handler
 */
async function fakeController(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ host: string; paths: string[]; close: () => Promise<void> }> {
    const paths: string[] = [];
    const sockets = new Set<Socket>();
    const server = http.createServer((req, res) => {
        paths.push(req.url ?? '');
        handler(req, res);
    });
    server.on('connection', s => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        host: `127.0.0.1:${port}`,
        paths,
        close: () =>
            new Promise<void>(resolve => {
                sockets.forEach(s => s.destroy());
                server.close(() => resolve());
            }),
    };
}

describe('parseLocalHost', () => {
    it('accepts a bare host or host:port', () => {
        expect(parseLocalHost(' 192.168.1.50 ')).to.equal('192.168.1.50');
        expect(parseLocalHost('mixpi.local:8080')).to.equal('mixpi.local:8080');
    });

    it('rejects anything that could change the request path', () => {
        for (const bad of [
            '',
            '192.168.1.5/disconnect',
            'http://192.168.1.5',
            '1.2.3.4?x',
            'a b',
            '1.2.3.4:',
            '1.2.3.4:0',
            '1.2.3.4:70000',
        ]) {
            expect(parseLocalHost(bad)).to.equal(null);
        }
    });
});

describe('LocalStream', () => {
    it('reads the captured stream delivered in odd-sized chunks', async () => {
        const ctl = await fakeController((_req, res) => {
            res.writeHead(200); // the real controller sends no content-type
            for (let i = 0; i < measurements.length; i += 37) {
                res.write(measurements.slice(i, i + 37));
            }
            res.end();
        });
        const messages: LocalMessage[] = [];
        const reason = await new Promise<string>(resolve => {
            new LocalStream(ctl.host, { onMessage: m => messages.push(m), onClose: resolve }).start();
        });
        await ctl.close();
        expect(ctl.paths).to.deep.equal(['/measurements']);
        expect(messages).to.have.length(78);
        expect(reason).to.be.a('string');
    });

    it('reports a stalled stream once', async () => {
        const ctl = await fakeController((_req, res) => {
            res.writeHead(200);
            res.write(`${measurements.split('\n')[0]}\n`); // then goes silent
        });
        let closes = 0;
        const messages: LocalMessage[] = [];
        const reason = await new Promise<string>(resolve => {
            new LocalStream(
                ctl.host,
                {
                    onMessage: m => messages.push(m),
                    onClose: r => {
                        closes++;
                        resolve(r);
                    },
                },
                200,
            ).start();
        });
        await new Promise(resolve => setImmediate(resolve));
        await ctl.close();
        expect(messages).to.have.length(1);
        expect(reason).to.match(/no data/);
        expect(closes).to.equal(1);
    });

    it('reports a non-200 response', async () => {
        const ctl = await fakeController((_req, res) => {
            res.writeHead(500);
            res.end();
        });
        const reason = await new Promise<string>(resolve => {
            new LocalStream(ctl.host, { onMessage: () => undefined, onClose: resolve }).start();
        });
        await ctl.close();
        expect(reason).to.match(/HTTP 500/);
    });

    it('does not report a deliberate stop', async () => {
        const ctl = await fakeController((_req, res) => {
            res.writeHead(200);
            res.write(`${measurements.split('\n')[0]}\n`);
        });
        let closed = false;
        await new Promise<void>(resolve => {
            const stream = new LocalStream(ctl.host, {
                onMessage: () => {
                    stream.stop();
                    resolve();
                },
                onClose: () => (closed = true),
            });
            stream.start();
        });
        await ctl.close();
        expect(closed).to.equal(false);
    });
});

describe('fetchLocalStatus', () => {
    it('reads and normalises /status', async () => {
        const ctl = await fakeController((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(status);
        });
        const s = await fetchLocalStatus(ctl.host);
        await ctl.close();
        expect(ctl.paths).to.deep.equal(['/status']);
        expect(s.heatSourceActual).to.equal('indirect');
        expect(s.systemOn).to.equal(true);
    });
});
