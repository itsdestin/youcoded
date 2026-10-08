// Pure image rewrites over model history, applied by HarnessSession.
// WHY a separate file: harness-session.ts is far over the 1,500-line default and
// held by a line-budget ratchet; these two functions need no session state (the
// session passes its history and its provider's limits), so they live beside
// the reader they share a note format with instead of growing the session.
import * as path from 'path';
import type { ModelMessage } from 'ai';
import type { ImageLimits } from './capability-profile';
import type { ModelAttachment, UserPart } from './busy-message-boundary';
import { readImageFromDisk, deliverableImageMediaType, imageNote, UNDELIVERABLE_IMAGE_EXTENSIONS, imageDimensions, withinImageLimits, patchCount } from './image-support';

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

/** The shared rewrite: `pick` returns the W×H to write in the note for an image
 *  part that must go, or null to keep it. Visits parts in history order. */
function collapseImageParts(history: ModelMessage[], pick: (part: object, buf: unknown) => { width: number; height: number } | null): ModelMessage[] | null {
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
          const dims = v?.type === 'file' && v.data?.type === 'data' ? pick(v, v.data.data) : null;
          if (dims) notes.push(imageNote({ kind: 'oversized', label: v.filename ?? part.toolName ?? 'image', width: dims.width, height: dims.height }));
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
        const dims = p?.type === 'file' ? pick(p, p.data) : null;
        if (dims) notes.push({ type: 'text', text: imageNote({ kind: 'oversized', label: 'image', width: dims.width, height: dims.height }) });
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
    if (typeof entry !== 'string') {
      // Preparation refused this picture: say so, with the preparer's reason —
      // never "above size limit", which would send the model to crop a file
      // the app itself could not decode.
      notes.push({ type: 'text', text: imageNote({ kind: 'unavailable', label: path.basename(entry.path), reason: 'prepare-failed', detail: entry.prepareFailed }) });
      continue;
    }
    const p = entry;
    // WHY only image-shaped paths get a note: a PDF or text attachment was never
    // a picture to deliver — it keeps today's silent skip (its path is in the
    // text), so ordinary attachments keep today's prompt text and checkpoint shape.
    if (!deliverableImageMediaType(p) && !UNDELIVERABLE_IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase())) continue;
    const img = readImageFromDisk(p, limits);   // shared reader — one table, one cap, one pixel gate
    if (img.ok) files.push({ type: 'file', mediaType: img.mediaType, data: img.data });
    else if (img.reason === 'oversized') notes.push({ type: 'text', text: imageNote({ kind: 'oversized', label: path.basename(p), width: img.width ?? 0, height: img.height ?? 0 }) });
    else notes.push({ type: 'text', text: imageNote({ kind: 'unavailable', label: path.basename(p), reason: img.reason }) });
  }
  return [...files, ...notes];
}
