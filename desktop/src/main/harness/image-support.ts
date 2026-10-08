// The ONE extension table + disk reader for image delivery (spec 2026-08-11).
// #290 shipped two disagreeing tables: Read's IMAGE_EXTENSIONS included
// .bmp/.svg/.avif that imagePartsFor's IMAGE_MEDIA_TYPES could not deliver —
// harmless while the tool only refused images, a silent dead end the moment it
// promises one. Everything image-shaped imports from here now.
import * as fs from 'fs';
import * as path from 'path';
import type { ImageLimits } from './capability-profile';

// Only formats every mainstream vision model accepts (moved verbatim from
// harness-session.ts).
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

// Real image formats we deliberately do NOT deliver (providers reject or
// mis-handle them). Read names these honestly instead of promising them.
export const UNDELIVERABLE_IMAGE_EXTENSIONS = new Set(['.bmp', '.svg', '.avif']);

// Attachments are base64'd into the request, so a huge one is a request-size
// failure AND a token bill. 10 MB is far above any screenshot (moved from
// harness-session.ts).
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Model-initiated fetch budgets (spec "Budgets" — starting numbers, tunable).
// Roo caps 20 MB/task, Cline 8 MiB/request; unlimited is the ecosystem outlier.
export const MAX_IMAGES_PER_TURN = 8;
export const MAX_IMAGE_BYTES_PER_TURN = 20 * 1024 * 1024;

export function deliverableImageMediaType(p: string): string | null {
  return IMAGE_MEDIA_TYPES[path.extname(p).toLowerCase()] ?? null;
}

/** OpenAI bills and limits pictures in 32-px tiles ("patches"); the one
 *  rejection ever captured named exactly ceil(w/32)*ceil(h/32). */
export const IMAGE_PATCH_PX = 32;
export function patchCount(width: number, height: number): number {
  return Math.ceil(width / IMAGE_PATCH_PX) * Math.ceil(height / IMAGE_PATCH_PX);
}
export function withinImageLimits(dims: { width: number; height: number }, limits: ImageLimits): boolean {
  return Math.max(dims.width, dims.height) <= limits.maxEdgePx && patchCount(dims.width, dims.height) <= limits.maxPatches;
}

/** Width/height from the first bytes of a deliverable image, or null. Pure and
 *  total: junk, truncation and unknown layouts yield null, never a throw.
 *  WHY a hand parser instead of decoding: judge a 50-megapixel file without
 *  ever allocating its pixels on the main thread. */
export function imageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 4) === 'GIF8') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') { const bits = buf.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // WHY a segment walk: SOF (the size) usually sits behind EXIF/APPn
    // segments, so skip each by its declared length until a SOF marker.
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null;
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc), which share the range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

// The ONE wording family for a picture the model did not get. Every site —
// live driver, rebuild, portable restore, collapse — labels by BASENAME, so
// live and resumed histories are byte-identical and the accepted-history
// store (which recomputes a note from fields on restore) can describe either.
// parseImageNote must stay the exact inverse of imageNote.
// `downscaled` (a picture the model DID get, but smaller) shares the family so
// the store and the rebuild describe it the same way.
export type ImageNote =
  | { kind: 'oversized'; label: string; width: number; height: number }
  | { kind: 'unavailable'; label: string; reason: 'missing' | 'too-many-bytes' | 'undeliverable' | 'prepare-failed'; detail?: string }
  | { kind: 'downscaled'; label: string; width: number; height: number; shownWidth: number; shownHeight: number };
