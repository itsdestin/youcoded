// Shrink-once preparation of pictures over a provider's limits (2026-10-07).
//
// WHY a cached FILE, not a request-time transform: every resume path re-reads
// pictures BY PATH and the private checkpoint fingerprints the bytes the model
// saw. A derivative that is a real file, promised under its own path, needs
// none of them to know it exists. The original is never modified.
// WHY only when the limits fail: an in-budget picture is sent as-is — nothing
// is ever downscaled "just in case", so a 4096² screenshot on OpenAI keeps
// every pixel. The target is the LARGEST size under both limits with a 10%
// margin, aspect preserved, never enlarged.
// WHY pure + injected resize: decoding runs in a worker thread
// (image-resize-service.ts); this module only decides and stores.
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { imageDimensions, withinImageLimits, patchCount, IMAGE_PATCH_PX, MAX_ATTACHMENT_BYTES } from './image-support';
import type { ImageLimits } from './capability-profile';

/** Decoded pixels we are willing to hold at once: pngjs keeps width×height×4
 *  bytes (320 MB at this bound) in the worker. The 2026-10-06 incident image
 *  was 50.9 MP and must prepare; anything larger is declined with a hint. */
export const MAX_DECODE_PIXELS = 80_000_000;
// WHY not exported (these three): only this file reads them; exporting them added
// unused exports to knip's ratchet. Tests reach them through prepareTarget/prepare.
/** Enough to reach a JPEG SOF past large EXIF/ICC segments; PNG/GIF/WebP need
 *  under 64 bytes. */
const HEADER_READ_BYTES = 256 * 1024;
/** Provider limits are "at most": aim 10% under both so rounding, "after
 *  processing" and an off-by-one tile can never push a prepared picture over. */
const PREPARE_MARGIN = 0.9;

type ResizeFormat = 'png' | 'jpeg';
/** WHY a discriminated result (not Buffer | null): one null used to stand for
 *  "not PNG/JPEG", "the worker crashed" and "it timed out" alike, and the refusal
 *  blamed the decoder for all three. Each reason now gets its own wording. */
export type ResizeResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'undecodable' | 'failed' }
  | { ok: false; reason: 'timeout'; afterMs: number };
export type ResizeFn = (req: { bytes: Buffer; width: number; height: number; format: ResizeFormat }) => Promise<ResizeResult>;

export type PreparedImage =
  | { kind: 'unchanged'; width?: number; height?: number }
  | { kind: 'prepared'; path: string; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number; preparedWidth: number; preparedHeight: number }
  | { kind: 'refused'; reason: string; width?: number; height?: number };

export interface ImagePreparerLike {
  prepare(absPath: string, limits: ImageLimits): Promise<PreparedImage>;
  /** Sync, IO-free: the derivative the LAST prepare() produced for `absPath`,
   *  if it produced one. The send path reads it; it must not await. */
  preparedPathFor(absPath: string): string | null;
}

/** null = fits (leave it alone) OR no size can meet the limits; the caller
 *  tells them apart with withinImageLimits. Otherwise the largest floor-scaled
 *  size whose long edge and rounded-up patch count both sit under
 *  limits×margin. The area estimate can land a tile over (ceil per axis), so
 *  step down 1% until it fits — two steps at most in practice; 64 is a hard
 *  stop. WHY null after the hard stop: an unchecked last guess could still
 *  break the limits and be sent; refusing is the honest outcome. */
export function prepareTarget(width: number, height: number, limits: ImageLimits, margin = PREPARE_MARGIN): { width: number; height: number } | null {
  if (withinImageLimits({ width, height }, limits)) return null;
  const edgeCap = limits.maxEdgePx * margin;
  const patchCap = limits.maxPatches * margin;
  let scale = Math.min(1, edgeCap / Math.max(width, height), Math.sqrt((patchCap * IMAGE_PATCH_PX * IMAGE_PATCH_PX) / (width * height)));
  for (let i = 0; i < 64; i++) {
    const target = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
    if (Math.max(target.width, target.height) <= edgeCap && patchCount(target.width, target.height) <= patchCap) return target;
    scale *= 0.99;
  }
  return null;
}

/** `<16 hex>-<original basename>.<ext>`: the hash keys the cache (path, size,
 *  mtime AND target — a different provider's limits give a different file);
 *  the basename is for a human browsing the cache folder. The MODEL-facing
 *  label is never derived from this file name: Read passes the original
 *  basename explicitly (ToolResultPayload.imageLabels), so a shrunk contact.png
 *  is still called contact.png on the wire, on reopen and in the checkpoint. */
export function derivativeName(absPath: string, size: number, mtimeMs: number, target: { width: number; height: number }, ext: 'png' | 'jpg'): string {
  const key = createHash('sha1').update(`${absPath}|${size}|${Math.floor(mtimeMs)}|${target.width}x${target.height}`).digest('hex').slice(0, 16);
  return `${key}-${path.basename(absPath, path.extname(absPath))}.${ext}`;
}

