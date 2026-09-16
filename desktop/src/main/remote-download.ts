// Download over remote access — a short-lived link, always saved, never
// displayed, resumable (remote access batch 3, technical design 2026-09-10 §10;
// contract rows R9, R10, R18, R20).
//
// WHY a link and not the bytes over the WebSocket: a 60 MB file through the
// socket would sit in the renderer as one string, block the chat while it
// arrived, and give the phone nothing to pause or resume. A plain HTTP GET lets
// the browser's own download manager do what it already does — progress, a
// notification, resume after a drop — and keeps the chat usable (R9).
//
// WHY the token is the whole secret: 32 random bytes, base64url, in memory
// only. The GET carries no cookie and no device credential (a download manager
// on Android fetches from its own process and has neither), so the link itself
// is what authorizes. It is bound to the device and socket that minted it, dies
// with the process, with an unpair (R10), and after five idle minutes.
//
// WHY the identity compare and not the flag: between mint and GET the file at
// that path can be swapped for a symlink to a secret. O_NOFOLLOW refuses that
// where it exists (not Windows, R3-6); comparing the opened handle's dev/ino
// against the mint-time identity refuses it everywhere, so the compare is the
// guard and the flag is a courtesy (R2-1). A filesystem that reports inode 0
// has no stable identity to compare, so a mint there is refused outright.
//
// Hardened after the T7 review (2026-09-10): the stream slot is reserved before
// the first await and released from a close listener attached at once, so a
// burst cannot beat the cap and a hang-up mid-open cannot leak a slot or a file
// handle (findings 1, 2); identity is pinned through an OPEN handle at mint and
// the path re-resolved on both sides, so a folder swapped for a link on the way
// is caught (3); a stalled transfer is ended after an idle timeout and "busy"
// answers 503 (5); the link is renewed when a transfer ends (6); If-Match is
// honoured (7); refusals carry their real cause (8); links per device are
// capped (10); a pipe cannot block a file thread (11); a file cut short ends
// the connection (12).
import fs from 'fs';
import http from 'http';
import path from 'path';
import { randomBytes } from 'crypto';
import { canonicalize } from '../shared/artifacts/canonicalize';
import { isSensitivePath } from './artifacts/read-binary-access';
import { authorizeBytesRead } from './artifacts/read-service';
import { readSidecarShared } from './artifacts/artifact-store';
import { authorizeArtifactRead } from './artifacts/write-authorization';

type FileHandle = fs.promises.FileHandle;

/** Sliding: renewed by every GET and again when a transfer ends. */
export const DOWNLOAD_TOKEN_TTL_MS = 5 * 60_000;
/** Per SOCKET (R3-7): two tabs are two sockets, two budgets. */
export const MAX_LIVE_STREAMS_PER_SOCKET = 2;
/**
 * Links one device may hold at once. WHY a cap: every mint reads the project
 * index and sidecars and keeps an entry for five minutes, so a loop of mints
 * would otherwise grow the map without bound (T7 review, finding 10). Sixteen
 * is far more than a person tapping Download can use; the oldest goes first.
 */
export const MAX_TOKENS_PER_DEVICE = 16;
/**
 * How long a transfer may make no progress before the host ends it. WHY: a
 * phone that changes networks mid-download without a clean disconnect leaves
 * the connection open until TCP gives up (~15 min on Linux), holding a stream
 * slot the whole time (T7 review, finding 5).
 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

const TOKEN_BYTES = 32;
const ROUTE_PREFIX = '/download/';
// base64url of 32 bytes is 43 characters, no padding; an optional file name after it.
const ROUTE = /^\/download\/([A-Za-z0-9_-]{43})(?:\/[^/]*)?$/;

interface DownloadToken {
  token: string;
  deviceId: string;
  socketId: string;
  realPath: string;
  name: string;
  dev: bigint;
  ino: bigint;
  expiresAt: number;
}

export interface MintRequest {
  absolutePath?: unknown;
  projectRoot?: unknown;
  artifactId?: unknown;
}

/**
 * Refusal codes, each naming what the host actually decided. The phone's
 * notice puts them into words and must never guess (download-file.ts):
 *   sensitive      the real path is in the private set (keys, credentials, .env)
 *   outside-roots  not under any folder the computer shows, nor a tracked file
 *   not-a-file     a folder, a pipe, a device
 *   not-allowed    no stable identity (inode 0), or the path changed under us
 *   busy, orphan, no path — as named; anything else is an I/O error's own text
 */
