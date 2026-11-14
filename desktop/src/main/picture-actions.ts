// picture-actions.ts — the right-click menu on a picture in a chat: "Copy image" and "Save image as…" (card #143 a, deck C-2).
//
// WHY the computer fetches the bytes itself instead of the window: a picture from a website is drawn from another origin,
// and the window cannot read another origin's pixels (a canvas or clipboard write of it is refused), so copying it from
// the window fails for exactly the pictures people most want to copy. The computer's own process can read it, and the
// person has already chosen to load it (a website picture waits behind a Show button, MarkdownContent ChatImage).
// Only http(s) and file addresses are taken; a data: or blob: picture never reaches here (react-markdown drops it).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { clipboard, ClipboardItem, dialog, nativeImage, net, type BrowserWindow } from 'electron';

/** A picture larger than this is refused rather than held in memory (no chat picture is near it). */
const MAX_PICTURE_BYTES = 50 * 1024 * 1024;

export type PictureAction = 'copy' | 'save';
export interface PictureResult { ok: boolean; canceled?: boolean; reason?: string }

const EXT_BY_TYPE: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp', 'image/avif': '.avif' };

async function loadPicture(src: string): Promise<{ bytes: Buffer; name: string; type: string } | PictureResult> {
  let url: URL;
  try { url = new URL(src); } catch { return { ok: false, reason: 'bad-address' }; }
  const baseName = decodeURIComponent(path.basename(url.pathname) || '').replace(/[\\/:*?"<>|]/g, '_') || 'picture';
  if (url.protocol === 'file:') {
    const p = fileURLToPath(url);
    const stat = await fs.promises.stat(p);
    if (stat.size > MAX_PICTURE_BYTES) return { ok: false, reason: 'too-large' };
    return { bytes: await fs.promises.readFile(p), name: baseName, type: '' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'unsupported-address' };
  const res = await net.fetch(url.toString());
  if (!res.ok) return { ok: false, reason: 'fetch-failed' };
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_PICTURE_BYTES) return { ok: false, reason: 'too-large' };
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_PICTURE_BYTES) return { ok: false, reason: 'too-large' };
  return { bytes, name: baseName, type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
}

export async function runPictureAction(action: PictureAction, src: string, window: BrowserWindow | null): Promise<PictureResult> {
  if (typeof src !== 'string' || src.length === 0 || src.length > 4096) return { ok: false, reason: 'bad-address' };
  try {
    const pic = await loadPicture(src);
    if (!('bytes' in pic)) return pic;
    if (action === 'copy') {
      const img = nativeImage.createFromBuffer(pic.bytes);
      if (img.isEmpty()) return { ok: false, reason: 'not-a-picture' };
      // WHY write([ClipboardItem]) and not writeImage: Electron 44 removed the synchronous clipboard calls (see shell.ts CLIPBOARD_SAVE_IMAGE).
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })]);
      return { ok: true };
    }
    // Save: the person picks the place; the file keeps the picture's own bytes (no re-encoding).
    const ext = path.extname(pic.name) || EXT_BY_TYPE[pic.type] || '';
    const defaultPath = ext && !path.extname(pic.name) ? `${pic.name}${ext}` : pic.name;
    const opts = { defaultPath };
    const chosen = window ? await dialog.showSaveDialog(window, opts) : await dialog.showSaveDialog(opts);
    if (chosen.canceled || !chosen.filePath) return { ok: true, canceled: true };
    await fs.promises.writeFile(chosen.filePath, pic.bytes);
    return { ok: true };
  } catch {
    // No cause is guessed (docs/error-message-standards.md): the renderer says only that it could not.
    return { ok: false, reason: 'failed' };
  }
}
