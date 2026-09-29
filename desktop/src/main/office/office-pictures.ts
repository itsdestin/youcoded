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
import path from 'node:path';
import { log } from '../logger';
import type { OfficeSession } from './office-sessions';

/** WHY 25 MB (Destin's decision for this task): far above any photo a person inserts, far
 *  below what would make a document unworkable. Applies to chosen files and downloads alike. */
export const PICTURE_MAX_BYTES = 25 * 1024 * 1024;
/** WHY 20 s: the editor waits for this answer with a synchronous request — its window is frozen
 *  until it arrives — so a slow or stalled server must not hold it longer than that. */
export const PICTURE_DOWNLOAD_TIMEOUT_MS = 20_000;

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
    return store(s, ext, await fsp.readFile(granted));
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

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const isWeb = (u: string) => {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
};

/** download-to-media: the bare media name, or null (refused; the caller answers 404). */
export async function downloadToMedia(s: OfficeSession, url: string, fetch: Fetch, timeoutMs = PICTURE_DOWNLOAD_TIMEOUT_MS): Promise<string | null> {
  if (!isWeb(url)) return refuse('download-to-media', 'not an http(s) address');
  const ctl = new AbortController();
  // WHY one timer over the whole download, body included: a server that answers at once but
  // then trickles the bytes would otherwise freeze the editor just the same.
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // WHY credentials 'omit': the address comes from the document or the person, and the app's
    // own cookies for that site have no business going with it.
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit', redirect: 'follow' });
    // WHY re-checked after redirects: the address may lead somewhere that is not the web at all.
    if (res.url && !isWeb(res.url)) return refuse('download-to-media', 'redirected off http(s)');
    if (!res.ok) return refuse('download-to-media', `status ${res.status}`);
    const ext = TYPES[(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()];
    if (!ext) return refuse('download-to-media', 'not a picture');
    if (Number(res.headers.get('content-length') ?? 0) > PICTURE_MAX_BYTES) return refuse('download-to-media', 'over the size cap');
    const data = await readCapped(res, ctl);
    if (!data) return refuse('download-to-media', 'over the size cap');
    return await store(s, ext, data);
  } catch (e) {
    return refuse('download-to-media', ctl.signal.aborted ? 'timed out' : String(e));
  } finally {
    clearTimeout(timer);
  }
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
  if (!res.body) return Buffer.from(await res.arrayBuffer());
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