export type MintResult =
  | { ok: true; url: string; name: string; sizeBytes: number }
  | { ok: false; error: string };

export interface RemoteDownloadsOptions {
  /** A device the computer removed keeps nothing: the GET checks the record, not only the mint. */
  isDeviceRevoked: (deviceId: string) => boolean;
  /** Injectable clock, for the expiry tests. */
  now?: () => number;
  /** Open with O_NOFOLLOW where it exists (default). Tests force it off to prove the identity compare alone. */
  noFollow?: boolean;
  idleTimeoutMs?: number;
  /** The mint-time stat of the OPENED handle, injectable so a test can present an inode of 0. */
  statForMint?: (fh: FileHandle) => Promise<fs.BigIntStats>;
  /** The GET-time open, injectable so a test can hold it open while the phone hangs up. */
  openForServe?: (realPath: string, flags: number) => Promise<FileHandle>;
  /** Test seam between authorization and the identity pin, where a folder swap would land. */
  beforePinForTest?: (realPath: string) => Promise<void>;
  /** Test seam right after the mint-time open, where a swap BACK would land. */
  afterOpenForTest?: (realPath: string) => Promise<void>;
}

/**
 * The path an open handle really refers to, where the platform can say
 * (Linux: /proc/self/fd). WHY: a folder on the way swapped for a link and
 * swapped BACK between the open and a re-resolve passes every path-string
 * check (T7 re-review, finding 3); the kernel's answer does not move. Elsewhere
 * null, and the identity compare plus the re-resolve remain the guard — that
 * swap-and-swap-back window is the documented residue on macOS and Windows.
 */
async function openedPathOf(fh: FileHandle): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  return fs.promises.readlink(`/proc/self/fd/${fh.fd}`).catch(() => null);
}