async function readHeader(absPath: string): Promise<Buffer> {
  const fh = await fs.promises.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_READ_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

export class ImagePreparer implements ImagePreparerLike {
  private readonly prepared = new Map<string, string>();
  /** One job per (path, limits) at a time: concurrent callers share it. */
  private readonly inFlight = new Map<string, Promise<PreparedImage>>();
  /** One resize at a time overall: two 50-MP decodes side by side would double
   *  peak memory for no latency win. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly cacheDir: string, private readonly resize: ResizeFn) {}

  preparedPathFor(absPath: string): string | null { return this.prepared.get(absPath) ?? null; }

  prepare(absPath: string, limits: ImageLimits): Promise<PreparedImage> {
    const key = `${absPath}|${limits.maxEdgePx}|${limits.maxPatches}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    // WHY never throw: Read awaits this; a thrown IO error would surface as a
    // generic "Read failed" instead of the named refusal the standard asks for.
    const job = this.prepareUnguarded(absPath, limits)
      .catch((err: any): PreparedImage => ({ kind: 'refused', reason: `could not be prepared for the model (${err?.code ?? err?.message ?? 'unknown error'})` }))
      .then((result) => {
        // Stale-map rule: only a 'prepared' result may vouch for a derivative.
        if (result.kind === 'prepared') this.prepared.set(absPath, result.path); else this.prepared.delete(absPath);
        return result;
      })
      .finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, job);
    return job;
  }

  private async prepareUnguarded(absPath: string, limits: ImageLimits): Promise<PreparedImage> {
    const st = await fs.promises.stat(absPath);
    const dims = imageDimensions(await readHeader(absPath));
    if (!dims) return { kind: 'unchanged' };   // unmeasurable: not this module's class; the reader/provider decide
    if (dims.width * dims.height > MAX_DECODE_PIXELS) {
      return { kind: 'refused', ...dims, reason: `is ${dims.width}×${dims.height} px — too large to downscale for the model (over ${MAX_DECODE_PIXELS / 1_000_000} megapixels). Crop or shrink it with Bash (e.g. magick in.png -resize 4000x4000 out.png) and Read the copy.` };
    }
    if (withinImageLimits(dims, limits)) return { kind: 'unchanged', ...dims };
    const target = prepareTarget(dims.width, dims.height, limits);
    // WHY refused, not unchanged: over the limits and no size fits them, so
    // sending the original would only fail again at the provider.
    if (!target) {
      return { kind: 'refused', ...dims, reason: `is ${dims.width}×${dims.height} px — too large to downscale for the model (no size fits this provider's picture limits). Crop it with Bash and Read the copy.` };
    }
    const file = (ext: 'png' | 'jpg') => path.join(this.cacheDir, derivativeName(absPath, st.size, st.mtimeMs, target, ext));
    const done = (p: string, mediaType: 'image/png' | 'image/jpeg'): PreparedImage =>
      ({ kind: 'prepared', path: p, mediaType, ...dims, preparedWidth: target.width, preparedHeight: target.height });
    for (const [p, mediaType] of [[file('png'), 'image/png'], [file('jpg'), 'image/jpeg']] as const) {
      try { await fs.promises.access(p); return done(p, mediaType); } catch { /* not cached yet */ }
    }
    const run = this.chain.then(async (): Promise<PreparedImage> => {
      const bytes = await fs.promises.readFile(absPath);
      let res = await this.resize({ bytes, width: target.width, height: target.height, format: 'png' });
      let p = file('png'); let mediaType: 'image/png' | 'image/jpeg' = 'image/png';
      // WHY JPEG second: screenshots are text; PNG keeps it crisp. Only a PNG
      // that still breaks the byte cap trades sharpness for size.
      if (res.ok && res.bytes.length > MAX_ATTACHMENT_BYTES) { res = await this.resize({ bytes, width: target.width, height: target.height, format: 'jpeg' }); p = file('jpg'); mediaType = 'image/jpeg'; }
      // WHY three wordings (error-message-standards: never invent a cause): only
      // the worker's own format check may blame the decoder; a slow job and a
      // crashed one say exactly that, and neither suggests converting the file.
      if (!res.ok) {
        const size = `is ${dims.width}×${dims.height} px and`;
        if (res.reason === 'undecodable') {
          return { kind: 'refused', ...dims, reason: `${size} could not be downscaled for the model (the image decoder could not read it — only PNG and JPEG can be shrunk here). Convert or shrink it with Bash (e.g. magick in.gif[0] -resize 4000x4000 out.png) and Read the copy.` };
        }
        if (res.reason === 'timeout') {
          return { kind: 'refused', ...dims, reason: `${size} could not be downscaled for the model (shrinking it took longer than ${Math.round(res.afterMs / 1000)} s on this computer). Crop it or save a smaller copy with Bash and Read that.` };
        }
        return { kind: 'refused', ...dims, reason: `${size} could not be downscaled for the model (the shrinking step failed). Crop it or save a smaller copy with Bash and Read that.` };
      }
      const out = res.bytes;
      // WHY a separate detail: here the decoder WORKED and even the JPEG is too
      // big; blaming the decoder would invent a cause (error-message-standards).
      if (out.length > MAX_ATTACHMENT_BYTES) {
        return { kind: 'refused', ...dims, reason: `is ${dims.width}×${dims.height} px and still over ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB after shrinking; crop it or save a smaller copy with Bash and Read that.` };
      }
      await fs.promises.mkdir(this.cacheDir, { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, out);
      await fs.promises.rename(tmp, p);   // atomic: a crash never leaves a half-written derivative under the final name
      return done(p, mediaType);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
