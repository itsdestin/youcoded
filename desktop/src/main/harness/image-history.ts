// Pure image rewrites over model history, applied by HarnessSession.
// WHY a separate file: harness-session.ts is far over the 1,500-line default and
// held by a line-budget ratchet; these two functions need no session state (the
// session passes its history and its provider's limits), so they live beside
// the reader they share a note format with instead of growing the session.
import * as path from 'path';
import type { ModelMessage } from 'ai';
import type { ImageLimits } from './capability-profile';
import type { ModelAttachment, UserPart } from './busy-message-boundary';
import { readImageFromDisk, deliverableImageMediaType, imageNote, downscaledNote, UNDELIVERABLE_IMAGE_EXTENSIONS, imageDimensions, withinImageLimits, patchCount } from './image-support';

/** Rewrite history so no image part exceeds `limits`: a tool-result file part
 *  becomes the shared oversized note appended to that result's text (fitting
 *  siblings stay; text first, files, then notes); a user-message file part
 *  becomes a trailing note text part. Same length, same order, same tool
 *  pairing. Labels are BASENAMES (a user part has no name → 'image').
 *  Returns null when nothing was over the limits.
 *  WHY null for a no-op (identity-preserving): like commitPrune, the caller must
 *  not swap the array, bump the capture revision or clear shownImages — that
 *  would invalidate a published checkpoint for a history that never moved.
 *  Untouched messages keep their object identity in the returned array. */
export function collapseOversizedImageParts(history: ModelMessage[], limits: ImageLimits): ModelMessage[] | null {
  return collapseImageParts(history, (_part, buf) => {
    if (!Buffer.isBuffer(buf)) return null;
    const dims = imageDimensions(buf);
    return dims && !withinImageLimits(dims, limits) ? dims : null;
  });
}

export type ShrinkFn = (bytes: Buffer, limits: ImageLimits) => Promise<{ bytes: Buffer; mediaType: string } | null>;

/** Every limit applied to history at once, for the session's gate: pictures
 *  over the size limits are shrunk (when `shrink` is given) or else become the
 *  oversized note, then the per-request count cap applies. WHY size before
 *  count: a picture already collapsed for size no longer counts toward the cap,
 *  so fewer older ones are dropped. Returns null when nothing changed. */
export async function fitHistoryToImageLimits(history: ModelMessage[], limits: ImageLimits,
  shrinker?: { shrinkBytes?: ShrinkFn }, signal?: AbortSignal): Promise<ModelMessage[] | null> {
  // An image service without shrinkBytes (fakes, older wiring) drops to the note.
  // WHY the signal: shrinking is serial (~0.4 s a picture); after Stop, the rest
  // skip straight to the note instead of holding the stop behind the queue.
  const shrunk = shrinker?.shrinkBytes ? await shrinkOversizedImageParts(history, limits,
    (b, l) => signal?.aborted ? Promise.resolve(null) : shrinker.shrinkBytes!(b, l)) : null;
  return fitHistoryToImageLimitsSync(shrunk ?? history, limits) ?? shrunk;
}

/** The synchronous half (no shrinking): oversized → note, then the count cap. */
export function fitHistoryToImageLimitsSync(history: ModelMessage[], limits: ImageLimits): ModelMessage[] | null {
  const sized = collapseOversizedImageParts(history, limits);
  const counted = limits.maxImagesPerRequest === undefined ? null : collapseExcessImageParts(sized ?? history, limits.maxImagesPerRequest);
  return counted ?? sized;
}

/** Replace every picture in history that is over `limits` with a smaller copy
 *  from `shrink` (same label, same place); one that cannot be shrunk is left
 *  for collapseOversizedImageParts to turn into the note. WHY: when a provider
 *  tightens its limit mid-conversation (Anthropic's 2000 px once a request holds
 *  over 20 pictures), the model keeps its pictures instead of losing them.
 *  Pictures are shrunk one at a time (the shrinker serialises anyway). Same
 *  identity rules and null-for-no-op as collapseOversizedImageParts.
 *  KNOWN TRADE-OFF: the shrunk copy lives only in memory, so the private
 *  accepted-history checkpoint (which cites pictures by the digest of their
 *  file) cannot describe it and stops publishing for that session; reopening
 *  uses the ordinary rebuild, which re-reads the originals and relearns the cap
 *  from one rejection. Chosen over a new checkpoint format: the checkpoint is
 *  an optimisation, and a stuck conversation is the failure being fixed. */
