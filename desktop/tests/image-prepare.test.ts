import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImagePreparer, prepareTarget, derivativeName, MAX_DECODE_PIXELS, type ResizeFn } from '../src/main/harness/image-prepare';
import { IMAGE_LIMITS_OPENAI, IMAGE_LIMITS_DEFAULT } from '../src/main/harness/capability-profile';
import { patchCount } from '../src/main/harness/image-support';
import { pngHeader, gifHeader } from './helpers/image-fixtures';

describe('prepareTarget shrinks only when the limits fail, to the largest size under both with a 10% margin', () => {
  it('leaves an in-budget picture alone, even a big one', () => {
    expect(prepareTarget(4096, 4096, IMAGE_LIMITS_OPENAI)).toBeNull();
    expect(prepareTarget(2048, 2048, IMAGE_LIMITS_DEFAULT)).toBeNull();
  });
  it('the contact sheet: edge-bound on OpenAI, 1221×7372', () => {
    expect(prepareTarget(2904, 17528, IMAGE_LIMITS_OPENAI)).toEqual({ width: 1221, height: 7372 });
    expect(patchCount(1221, 7372)).toBe(9_009);
  });
  it('the contact sheet on the conservative default: 610×3686', () => {
    expect(prepareTarget(2904, 17528, IMAGE_LIMITS_DEFAULT)).toEqual({ width: 610, height: 3686 });
  });
  it('a patch-bound square steps down until the rounded-up count fits the margin', () => {
    const t = prepareTarget(6000, 6000, IMAGE_LIMITS_OPENAI)!;
    expect(t).toEqual({ width: 5205, height: 5205 });
    expect(patchCount(t.width, t.height)).toBeLessThanOrEqual(27_000);
  });
  it('never enlarges and never yields a zero edge', () => {
    expect(prepareTarget(100000, 1, IMAGE_LIMITS_OPENAI)).toEqual({ width: 7372, height: 1 });
  });
});

describe('derivativeName is deterministic and keeps the original basename for a human reading the cache', () => {
  it('same inputs → same name; any input change → different name', () => {
    const a = derivativeName('/x/contact.png', 100, 5.9, { width: 1221, height: 7372 }, 'png');
    expect(a).toBe(derivativeName('/x/contact.png', 100, 5.9, { width: 1221, height: 7372 }, 'png'));
    expect(a).toMatch(/^[0-9a-f]{16}-contact\.png$/);
    expect(derivativeName('/x/contact.png', 101, 5.9, { width: 1221, height: 7372 }, 'png')).not.toBe(a);
    expect(derivativeName('/x/contact.png', 100, 5.9, { width: 610, height: 3686 }, 'jpg')).toMatch(/-contact\.jpg$/);
  });
});

