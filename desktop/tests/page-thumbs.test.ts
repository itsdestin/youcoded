// Tile pictures for the phone's file chooser: a JPEG's own preview, or a small image itself,
// within a budget (main/pages/page-thumbs.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { addThumbs, exifPreview } from '../src/main/pages/page-thumbs';

const PREVIEW = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);

/** A JPEG whose EXIF block carries PREVIEW in IFD1, followed by `pad` bytes of "image". */
function jpegWithPreview(pad: number): Buffer {
  const tiff = Buffer.alloc(8 + 6 + 2 + 2 * 12 + 4 + PREVIEW.length);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(0, 8); tiff.writeUInt32LE(14, 10); // IFD0: no entries, IFD1 at 14
  tiff.writeUInt16LE(2, 14);
  const at = 14 + 2 + 2 * 12 + 4;
  tiff.writeUInt16LE(0x0201, 16); tiff.writeUInt16LE(4, 18); tiff.writeUInt32LE(1, 20); tiff.writeUInt32LE(at, 24);
  tiff.writeUInt16LE(0x0202, 28); tiff.writeUInt16LE(4, 30); tiff.writeUInt32LE(1, 32); tiff.writeUInt32LE(PREVIEW.length, 36);
  PREVIEW.copy(tiff, at);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(pad, 7)]);
}

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-thumbs-'));
  fs.writeFileSync(path.join(dir, 'big.jpg'), jpegWithPreview(400 * 1024));
  fs.writeFileSync(path.join(dir, 'plain-big.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), Buffer.alloc(400 * 1024)]));
  fs.writeFileSync(path.join(dir, 'small.png'), Buffer.from('tiny-png'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

describe('the picture on a tile', () => {
  it('reads a JPEG’s own preview', () => {
    expect(exifPreview(jpegWithPreview(10))).toEqual(PREVIEW);
  });

  it('gives up safely on bytes that are not a JPEG, or lie about their offsets', () => {
    expect(exifPreview(Buffer.from('not a jpeg'))).toBeNull();
    const broken = jpegWithPreview(10);
    broken.writeUInt32LE(0xfffffff0, 12 + 24); // IFD1's preview offset (TIFF starts at byte 12), far past the end
    expect(exifPreview(broken)).toBeNull();
  });

  it('fills small images and embedded previews only', async () => {
    const entries = ['big.jpg', 'plain-big.jpg', 'small.png', 'notes.txt'].map((name) => ({ name, kind: 'file' as const, size: fs.statSync(path.join(dir, name)).size, thumb: undefined as string | undefined }));
    await addThumbs(dir, entries);
    const by = Object.fromEntries(entries.map((e) => [e.name, e.thumb]));
    expect(by['big.jpg']).toBe(`data:image/jpeg;base64,${PREVIEW.toString('base64')}`);
    expect(by['small.png']).toMatch(/^data:image\/png;base64,/);
    expect(by['plain-big.jpg']).toBeUndefined();
    expect(by['notes.txt']).toBeUndefined();
  });
});