async function shrinkOversizedImageParts(history: ModelMessage[], limits: ImageLimits, shrink: ShrinkFn): Promise<ModelMessage[] | null> {
  const over = (buf: unknown) => { const d = Buffer.isBuffer(buf) ? imageDimensions(buf) : null; return !!d && !withinImageLimits(d, limits); };
  const replaced = new Map<Buffer, { bytes: Buffer; mediaType: string }>();
  for (const m of history) {
    const content = (m as any).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const values = m.role === 'tool' && part?.type === 'tool-result' && part.output?.type === 'content' && Array.isArray(part.output.value)
        ? part.output.value.filter((v: any) => v?.type === 'file' && v.data?.type === 'data').map((v: any) => v.data.data)
        : m.role === 'user' && part?.type === 'file' ? [part.data] : [];
      for (const buf of values) if (over(buf) && !replaced.has(buf)) {
        const out = await shrink(buf, limits);
        // Re-check the result: a shrinker that misjudged must not send an over-limit copy.
        if (out && !over(out.bytes)) replaced.set(buf, out);
      }
    }
  }
  if (!replaced.size) return null;
  return history.map((m) => {
    const content = (m as any).content;
    if (!Array.isArray(content)) return m;
    let touched = false;
    const parts = content.map((part: any) => {
      if (m.role === 'user' && part?.type === 'file' && replaced.has(part.data)) {
        touched = true; const r = replaced.get(part.data)!;
        return { ...part, data: r.bytes, mediaType: r.mediaType };
      }
      if (m.role !== 'tool' || part?.type !== 'tool-result' || part.output?.type !== 'content' || !Array.isArray(part.output.value)) return part;
      let hit = false;
      const value = part.output.value.map((v: any) => {
        const r = v?.type === 'file' && v.data?.type === 'data' ? replaced.get(v.data.data) : undefined;
        if (!r) return v;
        hit = true;
        return { ...v, mediaType: r.mediaType, data: { type: 'data', data: r.bytes } };
      });
      if (!hit) return part;
      touched = true;
      return { ...part, output: { ...part.output, value } };
    });
    return touched ? ({ ...(m as object), content: parts } as ModelMessage) : m;
  });
}

/** The second recovery mode, for when the provider's patch count disagrees with
 *  ours: it rejected the request ("requires R patches … limit of L") yet no part
 *  is over L by OUR count, so the size-based collapse changed nothing.
 *  WHY this exists: without it the error rethrew and, because failed turns keep
 *  history, every later message resent the same picture and failed again — the
 *  2026-10-06 incident's shape, just with a count we cannot reproduce (a resize
 *  rule or tile size the provider never documented). Collapse the LARGEST image
 *  parts by our patch count (ties: the most recent first — the newest picture is
 *  the likeliest to be the one just added) until R − removed ≤ L, writing the
 *  same oversized note with each part's real W×H. Parts whose header cannot be
 *  measured are left alone (no honest W×H to write). Same identity rules and
 *  null-for-no-op as collapseOversizedImageParts. */
export function collapseLargestImageParts(history: ModelMessage[], requiredPatches: number, limitPatches: number): ModelMessage[] | null {
  const found: Array<{ part: object; dims: { width: number; height: number }; patches: number; order: number }> = [];
  collapseImageParts(history, (part, buf) => {
    const dims = Buffer.isBuffer(buf) ? imageDimensions(buf) : null;
    if (dims) found.push({ part, dims, patches: patchCount(dims.width, dims.height), order: found.length });
    return null;   // survey only: nothing collapses on this pass
  });
  found.sort((a, b) => b.patches - a.patches || b.order - a.order);
  const chosen = new Map<object, { width: number; height: number }>();
  let removed = 0;
  for (const f of found) {
    if (requiredPatches - removed <= limitPatches) break;
    chosen.set(f.part, f.dims); removed += f.patches;
  }
  return chosen.size ? collapseImageParts(history, (part) => chosen.get(part) ?? null) : null;
}

/** Once history holds more than `max` pictures, keep only the NEWEST 80% of
 *  `max`; each older one becomes the shared 'over-count' note. WHY: every
 *  picture in history is resent with each request, and a provider with a
 *  per-request cap (Anthropic: 100) refuses the whole request once a
 *  conversation passes it — and every send after, since failed turns keep
 *  history. Oldest go first: the newest are likeliest to matter. Same identity
 *  rules and null-for-no-op as collapseOversizedImageParts. */
export function collapseExcessImageParts(history: ModelMessage[], max: number): ModelMessage[] | null {
  // WHY the media-type test: a user-attached PDF is also a `file` part; it is
  // not a picture, so it neither counts nor gets the picture note.
  const isPicture = (part: any) => typeof part?.mediaType === 'string' && part.mediaType.startsWith('image/');
  let total = 0;
  collapseImageParts(history, (part) => { if (isPicture(part)) total++; return null; });   // survey only
  if (total <= max) return null;
  // WHY down to 80% rather than to `max`: dropping exactly one old picture per
  // new one would rewrite the start of history on EVERY later turn, missing the
  // provider's prompt cache each time. A batch moves it once per ~20 pictures.
  let drop = total - Math.floor(Math.max(0, max) * 0.8);
  return collapseImageParts(history, () => null, (label, part) => {
    if (drop <= 0 || !isPicture(part)) return null;
    drop--;
    return imageNote({ kind: 'unavailable', label, reason: 'over-count' });
  });
}

