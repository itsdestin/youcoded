// Insert → Picture (finish plan Task 1). The editor's bridge.js turns every picture it is given
// — one the person chose in the file dialog, one typed as a web address, one in pasted web
// content — into a synchronous request on its own origin (a dropped picture: uploadToMedia below):
//   office://<token>/asc/copy-to-media/<what the dialog answered>
//   office://<token>/asc/download-to-media/<http(s) address>
// and expects back the bare file name the picture now has in the document's media folder
// (<session temp>/media). The editor then shows it from asc/docmedia/media/<name>, and x2t packs
// that folder into the file on save, which is what makes the picture survive a reopen.
//
// WHY handles instead of paths (security invariants, finish plan): the editor frame must never
// learn where a file lives, and main must read only files the person chose in a dialog main
// itself showed. So the dialog answer the frame sees is an opaque, per-document handle
// (yc-picked/<random>/<file name>); only this module knows which real file it stands for, and
// only for the document whose dialog it came from. A real path sent by the frame is refused.
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { log } from '../logger';
import type { OfficeSession } from './office-sessions';
import { nonPublicReason } from './public-address';

/** WHY 25 MB (Destin's decision for this task): far above any photo a person inserts, far
 *  below what would make a document unworkable. Applies to chosen files and downloads alike. */
export const PICTURE_MAX_BYTES = 25 * 1024 * 1024;
/** WHY 20 s: the editor waits for this answer with a synchronous request — its window is frozen
 *  until it arrives — so a slow or stalled server must not hold it longer than that. */
const PICTURE_DOWNLOAD_TIMEOUT_MS = 20_000;

// WHY this list (no tif/tiff, emf, wmf): the pictures the editor's Chromium can draw. The dialog
// offers tif too (bridge.js's filter), but one inserted would only show as a broken picture.
const EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'ico']);
const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

const HANDLE = /^yc-picked\/([0-9a-f]{32})\/[^/\\]+$/;
// Per document; a WeakMap so a closed document's grants go with it (nothing else holds them).
const grants = new WeakMap<OfficeSession, Map<string, string>>();

/** Record the files the person just chose in main's own dialog for this document, and return
 *  the handles the editor gets in their place (same order). */
export function grantPicked(s: OfficeSession, paths: string[]): string[] {
  let mine = grants.get(s);
  if (!mine) grants.set(s, (mine = new Map()));
  return paths.map((p) => {
    const handle = `yc-picked/${randomBytes(16).toString('hex')}/${path.basename(p)}`;
    mine.set(handle, p);
    return handle;
  });
}

const mediaDir = (s: OfficeSession) => path.join(s.temp, 'media');

// WHY a fresh random name: media/ already holds image1.png, image2.png… from the opened file, so
// reusing the source's name would overwrite (and silently change) a picture the document has.
async function store(s: OfficeSession, ext: string, data: Buffer): Promise<string> {
  await fsp.mkdir(mediaDir(s), { recursive: true });
  const name = `picture-${randomBytes(8).toString('hex')}.${ext}`;
  // 'wx': never replaces a file, even in the astronomically unlikely case of a repeat.
  await fsp.writeFile(path.join(mediaDir(s), name), data, { flag: 'wx' });
  return name;
}

const extOf = (name: string) => path.extname(name).slice(1).toLowerCase();

