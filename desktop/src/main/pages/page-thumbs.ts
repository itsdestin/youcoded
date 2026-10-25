// Small pictures for the tiles of YouCoded's own file chooser on a phone (pages-finish step 2,
// design §4; full thumbnails are card #204).
//
// WHY only these two sources: decoding every photo in a folder on main would stall the app
// (main never blocks), and sending full photos to a phone is too heavy. So a tile shows
//   - a JPEG's own embedded preview (the small picture cameras write into the EXIF block),
//     read from the first 64 KB of the file; or
//   - the image itself when it is already small (≤ 200 KB);
// and otherwise the kind icon. Every listing has a total budget, so a folder of a thousand
// photos costs at most a few megabytes.
import fs from 'fs';
import path from 'path';

const SMALL_IMAGE_BYTES = 200 * 1024;
const EXIF_HEAD_BYTES = 64 * 1024;
const LISTING_BUDGET_BYTES = 3 * 1024 * 1024;
const MAX_THUMBS = 80;

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

/** Fill `thumb` on the image entries of one listing, within the budget. Never throws. */
export async function addThumbs(dir: string, entries: Array<{ name: string; kind: 'folder' | 'file'; size?: number; thumb?: string }>): Promise<void> {
  let spent = 0;
  let made = 0;
  for (const e of entries) {
    if (made >= MAX_THUMBS || spent >= LISTING_BUDGET_BYTES) return;
    const type = e.kind === 'file' ? TYPES[path.extname(e.name).toLowerCase()] : undefined;
    if (!type || e.size === undefined) continue;
    const bytes = await thumbBytes(path.join(dir, e.name), e.size, type).catch(() => null);
    if (!bytes || spent + bytes.length > LISTING_BUDGET_BYTES) continue;
    e.thumb = `data:${bytes.type};base64,${bytes.data.toString('base64')}`;
    spent += bytes.length;
    made++;
  }
}

async function thumbBytes(file: string, size: number, type: string): Promise<{ data: Buffer; type: string; length: number } | null> {
  if (size > SMALL_IMAGE_BYTES && type !== 'image/jpeg') return null;
  const fh = await fs.promises.open(file, 'r');
  try {
    if (size <= SMALL_IMAGE_BYTES) {
      // At most one byte past the limit is read: a file that grew since it was listed is skipped, never read whole.
      const buf = Buffer.alloc(SMALL_IMAGE_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return bytesRead <= SMALL_IMAGE_BYTES ? { data: buf.subarray(0, bytesRead), type, length: bytesRead } : null;
    }
    const head = Buffer.alloc(Math.min(size, EXIF_HEAD_BYTES));
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    const preview = exifPreview(head.subarray(0, bytesRead));
    return preview ? { data: preview, type: 'image/jpeg', length: preview.length } : null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** The JPEG preview inside a JPEG's EXIF block (IFD1's JPEGInterchangeFormat), or null.
 *  Every offset is bounds-checked: the file is the person's, but its bytes are anyone's. */
export function exifPreview(buf: Buffer): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return null;
    const marker = buf[p + 1];
    const len = buf.readUInt16BE(p + 2);
    if (marker === 0xe1 && p + 10 <= buf.length && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      return fromTiff(buf.subarray(p + 10, Math.min(buf.length, p + 2 + len)));
    }
    if (marker === 0xda || len < 2) return null; // image data starts: no EXIF before it
    p += 2 + len;
  }
  return null;
}

function fromTiff(t: Buffer): Buffer | null {
  if (t.length < 8) return null;
  const le = t.toString('latin1', 0, 2) === 'II';
  if (!le && t.toString('latin1', 0, 2) !== 'MM') return null;
  const u16 = (o: number) => (o + 2 <= t.length ? (le ? t.readUInt16LE(o) : t.readUInt16BE(o)) : -1);
  const u32 = (o: number) => (o + 4 <= t.length ? (le ? t.readUInt32LE(o) : t.readUInt32BE(o)) : -1);
  const ifd0 = u32(4);
  const n0 = u16(ifd0);
  if (ifd0 < 0 || n0 < 0) return null;
  const ifd1 = u32(ifd0 + 2 + n0 * 12);
  const n1 = u16(ifd1);
  if (ifd1 <= 0 || n1 < 0) return null;
  let offset = -1;
  let length = -1;
  for (let i = 0; i < n1; i++) {
    const e = ifd1 + 2 + i * 12;
    const tag = u16(e);
    if (tag === 0x0201) offset = u32(e + 8);
    if (tag === 0x0202) length = u32(e + 8);
  }
  if (offset <= 0 || length <= 0 || offset + length > t.length) return null;
  const out = t.subarray(offset, offset + length);
  return out[0] === 0xff && out[1] === 0xd8 ? Buffer.from(out) : null;
}
