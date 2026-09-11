// Remote access batch 3, design test 9 — Download: a short-lived link, always
// saved, never displayed, resumable (technical design 2026-09-10 §10; contract
// rows R9, R10, R18, R20).
//
// A real HTTP server on a loopback port in front of the real route handler,
// real files (one 60 MB, sparse) under os.tmpdir(), Node's own fetch/http
// client as the "phone". The identity compare (dev/ino at mint vs at GET) is
// the guard on every platform; O_NOFOLLOW is a convenience where it exists, and
// one case below forces it to 0 to prove the compare alone is enough (R2-1,
// R3-6).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: vi.fn(() => []) }),
  shell: { openExternal: vi.fn() },
  webContents: { getAllWebContents: vi.fn(() => []) },
}));

import { RemoteDownloads, DOWNLOAD_TOKEN_TTL_MS, MAX_LIVE_STREAMS_PER_SOCKET } from '../src/main/remote-download';
import { RemoteServer } from '../src/main/remote-server';
import { INDEX_SCHEMA_VERSION, SIDECAR_SCHEMA_VERSION } from '../src/shared/artifacts/types';

let root: string;          // a project root the host knows (central index)
let stray: string;         // a folder the host does NOT know; holds one tracked artifact
let secretDir: string;
let clock: number;
let downloads: RemoteDownloads;
let server: http.Server;
let origin: string;
const revoked = new Set<string>();
const phone = { deviceId: 'phone-1', socketId: 'sock-1' };

