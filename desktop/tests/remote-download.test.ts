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
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readStripped, assertPatternMatches } from './helpers/guard-scope';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'), on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: vi.fn(() => []) }),
  shell: { openExternal: vi.fn() },
  webContents: { getAllWebContents: vi.fn(() => []) },
}));

import { RemoteDownloads, DOWNLOAD_TOKEN_TTL_MS, MAX_LIVE_STREAMS_PER_SOCKET, MAX_TOKENS_PER_DEVICE } from '../src/main/remote-download';
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

// Windows CI cannot always create symlinks and has no mkfifo; those cases are
// skipped there, the way native-home.test.ts does it.
const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-dl-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(probeDir, 'target'), 'x');
    fs.symlinkSync('target', path.join(probeDir, 'link'), 'file');
    return true;
  } catch { return false; }
  finally { try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* best effort */ } }
})();
const posix = process.platform !== 'win32';

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

  // Each refusal names its real cause, so the phone's notice never guesses one
  // (T7 review, finding 8: "outside the folders" was shown for a private file).
  it('refuses a file outside every root, a secret, and a missing file, each with its own code', async () => {
    expect(await mint(path.join(stray, 'unlisted.md'))).toMatchObject({ ok: false, error: 'outside-roots' });
    expect(await mint(path.join(secretDir, '.ssh', 'id_rsa'))).toMatchObject({ ok: false, error: 'sensitive' });
    expect(await mint(path.join(root, 'gone.md'))).toMatchObject({ ok: false, error: 'orphan' });
    expect(await mint('' as any)).toMatchObject({ ok: false });
  });

  it.skipIf(!canSymlink)('a symlink under a root to a secret is refused at mint — sensitive is decided on the REAL path', async () => {
    const link = path.join(root, 'looks-fine.txt');
    fs.symlinkSync(path.join(secretDir, '.ssh', 'id_rsa'), link);
    try {
      expect(await mint(link)).toMatchObject({ ok: false, error: 'sensitive' });
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
    expect(await mint(path.join(stray, 'unlisted.md'), { projectRoot: stray, artifactId: 'art-1' })).toMatchObject({ ok: false, error: 'outside-roots' });
  });

  it('a file whose inode is 0 is refused as not-allowed rather than accepted unpinnable', async () => {
    const dl = makeDownloads({
      // A real BigIntStats (isFile() and all) with its inode zeroed, as a
      // filesystem without stable ids would report it.
      statForMint: async (fh) => Object.assign(await fh.stat({ bigint: true }), { ino: 0n }),
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
    expect(fallback).not.toMatch(/["\\\u0000-\u001f\u007f-\uffff]/);
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
    it.skipIf(!canSymlink)(`a file swapped for a symlink to a secret after mint answers 404 at GET (O_NOFOLLOW ${noFollow ? 'on' : 'forced to 0 — identity compare alone'})`, async () => {
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
    // 503 + Retry-After, not 429: download managers retry a 503 and give up on
    // other 4xx (T7 review, finding 5).
    expect(overCap.status).toBe(503);
    expect(overCap.headers.get('retry-after')).toBe('5');

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

// ── Hardening from the T7 review (2026-09-10) ──────────────────────────────────
// Each case is the regression its finding named; each was watched go red first.
describe('download hardening', () => {
  const closeServer = (srv: http.Server) => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); });

  it('a burst of GETs cannot beat the stream cap, and a hang-up while the file is opening releases its slot and handle (findings 1, 2)', async () => {
    let releaseOpen!: () => void;
    const gate = new Promise<void>((r) => { releaseOpen = r; });
    const opened: fs.promises.FileHandle[] = [];
    let openCalls = 0;
    const dl = makeDownloads({
      openForServe: async (p, flags) => {
        openCalls++;
        await gate;
        const fh = await fs.promises.open(p, flags);
        opened.push(fh);
        return fh;
      },
    });
    const { server: srv, origin: o } = await serveWith(dl);
    const who = { deviceId: 'phone-burst', socketId: 'sock-burst' };
    const minted: any = await dl.mint({ absolutePath: path.join(root, 'notes.md') }, who);
    const reqs = Array.from({ length: 5 }, () => {
      const entry: { req: http.ClientRequest; status: number | null } = { req: null as any, status: null };
      entry.req = http.get(o + minted.url, { agent: false }, (res) => { entry.status = res.statusCode!; res.resume(); });
      entry.req.on('error', () => { /* the hang-up below */ });
      return entry;
    });
    try {
      // Only two may reach the file; the other three are told to retry.
      await vi.waitFor(() => {
        expect(reqs.filter((r) => r.status === 503)).toHaveLength(3);
        expect(openCalls).toBe(2);
      });
      expect(dl.liveStreams(who.socketId)).toBe(2);
      // One phone hangs up while its file is still opening.
      const waiting = reqs.filter((r) => r.status === null);
      expect(waiting).toHaveLength(2);
      waiting[0].req.destroy();
      await vi.waitFor(() => expect(dl.liveStreams(who.socketId)).toBe(1));
      // The open finishes after the hang-up: its handle must still be closed.
      releaseOpen();
      await vi.waitFor(() => {
        expect(opened).toHaveLength(2);
        expect(opened.every((h) => h.fd === -1)).toBe(true);
        expect(dl.liveStreams(who.socketId)).toBe(0);
      });
      expect(waiting[1].status).toBe(200);
    } finally {
      releaseOpen();
      for (const r of reqs) r.req.destroy();
      await closeServer(srv);
    }
  });

  it('a stream the phone stops reading is ended after the idle timeout, freeing its slot (finding 5)', async () => {
    const dl = makeDownloads({ idleTimeoutMs: 300 });
    const { server: srv, origin: o } = await serveWith(dl);
    const who = { deviceId: 'phone-idle', socketId: 'sock-idle' };
    try {
      const minted: any = await dl.mint({ absolutePath: path.join(root, 'big.bin') }, who);
      const s = await openStream(o + minted.url);
      expect(s.res.statusCode).toBe(200);
      expect(dl.liveStreams(who.socketId)).toBe(1);
      // Nothing reads: the socket buffers fill and the transfer goes idle.
      await vi.waitFor(() => expect(dl.liveStreams(who.socketId)).toBe(0));
      s.req.destroy();
    } finally {
      await closeServer(srv);
    }
  });

  it('a link stays alive for five minutes after a transfer ENDS, so a long download that drops can resume (finding 6)', async () => {
    const dl = makeDownloads();
    const { server: srv, origin: o } = await serveWith(dl);
    const who = { deviceId: 'phone-long', socketId: 'sock-long' };
    try {
      const minted: any = await dl.mint({ absolutePath: path.join(root, 'big.bin') }, who);
      const s = await openStream(o + minted.url);
      expect(dl.liveStreams(who.socketId)).toBe(1);
      clock += DOWNLOAD_TOKEN_TTL_MS - 1000;   // a slow transfer, nearly five minutes in
      s.req.destroy();                          // …and the network drops
      await vi.waitFor(() => expect(dl.liveStreams(who.socketId)).toBe(0));
      clock += 2000;                            // past five minutes since the GET started
      const resume = await fetch(o + minted.url, { headers: { Range: 'bytes=0-9' } });
      expect(resume.status).toBe(206);
      await resume.arrayBuffer();
    } finally {
      await closeServer(srv);
    }
  });

  it('a resume whose If-Match no longer matches answers 412, never a stitched file (finding 7)', async () => {
    const { url } = await mint(path.join(root, 'notes.md'));
    const first = await fetch(url, { headers: { Range: 'bytes=0-9' } });
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();
    const stale = await fetch(url, { headers: { Range: 'bytes=10-', 'If-Match': '"an-older-version"' } });
    expect(stale.status).toBe(412);
    expect(await stale.text()).toBe('');
    const fresh = await fetch(url, { headers: { Range: 'bytes=10-', 'If-Match': etag } });
    expect(fresh.status).toBe(206);
    await fresh.arrayBuffer();
  });

  it('one device holds at most MAX_TOKENS_PER_DEVICE links; the oldest goes first (finding 10)', async () => {
    const who = { deviceId: 'phone-cap', socketId: 'sock-cap' };
    const urls: string[] = [];
    for (let i = 0; i <= MAX_TOKENS_PER_DEVICE; i++) urls.push((await mint(path.join(root, 'notes.md'), {}, downloads, who)).url);
    const oldest = await fetch(urls[0]);
    expect(oldest.status).toBe(404);
    for (const u of [urls[1], urls[MAX_TOKENS_PER_DEVICE]]) {
      const res = await fetch(u, { headers: { Range: 'bytes=0-0' } });
      expect(res.status).toBe(206);
      await res.arrayBuffer();
    }
  });

  it.skipIf(!posix)('a folder or a pipe is refused at mint as not-a-file', async () => {
    fs.mkdirSync(path.join(root, 'a-folder'), { recursive: true });
    expect(await mint(path.join(root, 'a-folder'))).toMatchObject({ ok: false, error: 'not-a-file' });
    const fifo = path.join(root, 'a-pipe');
    execFileSync('mkfifo', [fifo]);
    try {
      expect(await mint(fifo)).toMatchObject({ ok: false, error: 'not-a-file' });
    } finally { fs.unlinkSync(fifo); }
  });

  it.skipIf(!posix)('a pipe swapped in after mint answers 404 at once instead of freezing a file thread (finding 11)', async () => {
    const file = path.join(root, 'pipe-swap.txt');
    fs.writeFileSync(file, 'ordinary');
    const { url } = await mint(file);
    fs.unlinkSync(file);
    execFileSync('mkfifo', [file]);
    let status: number | null = null;
    const pending = fetch(url).then(async (r) => { status = r.status; await r.arrayBuffer(); }).catch(() => {});
    try {
      await vi.waitFor(() => expect(status).toBe(404));
    } finally {
      // If the open did block, give it a writer so the thread comes back.
      try { fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch { /* no reader waiting */ }
      await pending;
      fs.unlinkSync(file);
    }
  });

  it('a file cut short during a download ends the connection instead of leaving the phone waiting (finding 12)', async () => {
    const file = path.join(root, 'shrinks.bin');
    const fd = fs.openSync(file, 'w');
    fs.ftruncateSync(fd, 32 * 1024 * 1024);
    fs.closeSync(fd);
    const { url } = await mint(file);
    const s = await openStream(url);
    expect(s.res.statusCode).toBe(200);
    fs.truncateSync(file, 10);
    let ended: 'complete' | 'cut-off' | null = null;
    s.res.on('end', () => { ended = 'complete'; });
    s.res.on('close', () => { if (!s.res.complete) ended = 'cut-off'; });
    s.res.on('error', () => { ended = 'cut-off'; });
    s.res.resume();
    try {
      await vi.waitFor(() => expect(ended).toBe('cut-off'));
    } finally {
      s.req.destroy();
      fs.unlinkSync(file);
    }
  });

  it.skipIf(!canSymlink)('a folder on the path swapped for a link to a secret while the mint is authorizing is refused (finding 3, mint)', async () => {
    const dir = path.join(root, 'swapdir');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'id_rsa'), 'a harmless file that shares a name');
    const dl = makeDownloads({
      beforePinForTest: async () => {
        fs.renameSync(dir, `${dir}-gone`);
        fs.symlinkSync(path.join(secretDir, '.ssh'), dir);
      },
    });
    try {
      expect(await dl.mint({ absolutePath: path.join(dir, 'id_rsa') }, phone)).toMatchObject({ ok: false, error: 'not-allowed' });
    } finally {
      fs.unlinkSync(dir);
      fs.rmSync(`${dir}-gone`, { recursive: true, force: true });
    }
  });

  it.skipIf(!canSymlink)('a folder on the path swapped for a link after mint answers 404, even to the same inode (finding 3, GET)', async () => {
    // Two targets, because the private-path check alone already refuses the
    // secret folder: the re-resolved path must equal the minted one even when
    // the link leads somewhere merely unlisted.
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-dl-elsewhere-')));
    try {
      for (const [i, target] of [path.join(secretDir, '.ssh'), elsewhere].entries()) {
        const dir = path.join(root, `hl-${i}`);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'data.txt');
        fs.writeFileSync(file, 'data');
        const { url } = await mint(file);
        const twin = path.join(target, 'data.txt');
        fs.linkSync(file, twin);                  // the same inode, in the other folder
        fs.renameSync(dir, `${dir}-gone`);
        fs.symlinkSync(target, dir);
        try {
          const res = await fetch(url);
          expect(res.status, target).toBe(404);
          expect(await res.text()).toBe('');
        } finally {
          fs.unlinkSync(dir);
          fs.unlinkSync(twin);
          fs.rmSync(`${dir}-gone`, { recursive: true, force: true });
        }
      }
    } finally {
      await fs.promises.rm(elsewhere, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it('HTTP details: a malformed download path is 404 not the app; an inverted range is ignored; a dated If-Range restarts; filename* encodes quote-like characters (finding 14)', async () => {
    const odd = await fetch(`${origin}/download/${'A'.repeat(43)}/a/b`);
    expect(odd.status).toBe(404);
    expect(await odd.text()).toBe('');

    const { url } = await mint(path.join(root, 'notes.md'));
    const inverted = await fetch(url, { headers: { Range: 'bytes=5-3' } });
    expect(inverted.status).toBe(200);
    expect((await inverted.arrayBuffer()).byteLength).toBe(5000);

    const first = await fetch(url);
    const lastModified = first.headers.get('last-modified')!;
    await first.arrayBuffer();
    const dated = await fetch(url, { headers: { Range: 'bytes=2000-', 'If-Range': lastModified } });
    expect(dated.status).toBe(200);
    expect((await dated.arrayBuffer()).byteLength).toBe(5000);

    const quoted = path.join(root, "Destin's (1)*.txt");
    fs.writeFileSync(quoted, 'q');
    const minted = await mint(quoted);
    const res = await fetch(minted.url);
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''Destin%27s%20%281%29%2A.txt");
    await res.arrayBuffer();
  });

  it('over the WS host: a session-only folder downloads only its recorded files, and a record in an unknown folder is ignored (T7 re-review, findings 1, 6)', async () => {
    const sessionOnly = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yc-dl-session-')));
    fs.writeFileSync(path.join(sessionOnly, 'todo.md'), 'from a live session');
    fs.writeFileSync(path.join(sessionOnly, 'untracked.md'), 'never recorded');
    fs.mkdirSync(path.join(sessionOnly, '.youcoded'));
    fs.writeFileSync(path.join(sessionOnly, '.youcoded', 'artifacts.json'), JSON.stringify({
      $schema: SIDECAR_SCHEMA_VERSION, projectId: 'session-only', name: 'session-only',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      artifacts: [{
        id: 'rec-todo', path: 'todo.md', kind: 'internal', absolutePath: null,
        lastModified: new Date().toISOString(), status: 'active',
        versions: [{ id: 'v1', kind: 'create', at: new Date().toISOString(), sessionId: 's-live' }],
        comments: [], tags: [],
      }],
      manualExcludes: [], manualIncludes: [],
    }));
    try {
      const sessionManager: any = Object.assign(new EventEmitter(), {
        listSessions: vi.fn(() => [{ id: 's-live', name: 'live', cwd: sessionOnly, status: 'active' }]),
        createSession: vi.fn(), destroySession: vi.fn(), sendInput: vi.fn(), resizeSession: vi.fn(),
      });
      const hookRelay: any = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
      const config: any = { enabled: false, port: 9900, passwordHash: null, toSafeObject: () => ({}) };
      const host: any = new RemoteServer(sessionManager, hookRelay, config);
      const paired = host.devices.pair('Gate phone');
      const frames: any[] = [];
      const ws: any = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)), close: vi.fn() });
      const client = { id: 'sock-gate', ws, deviceId: paired.deviceId, ip: '127.0.0.1', connectedAt: Date.now() };
      let n = 0;
      const ask = async (payload: any) => {
        const id = `g${++n}`;
        await host.handleMessage(client, JSON.stringify({ type: 'artifacts:download', id, payload }));
        return frames.find((f) => f.id === id)?.payload;
      };
      // By path, a folder known only because a session runs there grants nothing.
      expect(await ask({ absolutePath: path.join(sessionOnly, 'untracked.md') })).toMatchObject({ ok: false, error: 'outside-roots' });
      // Its recorded file, asked for through the record, downloads.
      expect(await ask({ absolutePath: path.join(sessionOnly, 'todo.md'), projectRoot: sessionOnly, artifactId: 'rec-todo' }))
        .toMatchObject({ ok: true, name: 'todo.md' });
      // A record in a folder the computer never showed is ignored, not a refusal of
      // its own: the path alone decides.
      expect(await ask({ absolutePath: path.join(stray, 'notes', 'tracked.md'), projectRoot: stray, artifactId: 'art-1' }))
        .toMatchObject({ ok: false, error: 'outside-roots' });
      // So is a malformed one, and the file still downloads on its own merits.
      expect(await ask({ absolutePath: path.join(root, 'notes.md'), projectRoot: 42, artifactId: 'x' })).toMatchObject({ ok: true });
    } finally {
      await fs.promises.rm(sessionOnly, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

// ── The second review of the download fixes (2026-09-10) ──────────────────────
describe('download hardening, second review', () => {
  const closeServer = (srv: http.Server) => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); });

  it("a completed download leaves the connection to the server's own keep-alive timeout (finding 2)", async () => {
    const dl = makeDownloads();
    const { server: srv, origin: o } = await serveWith(dl);
    srv.keepAliveTimeout = 300;
    const minted: any = await dl.mint({ absolutePath: path.join(root, 'notes.md') }, { deviceId: 'phone-ka', socketId: 'sock-ka' });
    // A raw socket, not Node's HTTP client: that client closes an idle
    // keep-alive connection by itself when the server's Keep-Alive header says
    // to, which hid the bug. Only the SERVER's own timer is under test here.
    const sock = net.connect(Number(new URL(o).port), '127.0.0.1');
    let received = '';
    let closed = false;
    sock.on('data', (d) => { received += d.toString('latin1'); });
    sock.on('close', () => { closed = true; });
    sock.on('error', () => { /* the server hanging up is the expected end */ });
    try {
      sock.write(`GET ${minted.url} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\nRange: bytes=0-9\r\n\r\n`);
      // The transfer completes: headers, then exactly the ten bytes asked for…
      await vi.waitFor(() => expect(received).toMatch(/^HTTP\/1\.1 206[\s\S]*\r\n\r\nx{10}$/));
      // …and the server then closes the idle connection on its own schedule.
      // Clearing the socket timeout when the transfer closed cancelled that timer.
      await vi.waitFor(() => expect(closed).toBe(true));
    } finally {
      sock.destroy();
      await closeServer(srv);
    }
  });

  it.skipIf(process.platform !== 'linux' || !canSymlink)('a folder swapped for a link and swapped back while the mint opens the file is refused (finding 3)', async () => {
    const dir = path.join(root, 'swapback');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'id_rsa'), 'a harmless file that shares a name');
    const dl = makeDownloads({
      beforePinForTest: async () => {
        fs.renameSync(dir, `${dir}-real`);
        fs.symlinkSync(path.join(secretDir, '.ssh'), dir);
      },
      // Back to the harmless folder before anything re-resolves the path.
      afterOpenForTest: async () => {
        fs.unlinkSync(dir);
        fs.renameSync(`${dir}-real`, dir);
      },
    } as any);
    try {
      expect(await dl.mint({ absolutePath: path.join(dir, 'id_rsa') }, phone)).toMatchObject({ ok: false, error: 'not-allowed' });
    } finally {
      try { fs.unlinkSync(dir); } catch { /* already a folder again */ }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(`${dir}-real`, { recursive: true, force: true });
    }
  });

  it('removing a device ends a download that is already streaming (finding 4, contract R10)', async () => {
    const dl = makeDownloads();
    const { server: srv, origin: o } = await serveWith(dl);
    const who = { deviceId: 'phone-removed', socketId: 'sock-removed' };
    try {
      const minted: any = await dl.mint({ absolutePath: path.join(root, 'big.bin') }, who);
      const s = await openStream(o + minted.url);
      expect(dl.liveStreams(who.socketId)).toBe(1);
      let ended = false;
      s.res.on('close', () => { ended = true; });
      s.res.on('error', () => { /* the host hung up, which is the point */ });
      dl.revokeDevice(who.deviceId);
      await vi.waitFor(() => {
        expect(dl.liveStreams(who.socketId)).toBe(0);
        expect(ended).toBe(true);
      });
    } finally {
      await closeServer(srv);
    }
  });

  it('the link cap never drops a link that is mid-download (finding 5)', async () => {
    const dl = makeDownloads();
    const { server: srv, origin: o } = await serveWith(dl);
    const who = { deviceId: 'phone-batch', socketId: 'sock-batch' };
    try {
      const first: any = await dl.mint({ absolutePath: path.join(root, 'big.bin') }, who);
      const s = await openStream(o + first.url);
      for (let i = 0; i < MAX_TOKENS_PER_DEVICE; i++) {
        expect((await dl.mint({ absolutePath: path.join(root, 'notes.md') }, who)).ok).toBe(true);
      }
      // The busy download's link still answers, so its resume would too.
      const resume = await fetch(o + first.url, { headers: { Range: 'bytes=0-0' } });
      expect(resume.status).toBe(206);
      await resume.arrayBuffer();
      s.req.destroy();
    } finally {
      await closeServer(srv);
    }
  });

  it('a failed request does not keep a link alive (finding 7)', async () => {
    const { url } = await mint(path.join(root, 'notes.md'));
    clock += DOWNLOAD_TOKEN_TTL_MS - 1000;
    const refused = await fetch(url, { headers: { Range: 'bytes=99999-' } });
    expect(refused.status).toBe(416);
    await refused.arrayBuffer();
    clock += 2000;
    const dead = await fetch(url);
    expect(dead.status).toBe(404);
    await dead.arrayBuffer();
  });
});
