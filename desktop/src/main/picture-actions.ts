// picture-actions.ts — the right-click menu on a picture in a chat: "Copy image" and "Save image as…" (card #143 a, deck C-2).
//
// WHY the computer fetches the bytes itself instead of the window: a picture from a website is drawn from another origin,
// and the window cannot read another origin's pixels, so copying it from the window fails for exactly the pictures people most
// want to copy. The person has already chosen to load it (a website picture waits behind a Show button, MarkdownContent ChatImage).
//
// WHY every rule below (security review of session/round3-chat, 2026-11-13): the picture's ADDRESS is chat content, so it can be
// written by whatever the assistant read. Therefore:
//  - the fetch goes through the app's one guarded path (net-guard: public hosts only, every redirect hop re-checked, http(s) only),
//    never a bare fetch — so an address like http://169.254.169.254/ or a redirect to the home network is refused;
//  - the size cap is enforced WHILE the body streams, with a timeout, not after it is all in memory;
//  - Save writes only pictures: the reply must say image/* AND its first bytes must be a real picture format, and the suggested
//    file name takes its ending from that detected format, never from the address (so no "setup.exe");
//  - file: addresses are not accepted at all. WHY: no picture in a chat is a file: address today (the markdown layer does not pass
//    them and attachments are drawn only in the message box), the main process cannot tell which file addresses the app itself
//    offered, and accepting any would let a crafted address copy an arbitrary file to a place the person picks. Refusing is the
//    only version that is both safe and checkable.
import fs from 'fs';
import path from 'path';
import { clipboard, ClipboardItem, dialog, nativeImage, type BrowserWindow } from 'electron';
import { guardedFetch, readBytesCapped } from './harness/tools/net-guard';

/** A picture larger than this is refused rather than held in memory (no chat picture is near it). */
const MAX_PICTURE_BYTES = 50 * 1024 * 1024;
/** The whole fetch, redirects included, gets this long. A body that never ends is cut here. */
const PICTURE_TIMEOUT_MS = 30_000;

export interface PictureResult { ok: boolean; canceled?: boolean; reason?: string }

/** The picture formats Save will write, found from the FIRST BYTES, never from the name or the declared type. SVG is left out on
 *  purpose: it can carry script and the clipboard path cannot draw it. */
export function sniffPictureType(b: Uint8Array): { type: string; ext: string } | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { type: 'image/png', ext: '.png' };
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return { type: 'image/jpeg', ext: '.jpg' };
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return { type: 'image/gif', ext: '.gif' };
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { type: 'image/webp', ext: '.webp' };
  if (b.length >= 2 && at(0, 0x42, 0x4d)) return { type: 'image/bmp', ext: '.bmp' };
  if (b.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70) && at(8, 0x61, 0x76, 0x69, 0x66)) return { type: 'image/avif', ext: '.avif' };
  return null;
}

/** A file name taken from the address, with letters, digits and a few safe marks only and NO ending: the ending comes from the picture. */
function stemFromAddress(url: URL): string {
  let name = '';
  try { name = decodeURIComponent(path.posix.basename(url.pathname)); } catch { name = path.posix.basename(url.pathname); }
  name = name.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9 _-]/g, '_').replace(/^[._ ]+/, '').slice(0, 80);
  // WHY (review): Windows cannot save a file named CON, PRN, AUX, NUL, COM1-9 or LPT1-9 (with or without an ending), so those are
  // prefixed and the person still gets a usable suggestion.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `picture-${name}`;
  return name || 'picture';
}

async function loadPicture(src: string, timeoutMs: number): Promise<{ bytes: Buffer; stem: string; kind: { type: string; ext: string } } | PictureResult> {
  let url: URL;
  try { url = new URL(src); } catch { return { ok: false, reason: 'bad-address' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'unsupported-address' };
  const { res } = await guardedFetch(url.toString(), {
    signal: new AbortController().signal,
    timeoutMs,
    headers: { accept: 'image/*' },
  });
  // WHY the body is cancelled on every early return: an unread body keeps its connection open until the timeout.
  const drop = async () => { await res.body?.cancel().catch(() => {}); };
  if (!res.ok) { await drop(); return { ok: false, reason: 'fetch-failed' }; }
  const declaredType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!declaredType.startsWith('image/')) { await drop(); return { ok: false, reason: 'not-a-picture' }; }
  const declaredLength = Number(res.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_PICTURE_BYTES) { await drop(); return { ok: false, reason: 'too-large' }; }
  // The cap is enforced as the body arrives, so a missing or lying length cannot fill memory.
  const { bytes, truncated } = await readBytesCapped(res, MAX_PICTURE_BYTES);
  if (truncated) return { ok: false, reason: 'too-large' };
  const kind = sniffPictureType(bytes);
  if (!kind) return { ok: false, reason: 'not-a-picture' };
  return { bytes, stem: stemFromAddress(url), kind };
}

export async function runPictureAction(action: unknown, src: unknown, window: BrowserWindow | null, timeoutMs = PICTURE_TIMEOUT_MS): Promise<PictureResult> {
  // The payload comes over IPC: check its shape before anything else.
  if ((action !== 'copy' && action !== 'save') || typeof src !== 'string' || src.length === 0 || src.length > 4096) return { ok: false, reason: 'bad-request' };
  try {
    const pic = await loadPicture(src, timeoutMs);
    if (!('bytes' in pic)) return pic;
    if (action === 'copy') {
      const img = nativeImage.createFromBuffer(pic.bytes);
      if (img.isEmpty()) return { ok: false, reason: 'not-a-picture' };
      // WHY write([ClipboardItem]) and not writeImage: Electron 44 removed the synchronous clipboard calls (see shell.ts CLIPBOARD_SAVE_IMAGE).
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })]);
      return { ok: true };
    }
    // Save: the person picks the place; the file keeps the picture's own bytes (no re-encoding), named from the DETECTED type.
    const opts = { defaultPath: `${pic.stem}${pic.kind.ext}` };
    const chosen = window ? await dialog.showSaveDialog(window, opts) : await dialog.showSaveDialog(opts);
    if (chosen.canceled || !chosen.filePath) return { ok: true, canceled: true };
    await fs.promises.writeFile(chosen.filePath, pic.bytes);
    return { ok: true };
  } catch {
    // No cause is guessed (docs/error-message-standards.md): the renderer says only that it could not. A refused address, an
    // unreachable site, a timeout and an oversize body all land here or above and read the same to the person.
    return { ok: false, reason: 'failed' };
  }
}