function serveWith(dl: RemoteDownloads): Promise<{ server: http.Server; origin: string }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (dl.handleHttpRequest(req, res)) return;
      // What the real host does for everything else: the SPA's index page.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>YouCoded</title>');
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve({ server: srv, origin: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function makeDownloads(opts: Partial<ConstructorParameters<typeof RemoteDownloads>[0]> = {}) {
  return new RemoteDownloads({
    isDeviceRevoked: (id) => revoked.has(id),
    now: () => clock,
    ...opts,
  });
}

/** Mint and return the ABSOLUTE url on the test server. */
async function mint(absolutePath: string, extra: Record<string, unknown> = {}, dl = downloads, who = phone) {
  const res: any = await dl.mint({ absolutePath, ...extra }, who);
  return res.ok ? { ...res, url: origin + res.url } : res;
}

/** An http.request the test can leave UNREAD, so the stream stays live on the host. */
function openStream(url: string): Promise<{ res: http.IncomingMessage; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => resolve({ res, req }));
    req.on('error', reject);
  });
}

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-dl-root-')));
  stray = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-dl-stray-')));
  secretDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-dl-secret-')));

  fs.writeFileSync(path.join(root, 'notes.md'), 'x'.repeat(5000));
  fs.writeFileSync(path.join(root, 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(root, 'odd"; \r\nname 🎉.txt'), 'odd name');
  const big = fs.openSync(path.join(root, 'big.bin'), 'w');
  fs.writeSync(big, 'BEGIN');
  fs.ftruncateSync(big, 60 * 1024 * 1024);
  fs.closeSync(big);
  fs.mkdirSync(path.join(secretDir, '.ssh'));
  fs.writeFileSync(path.join(secretDir, '.ssh', 'id_rsa'), 'PRIVATE');

  // A tracked-internal artifact in a folder the host does not otherwise know.
  fs.mkdirSync(path.join(stray, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(stray, '.youcoded'));
  fs.writeFileSync(path.join(stray, 'notes', 'tracked.md'), 'tracked by a session');
  fs.writeFileSync(path.join(stray, 'unlisted.md'), 'nobody listed me');
  fs.writeFileSync(path.join(stray, '.youcoded', 'artifacts.json'), JSON.stringify({
    $schema: SIDECAR_SCHEMA_VERSION, projectId: 'stray', name: 'stray',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    artifacts: [{
      id: 'art-1', path: 'notes/tracked.md', kind: 'internal', absolutePath: null,
      lastModified: new Date().toISOString(), status: 'active',
      versions: [{ id: 'v1', kind: 'create', at: new Date().toISOString(), sessionId: 's1' }],
      comments: [], tags: [],
    }],
    manualExcludes: [], manualIncludes: [],
  }));

  // The root is a central-index project — one of the two root sources the
  // download policy shares with read-binary. (remote-files.test.ts uses the
  // OTHER source, the saved-folders file, so the two files never write the same
  // sandbox file.)
  const home = process.env.HOME!;
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'youcoded-projects-index.json'), JSON.stringify({
    $schema: INDEX_SCHEMA_VERSION,
    projects: [{ id: 'proj-dl', name: 'dl', path: root, lastIndexed: new Date().toISOString(), lastSession: null, contentTypes: [], stats: { artifactCount: 0 } }],
  }));

  clock = Date.now();
  downloads = makeDownloads();
  ({ server, origin } = await serveWith(downloads));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const dir of [root, stray, secretDir]) {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

beforeEach(() => { revoked.clear(); });

describe('minting a link', () => {
  it('answers ok with a relative /download/ url, the name and the size', async () => {
    const res: any = await downloads.mint({ absolutePath: path.join(root, 'notes.md') }, phone);
    expect(res.ok).toBe(true);
    expect(res.url).toMatch(/^\/download\/[A-Za-z0-9_-]{43}\/notes\.md$/);
    expect(res.name).toBe('notes.md');
    expect(res.sizeBytes).toBe(5000);
  });

  it('refuses a file outside every root (not-allowed), a secret, and a missing file', async () => {
    expect(await mint(path.join(stray, 'unlisted.md'))).toMatchObject({ ok: false, error: 'not-allowed' });
    expect(await mint(path.join(secretDir, '.ssh', 'id_rsa'))).toMatchObject({ ok: false, error: 'not-allowed' });
    expect(await mint(path.join(root, 'gone.md'))).toMatchObject({ ok: false, error: 'orphan' });
    expect(await mint('' as any)).toMatchObject({ ok: false });
  });

  it('a symlink under a root to a secret is refused at mint — sensitive is decided on the REAL path', async () => {
    const link = path.join(root, 'looks-fine.txt');
    fs.symlinkSync(path.join(secretDir, '.ssh', 'id_rsa'), link);
    try {
      expect(await mint(link)).toMatchObject({ ok: false, error: 'not-allowed' });
    } finally { fs.unlinkSync(link); }
  });

  it('a listed tracked-internal file in an otherwise unknown folder downloads through the artifact read authorization', async () => {
    const file = path.join(stray, 'notes', 'tracked.md');
    const res = await mint(file, { projectRoot: stray, artifactId: 'art-1' });
    expect(res.ok).toBe(true);
    const got = await fetch(res.url);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('tracked by a session');
    // The same folder's UNLISTED file gets no such pass.
    expect(await mint(path.join(stray, 'unlisted.md'), { projectRoot: stray, artifactId: 'art-1' })).toMatchObject({ ok: false, error: 'not-allowed' });
  });

  it('a file whose inode is 0 is refused as not-allowed rather than accepted unpinnable', async () => {
    const dl = makeDownloads({
      // A real BigIntStats (isFile() and all) with its inode zeroed, as a
      // filesystem without stable ids would report it.
      statForMint: async (p) => Object.assign(await fs.promises.stat(p, { bigint: true }), { ino: 0n }),
    });
    expect(await mint(path.join(root, 'notes.md'), {}, dl)).toMatchObject({ ok: false, error: 'not-allowed' });
  });
});

describe('GET /download/<token>', () => {
  it('carries the save-only headers: attachment, nosniff, octet-stream, no-store — even for an .html file (R20)', async () => {
    const res = await fetch((await mint(path.join(root, 'page.html'))).url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="page\.html"; filename\*=UTF-8''page\.html$/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('<script>alert(1)</script>');
  });

  it('carries what a download manager needs to resume: ETag, Accept-Ranges, Content-Length, Last-Modified', async () => {
    const res = await fetch((await mint(path.join(root, 'notes.md'))).url);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('5000');
    expect(res.headers.get('etag')).toMatch(/^"\d+-\d+-5000-\d+"$/);
    expect(new Date(res.headers.get('last-modified')!).getTime()).toBeGreaterThan(0);
  });

  it('a paused download resumed with Range + If-Range completes byte-exact', async () => {
    const { url } = await mint(path.join(root, 'notes.md'));
    const first = await fetch(url, { headers: { Range: 'bytes=0-1999' } });
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe('bytes 0-1999/5000');
    const head = Buffer.from(await first.arrayBuffer());
    expect(head.length).toBe(2000);
    const etag = first.headers.get('etag')!;
    const rest = await fetch(url, { headers: { Range: 'bytes=2000-', 'If-Range': etag } });
    expect(rest.status).toBe(206);
    expect(rest.headers.get('content-range')).toBe('bytes 2000-4999/5000');
    const tail = Buffer.from(await rest.arrayBuffer());
    expect(Buffer.concat([head, tail]).equals(fs.readFileSync(path.join(root, 'notes.md')))).toBe(true);
  });

  it('a stale If-Range answers 200 from byte 0, never a mismatched slice', async () => {
    const { url } = await mint(path.join(root, 'notes.md'));
    const res = await fetch(url, { headers: { Range: 'bytes=2000-', 'If-Range': '"not-the-etag"' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('5000');
    expect((await res.arrayBuffer()).byteLength).toBe(5000);
  });

  it('an unsatisfiable range answers 416 with the size', async () => {
    const { url } = await mint(path.join(root, 'notes.md'));
    const res = await fetch(url, { headers: { Range: 'bytes=5000-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */5000');
  });

  it('a name containing quote, semicolon, CR, LF and an emoji produces a valid header and a byte-exact body', async () => {
    const file = path.join(root, 'odd"; \r\nname 🎉.txt');
    const { url } = await mint(file);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition')!;
    expect(cd.startsWith('attachment; filename="')).toBe(true);
    // Nothing that could break out of the quoted fallback or the header line.
    expect(cd).not.toMatch(/[\r\n]/);
    const fallback = /filename="([^"]*)"/.exec(cd)![1];
    expect(fallback).not.toMatch(/["\\ --￿]/);
    // The real name rides RFC 5987, percent-encoded.
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('odd"; \r\nname 🎉.txt')}`);
    expect(await res.text()).toBe('odd name');
  });

  it('a 60 MB file downloads whole', async () => {
    const { url, sizeBytes } = await mint(path.join(root, 'big.bin'));
    expect(sizeBytes).toBe(60 * 1024 * 1024);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    let received = 0;
    for await (const chunk of res.body as any) received += (chunk as Uint8Array).byteLength;
    expect(received).toBe(60 * 1024 * 1024);
  });

  it('an unknown token answers 404 with an EMPTY body, not the app page', async () => {
    const res = await fetch(`${origin}/download/${'A'.repeat(43)}/x.bin`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    // And a path that is not the download route still reaches the app.
    const page = await fetch(`${origin}/downloads-are-not-this`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('YouCoded');
  });

  it('a link expires after five idle minutes, and every successful GET renews it (sliding)', async () => {
    const { url } = await mint(path.join(root, 'notes.md'));
    clock += DOWNLOAD_TOKEN_TTL_MS - 60_000;             // 4 min: alive
    expect((await fetch(url)).status).toBe(200);          // renews
    clock += DOWNLOAD_TOKEN_TTL_MS - 60_000;             // 8 min since mint, 4 since the GET: alive
    expect((await fetch(url)).status).toBe(200);
    clock += DOWNLOAD_TOKEN_TTL_MS + 1;                   // idle past the TTL: dead
    const dead = await fetch(url);
    expect(dead.status).toBe(404);
    expect(await dead.text()).toBe('');
  });

  it('a device removed from the computer loses its links (R10)', async () => {
    const { url } = await mint(path.join(root, 'notes.md'));
    revoked.add(phone.deviceId);
    expect((await fetch(url)).status).toBe(404);
    revoked.delete(phone.deviceId);
    // Explicit revocation drops the token itself, so a record that comes back
    // (a re-pair with the same id can never happen, but belt and braces) finds nothing.
    const { url: url2 } = await mint(path.join(root, 'notes.md'));
    downloads.revokeDevice(phone.deviceId);
    expect((await fetch(url2)).status).toBe(404);
  });

  it('a file replaced between mint and GET (different inode) answers 404', async () => {
    const file = path.join(root, 'replace-me.txt');
    fs.writeFileSync(file, 'first');
    const { url } = await mint(file);
    fs.unlinkSync(file);
    fs.writeFileSync(file, 'second — a different inode at the same path');
    const res = await fetch(url);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  for (const noFollow of [true, false]) {
    it(`a file swapped for a symlink to a secret after mint answers 404 at GET (O_NOFOLLOW ${noFollow ? 'on' : 'forced to 0 — identity compare alone'})`, async () => {
      // Its own instance AND its own server: a token is only known to the
      // instance that minted it, so fetching from the shared server would 404
      // for the wrong reason and prove nothing.
      const dl = makeDownloads({ noFollow });
      const { server: srv, origin: o } = await serveWith(dl);
      const file = path.join(root, `swap-${noFollow}.txt`);
      fs.writeFileSync(file, 'harmless');
      const minted: any = await dl.mint({ absolutePath: file }, phone);
      expect(minted.ok).toBe(true);
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(secretDir, '.ssh', 'id_rsa'), file);
      try {
        const res = await fetch(o + minted.url);
        expect(res.status).toBe(404);
        expect(await res.text()).toBe('');
      } finally {
        fs.unlinkSync(file);
        await new Promise<void>((r) => srv.close(() => r()));
      }
    });
  }

  it('a host restart kills every link; a fresh mint works', async () => {
    const { url } = await mint(path.join(root, 'notes.md'));
    // Tokens live in memory: a new instance is what a restarted host has.
    const restarted = makeDownloads();
    const { server: srv2, origin: origin2 } = await serveWith(restarted);
    try {
      const old = await fetch(url.replace(origin, origin2));
      expect(old.status).toBe(404);
      const fresh: any = await restarted.mint({ absolutePath: path.join(root, 'notes.md') }, phone);
      expect(fresh.ok).toBe(true);
      expect((await fetch(origin2 + fresh.url)).status).toBe(200);
    } finally {
      await new Promise<void>((r) => srv2.close(() => r()));
    }
  });
});

describe('at most two live streams per socket (R3-7)', () => {
  it('a third mint answers busy while two streams are open; an abort releases its slot', async () => {
    const who = { deviceId: 'phone-2', socketId: 'sock-busy' };
    const big = path.join(root, 'big.bin');
    const a = await mint(big, {}, downloads, who);
    const b = await mint(big, {}, downloads, who);
    expect(a.ok && b.ok).toBe(true);
    // Two GETs the phone never reads from: the host's streams stay live.
    const s1 = await openStream(a.url);
    const s2 = await openStream(b.url);
    expect(s1.res.statusCode).toBe(200);
    expect(s2.res.statusCode).toBe(200);
    expect(downloads.liveStreams(who.socketId)).toBe(MAX_LIVE_STREAMS_PER_SOCKET);

    const third: any = await downloads.mint({ absolutePath: big }, who);
    expect(third).toMatchObject({ ok: false, error: 'busy' });
    // A third GET on a still-valid token is refused too — the cap is on streams, not on mints.
    const overCap = await fetch(a.url);
    expect(overCap.status).toBe(429);

    // The phone gives up on one: the slot comes back and the count is exact.
    s1.req.destroy();
    await vi.waitFor(() => expect(downloads.liveStreams(who.socketId)).toBe(1));
    const again: any = await downloads.mint({ absolutePath: big }, who);
    expect(again.ok).toBe(true);
    s2.req.destroy();
    await vi.waitFor(() => expect(downloads.liveStreams(who.socketId)).toBe(0));
    // Another socket of the same device is another budget — two tabs are two sockets.
    const other: any = await downloads.mint({ absolutePath: big }, { deviceId: 'phone-2', socketId: 'sock-other' });
    expect(other.ok).toBe(true);
  });
});

describe('through the WS host', () => {
  it('artifacts:download mints for the calling socket and device; unpair kills the link', async () => {
    const sessionManager: any = Object.assign(new EventEmitter(), { listSessions: vi.fn(() => []), createSession: vi.fn(), destroySession: vi.fn(), sendInput: vi.fn(), resizeSession: vi.fn() });
    const hookRelay: any = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
    const config: any = { enabled: false, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
    const host: any = new RemoteServer(sessionManager, hookRelay, config);
    const paired = host.devices.pair('Test phone');
    const frames: any[] = [];
    const ws: any = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)), close: vi.fn() });
    const client = { id: 'sock-ws-1', ws, deviceId: paired.deviceId, ip: '127.0.0.1', connectedAt: Date.now() };
    host.clients.add(client);

    await host.handleMessage(client, JSON.stringify({ type: 'artifacts:download', id: 'r1', payload: { absolutePath: path.join(root, 'notes.md') } }));
    const reply = frames.find((f) => f.type === 'artifacts:download:response')?.payload;
    expect(reply).toMatchObject({ ok: true, name: 'notes.md', sizeBytes: 5000 });
    expect(reply.url).toMatch(/^\/download\//);

    // The host's own route handler serves it, through the same request path the static handler sits behind.
    const { server: srv, origin: o } = await serveWith(host.downloads);
    try {
      expect((await fetch(o + reply.url)).status).toBe(200);
      // Removing the device from the computer ends its right to download (R10).
      expect(host.unpairDevice(paired.deviceId)).toBe(true);
      const after = await fetch(o + reply.url);
      expect(after.status).toBe(404);
      expect(await after.text()).toBe('');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it('the route is matched before the static handler AND before the Vite proxy', () => {
    const src = readStripped(fileURLToPath(new URL('../src/main/remote-server.ts', import.meta.url)));
    const createServer = src.indexOf('http.createServer((req, res) => {');
    expect(createServer).toBeGreaterThan(0);
    const body = src.slice(createServer);
    const route = /this\.downloads\.handleHttpRequest\(req, res\)/;
    assertPatternMatches(route, 'if (this.downloads.handleHttpRequest(req, res)) return;', 'the download route dispatch');
    const routeAt = body.search(route);
    const staticAt = body.indexOf('this.handleHttpRequest(req, res, staticDir)');
    const proxyAt = body.indexOf('this.proxyToVite(req, res, viteDevUrl)');
    expect(routeAt).toBeGreaterThan(0);
    expect(staticAt).toBeGreaterThan(routeAt);
    expect(proxyAt).toBeGreaterThan(routeAt);
  });
});