const UNAVAILABLE_TEXT = {
  'missing': 'could not be read',
  'too-many-bytes': `exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB per-image size limit`,
  'undeliverable': 'is not a deliverable image format',
  'prepare-failed': 'could not be downscaled for the model',
} as const;
export function imageNote(n: ImageNote): string {
  if (n.kind === 'oversized') return `[image not attached: ${n.label} is ${n.width}×${n.height} px, above this model's image size limit]`;
  if (n.kind === 'downscaled') {
    // WHY the percentage is derived, not stored: parse ignores it and the
    // store's recompute check (imageNote(parse(x)) === x) rejects a tampered one.
    const pct = Math.round((100 * Math.max(n.shownWidth / Math.max(1, n.width), n.shownHeight / Math.max(1, n.height))));
    return `[image downscaled: ${n.label} was ${n.width}×${n.height} px, shown at ${n.shownWidth}×${n.shownHeight} px (${pct}%); small text may be unreadable]`;
  }
  // `detail` (prepare-failed only) carries the preparer's own reason so the model
  // learns WHY (unreadable format, too slow, shrink failed, over the decode
  // bound) and what to do.
  const detail = n.reason === 'prepare-failed' && n.detail ? `: ${n.detail}` : '';
  return `[image not attached: ${n.label} ${UNAVAILABLE_TEXT[n.reason]}${detail}]`;
}
const OVERSIZED_RE = /^\[image not attached: (.+) is (\d+)×(\d+) px, above this model's image size limit\]$/;
const PREPARE_FAILED_RE = /^\[image not attached: (.+?) could not be downscaled for the model(?:: (.+))?\]$/;
/** The "[image downscaled: …]" note when the delivered copy really is smaller
 *  than the original on either edge, else null. One helper for the live send
 *  (image-history userAttachmentParts) and the reopen (history-rebuild), so both
 *  write the identical sentence. Labelled by the ORIGINAL's basename. */
export function downscaledNote(original: { path: string; width: number; height: number }, shown: { width?: number; height?: number }): string | null {
  if (shown.width === undefined || shown.height === undefined) return null;
  if (shown.width >= original.width && shown.height >= original.height) return null;
  return imageNote({ kind: 'downscaled', label: path.basename(original.path), width: original.width, height: original.height, shownWidth: shown.width, shownHeight: shown.height });
}
const DOWNSCALED_RE = /^\[image downscaled: (.+) was (\d+)×(\d+) px, shown at (\d+)×(\d+) px \(\d+%\); small text may be unreadable\]$/;
export function parseImageNote(line: string): ImageNote | null {
  const m = OVERSIZED_RE.exec(line);
  if (m) return { kind: 'oversized', label: m[1], width: Number(m[2]), height: Number(m[3]) };
  const d = DOWNSCALED_RE.exec(line);
  if (d) return { kind: 'downscaled', label: d[1], width: Number(d[2]), height: Number(d[3]), shownWidth: Number(d[4]), shownHeight: Number(d[5]) };
  const f = PREPARE_FAILED_RE.exec(line);
  if (f) return { kind: 'unavailable', label: f[1], reason: 'prepare-failed', ...(f[2] !== undefined ? { detail: f[2] } : {}) };
  for (const reason of ['missing', 'too-many-bytes', 'undeliverable'] as const) {
    const suffix = ` ${UNAVAILABLE_TEXT[reason]}]`;
    if (line.startsWith('[image not attached: ') && line.endsWith(suffix)) {
      const label = line.slice('[image not attached: '.length, line.length - suffix.length);
      if (label.length) return { kind: 'unavailable', label, reason };
    }
  }
  return null;
}

export type ImageReadResult =
  | { ok: true; mediaType: string; data: Buffer; width?: number; height?: number }
  | { ok: false; reason: 'undeliverable' | 'missing' | 'too-many-bytes' | 'oversized'; width?: number; height?: number };

/** Bytes+mediaType for a deliverable image, or a refusal (missing, unreadable,
 *  too many bytes, oversized, or not a deliverable format). Never throws,
 *  because every caller (attachment push, tool delivery, resume rebuild)
 *  treats a bad file as a skip-with-note, not a dead turn.
 *  Since 2026-10-07 the result says WHY it declined, and `limits` (the session
 *  profile's imageLimits) turns on the pixel gate — a 6.8 MB, 2904×17528 PNG
 *  was 49,868 patches against 30,000 and poisoned a conversation (2026-10-06).
 *  Dimensions come from the bytes already read; still exactly one stat and one
 *  read (tests/main-blocking-calls.allowlist.json counts them). An unparseable
 *  header passes through unmeasured. */
export function readImageFromDisk(absPath: string, limits?: ImageLimits): ImageReadResult {
  const mediaType = deliverableImageMediaType(absPath);
  if (!mediaType) return { ok: false, reason: 'undeliverable' };
  try {
    const st = fs.statSync(absPath);
    if (st.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'too-many-bytes' };
    const data = fs.readFileSync(absPath);
    const dims = imageDimensions(data);
    if (dims && limits && !withinImageLimits(dims, limits)) return { ok: false, reason: 'oversized', ...dims };
    return { ok: true, mediaType, data, ...(dims ?? {}) };
  } catch { return { ok: false, reason: 'missing' }; }
}