describe('ImagePreparer', () => {
  let dir: string; let cache: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgprep-')); cache = path.join(dir, 'cache'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const calls: any[] = [];
  const resize: ResizeFn = async (req) => { calls.push(req); return req.format === 'png' ? Buffer.concat([pngHeader(req.width, req.height), Buffer.from('small')]) : Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 0x11, 8, req.height >> 8, req.height & 255, req.width >> 8, req.width & 255, 3]); };

  it('an in-budget picture is unchanged and the resizer is never called', async () => {
    const p = path.join(dir, 'ok.png'); fs.writeFileSync(p, pngHeader(4000, 4000));
    calls.length = 0;
    expect(await new ImagePreparer(cache, resize).prepare(p, IMAGE_LIMITS_OPENAI)).toEqual({ kind: 'unchanged', width: 4000, height: 4000 });
    expect(calls).toHaveLength(0);
  });

  it('an over-budget picture is shrunk ONCE into a real cached file; the original is untouched; the second call reuses the file', async () => {
    const p = path.join(dir, 'contact.png'); fs.writeFileSync(p, Buffer.concat([pngHeader(2904, 17528), Buffer.alloc(100)]));
    const before = fs.readFileSync(p);
    calls.length = 0;
    const prep = new ImagePreparer(cache, resize);
    const r = await prep.prepare(p, IMAGE_LIMITS_OPENAI);
    expect(r).toMatchObject({ kind: 'prepared', width: 2904, height: 17528, preparedWidth: 1221, preparedHeight: 7372, mediaType: 'image/png' });
    if (r.kind !== 'prepared') return;
    expect(r.path.startsWith(cache)).toBe(true);
    expect(path.basename(r.path)).toMatch(/-contact\.png$/);
    expect(fs.existsSync(r.path)).toBe(true);
    expect(fs.readFileSync(p)).toEqual(before);
    expect(prep.preparedPathFor(p)).toBe(r.path);
    expect(calls).toHaveLength(1);
    expect(await prep.prepare(p, IMAGE_LIMITS_OPENAI)).toEqual(r);
    expect(calls).toHaveLength(1);
  });

  it('the same picture is prepared differently for different limits (two cache files, two names)', async () => {
    const p = path.join(dir, 'contact.png'); fs.writeFileSync(p, pngHeader(2904, 17528));
    const prep = new ImagePreparer(cache, resize);
    const a = await prep.prepare(p, IMAGE_LIMITS_OPENAI);
    const b = await prep.prepare(p, IMAGE_LIMITS_DEFAULT);
    expect(a).toMatchObject({ kind: 'prepared', preparedWidth: 1221 });
    expect(b).toMatchObject({ kind: 'prepared', preparedWidth: 610 });
    if (a.kind === 'prepared' && b.kind === 'prepared') expect(a.path).not.toBe(b.path);
    expect(prep.preparedPathFor(p)).toBe((b as any).path);   // the latest preparation wins
  });

  it('stale entries: an unchanged or refused result forgets any earlier derivative for that path', async () => {
    const p = path.join(dir, 'x.png'); fs.writeFileSync(p, pngHeader(2904, 17528));
    const prep = new ImagePreparer(cache, resize);
    await prep.prepare(p, IMAGE_LIMITS_OPENAI);
    expect(prep.preparedPathFor(p)).toBeTruthy();
    fs.writeFileSync(p, pngHeader(640, 480));
    expect(await prep.prepare(p, IMAGE_LIMITS_OPENAI)).toEqual({ kind: 'unchanged', width: 640, height: 480 });
    expect(prep.preparedPathFor(p)).toBeNull();
    // Refused case: prepare again (prepared), then make the picture exceed the decode bound.
    fs.writeFileSync(p, pngHeader(2904, 17528));
    await prep.prepare(p, IMAGE_LIMITS_OPENAI);
    expect(prep.preparedPathFor(p)).toBeTruthy();
    fs.writeFileSync(p, pngHeader(20000, 20000));
    expect((await prep.prepare(p, IMAGE_LIMITS_OPENAI)).kind).toBe('refused');
    expect(prep.preparedPathFor(p)).toBeNull();
  });

  it('a JPEG fallback still over the byte cap is refused with the size, not a decoder failure', async () => {
    const p = path.join(dir, 'noisy.png'); fs.writeFileSync(p, pngHeader(8000, 8000));
    const fatBoth: ResizeFn = async () => Buffer.alloc(11 * 1024 * 1024);
    const r = await new ImagePreparer(cache, fatBoth).prepare(p, IMAGE_LIMITS_OPENAI);
    expect(r).toMatchObject({ kind: 'refused', width: 8000, height: 8000 });
    if (r.kind === 'refused') { expect(r.reason).toMatch(/still over 10 MB after shrinking/); expect(r.reason).not.toMatch(/decoder/); }
    expect(fs.existsSync(cache) ? fs.readdirSync(cache) : []).toEqual([]);
  });

  it('limits no size can meet are refused as oversized, never sent unchecked', async () => {
    expect(prepareTarget(100, 100, { maxEdgePx: 1, maxPatches: 0 })).toBeNull();
    const p = path.join(dir, 'tiny.png'); fs.writeFileSync(p, pngHeader(100, 100));
    const r = await new ImagePreparer(cache, resize).prepare(p, { maxEdgePx: 1, maxPatches: 0 });
    expect(r).toMatchObject({ kind: 'refused', width: 100, height: 100 });
    if (r.kind === 'refused') expect(r.reason).toMatch(/too large/);
  });

  it('concurrent prepares of one path share one job', async () => {
    const p = path.join(dir, 'c.png'); fs.writeFileSync(p, pngHeader(2904, 17528));
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const gated: ResizeFn = async (req) => { n++; await gate; return pngHeader(req.width, req.height); };
    const prep = new ImagePreparer(cache, gated);
    const a = prep.prepare(p, IMAGE_LIMITS_OPENAI);
    const b = prep.prepare(p, IMAGE_LIMITS_OPENAI);
    release();
    expect(await a).toEqual(await b);
    expect(n).toBe(1);
  });

  it('falls back to JPEG only when the PNG is still over the byte cap', async () => {
    // WHY 8000²: over OpenAI's patch budget (62,500) yet under the 80 MP decode bound — 9000² (81 MP) would be refused before any resize.
    const p = path.join(dir, 'big.png'); fs.writeFileSync(p, Buffer.concat([pngHeader(8000, 8000), Buffer.alloc(10)]));
    const fatPng: ResizeFn = async (req) => req.format === 'png' ? Buffer.alloc(11 * 1024 * 1024) : Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 0x11, 8, 8, 0, 8, 0, 3]);
    const r = await new ImagePreparer(cache, fatPng).prepare(p, IMAGE_LIMITS_OPENAI);
    expect(r.kind).toBe('prepared');
    if (r.kind === 'prepared') { expect(r.mediaType).toBe('image/jpeg'); expect(r.path).toMatch(/\.jpg$/); }
  });

  it('refuses honestly when decode is impossible or the picture is beyond the decode bound — never the original bytes', async () => {
    const p = path.join(dir, 'anim.gif'); fs.writeFileSync(p, gifHeader(5000, 5000));   // 25 MP: under the bound, so only the resizer can refuse
    const cannot: ResizeFn = async () => null;
    // WHY the default limits: 5000² fits OpenAI's (24,649 patches, 5000 px edge) and would come back unchanged; its 5000 px edge breaks the default 4096.
    const r = await new ImagePreparer(cache, cannot).prepare(p, IMAGE_LIMITS_DEFAULT);
    expect(r).toMatchObject({ kind: 'refused', width: 5000, height: 5000 });
    if (r.kind === 'refused') expect(r.reason).toMatch(/could not be downscaled/);
    const q = path.join(dir, 'vast.png'); fs.writeFileSync(q, pngHeader(20000, 20000));
    const v = await new ImagePreparer(cache, resize).prepare(q, IMAGE_LIMITS_OPENAI);
    expect(v).toMatchObject({ kind: 'refused', width: 20000, height: 20000 });
    if (v.kind === 'refused') expect(v.reason).toContain(`${MAX_DECODE_PIXELS / 1_000_000} megapixels`);
    expect(fs.existsSync(cache) ? fs.readdirSync(cache) : []).toEqual([]);
  });

  it('a read error is a refusal, not a throw', async () => {
    const r = await new ImagePreparer(cache, resize).prepare(path.join(dir, 'nope.png'), IMAGE_LIMITS_OPENAI);
    expect(r.kind).toBe('refused');
  });
});
