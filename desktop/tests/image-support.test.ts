import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deliverableImageMediaType, UNDELIVERABLE_IMAGE_EXTENSIONS, readImageFromDisk,
  imageDimensions, patchCount, withinImageLimits, imageNote, parseImageNote, IMAGE_PATCH_PX, type ImageNote,
} from '../src/main/harness/image-support';
import { IMAGE_LIMITS_OPENAI } from '../src/main/harness/capability-profile';
import { pngHeader, jpegHeader, gifHeader, webpVp8Header, webpVp8lHeader, webpVp8xHeader } from './helpers/image-fixtures';

describe('image-support', () => {
  // Fix 5 (2026-08-11 review): the two mkdtempSync calls below never cleaned
  // up, leaking a dir into os.tmpdir() on every run — same defect
  // harness-session-loop.test.ts fixed for its own mkTmpDir helper. Track
  // every dir created via mkTmpDir() and sweep it after each test, whether it
  // passed or threw.
  const tmpDirs: string[] = [];
  function mkTmpDir(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }
  afterEach(() => {
    // WHY maxRetries: a late write makes a bare rmSync throw ENOTEMPTY into a
    // passing test (test-suite-hygiene rule).
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  });

  it('maps deliverable extensions and rejects the rest', () => {
    expect(deliverableImageMediaType('/a/shot.PNG')).toBe('image/png');
    expect(deliverableImageMediaType('/a/pic.jpeg')).toBe('image/jpeg');
    expect(deliverableImageMediaType('/a/anim.webp')).toBe('image/webp');
    expect(deliverableImageMediaType('/a/notes.txt')).toBeNull();
    // An image format we CANNOT deliver must never be "deliverable" — the
    // old split table promised these and silently delivered nothing.
    expect(deliverableImageMediaType('/a/logo.svg')).toBeNull();
    expect(UNDELIVERABLE_IMAGE_EXTENSIONS.has('.svg')).toBe(true);
    expect(UNDELIVERABLE_IMAGE_EXTENSIONS.has('.bmp')).toBe(true);
    expect(UNDELIVERABLE_IMAGE_EXTENSIONS.has('.avif')).toBe(true);
  });

  it('readImageFromDisk reads a real file and says why on missing/undeliverable', () => {
    const p = path.join(mkTmpDir('imgsup-'), 'x.png');
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(readImageFromDisk(p)).toEqual({ ok: true, mediaType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    expect(readImageFromDisk(path.join(path.dirname(p), 'gone.png'))).toEqual({ ok: false, reason: 'missing' });
    expect(readImageFromDisk(p.replace('.png', '.svg'))).toEqual({ ok: false, reason: 'undeliverable' });
  });

  // MAX_ATTACHMENT_BYTES cap: four later tasks rely on oversized attachments
  // being rejected here rather than silently forwarded to the model.
  it('readImageFromDisk refuses a deliverable image over MAX_ATTACHMENT_BYTES', () => {
    const p = path.join(mkTmpDir('imgsup-'), 'big.png');
    fs.writeFileSync(p, Buffer.alloc(11 * 1024 * 1024));
    expect(readImageFromDisk(p)).toEqual({ ok: false, reason: 'too-many-bytes' });
  });

  describe('imageDimensions reads the header of every deliverable format', () => {
    it('PNG', () => expect(imageDimensions(pngHeader(2904, 17528))).toEqual({ width: 2904, height: 17528 }));
    it('JPEG, with SOF past leading APP segments', () => {
      expect(imageDimensions(jpegHeader(640, 480))).toEqual({ width: 640, height: 480 });
      expect(imageDimensions(jpegHeader(640, 480, 3))).toEqual({ width: 640, height: 480 });
    });
    it('GIF', () => expect(imageDimensions(gifHeader(320, 200))).toEqual({ width: 320, height: 200 }));
    it('WebP VP8 / VP8L / VP8X', () => {
      expect(imageDimensions(webpVp8Header(1000, 700))).toEqual({ width: 1000, height: 700 });
      expect(imageDimensions(webpVp8lHeader(1000, 700))).toEqual({ width: 1000, height: 700 });
      expect(imageDimensions(webpVp8xHeader(5000, 3000))).toEqual({ width: 5000, height: 3000 });
    });
    it('returns null for junk and truncated input — never throws', () => {
      expect(imageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
      expect(imageDimensions(Buffer.from('hello'))).toBeNull();
      expect(imageDimensions(Buffer.alloc(0))).toBeNull();
    });
  });

  describe('patch budget and the note family', () => {
    it('rounds UP per axis — the real contact sheet is 49,868 patches', () => {
      expect(IMAGE_PATCH_PX).toBe(32);
      expect(patchCount(2904, 17528)).toBe(49_868);
      expect(patchCount(32, 32)).toBe(1);
      expect(patchCount(33, 33)).toBe(4);
    });
    it('withinImageLimits checks both the edge and the patch product', () => {
      expect(withinImageLimits({ width: 2904, height: 17528 }, IMAGE_LIMITS_OPENAI)).toBe(false);
      expect(withinImageLimits({ width: 9000, height: 10 }, IMAGE_LIMITS_OPENAI)).toBe(false);
      expect(withinImageLimits({ width: 4096, height: 4096 }, IMAGE_LIMITS_OPENAI)).toBe(true);
    });
    it('every note is one line the store can parse back exactly', () => {
      const notes: ImageNote[] = [
        { kind: 'oversized', label: 'contact.png', width: 2904, height: 17528 },
        { kind: 'unavailable', label: 'a b.png', reason: 'missing' },
        { kind: 'unavailable', label: 'x.png', reason: 'too-many-bytes' },
        { kind: 'unavailable', label: 'x.svg', reason: 'undeliverable' },
        { kind: 'unavailable', label: 'x.gif', reason: 'prepare-failed' },
        { kind: 'unavailable', label: 'x.gif', reason: 'prepare-failed', detail: 'is 5000×5000 px and could not be downscaled for the model (the image decoder could not read it — only PNG and JPEG can be shrunk here)' },
        { kind: 'downscaled', label: 'contact.png', width: 2904, height: 17528, shownWidth: 1221, shownHeight: 7372 },
      ];
      for (const n of notes) expect(parseImageNote(imageNote(n))).toEqual(n);
      expect(imageNote(notes[0])).toBe("[image not attached: contact.png is 2904×17528 px, above this model's image size limit]");
      expect(imageNote(notes.at(-1)!)).toBe('[image downscaled: contact.png was 2904×17528 px, shown at 1221×7372 px (42%); small text may be unreadable]');
      expect(parseImageNote('[image no longer available: /tmp/x.png]')).toBeNull();
      expect(parseImageNote(imageNote(notes[0]) + ' trailing')).toBeNull();
    });
  });

  describe('readImageFromDisk is gated by the header, never by file bytes alone', () => {
    it('a 70-byte PNG that CLAIMS 2904×17528 is refused with its dimensions', () => {
      const p = path.join(mkTmpDir('imgsup-'), 'huge.png');
      fs.writeFileSync(p, Buffer.concat([pngHeader(2904, 17528), Buffer.alloc(37)]));
      expect(readImageFromDisk(p, IMAGE_LIMITS_OPENAI)).toEqual({ ok: false, reason: 'oversized', width: 2904, height: 17528 });
      expect(readImageFromDisk(p).ok).toBe(true);   // no limits (legacy/pure callers): the GATE is the caller's limits
    });
    it('a fitting image is delivered with its dimensions; unparseable headers pass through unmeasured', () => {
      const d = mkTmpDir('imgsup-');
      const ok = path.join(d, 'ok.png'); fs.writeFileSync(ok, pngHeader(640, 480));
      expect(readImageFromDisk(ok, IMAGE_LIMITS_OPENAI)).toEqual({ ok: true, mediaType: 'image/png', data: pngHeader(640, 480), width: 640, height: 480 });
      const junk = path.join(d, 'junk.png'); fs.writeFileSync(junk, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(readImageFromDisk(junk, IMAGE_LIMITS_OPENAI)).toEqual({ ok: true, mediaType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    });
  });
});
