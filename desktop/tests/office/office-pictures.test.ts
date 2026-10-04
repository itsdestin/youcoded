// Insert → Picture (finish plan Task 1): the editor asks its own office://<token> origin to copy a
// picture the person chose (copy-to-media/<handle>) or to fetch one from the web
// (download-to-media/<url>) into the document's media folder, and answers with the bare name it
// got there — the name the document then references and x2t packs on save.
import path from 'node:path';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promises as fsp } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessions } from '../../src/main/office/office-sessions';
import { MEDIA_CSP, OFFICE_CSP, officeRequestHandler } from '../../src/main/office/office-protocol';
import { EventEmitter } from 'node:events';
import { downloadToMedia, grantPicked, PICTURE_MAX_BYTES, pictureRequestVia, type PictureRequest } from '../../src/main/office/office-pictures';
import { nonPublicReason } from '../../src/main/office/public-address';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('pictures into a document', () => {
  let dir: string;
  let sessions: ReturnType<typeof createSessions>;
  let fetched: string[];
  let download: PictureRequest;
  let dns: Record<string, string[]>;
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'office-pictures-test-'));
    await mkdir(path.join(dir, 'addon', 'editors'), { recursive: true });
    await mkdir(path.join(dir, 'pics'), { recursive: true });
    await writeFile(path.join(dir, 'pics', 'cat.png'), PNG);
    await writeFile(path.join(dir, 'pics', 'notes.txt'), 'not a picture');
    sessions = createSessions(path.join(dir, 'sessions-tmp'));
    fetched = [];
    download = async (url) => {
      fetched.push(url);
      return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    };
    // example.com and example.org resolve to public addresses; anything unknown fails to resolve
    dns = { 'example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'], 'example.org': ['93.184.215.14'] };
    handler = officeRequestHandler({ root: path.join(dir, 'addon'), sessions, ...net() });
  });

  /** The handler's network seams: the one-hop request and the name lookup, both fakes. */
  const net = (timeoutMs?: number) => ({
    download: ((u, o) => download(u, o)) as PictureRequest,
    resolveHost: async (h: string) => { if (!dns[h]) throw new Error('ENOTFOUND'); return dns[h]; },
    downloadTimeoutMs: timeoutMs,
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  const ask = (token: string, route: string, what: string) =>
    handler(new Request(`office://${token}/asc/${route}/${encodeURIComponent(what)}`));

  describe('a picture the person chose in the dialog', () => {
    it('hands the editor a handle that names the file but never its folder', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const [handle] = grantPicked(s, [path.join(dir, 'pics', 'cat.png')]);
      expect(handle.endsWith('/cat.png')).toBe(true);
      expect(handle).not.toContain(dir);
      expect(handle).not.toContain('pics');
    });

    it('is copied into the document\'s media under a fresh name, answered with that bare name', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const [handle] = grantPicked(s, [path.join(dir, 'pics', 'cat.png')]);
      const res = await ask(s.token, 'copy-to-media', handle);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const name = await res.text();
      expect(name).toMatch(/^[\w-]+\.png$/);
      expect(await readFile(path.join(s.temp, 'media', name))).toEqual(PNG);
      // and the editor can then load it from its own origin
      const shown = await handler(new Request(`office://${s.token}/asc/docmedia/media/${name}`));
      expect(shown.status).toBe(200);
      expect(Buffer.from(await shown.arrayBuffer())).toEqual(PNG);
    });

    it('never overwrites a picture the document already has', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const [handle] = grantPicked(s, [path.join(dir, 'pics', 'cat.png')]);
      const a = await (await ask(s.token, 'copy-to-media', handle)).text();
      const b = await (await ask(s.token, 'copy-to-media', handle)).text();
      expect(a).not.toBe(b);
      expect((await readdir(path.join(s.temp, 'media'))).sort()).toEqual([a, b].sort());
    });

    it('refuses a real path the dialog never gave, even an existing picture', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const res = await ask(s.token, 'copy-to-media', path.join(dir, 'pics', 'cat.png'));
      expect(res.status).toBe(404);
      await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
    });

    it('refuses a handle granted to another document', async () => {
      const mine = await sessions.open('/docs/report.docx', 1);
      const other = await sessions.open('/docs/other.docx', 1);
      const [handle] = grantPicked(mine, [path.join(dir, 'pics', 'cat.png')]);
      expect((await ask(other.token, 'copy-to-media', handle)).status).toBe(404);
    });

    it('refuses a made-up handle', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      grantPicked(s, [path.join(dir, 'pics', 'cat.png')]);
      expect((await ask(s.token, 'copy-to-media', 'yc-picked/00000000000000000000000000000000/cat.png')).status).toBe(404);
    });

    it('refuses a chosen file that is not a picture', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const [handle] = grantPicked(s, [path.join(dir, 'pics', 'notes.txt')]);
      expect((await ask(s.token, 'copy-to-media', handle)).status).toBe(404);
    });

    it('refuses a chosen picture over the size cap', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const big = path.join(dir, 'pics', 'huge.png');
      await writeFile(big, Buffer.alloc(PICTURE_MAX_BYTES + 1));
      const [handle] = grantPicked(s, [big]);
      expect((await ask(s.token, 'copy-to-media', handle)).status).toBe(404);
    });
  });

  it('serves the document\'s pictures sandboxed, so an SVG from the web runs nothing on this origin', async () => {
    const s = await sessions.open('/docs/report.docx', 1);
    await mkdir(path.join(s.temp, 'media'), { recursive: true });
    await writeFile(path.join(s.temp, 'media', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await handler(new Request(`office://${s.token}/asc/docmedia/media/x.svg`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toBe(MEDIA_CSP);
    expect(MEDIA_CSP).toMatch(/^sandbox;/);
    expect(MEDIA_CSP).not.toContain('script');
    // an encoded slash reaches the same folder once decoded, so it gets the same policy
    const encoded = await handler(new Request(`office://${s.token}/asc%2Fdocmedia/media/x.svg`));
    expect(encoded.status).toBe(200);
    expect(encoded.headers.get('Content-Security-Policy')).toBe(MEDIA_CSP);
    // the editor's own files keep the editor's policy
    expect((await handler(new Request(`office://${s.token}/index.html`))).headers.get('Content-Security-Policy')).toBe(OFFICE_CSP);
  });

  it('refuses a chosen picture that grew past the cap after it was measured', async () => {
    const s = await sessions.open('/docs/report.docx', 1);
    const [handle] = grantPicked(s, [path.join(dir, 'pics', 'cat.png')]);
    // the file measured small, then the read returned more than the cap
    const read = vi.spyOn(fsp, 'readFile').mockResolvedValueOnce(Buffer.alloc(PICTURE_MAX_BYTES + 1) as never);
    try {
      expect((await ask(s.token, 'copy-to-media', handle)).status).toBe(404);
    } finally {
      read.mockRestore();
    }
    await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
  });

  describe('a picture the document already has', () => {
    it('answers with its own name, bare or under media/, without copying anything', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      await mkdir(path.join(s.temp, 'media'), { recursive: true });
      await writeFile(path.join(s.temp, 'media', 'image1.png'), PNG);
      expect(await (await ask(s.token, 'copy-to-media', 'image1.png')).text()).toBe('image1.png');
      expect(await (await ask(s.token, 'copy-to-media', 'media/image1.png')).text()).toBe('image1.png');
      expect(await readdir(path.join(s.temp, 'media'))).toEqual(['image1.png']);
    });

    it('refuses a name it does not have, and any name that walks out of media/', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      await mkdir(path.join(s.temp, 'media'), { recursive: true });
      await writeFile(path.join(s.temp, 'Editor.bin'), 'x');
      expect((await ask(s.token, 'copy-to-media', 'image9.png')).status).toBe(404);
      expect((await ask(s.token, 'copy-to-media', '../Editor.bin')).status).toBe(404);
      expect((await ask(s.token, 'copy-to-media', 'media/../Editor.bin')).status).toBe(404);
    });
  });

  describe('a picture dropped onto the document', () => {
    // The add-on answers sdkjs's drop by sending the dropped file's bytes (never a path) to
    // upload/drop, and expects {"media/<name>": "<url>"} back.
    const upload = (token: string, body: BodyInit, type = 'image/png', method = 'POST') =>
      handler(new Request(`office://${token}/upload/drop`, { method, body: method === 'POST' ? body : undefined, headers: { 'content-type': type } }));

    it('stores the bytes in media and answers the name and its address on this origin', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const res = await upload(s.token, PNG);
      expect(res.status).toBe(200);
      const map = (await res.json()) as Record<string, string>;
      const [[key, url]] = Object.entries(map);
      const name = key.replace(/^media\//, '');
      expect(key).toMatch(/^media\/[\w-]+\.png$/);
      expect(url).toBe(`office://${s.token}/asc/docmedia/media/${name}`);
      expect(await readFile(path.join(s.temp, 'media', name))).toEqual(PNG);
    });

    it('refuses anything that is not a picture, and any other method', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      expect((await upload(s.token, 'hello', 'text/html')).status).toBe(404);
      expect((await upload(s.token, PNG, 'image/png', 'GET')).status).toBe(404);
      await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
    });

    it('refuses a dropped picture over the size cap', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      expect((await upload(s.token, new Uint8Array(PICTURE_MAX_BYTES + 1))).status).toBe(404);
      await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
    });
  });

  describe('a picture from the web', () => {
    it('downloads an http(s) picture into media and answers with its bare name', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const res = await ask(s.token, 'download-to-media', 'https://example.com/a/cat.png?x=1');
      expect(res.status).toBe(200);
      const name = await res.text();
      expect(name).toMatch(/^[\w-]+\.png$/);
      expect(fetched).toEqual(['https://example.com/a/cat.png?x=1']);
      expect(await readFile(path.join(s.temp, 'media', name))).toEqual(PNG);
    });

    it('names the file by what the server says it is, not by the address', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      download = async () => new Response(PNG, { headers: { 'content-type': 'image/jpeg; charset=binary' } });
      expect(await (await ask(s.token, 'download-to-media', 'https://example.com/picture')).text()).toMatch(/\.jpg$/);
    });

    it('never fetches anything but http(s)', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      for (const url of ['file:///etc/passwd', 'ftp://example.com/a.png', 'office://abc/x.png', 'javascript:alert(1)']) {
        expect((await ask(s.token, 'download-to-media', url)).status).toBe(404);
      }
      expect(fetched).toEqual([]);
    });

    it('refuses an answer that is not a picture', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      download = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
      expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status).toBe(404);
      await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
    });

    it('refuses a failed answer', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      download = async () => new Response(PNG, { status: 403, headers: { 'content-type': 'image/png' } });
      expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status).toBe(404);
    });

    it('refuses a picture that says it is over the size cap without reading it', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      download = async () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(PICTURE_MAX_BYTES + 1) } });
      expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status).toBe(404);
    });

    it('stops reading a picture that turns out bigger than the cap', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent > PICTURE_MAX_BYTES + 5 * chunk.length) { c.close(); return; }
          sent += chunk.length;
          c.enqueue(chunk);
        },
      });
      download = async () => new Response(body, { headers: { 'content-type': 'image/png' } });
      expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status).toBe(404);
      expect(sent).toBeLessThanOrEqual(PICTURE_MAX_BYTES + 3 * chunk.length);
      // nothing half-written left behind (the folder is not even made)
      await expect(readdir(path.join(s.temp, 'media'))).rejects.toThrow();
    });

    it('gives up on a download that takes too long', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      let aborted = false;
      download = (_u, o) => new Promise((_r, reject) => {
        o.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      });
      const h = officeRequestHandler({ root: path.join(dir, 'addon'), sessions, ...net(50) });
      const res = await h(new Request(`office://${s.token}/asc/download-to-media/${encodeURIComponent('https://example.com/slow.png')}`));
      expect(res.status).toBe(404);
      expect(aborted).toBe(true);
    });

    it('never connects to this machine or the local network, by address or by name', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      dns.localhost = ['127.0.0.1', '::1'];
      dns['printer.lan'] = ['192.168.1.20'];
      dns['mixed.example'] = ['93.184.216.34', '10.0.0.5']; // one private answer is enough to refuse
      const urls = [
        'http://127.0.0.1/a.png', 'http://localhost:8080/a.png', 'http://[::1]/a.png',
        'http://10.1.2.3/a.png', 'http://172.20.0.1/a.png', 'http://192.168.1.1/a.png', 'http://printer.lan/a.png',
        'http://169.254.169.254/latest/meta-data', 'http://[fe80::1]/a.png',
        'http://100.64.0.1/a.png', 'http://[fd12:3456::1]/a.png',
        'http://[::ffff:127.0.0.1]/a.png', 'http://[::ffff:a00:1]/a.png', 'http://0.0.0.0/a.png',
        'http://mixed.example/a.png', 'http://unknown.invalid/a.png',
      ];
      for (const url of urls) expect((await ask(s.token, 'download-to-media', url)).status, url).toBe(404);
      expect(fetched).toEqual([]);
    });

    it('refuses a redirect into the local network or off the web, and follows one to a public address', async () => {
      const s = await sessions.open('/docs/report.docx', 1);
      const answers: boolean[] = [];
      let to = '';
      download = async (u, o) => {
        fetched.push(u);
        const ok = await o.allowRedirect(to);
        answers.push(ok);
        if (!ok) throw new Error('redirect refused');
        return new Response(PNG, { headers: { 'content-type': 'image/png' } });
      };
      dns['sneaky.example'] = ['192.168.0.10'];
      for (const target of ['http://127.0.0.1/x.png', 'http://sneaky.example/x.png', 'http://[fc00::1]/x.png', 'file:///etc/passwd']) {
        to = target;
        expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status, target).toBe(404);
      }
      to = 'https://example.org/b.png';
      expect((await ask(s.token, 'download-to-media', 'https://example.com/a.png')).status).toBe(200);
      expect(answers).toEqual([false, false, false, false, true]);
    });
  });

  describe('the addresses a download may reach', () => {
    it('allows public addresses and names each refused class', () => {
      expect(nonPublicReason('93.184.216.34')).toBeNull();
      expect(nonPublicReason('2606:2800:220:1:248:1893:25c8:1946')).toBeNull();
      const cases: [string, string][] = [
        ['127.0.0.1', 'loopback'], ['::1', 'loopback'], ['[::1]', 'loopback'],
        ['10.0.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.0.1', 'private'],
        ['169.254.1.1', 'link-local'], ['fe80::1%eth0', 'link-local'],
        ['100.64.0.1', 'carrier-grade NAT'], ['100.127.255.254', 'carrier-grade NAT'],
        ['fc00::1', 'unique-local'], ['fdff::1', 'unique-local'],
        ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'], ['::ffff:192.168.1.1', 'private'],
        ['0.0.0.0', 'unspecified'], ['::', 'unspecified'], ['224.0.0.1', 'multicast'],
        ['localhost', 'not an address'],
      ];
      for (const [ip, why] of cases) expect(nonPublicReason(ip), ip).toBe(why);
      // an IPv4 address carried inside IPv6 (NAT64, 6to4, the old IPv4-compatible form) is judged
      // by the IPv4 address it carries
      const wrapped: [string, string | null][] = [
        ['64:ff9b::127.0.0.1', 'loopback'], ['64:ff9b::7f00:1', 'loopback'], ['64:ff9b::a9fe:a9fe', 'link-local'],
        ['64:ff9b::c0a8:101', 'private'], ['64:ff9b::5db8:d822', null],
        ['2002:7f00:1::1', 'loopback'], ['2002:c0a8:101::', 'private'], ['2002:6440:1::1', 'carrier-grade NAT'], ['2002:5db8:d822::1', null],
        ['::127.0.0.1', 'loopback'], ['::10.0.0.1', 'private'], ['::a00:1', 'private'], ['::93.184.216.34', null],
      ];
      for (const [ip, why] of wrapped) expect(nonPublicReason(ip), ip).toBe(why);
      // the edges just outside the ranges stay public
      expect(nonPublicReason('100.128.0.1')).toBeNull();
      expect(nonPublicReason('172.32.0.1')).toBeNull();
    });
  });

  describe('the request main makes (Electron net.request, one hop at a time)', () => {
    /** A stand-in for Electron's ClientRequest: records its options, emits what the test says. */
    function fakeNet() {
      type FakeReq = EventEmitter & { followed: number; aborted: boolean; ended: boolean; followRedirect(): void; abort(): void; end(): void };
      const made: { opts: Record<string, unknown>; req: FakeReq }[] = [];
      const request = (opts: Record<string, unknown>) => {
        const req: FakeReq = Object.assign(new EventEmitter(), {
          followed: 0, aborted: false, ended: false,
          followRedirect() { throw new Error('not used: followRedirect only works synchronously'); },
          // As Electron's does: an abort after the answer began makes the answer emit 'aborted' —
          // never 'end' or 'error'.
          abort() { (this as { aborted: boolean }).aborted = true; (this as { res?: EventEmitter }).res?.emit('aborted'); },
          end() { (this as { ended: boolean }).ended = true; },
        });
        made.push({ opts, req });
        return req as never;
      };
      return { made, request };
    }
    const answer = (req: EventEmitter, status: number, headers: Record<string, string>, body: Buffer) => {
      const res = Object.assign(new EventEmitter(), { statusCode: status, headers });
      (req as EventEmitter & { res?: EventEmitter }).res = res;
      req.emit('response', res);
      res.emit('data', body);
      res.emit('end');
    };

    it('sends no cookies, never follows a redirect on its own, and hands back the answer', async () => {
      const { made, request } = fakeNet();
      const fetchOne = pictureRequestVia(request);
      const p = fetchOne('https://example.com/a.png', { signal: new AbortController().signal, allowRedirect: async () => true });
      const { opts, req } = made[0];
      expect(opts).toMatchObject({ url: 'https://example.com/a.png', redirect: 'manual', useSessionCookies: false, credentials: 'omit' });
      answer(req, 200, { 'content-type': 'image/png' }, PNG);
      const res = await p;
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    });

    it('asks before each redirect: follows an allowed one with a new request, stops at a refused one', async () => {
      const { made, request } = fakeNet();
      const asked: string[] = [];
      const fetchOne = pictureRequestVia(request);
      const p = fetchOne('https://example.com/a.png', {
        signal: new AbortController().signal,
        allowRedirect: async (to) => { asked.push(to); return to.startsWith('https://example.org'); },
      });
      made[0].req.emit('redirect', 302, 'GET', 'https://example.org/b.png', {});
      // the first request is dropped; only after the check is a new one made to the target
      await vi.waitFor(() => expect(made).toHaveLength(2));
      expect(made[0].req.aborted).toBe(true);
      expect(made[1].opts).toMatchObject({ url: 'https://example.org/b.png', redirect: 'manual', useSessionCookies: false });
      made[1].req.emit('redirect', 302, 'GET', 'http://127.0.0.1/c.png', {});
      await expect(p).rejects.toThrow('redirect refused');
      expect(asked).toEqual(['https://example.org/b.png', 'http://127.0.0.1/c.png']);
      expect(made).toHaveLength(2); // never connected to the refused target
    });

    it('lets go of the cap\'s listener when each hop is done', async () => {
      // A signal that counts its listeners (the real one hides them).
      const ctl = new AbortController();
      const live = new Set<unknown>();
      const signal = {
        get aborted() { return ctl.signal.aborted; },
        addEventListener: (t: string, f: () => void, o?: unknown) => { live.add(f); ctl.signal.addEventListener(t, f, o as AddEventListenerOptions); },
        removeEventListener: (t: string, f: () => void) => { live.delete(f); ctl.signal.removeEventListener(t, f); },
      } as unknown as AbortSignal;
      const { made, request } = fakeNet();
      const p = pictureRequestVia(request)('https://example.com/a.png', { signal, allowRedirect: async () => true });
      made[0].req.emit('redirect', 302, 'GET', 'https://example.org/b.png', {});
      await vi.waitFor(() => expect(made).toHaveLength(2));
      expect(live.size).toBe(1); // only the hop in flight
      answer(made[1].req, 200, { 'content-type': 'image/png' }, PNG);
      const res = await p;
      await res.arrayBuffer();
      expect(live.size).toBe(0);
    });

    describe('the 20 s cap covers the whole download', () => {
      beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
      afterEach(() => { vi.useRealTimers(); });
      const CAP = 20_000;

      it('gives up on an answer that sends one piece and then stalls', async () => {
        const s = await sessions.open('/docs/report.docx', 1);
        const { made, request } = fakeNet();
        const p = downloadToMedia(s, 'https://example.com/a.png', { request: pictureRequestVia(request), resolve: async () => ['93.184.216.34'], timeoutMs: CAP });
        await vi.waitFor(() => expect(made).toHaveLength(1));
        const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'image/png' } });
        (made[0].req as EventEmitter & { res?: EventEmitter }).res = res;
        made[0].req.emit('response', res);
        res.emit('data', PNG); // ... and nothing more, ever
        await vi.advanceTimersByTimeAsync(CAP);
        await expect(p).resolves.toBeNull();
        expect(made[0].req.aborted).toBe(true);
      });

      it('gives up during a name lookup that never answers, before connecting', async () => {
        const s = await sessions.open('/docs/report.docx', 1);
        const { made, request } = fakeNet();
        const p = downloadToMedia(s, 'https://example.com/a.png', { request: pictureRequestVia(request), resolve: () => new Promise(() => {}), timeoutMs: CAP });
        await vi.advanceTimersByTimeAsync(CAP);
        await expect(p).resolves.toBeNull();
        expect(made).toHaveLength(0);
      });

      it('gives up during a redirect\'s lookup and never makes the next request', async () => {
        const s = await sessions.open('/docs/report.docx', 1);
        const { made, request } = fakeNet();
        const resolve = async (h: string) => (h === 'example.com' ? ['93.184.216.34'] : new Promise<string[]>(() => {}));
        const p = downloadToMedia(s, 'https://example.com/a.png', { request: pictureRequestVia(request), resolve, timeoutMs: CAP });
        await vi.waitFor(() => expect(made).toHaveLength(1));
        made[0].req.emit('redirect', 302, 'GET', 'https://slow-dns.example/b.png', {});
        await vi.advanceTimersByTimeAsync(CAP);
        await expect(p).resolves.toBeNull();
        expect(made).toHaveLength(1);
      });
    });
  });
});