/** copy-to-media: the bare media name, or null (refused; the caller answers 404). */
export async function copyToMedia(s: OfficeSession, requested: string): Promise<string | null> {
  const granted = HANDLE.test(requested) ? grants.get(s)?.get(requested) : undefined;
  if (granted) {
    const ext = extOf(granted);
    if (!EXTS.has(ext)) return refuse('copy-to-media', 'not a picture');
    const info = await fsp.stat(granted).catch(() => null);
    if (!info?.isFile()) return refuse('copy-to-media', 'chosen file is gone');
    if (info.size > PICTURE_MAX_BYTES) return refuse('copy-to-media', 'over the size cap');
    const data = await fsp.readFile(granted);
    // WHY again on the bytes read (fix round 1): the file can grow between the stat and the read.
    if (data.length > PICTURE_MAX_BYTES) return refuse('copy-to-media', 'over the size cap');
    return store(s, ext, data);
  }
  // The document's own picture, asked for by name (e.g. image1.png or media/image1.png after a
  // copy and paste inside the document): already in media/, so it is its own answer. WHY one
  // plain name only: anything with a separator or "..", or that is not there, is refused.
  const own = requested.replace(/^media\//, '');
  if (own && !/[/\\]/.test(own) && own !== '.' && own !== '..') {
    const info = await fsp.stat(path.join(mediaDir(s), own)).catch(() => null);
    if (info?.isFile()) return own;
  }
  return refuse('copy-to-media', 'not a chosen file nor this document\'s picture');
}

/** One request, never following a redirect on its own: before each redirect it asks
 *  `allowRedirect(to)`, and stops (rejects) when that says no. Production: pictureRequestVia(net.request). */
export type PictureRequest = (url: string, opts: { signal: AbortSignal; allowRedirect(to: string): Promise<boolean> }) => Promise<Response>;
/** A host name's addresses (production: dns.lookup, all of them). */
export type ResolveHost = (host: string) => Promise<string[]>;

const MAX_REDIRECTS = 5;

const isWeb = (u: string) => {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
};

/** Why `url` may not be fetched, or null when it may: http(s) only, and EVERY address its host
 *  resolves to must be public (public-address.ts). WHY every one: a name answering with one
 *  public and one private address could be connected through the private one. */
async function refusalFor(url: string, resolve: ResolveHost, signal: AbortSignal): Promise<string | null> {
  if (!isWeb(url)) return 'not an http(s) address';
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  // WHY raced against the cap (fix round 2): a lookup can hang far past 20 s; the cap must hold
  // for the whole download, lookups included. An aborted lookup throws (the caller says "timed out").
  const addrs = isIP(host) ? [host] : await untilAborted(resolve(host), signal).catch((e: unknown) => {
    if (signal.aborted) throw e;
    return [] as string[];
  });
  if (!addrs.length) return 'host did not resolve';
  for (const a of addrs) {
    const why = nonPublicReason(a);
    if (why) return `not a public address (${why})`;
  }
  return null;
}

/** `p`, or a rejection as soon as `signal` aborts (the work itself is left to finish unseen). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/** download-to-media: the bare media name, or null (refused; the caller answers 404).
 *  NOTE (fix round 1): the check resolves the host itself, then Electron's network stack resolves
 *  it again to connect — it cannot be handed the checked address. A name that answers differently
 *  the second time (DNS rebinding) is therefore not fully stopped; see the finish-1 report. */
export async function downloadToMedia(
  s: OfficeSession,
  url: string,
  deps: { request: PictureRequest; resolve: ResolveHost; timeoutMs?: number },
): Promise<string | null> {
  const ctl = new AbortController();
  // WHY one timer over the whole download, lookups and body included: a server that answers at
  // once but then trickles the bytes would otherwise freeze the editor just the same.
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? PICTURE_DOWNLOAD_TIMEOUT_MS);
  try {
    const first = await refusalFor(url, deps.resolve, ctl.signal);
    if (first) return refuse('download-to-media', first);
    let hops = 0;
    let refusedHop: string | null = null;
    const res = await deps.request(url, {
      signal: ctl.signal,
      // WHY each redirect is checked like the first address: a public page may redirect into the
      // local network (or off the web) — such a redirect is never followed.
      allowRedirect: async (to) => {
        if (++hops > MAX_REDIRECTS) refusedHop = 'too many redirects';
        else refusedHop = await refusalFor(to, deps.resolve, ctl.signal).then((why) => (why ? `redirect: ${why}` : null));
        return refusedHop === null;
      },
    }).catch((e: unknown) => {
      if (refusedHop) return refusedHop;
      throw e;
    });
    if (typeof res === 'string') return refuse('download-to-media', res);
    if (!res.ok) return refuse('download-to-media', `status ${res.status}`);
    const ext = TYPES[(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()];
    if (!ext) return refuse('download-to-media', 'not a picture');
    if (Number(res.headers.get('content-length') ?? 0) > PICTURE_MAX_BYTES) return refuse('download-to-media', 'over the size cap');
    const data = await readCapped(res, ctl);
    if (!data) return refuse('download-to-media', 'over the size cap');
    return await store(s, ext, data);
  } catch {
    // WHY no error text: a network error's message can carry the address.
    return refuse('download-to-media', ctl.signal.aborted ? 'timed out' : 'request failed');
  } finally {
    clearTimeout(timer);
  }
}

/** The part of Electron's ClientRequest (net.request) a picture download uses. */
interface NetRequest {
  on(event: 'redirect', cb: (status: number, method: string, to: string) => void): unknown;
  on(event: 'response', cb: (res: { statusCode: number; headers: Record<string, string | string[]>; on(e: string, cb: (x?: unknown) => void): unknown }) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  abort(): void;
  end(): void;
}

/** A PictureRequest over Electron's net.request. WHY net.request, not net.fetch (fix round 1):
 *  net.fetch either follows a redirect unseen or, with redirect 'manual', fails with "Redirect
 *  was cancelled" and never shows where it pointed (measured in Electron 41; its final `url`
 *  reads ''). net.request in manual mode reports each redirect's target — but followRedirect()
 *  only works synchronously inside that event, and the check needs a DNS lookup. So each hop is
 *  its own request: on a redirect this one is aborted, the target is checked, and only then is
 *  a new GET made to it. WHY no cookies: the address comes from the document or the person; the
 *  app's own cookies for that site stay home. */
export function pictureRequestVia(request: (opts: Record<string, unknown>) => NetRequest): PictureRequest {
  const hop = (url: string, signal: AbortSignal) => new Promise<{ redirect: string } | { response: Response }>((resolve, reject) => {
    // WHY checked first (fix round 2): the cap can fire while a redirect's lookup was awaited; a
    // hop started after that would run with no cap at all (an aborted signal never fires again).
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const req = request({ url, method: 'GET', redirect: 'manual', useSessionCookies: false, credentials: 'omit' });
    const abort = () => { try { req.abort(); } catch { /* already done */ } };
    // The answer's body, once it has begun: the cap and Electron's own 'aborted' must end it.
    let bodyCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const failBody = () => { try { bodyCtl?.error(new Error('aborted')); } catch { /* already closed */ } bodyCtl = null; };
    req.on('redirect', (_status, _method, to) => { abort(); resolve({ redirect: to }); });
    req.on('response', (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          bodyCtl = c;
          res.on('data', (d) => bodyCtl?.enqueue(new Uint8Array(d as Buffer)));
          res.on('end', () => { bodyCtl?.close(); bodyCtl = null; });
          res.on('error', () => failBody());
          // WHY (fix round 2): after req.abort() Electron's answer emits 'aborted' — never 'end' or
          // 'error' — so without this a reader waiting on the body would wait forever, and the
          // editor's synchronous request with it.
          res.on('aborted', () => failBody());
        },
        cancel: abort,
      });
      resolve({ response: new Response(body, { status: res.statusCode, headers }) });
    });
    req.on('error', reject);
    // The cap: stop the request, and end a body already being read (see 'aborted' above).
    signal.addEventListener('abort', () => { abort(); failBody(); reject(new Error('aborted')); }, { once: true });
    req.end();
  });
  return async (url, { signal, allowRedirect }) => {
    for (let cur = url; ;) {
      const r = await hop(cur, signal);
      if ('response' in r) return r.response;
      if (!(await allowRedirect(r.redirect))) throw new Error('redirect refused');
      if (signal.aborted) throw new Error('aborted'); // the cap fired during that check
      cur = r.redirect;
    }
  };
}

