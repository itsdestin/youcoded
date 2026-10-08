import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { runResizeJob, boxDownscale, decodeImage } from '../src/main/image-resize-worker';
import { createResizeService, type WorkerLike } from '../src/main/image-resize-service';
import { ImagePreparer } from '../src/main/harness/image-prepare';
import { imageDimensions } from '../src/main/harness/image-support';
import { IMAGE_LIMITS_DEFAULT } from '../src/main/harness/capability-profile';
import { writeRealPng, webpVp8Header, pngHeader } from './helpers/image-fixtures';

/** Writing, decoding, box-filtering and re-encoding an 18-MP PNG in pure JS.
 *  WHY 15 s: 3× measured wall time, floored at 15 s. The built worker resized the
 *  larger 51-MP incident size (2904×17528 → 1221×7372) in 1.87 s flat / 3.11 s
 *  noise (2026-10-07, Linux); 3 × 3.11 s = 9.3 s, so the floor wins and still
 *  covers this smaller fixture on a slower Windows CI runner. */
const REAL_PNG_BUDGET_MS = 15_000;

describe('boxDownscale averages the source block of every destination pixel, channel by channel', () => {
  it('a 2×2 → 1×1 averages the four pixels', () => {
    const src = new Uint8Array([0, 0, 0, 255, 100, 0, 0, 255, 0, 200, 0, 255, 0, 0, 40, 255]);
    expect(Array.from(boxDownscale(src, 2, 2, 1, 1))).toEqual([25, 50, 10, 255]);
  });
  it('keeps every pixel when asked for the same size', () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Array.from(boxDownscale(src, 2, 1, 2, 1))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('runResizeJob (the worker body) decodes, shrinks and encodes real pictures', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgresize-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

  it('end to end: a 3000×6000 PNG becomes a 1843×3686 PNG derivative; the original is byte-identical afterwards', async () => {
    const p = path.join(dir, 'tall.png');
    writeRealPng(p, 3000, 6000);
    const before = fs.readFileSync(p);
    const prep = new ImagePreparer(path.join(dir, 'cache'), async (req) => {
      const reply = runResizeJob({ bytes: req.bytes, width: req.width, height: req.height, format: req.format });
      return reply.ok ? { ok: true, bytes: Buffer.from(reply.bytes) } : reply;
    });
    const r = await prep.prepare(p, IMAGE_LIMITS_DEFAULT);   // 3000×6000 is over 4096 on the long edge
    expect(r.kind).toBe('prepared');
    if (r.kind !== 'prepared') return;
    expect({ width: r.preparedWidth, height: r.preparedHeight }).toEqual({ width: 1843, height: 3686 });
    expect(imageDimensions(fs.readFileSync(r.path))).toEqual({ width: 1843, height: 3686 });
    expect(PNG.sync.read(fs.readFileSync(r.path)).width).toBe(1843);
    expect(fs.readFileSync(p)).toEqual(before);
  }, REAL_PNG_BUDGET_MS);

  it('JPEG in, JPEG out at the requested size', () => {
    const png = new PNG({ width: 64, height: 32 }); png.data.fill(90);
    const first = runResizeJob({ bytes: new Uint8Array(PNG.sync.write(png)), width: 64, height: 32, format: 'jpeg' });
    if (!first.ok) throw new Error(first.reason);
    expect(decodeImage(Buffer.from(first.bytes))).toMatchObject({ width: 64, height: 32 });
    const out = runResizeJob({ bytes: first.bytes, width: 16, height: 8, format: 'jpeg' });
    if (!out.ok) throw new Error(out.reason);
    expect(imageDimensions(Buffer.from(out.bytes))).toEqual({ width: 16, height: 8 });
  });

  it('GIF/WebP/junk are reported undecodable from their first bytes, never a throw', () => {
    expect(runResizeJob({ bytes: new Uint8Array(Buffer.from('GIF89a\x10\x00\x10\x00', 'latin1')), width: 8, height: 8, format: 'png' })).toEqual({ ok: false, reason: 'undecodable' });
    expect(runResizeJob({ bytes: new Uint8Array(webpVp8Header(64, 64)), width: 8, height: 8, format: 'png' })).toEqual({ ok: false, reason: 'undecodable' });
    expect(runResizeJob({ bytes: new Uint8Array([1, 2, 3]), width: 8, height: 8, format: 'png' })).toEqual({ ok: false, reason: 'undecodable' });
  });

  it('a PNG or JPEG whose decode throws (corrupt data, the JPEG memory cap) is a failed shrink, not an undecodable format', () => {
    const truncatedPng = Buffer.concat([pngHeader(64, 64), Buffer.from('not an IDAT')]);
    expect(runResizeJob({ bytes: new Uint8Array(truncatedPng), width: 8, height: 8, format: 'png' })).toEqual({ ok: false, reason: 'failed' });
    const memoryCap = () => { throw new Error('maxMemoryUsageInMB limit exceeded by at least 1MB'); };
    const jpegMagic = new Uint8Array([0xff, 0xd8, 0xff, 0xc0]);
    expect(runResizeJob({ bytes: jpegMagic, width: 8, height: 8, format: 'jpeg' }, memoryCap)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('createResizeService runs one worker per job, terminates it after, and names why a job failed', () => {
  function fakeWorker() {
    const handlers: Record<string, Function[]> = { message: [], error: [], exit: [] };
    const w = {
      terminated: 0,
      on: (ev: string, cb: Function) => { handlers[ev].push(cb); },
      terminate: async () => { w.terminated++; },
      emit: (ev: string, ...a: any[]) => handlers[ev].forEach(h => h(...a)),
    };
    return w as typeof w & WorkerLike;
  }
  it('spawns per job, resolves the reply bytes, terminates the worker', async () => {
    const workers: ReturnType<typeof fakeWorker>[] = [];
    const svc = createResizeService({ spawn: () => { const w = fakeWorker(); workers.push(w); return w; } });
    const p = svc.resize({ bytes: Buffer.from('in'), width: 1, height: 2, format: 'png' });
    expect(workers).toHaveLength(1);
    workers[0].emit('message', { ok: true, bytes: new Uint8Array([1, 2]) });
    expect(await p).toEqual({ ok: true, bytes: Buffer.from([1, 2]) });
    expect(workers[0].terminated).toBe(1);
    const q = svc.resize({ bytes: Buffer.from('in'), width: 1, height: 2, format: 'png' });
    expect(workers).toHaveLength(2);
    workers[1].emit('message', { ok: false, reason: 'undecodable' });
    expect(await q).toEqual({ ok: false, reason: 'undecodable' });
  });
  it('a worker that reports a failed shrink resolves failed', async () => {
    const w = fakeWorker();
    const svc = createResizeService({ spawn: () => w });
    const p = svc.resize({ bytes: Buffer.from('in'), width: 1, height: 1, format: 'png' });
    w.emit('message', { ok: false, reason: 'failed' });
    expect(await p).toEqual({ ok: false, reason: 'failed' });
  });
  it('a worker that errors or exits mid-job resolves failed, never undecodable', async () => {
    const w = fakeWorker();
    const svc = createResizeService({ spawn: () => w });
    const p = svc.resize({ bytes: Buffer.from('in'), width: 1, height: 1, format: 'png' });
    w.emit('error', new Error('boom'));
    expect(await p).toEqual({ ok: false, reason: 'failed' });
    const x = fakeWorker();
    const q = createResizeService({ spawn: () => x }).resize({ bytes: Buffer.from('in'), width: 1, height: 1, format: 'png' });
    x.emit('exit', 1);
    expect(await q).toEqual({ ok: false, reason: 'failed' });
  });
  it('a job over its time limit resolves timeout with the limit and the worker is terminated', async () => {
    vi.useFakeTimers();
    const w = fakeWorker();
    const svc = createResizeService({ spawn: () => w, jobTimeoutMs: 500 });
    const p = svc.resize({ bytes: Buffer.from('in'), width: 1, height: 1, format: 'png' });
    vi.advanceTimersByTime(501);
    expect(await p).toEqual({ ok: false, reason: 'timeout', afterMs: 500 });
    expect(w.terminated).toBe(1);
    vi.useRealTimers();
  });
});
