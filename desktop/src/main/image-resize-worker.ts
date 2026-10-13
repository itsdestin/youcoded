// The picture-shrinking program (2026-10-07). Run by image-resize-service.ts
// as a Node worker_threads Worker, one per job, so a 50-megapixel decode never
// runs on the main thread (performance rule 1) and its memory is released when
// the thread ends. Pure JS on purpose: Electron's nativeImage is NOT available
// off the main/renderer threads (electron.d.ts `namespace Utility` exports only
// net, parentPort, systemPreferences), and a native image library would add an
// install script. pngjs and jpeg-js have none, so allowScripts stays untouched.
// Self-contained (no project imports) so the compiled file runs standalone.
import { parentPort, workerData, isMainThread } from 'worker_threads';
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';

export interface ResizeJob { bytes: Uint8Array; width: number; height: number; format: 'png' | 'jpeg' }
export interface Decoded { data: Uint8Array; width: number; height: number }
/** What the worker posts back. WHY two failure reasons (not one null): the
 *  preparer words them differently, and saying "the decoder could not read it"
 *  about a PNG that ran out of memory would invent a cause
 *  (error-message-standards). `undecodable` = not PNG/JPEG at all (GIF, WebP,
 *  junk), decided from the magic bytes BEFORE any decode; `failed` = a PNG/JPEG
 *  whose decode or encode threw (corrupt data, jpeg-js's memory cap). */
export type ResizeReply = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'undecodable' | 'failed' };

/** PNG or JPEG → RGBA. Anything else (GIF, WebP, junk) is null: those formats
 *  are declined upstream with a convert hint rather than guessed at. A PNG/JPEG
 *  that fails to decode THROWS — runResizeJob reports that as `failed`, not as
 *  an unreadable format. The 80 MP guard is enforced by the caller before
 *  dispatch; jpeg-js gets it again as a belt-and-braces option. */
export function decodeImage(bytes: Buffer): Decoded | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) {
    const png = PNG.sync.read(bytes);
    return { data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength), width: png.width, height: png.height };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // WHY its memory cap throws through: hitting maxMemoryUsageInMB means the
    // JPEG was readable but too big to hold — a `failed` shrink, not `undecodable`.
    const out = jpeg.decode(bytes, { useTArray: true, maxResolutionInMP: 80, maxMemoryUsageInMB: 512 });
    return { data: out.data, width: out.width, height: out.height };
  }
  return null;
}

/** Area-average (box) downscale over RGBA. Each destination pixel is the mean
 *  of the source block it covers — the right filter for shrinking screenshots
 *  (no ringing, thin text stays legible for as long as any filter keeps it). */
export function boxDownscale(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) { r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++; }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return out;
}

// WHY not exported (the plan listed it as an export): only runResizeJob calls
// it, and knip's ratchet fails on a new unused export.
function encodeImage(rgba: Uint8Array, w: number, h: number, format: 'png' | 'jpeg'): Buffer {
  if (format === 'png') {
    const png = new PNG({ width: w, height: h });
    png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    return PNG.sync.write(png);
  }
  return jpeg.encode({ data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width: w, height: h }, 85).data;
}

/** The whole job, in one call — exported so tests run it in-process. Never
 *  throws: every failure is a typed reply (see ResizeReply for the split). */
export function runResizeJob(job: ResizeJob, decoder: typeof decodeImage = decodeImage): ResizeReply {
  try {
    const decoded = decoder(Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength));
    if (!decoded) return { ok: false, reason: 'undecodable' };
    const rgba = decoded.width === job.width && decoded.height === job.height ? decoded.data : boxDownscale(decoded.data, decoded.width, decoded.height, job.width, job.height);
    const out = encodeImage(rgba, job.width, job.height, job.format);
    return { ok: true, bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

if (!isMainThread && parentPort) {
  const out = runResizeJob(workerData as ResizeJob);
  // The smoke run reads this line back. NOTE: process.memoryUsage().rss is the
  // WHOLE process's RSS (main thread + every worker), not this thread's share.
  if (process.env.YOUCODED_RESIZE_SMOKE) console.error(`resize-worker rss=${Math.round(process.memoryUsage().rss / 1048576)} MB`);
  parentPort.postMessage(out);
}