/** A picture dropped onto the document (drag and drop). The add-on (yc-bridge.js, answering
 *  sdkjs's GetDropFiles) sends the dropped file's BYTES — never a path — as a POST to its own
 *  origin's upload/ route, the way the editor would upload to a document server. Main reads no file for this; it only checks and stores what it was given.
 *  The bare media name, or null (refused; the caller answers 404). */
export async function uploadToMedia(s: OfficeSession, req: Request): Promise<string | null> {
  if (req.method !== 'POST') return refuse('upload', 'not a POST');
  const ext = TYPES[(req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()];
  if (!ext) return refuse('upload', 'not a picture');
  const data = await readCapped(req, new AbortController());
  if (!data) return refuse('upload', 'over the size cap');
  return store(s, ext, data);
}

// WHY read piece by piece: the size a server announces can be absent or false, and the whole
// body must never be held in memory before we know it fits.
async function readCapped(res: Response | Request, ctl: AbortController): Promise<Buffer | null> {
  if (!res.body) {
    // A body-less answer holds nothing, but the cap is still checked on what was read.
    const all = Buffer.from(await res.arrayBuffer());
    return all.length > PICTURE_MAX_BYTES ? null : all;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > PICTURE_MAX_BYTES) {
      ctl.abort();
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

// WHY logged without the address or path: the log says what was refused and why; the request
// itself can hold a private file name or address, and the reason is what a bug report needs.
function refuse(route: string, why: string): null {
  log('WARN', 'Office', `${route} refused: ${why}`);
  return null;
}