/** The shared rewrite: `pick` returns the W×H to write in the oversized note for
 *  an image part that must go, or null to keep it; `pickNote` (optional, asked
 *  first) returns a finished note instead. Visits parts in history order. */
function collapseImageParts(history: ModelMessage[], pick: (part: object, buf: unknown) => { width: number; height: number } | null,
  pickNote?: (label: string, part: object) => string | null): ModelMessage[] | null {
  let changed = false;
  const next = history.map((m) => {
    const content = (m as any).content;
    if (!Array.isArray(content)) return m;
    if (m.role === 'tool') {
      let touched = false;
      const parts = content.map((part: any) => {
        if (part?.type !== 'tool-result' || part.output?.type !== 'content' || !Array.isArray(part.output.value)) return part;
        const texts: string[] = []; const files: any[] = []; const notes: string[] = [];
        for (const v of part.output.value) {
          const isImage = v?.type === 'file' && v.data?.type === 'data';
          const label = v?.filename ?? part.toolName ?? 'image';
          const ready = isImage && pickNote ? pickNote(label, v) : null;
          const dims = isImage && !ready ? pick(v, v.data.data) : null;
          if (ready) notes.push(ready);
          else if (dims) notes.push(imageNote({ kind: 'oversized', label, width: dims.width, height: dims.height }));
          else if (v?.type === 'text') texts.push(v.text);
          else files.push(v);
        }
        if (!notes.length) return part;
        touched = true;
        // Same shape history-rebuild writes for a refused picture: one text
        // part (result text + "\n<note>" per refusal), then the kept files.
        const text = texts.join('\n') + notes.map((n) => `\n${n}`).join('');
        return { ...part, output: files.length ? { type: 'content', value: [{ type: 'text', text }, ...files] } : { type: 'text', value: text } };
      });
      if (!touched) return m;
      changed = true;
      return { ...(m as object), content: parts } as ModelMessage;
    }
    if (m.role === 'user') {
      const kept: any[] = []; const notes: any[] = [];
      for (const p of content) {
        const ready = p?.type === 'file' && pickNote ? pickNote('image', p) : null;
        const dims = p?.type === 'file' && !ready ? pick(p, p.data) : null;
        if (ready) notes.push({ type: 'text', text: ready });
        else if (dims) notes.push({ type: 'text', text: imageNote({ kind: 'oversized', label: 'image', width: dims.width, height: dims.height }) });
        else kept.push(p);
      }
      if (!notes.length) return m;
      changed = true;
      return { ...(m as object), content: [...kept, ...notes] } as ModelMessage;
    }
    return m;
  });
  return changed ? next : null;
}

/** Parts for a user message's attachments — delivered pictures first, then a
 *  basename note for each picture the model did NOT get. A refused file never
 *  throws: a turn must not die because one attachment went missing between the
 *  composer and the send. Since 2026-10-07 a refused PICTURE is named (oversized,
 *  missing, preparation failed) instead of skipped silently, so the model never
 *  assumes it saw something it did not. The caller decides vision support. */
export function userAttachmentParts(entries: ModelAttachment[], limits: ImageLimits): UserPart[] {
  const files: UserPart[] = []; const notes: UserPart[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' && 'prepareFailed' in entry) {
      // Preparation refused this picture: say so, with the preparer's reason —
      // never "above size limit", which would send the model to crop a file
      // the app itself could not decode.
      notes.push({ type: 'text', text: imageNote({ kind: 'unavailable', label: path.basename(entry.path), reason: 'prepare-failed', detail: entry.prepareFailed }) });
      continue;
    }
    const p = typeof entry === 'string' ? entry : entry.path;
    // WHY only image-shaped paths get a note: a PDF or text attachment was never
    // a picture to deliver — it keeps today's silent skip (its path is in the
    // text), so ordinary attachments keep today's prompt text and checkpoint shape.
    if (!deliverableImageMediaType(p) && !UNDELIVERABLE_IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase())) continue;
    const img = readImageFromDisk(p, limits);   // shared reader — one table, one cap, one pixel gate
    if (img.ok) {
      files.push({ type: 'file', mediaType: img.mediaType, data: img.data });
      // WHY a "downscaled" note for a prepared composer picture: the model got a
      // smaller copy and, untold, would read a blurred screenshot as the real
      // thing. Original size from native:send (the preparer's async header read);
      // shown size from the bytes this reader already returned — no extra read
      // on this synchronous path. Labelled by the ORIGINAL's basename.
      const note = typeof entry === 'string' ? null : downscaledNote(entry.original, img);
      if (note) notes.push({ type: 'text', text: note });
    }
    else if (img.reason === 'oversized') notes.push({ type: 'text', text: imageNote({ kind: 'oversized', label: path.basename(p), width: img.width ?? 0, height: img.height ?? 0 }) });
    else notes.push({ type: 'text', text: imageNote({ kind: 'unavailable', label: path.basename(p), reason: img.reason }) });
  }
  return [...files, ...notes];
}
