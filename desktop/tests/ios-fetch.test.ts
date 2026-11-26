// The iPhone backend's `fetch` (src/main/headless/ios-fetch.ts): Node 18 on an iPhone has no WebAssembly, so the
// built-in fetch cannot work there and every provider call, sign-in and download goes through this one instead.
// Each case here is something the backend relies on the built-in for; the last block checks the two agree.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { iosFetch } from '../src/main/headless/ios-fetch';

let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      switch (url.pathname) {
        case '/echo':
          res.writeHead(200, { 'content-type': 'application/json', 'x-twice': ['a', 'b'] });
          res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
          return;
        case '/gzip': {
          const packed = zlib.gzipSync(Buffer.from(JSON.stringify({ packed: true })));
          res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': packed.length });
          res.end(packed);
          return;
        }
        case '/brotli':
          res.writeHead(200, { 'content-encoding': 'br' });
          res.end(zlib.brotliCompressSync(Buffer.from('brotli text')));
          return;
        case '/events':
          // A streamed reply: three events, a pause between each, the way a provider streams tokens.
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: one\n\n');
          setTimeout(() => res.write('data: two\n\n'), 40);
          setTimeout(() => { res.write('data: three\n\n'); res.end(); }, 80);
          return;
        case '/events-gzip': {
          const gz = zlib.createGzip();
          res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
          gz.pipe(res);
          gz.write('data: one\n\n'); gz.flush();
          // Never ends on its own: the test must receive "one" while the stream is still open.
          req.socket.on('close', () => gz.destroy());
          return;
        }
        case '/never':
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.write('started');
          return; // never ends
        case '/redirect':
          res.writeHead(302, { location: '/echo' });
          res.end();
          return;
        case '/redirect-307':
          res.writeHead(307, { location: '/echo' });
          res.end();
          return;
        case '/redirect-away':
          res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/echo` });
          res.end();
          return;
        case '/loop':
          res.writeHead(302, { location: '/loop' });
          res.end();
          return;
        case '/empty':
          res.writeHead(204);
          res.end();
          return;
        case '/cut':
          res.writeHead(200, { 'content-length': '1000' });
          res.write('partial');
          setTimeout(() => req.socket.destroy(), 20);
          return;
        default:
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('nope');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); });
});

describe('the iPhone backend\'s fetch', () => {
  it('GETs JSON and exposes status, ok, headers and url like the built-in', async () => {
    const r = await iosFetch(`${base}/echo`, { headers: { 'X-Test': 'yes' } });
    expect(r).toBeInstanceOf(Response);
    expect([r.status, r.ok, r.url, r.redirected]).toEqual([200, true, `${base}/echo`, false]);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get('x-twice')).toBe('a, b');
    const j = await r.json() as { method: string; headers: Record<string, string> };
    expect(j.method).toBe('GET');
    expect(j.headers['x-test']).toBe('yes');
  });

  it('sends string, bytes, URLSearchParams and stream bodies with the right content type', async () => {
    const text = await (await iosFetch(`${base}/echo`, { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })).json() as any;
    expect([text.body, text.headers['content-type'], text.headers['content-length']]).toEqual(['{"a":1}', 'application/json', '7']);
    const form = await (await iosFetch(`${base}/echo`, { method: 'POST', body: new URLSearchParams({ a: '1', b: 'two words' }) })).json() as any;
    expect(form.body).toBe('a=1&b=two+words');
    expect(form.headers['content-type']).toMatch(/^application\/x-www-form-urlencoded/);
    const bytes = await (await iosFetch(`${base}/echo`, { method: 'PUT', body: new Uint8Array([104, 105]) })).json() as any;
    expect([bytes.method, bytes.body]).toEqual(['PUT', 'hi']);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('streamed')); c.close(); } });
    const streamed = await (await iosFetch(`${base}/echo`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit)).json() as any;
    expect(streamed.body).toBe('streamed');
  });

  it('accepts a Request object', async () => {
    const r = await iosFetch(new Request(`${base}/echo`, { method: 'POST', body: 'from request', headers: { 'x-from': 'request' } }));
    const j = await r.json() as any;
    expect([j.body, j.headers['x-from']]).toEqual(['from request', 'request']);
  });

  it('unpacks gzip and brotli replies', async () => {
    const r = await iosFetch(`${base}/gzip`);
    expect(await r.json()).toEqual({ packed: true });
    expect(r.headers.get('content-encoding')).toBeNull();
    expect(await (await iosFetch(`${base}/brotli`)).text()).toBe('brotli text');
  });

  it('hands a streamed reply over piece by piece, not all at the end', async () => {
    const r = await iosFetch(`${base}/events`);
    const reader = r.body!.getReader();
    const seen: Array<{ text: string; at: number }> = [];
    const start = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push({ text: new TextDecoder().decode(value), at: Date.now() - start });
    }
    expect(seen.map((s) => s.text).join('')).toBe('data: one\n\ndata: two\n\ndata: three\n\n');
    // The first event arrived well before the last was even sent.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0].at).toBeLessThan(seen[seen.length - 1].at);
  });

  it('a compressed streamed reply still arrives as it is sent', async () => {
    const controller = new AbortController();
    const r = await iosFetch(`${base}/events-gzip`, { signal: controller.signal });
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: one\n\n');
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it('follows a redirect, turning a POST into a GET on 302 and keeping it on 307', async () => {
    const r = await iosFetch(`${base}/redirect`, { method: 'POST', body: 'x' });
    const j = await r.json() as any;
    expect([r.redirected, r.url, j.method, j.body]).toEqual([true, `${base}/echo`, 'GET', '']);
    const kept = await (await iosFetch(`${base}/redirect-307`, { method: 'POST', body: 'kept' })).json() as any;
    expect([kept.method, kept.body]).toEqual(['POST', 'kept']);
  });

  it('never carries a sign-in header to another site on a redirect', async () => {
    const j = await (await iosFetch(`${base}/redirect-away`, { headers: { authorization: 'Bearer secret', 'x-keep': '1' } })).json() as any;
    expect(j.headers.authorization).toBeUndefined();
    expect(j.headers['x-keep']).toBe('1');
  });

  it('redirect: manual returns the 3xx itself; redirect: error and an endless loop reject', async () => {
    const manual = await iosFetch(`${base}/redirect`, { redirect: 'manual' });
    expect([manual.status, manual.headers.get('location')]).toEqual([302, '/echo']);
    await expect(iosFetch(`${base}/redirect`, { redirect: 'error' })).rejects.toThrow(TypeError);
    await expect(iosFetch(`${base}/loop`)).rejects.toThrow(/redirect count/);
  });

  it('answers 204 and 404 without throwing', async () => {
    const empty = await iosFetch(`${base}/empty`);
    expect([empty.status, empty.body]).toEqual([204, null]);
    const missing = await iosFetch(`${base}/missing`);
    expect([missing.status, missing.ok, await missing.text()]).toEqual([404, false, 'nope']);
  });

  it('Stop before the reply starts rejects with the abort error; Stop mid-reply ends the read with it', async () => {
    const before = new AbortController();
    before.abort();
    await expect(iosFetch(`${base}/echo`, { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });

    const during = new AbortController();
    const r = await iosFetch(`${base}/never`, { signal: during.signal });
    const reader = r.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('started');
    during.abort();
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a timeout signal rejects with its own reason (TimeoutError), as the built-in does', async () => {
    const r = iosFetch(`${base}/never`, { signal: AbortSignal.timeout(30) }).then((res) => res.text());
    await expect(r).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('a network failure is TypeError("fetch failed") with the real error as its cause', async () => {
    const err = await iosFetch('http://127.0.0.1:1/').catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('fetch failed');
    expect((err.cause as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
  });

  it('a reply cut off part-way is an error to the reader, never a clean short body', async () => {
    const r = await iosFetch(`${base}/cut`);
    await expect(r.text()).rejects.toThrow();
  });

  it('refuses a body on GET, credentials in the address, and non-web schemes', async () => {
    await expect(iosFetch(`${base}/echo`, { body: 'x' })).rejects.toThrow(TypeError);
    await expect(iosFetch(base.replace('http://', 'http://user:pw@') + '/echo')).rejects.toThrow(TypeError);
    await expect(iosFetch('ftp://example.com/x')).rejects.toThrow(TypeError);
  });

  it('a caller\'s connect-time lookup decides the address, on the first request and on every redirect', async () => {
    const { Agent, fetch: guarded } = await import('../src/main/headless/ios-undici');
    const port = new URL(base).port;
    const seen: string[] = [];
    // A name that does not exist is sent to this computer by the lookup; a refusing lookup stops the request.
    // (Node asks for either one address or a list, depending on its version: answer in the shape asked for.)
    const lookup = ((host: string, o: { all?: boolean }, cb: (e: Error | null, address: unknown, family?: number) => void) => {
      seen.push(host);
      if (o?.all) cb(null, [{ address: '127.0.0.1', family: 4 }]); else cb(null, '127.0.0.1', 4);
    }) as never;
    const agent = new Agent({ connect: { lookup } });
    const r = await guarded(`http://name-that-does-not-exist.invalid:${port}/redirect`, { dispatcher: agent });
    expect(r.status).toBe(200);
    expect(seen.filter((h) => h === 'name-that-does-not-exist.invalid').length).toBeGreaterThanOrEqual(2); // the request and its redirect
    const refuse = ((_h: string, _o: unknown, cb: (e: Error | null) => void) => cb(new Error('refused by the guard'))) as never;
    const err = await guarded(`http://another-name.invalid:${port}/echo`, { dispatcher: new Agent({ connect: { lookup: refuse } }) }).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(String((err as { cause?: Error }).cause?.message)).toContain('refused by the guard');
  });

  it('agrees with the built-in fetch on the same requests', async () => {
    for (const [path, init] of [['/echo', { method: 'POST', body: 'same' }], ['/gzip', {}], ['/redirect', {}], ['/missing', {}]] as Array<[string, RequestInit]>) {
      const [mine, theirs] = await Promise.all([iosFetch(base + path, init), fetch(base + path, init)]);
      expect([mine.status, mine.ok, mine.url, mine.redirected]).toEqual([theirs.status, theirs.ok, theirs.url, theirs.redirected]);
      const [a, b] = await Promise.all([mine.text(), theirs.text()]);
      // The echo includes the request headers the server saw: the same ones, apart from the lines a client library
      // adds about itself.
      const view = (t: string) => {
        try {
          const j = JSON.parse(t) as { headers?: Record<string, string> };
          for (const k of ['user-agent', 'connection', 'accept-language', 'sec-fetch-mode', 'accept-encoding']) delete j.headers?.[k];
          return j;
        } catch { return t; }
      };
      expect(view(a)).toEqual(view(b));
    }
  });
});