/** Lone UTF-16 surrogates (possible in a Windows file name) make encodeURIComponent throw. */
function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/** RFC 5987 value: encodeURIComponent leaves ' ( ) * alone, which that syntax does not allow. */
function rfc5987(name: string): string {
  return encodeURIComponent(wellFormed(name)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** ASCII-only, quote-safe, control-free: what fits inside `filename="…"`. */
function asciiFallback(name: string): string {
  const cleaned = name.replace(/["\\\u0000-\u001f\u007f-\uffff]/g, '_');
  return cleaned || 'download';
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Multiple ranges, or anything malformed: serve the whole file (RFC 9110 lets
  // a server ignore Range), never a wrong slice.
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    // Suffix: the last N bytes.
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    // An inverted range-spec is invalid, and an invalid Range is ignored
    // (RFC 9110 section 14.2), not refused (T7 review, finding 14).
    if (b !== '' && Number(b) < start) return null;
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

export class RemoteDownloads {
  private readonly tokens = new Map<string, DownloadToken>();
  private readonly live = new Map<string, number>();
  private readonly now: () => number;
  private readonly noFollow: boolean;
  private readonly idleTimeoutMs: number;
  private readonly statForMint: (fh: FileHandle) => Promise<fs.BigIntStats>;
  private readonly openForServe: (realPath: string, flags: number) => Promise<FileHandle>;
  private readonly beforePinForTest?: (realPath: string) => Promise<void>;
  private readonly afterOpenForTest?: (realPath: string) => Promise<void>;
  private readonly isDeviceRevoked: (deviceId: string) => boolean;
  /** Streams open right now, per token — the link cap never drops one of these. */
  private readonly liveByToken = new Map<string, number>();
  /** Responses streaming right now, per device — removing a device ends them. */
  private readonly liveResponses = new Map<string, Set<http.ServerResponse>>();

  constructor(opts: RemoteDownloadsOptions) {
    this.isDeviceRevoked = opts.isDeviceRevoked;
    this.now = opts.now ?? Date.now;
    this.noFollow = opts.noFollow ?? true;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.statForMint = opts.statForMint ?? ((fh) => fh.stat({ bigint: true }));
    this.openForServe = opts.openForServe ?? ((p, flags) => fs.promises.open(p, flags));
    this.beforePinForTest = opts.beforePinForTest;
    this.afterOpenForTest = opts.afterOpenForTest;
  }

  /**
   * Read-only; no final-component symlink where the platform can refuse one;
   * never block on a pipe or device. A regular file ignores O_NONBLOCK, and a
   * FIFO opened without it waits for a writer on a shared libuv thread — four
   * such opens would stall every file read in the main process (finding 11).
   * Both optional flags are undefined on Windows.
   */
  private openFlags(): number {
    return fs.constants.O_RDONLY
      | (fs.constants.O_NONBLOCK ?? 0)
      | (this.noFollow ? (fs.constants.O_NOFOLLOW ?? 0) : 0);
  }

  /**
   * Policy, in order (§10.1): resolve the real path; a sensitive real path is
   * refused first; then allowed when the bytes-read authorization says so
   * (saved folders, indexed projects and tracked externals — the set read-binary
   * uses), or — given a projectRoot and an artifactId — when the artifact read
   * authorization passes for a record the sidecar actually holds. The caller
   * (remote-server.ts) passes the record only for a folder the computer shows
   * or a live session runs in. No size gate: Download exists for the file the
   * phone will not preview.
   */
  async mint(req: MintRequest, who: { deviceId: string; socketId: string }): Promise<MintResult> {
    this.sweepExpired();
    const { absolutePath } = req;
    if (typeof absolutePath !== 'string' || absolutePath.length === 0) return { ok: false, error: 'no path' };
    if (this.liveStreams(who.socketId) >= MAX_LIVE_STREAMS_PER_SOCKET) return { ok: false, error: 'busy' };
    let realPath: string;
    try {
      realPath = await fs.promises.realpath(absolutePath);
    } catch (e: any) {
      return { ok: false, error: e?.code === 'ENOENT' ? 'orphan' : String(e?.message ?? e) };
    }
    if (isSensitivePath(canonicalize(realPath, null))) return { ok: false, error: 'sensitive' };

    const bytes = await authorizeBytesRead(realPath);
    let allowed = bytes.ok;
    if (!allowed && typeof req.projectRoot === 'string' && typeof req.artifactId === 'string') {
      allowed = await this.authorizedAsArtifact(req.projectRoot, req.artifactId, realPath);
    }
    if (!allowed) {
      // Only the roots verdict is "outside"; a vanished file or an I/O error keeps its own cause.
      if (!bytes.ok && bytes.error !== 'not-allowed') return { ok: false, error: bytes.error };
      return { ok: false, error: 'outside-roots' };
    }

    // Pin the identity through an OPEN handle, then confirm the path still
    // leads where it did. WHY not stat(realPath): stat follows symlinks, so a
    // folder on the way swapped for a link during the (slow) authorization
    // above would pin the secret's identity under a harmless-looking path, and
    // the GET's identity compare would then agree with it (finding 3).
    await this.beforePinForTest?.(realPath);
    let fh: FileHandle;
    try {
      fh = await fs.promises.open(realPath, this.openFlags());
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { ok: false, error: 'orphan' };
      if (e?.code === 'ELOOP') return { ok: false, error: 'not-allowed' };
      return { ok: false, error: String(e?.message ?? e) };
    }
    let st: fs.BigIntStats;
    try {
      await this.afterOpenForTest?.(realPath);
      st = await this.statForMint(fh);
      if (!st.isFile()) return { ok: false, error: 'not-a-file' };
      // Only a file with a real identity can be pinned to its inode.
      if (st.ino === 0n) return { ok: false, error: 'not-allowed' };
      const opened = await openedPathOf(fh);
      if (opened !== null && opened !== realPath) return { ok: false, error: 'not-allowed' };
      const again = await fs.promises.realpath(realPath).catch(() => null);
      if (again !== realPath) return { ok: false, error: 'not-allowed' };
    } finally {
      await fh.close().catch(() => { /* already closed */ });
    }

    // Capacity: drop this device's oldest links first (Map order is mint order),
    // but never one with a download streaming right now — its resume would get
    // a permanent 404 (T7 re-review, finding 5). If every link is busy, say so.
    const mine = [...this.tokens.values()].filter((t) => t.deviceId === who.deviceId);
    const excess = mine.length - (MAX_TOKENS_PER_DEVICE - 1);
    if (excess > 0) {
      const idleLinks = mine.filter((t) => !this.liveByToken.has(t.token));
      if (idleLinks.length < excess) return { ok: false, error: 'busy' };
      for (const old of idleLinks.slice(0, excess)) this.tokens.delete(old.token);
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const name = path.basename(realPath);
    this.tokens.set(token, {
      token, deviceId: who.deviceId, socketId: who.socketId, realPath, name,
      dev: st.dev, ino: st.ino, expiresAt: this.now() + DOWNLOAD_TOKEN_TTL_MS,
    });
    // The name rides the URL so the Android download manager — which picks a
    // file name before it sees a header — has one; the host never reads it
    // back (the token is the only thing looked up).
    return { ok: true, url: `${ROUTE_PREFIX}${token}/${encodeURIComponent(wellFormed(name))}`, name, sizeBytes: Number(st.size) };
  }

  /**
   * The artifact route: a record the project's sidecar holds, resolved and
   * authorized the way artifacts:get does (symlinks resolved, in-root for
   * internals, protected paths refused), and it must resolve to the SAME real
   * file the phone named.
   */
  private async authorizedAsArtifact(projectRoot: string, artifactId: string, realPath: string): Promise<boolean> {
    const sidecar = await readSidecarShared(projectRoot).catch(() => null);
    if (!sidecar || 'corrupted' in sidecar) return false;
    const artifact = sidecar.artifacts.find((a) => a.id === artifactId);
    if (!artifact) return false;
    const fullPath = artifact.kind === 'internal' ? path.join(projectRoot, artifact.path) : artifact.absolutePath;
    if (!fullPath) return false;
    const auth = await authorizeArtifactRead(projectRoot, fullPath, artifact.kind === 'internal').catch(() => null);
    return !!auth && auth.ok && auth.realPath === realPath;
  }

  /**
   * Every link a device held AND every download it has streaming: removing a
   * device ends its right to download at once, not after its current transfer
   * finishes (R10; T7 re-review, finding 4). Called on unpair.
   */
  revokeDevice(deviceId: string): void {
    for (const [token, entry] of this.tokens) if (entry.deviceId === deviceId) this.tokens.delete(token);
    for (const res of [...(this.liveResponses.get(deviceId) ?? [])]) res.destroy();
  }

  /** Every device at once — what a password change means. */
  revokeAll(): void {
    this.tokens.clear();
    for (const set of [...this.liveResponses.values()]) for (const res of [...set]) res.destroy();
  }

  /** Streams open right now for one socket — the budget MAX_LIVE_STREAMS_PER_SOCKET counts. */
  liveStreams(socketId: string): number {
    return this.live.get(socketId) ?? 0;
  }

  /**
   * Route anything under `/download/`. Returns false for any other path so the
   * caller falls through to the app; true means the response is owned here —
   * including a malformed download path, which gets 404 rather than the app
   * page (finding 14). Matched BEFORE the static handler and the Vite proxy, or
   * the SPA fallback would answer an expired link with index.html and a 200.
   */
  handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== '/download' && !pathname.startsWith(ROUTE_PREFIX)) return false;
    const m = ROUTE.exec(pathname);
    if (!m) { this.notFound(res); return true; }
    void this.serve(m[1], req, res).catch(() => {
      // Anything unexpected mid-response: end it without a body. The client's
      // download manager shows a failed transfer and retries the same URL.
      if (!res.headersSent) res.writeHead(500, { 'Content-Length': '0', 'Cache-Control': 'no-store' });
      res.end();
    });
    return true;
  }

  private notFound(res: http.ServerResponse): void {
    // Empty body, deliberately: an unknown, expired or revoked link says
    // nothing about which of the three it was (R20 — never a page).
    res.writeHead(404, { 'Content-Length': '0', 'Cache-Control': 'no-store' });
    res.end();
  }

  private async serve(token: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') { this.notFound(res); return; }
    const entry = this.tokens.get(token);
    if (!entry || entry.expiresAt <= this.now() || this.isDeviceRevoked(entry.deviceId)) {
      if (entry) this.tokens.delete(token);
      this.notFound(res);
      return;
    }
    // The cap is on STREAMS, keyed by the minting socket: a resume after a drop
    // counts against the dead socket's budget, never the new one, by intent
    // (§10). Over the cap: 503 + Retry-After, which download managers retry
    // (a 429 is a permanent failure to Android's; finding 5).
    const socketId = entry.socketId;
    const inUse = this.live.get(socketId) ?? 0;
    if (inUse >= MAX_LIVE_STREAMS_PER_SOCKET) {
      res.writeHead(503, { 'Content-Length': '0', 'Cache-Control': 'no-store', 'Retry-After': '5' });
      res.end();
      return;
    }

    // Reserve the slot NOW, before the first await, and release it from a
    // close listener attached NOW. WHY both: a check here and a count after the
    // awaits let a burst of GETs all pass before any counted (finding 2), and a
    // listener attached after the awaits never hears a hang-up that happened
    // during them — the slot and the file handle leaked for good (finding 1).
    this.live.set(socketId, inUse + 1);
    this.liveByToken.set(token, (this.liveByToken.get(token) ?? 0) + 1);
    const deviceId = entry.deviceId;
    const deviceResponses = this.liveResponses.get(deviceId) ?? new Set<http.ServerResponse>();
    deviceResponses.add(res);
    this.liveResponses.set(deviceId, deviceResponses);
    let fh: FileHandle | null = null;
    let stream: fs.ReadStream | null = null;
    let closed = false;
    const dropHandle = () => {
      const h = fh;
      fh = null;
      if (h) void h.close().catch(() => { /* already closed */ });
    };
    // A per-transfer idle timer, refreshed by progress. WHY not the socket's own
    // timeout (as before): clearing it when the response closed also cancelled
    // the server's keep-alive timer, and a pipelined second request's transfer
    // lost its timer to the first response's close (T7 re-review, finding 2).
    const idle = setTimeout(() => res.destroy(), this.idleTimeoutMs);
    idle.unref?.();
    const progressed = () => { idle.refresh(); };
    res.on('drain', progressed);
    // Set once this request's file headers are sent: only a request that served
    // the file renews its link (finding 7).
    let served = false;
    res.on('close', () => {
      closed = true;
      clearTimeout(idle);
      const n = (this.live.get(socketId) ?? 1) - 1;
      if (n <= 0) this.live.delete(socketId); else this.live.set(socketId, n);
      const t = (this.liveByToken.get(token) ?? 1) - 1;
      if (t <= 0) this.liveByToken.delete(token); else this.liveByToken.set(token, t);
      deviceResponses.delete(res);
      if (deviceResponses.size === 0 && this.liveResponses.get(deviceId) === deviceResponses) this.liveResponses.delete(deviceId);
      // Sliding from the END of a transfer too: a long download that drops
      // after nearly five minutes must still be resumable (finding 6).
      const current = this.tokens.get(token);
      if (served && current) current.expiresAt = this.now() + DOWNLOAD_TOKEN_TTL_MS;
      if (stream) stream.destroy(); else dropHandle();
    });

    try {
      fh = await this.openForServe(entry.realPath, this.openFlags());
    } catch {
      // ELOOP (a symlink where a file was), ENOENT, EACCES: all the same answer.
      if (!closed) this.notFound(res);
      return;
    }
    if (closed) { dropHandle(); return; }
    let st: fs.BigIntStats;
    let realNow: string | null;
    let opened: string | null;
    try {
      st = await fh.stat({ bigint: true });
      realNow = await fs.promises.realpath(entry.realPath).catch(() => null);
      opened = await openedPathOf(fh);
    } catch {
      dropHandle();
      if (!closed) this.notFound(res);
      return;
    }
    if (closed) { dropHandle(); return; }
    // The identity compare — the guard on every platform — plus the path still
    // resolving to itself: O_NOFOLLOW guards only the last component, so a
    // folder on the way swapped for a link must be caught here (finding 3).
    if (st.dev !== entry.dev || st.ino !== entry.ino || !st.isFile()
        || realNow !== entry.realPath || (opened !== null && opened !== entry.realPath)
        || isSensitivePath(canonicalize(realNow, null))) {
      this.tokens.delete(token);     // a link that can never succeed again
      dropHandle();
      this.notFound(res);
      return;
    }

    const size = Number(st.size);
    const mtimeMs = Number(st.mtimeMs);
    const etag = `"${st.dev}-${st.ino}-${size}-${Math.floor(mtimeMs)}"`;
    const lastModified = new Date(mtimeMs).toUTCString();

    // If-Match: Android's download manager resumes with it. A file edited in
    // place keeps its inode, so without this a resume would stitch the new
    // version's tail onto the old half (finding 7). Strong comparison only.
    const ifMatch = typeof req.headers['if-match'] === 'string' ? req.headers['if-match'].trim() : undefined;
    if (ifMatch !== undefined && ifMatch !== '*' && !ifMatch.split(',').map((t) => t.trim()).includes(etag)) {
      dropHandle();
      res.writeHead(412, { 'Content-Length': '0', 'Cache-Control': 'no-store', 'ETag': etag });
      res.end();
      return;
    }
    // If-Range: a resume is only a resume when the file is the one the client
    // has half of. Only the ETag counts — Last-Modified has one-second
    // resolution, so an edit within that second would pass a date — and any
    // mismatch answers 200 from byte 0 (finding 14).
    const ifRange = typeof req.headers['if-range'] === 'string' ? req.headers['if-range'].trim() : undefined;
    const rangeAllowed = !ifRange || ifRange === etag;
    const range = rangeAllowed ? parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size) : null;
    if (range === 'unsatisfiable') {
      dropHandle();
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': '0', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const expected = size === 0 ? 0 : end - start + 1;
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${asciiFallback(entry.name)}"; filename*=UTF-8''${rfc5987(entry.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'ETag': etag,
      'Last-Modified': lastModified,
      'Content-Length': String(expected),
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    // A GET that serves the file renews its link (§10: sliding expiry); a HEAD,
    // a refusal or a failure does not (finding 7).
    if (req.method === 'GET') {
      served = true;
      entry.expiresAt = this.now() + DOWNLOAD_TOKEN_TTL_MS;
    }

    if (req.method === 'HEAD' || expected === 0) {
      dropHandle();
      res.end();
      return;
    }

    // The stream owns the handle from here (autoClose). A file cut short while
    // it is read ends the CONNECTION, never a response shorter than its
    // Content-Length that a client could keep waiting on (finding 12).
    const s = fh.createReadStream({ start, end, autoClose: true });
    stream = s;
    fh = null;
    let sent = 0;
    s.on('data', (chunk: string | Buffer) => { sent += chunk.length; progressed(); });
    s.on('error', () => { res.destroy(); });
    s.on('end', () => { if (sent === expected) res.end(); else res.destroy(); });
    s.pipe(res, { end: false });
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.tokens) if (entry.expiresAt <= now) this.tokens.delete(token);
  }
}
