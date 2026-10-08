// Header-only image fixtures: a few dozen bytes that CLAIM a size, so tests can
// prove the gate judges pixels, not file bytes. writeRealPng is the one real
// encoder, for the resize path.
import * as fs from 'fs';
import { PNG } from 'pngjs';

/** PNG signature + IHDR claiming w×h — 33 bytes, no pixels. */
export function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
/** SOI, `leadingSegments` 102-byte APP1 segments, then SOF0 — SOF must be found past them. */
export function jpegHeader(w: number, h: number, leadingSegments = 0): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (let i = 0; i < leadingSegments; i++) { const seg = Buffer.alloc(102); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(100, 2); parts.push(seg); }
  parts.push(Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]));
  return Buffer.concat(parts);
}
export function gifHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(13); b.write('GIF89a', 0); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b;
}
export function webpVp8Header(w: number, h: number): Buffer {
  const b = Buffer.alloc(30); b.write('RIFF', 0); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write('VP8 ', 12); b.writeUInt32LE(10, 16);
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28); return b;
}
export function webpVp8lHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(30); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8L', 12); b[20] = 0x2f;
  b.writeUInt32LE(((h - 1) << 14) | (w - 1), 21); return b;
}
export function webpVp8xHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(30); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b;
}
/** A real, decodable PNG (diagonal gradient) — the only fixture with pixels. */
export function writeRealPng(file: string, w: number, h: number): void {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    png.data[i] = (x * 255) / w; png.data[i + 1] = (y * 255) / h; png.data[i + 2] = 128; png.data[i + 3] = 255;
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}
/** The bytes of a file part as the PROVIDER received it. The SDK hands a mock
 *  model `{ type: 'data', data }`; base64 strings and raw bytes are accepted
 *  too, so the assertion does not depend on which form a version chooses. */
export function providerFileBytes(part: { data: unknown }): Buffer {
  const d: any = part.data && typeof part.data === 'object' && 'type' in (part.data as object) ? (part.data as any).data : part.data;
  return typeof d === 'string' ? Buffer.from(d, 'base64') : Buffer.from(d);
}
