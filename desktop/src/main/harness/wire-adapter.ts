// Per-provider image adaptation, at REQUEST-BUILD time (2026-08-11 spec).
//
// Canonical history keeps images where they factually belong — inside the tool
// result that fetched them, or the user message that attached them. But only
// the direct-Anthropic wire can carry an image inside a tool result;
// @ai-sdk/openai-compatible JSON.stringifies a content-type output into a wall
// of base64 the model hallucinates over (Cline documents this exact failure in
// its split-tool-images middleware, which this module mirrors). So every
// request adapts a COPY of the canonical view:
//   - nativeImageToolResults (Anthropic): pass through.
//   - otherwise: tool output becomes plain text with a forward-pointing
//     placeholder, and a SYNTHETIC user message carrying the image is inserted
//     immediately AFTER the complete tool message (the position
//     injectPathTriggers already proves safe on every provider).
//   - a non-vision model (e.g. mid-session swap to a local model): every image
//     part in ANY message — not just user/tool — becomes a named text
//     placeholder — pixels are NEVER sent.
// Synthetic messages exist only in the outgoing request: never pushed to
// history, never persisted, never rendered. Re-checked EVERY request, which is
// what closes the swap-time leak a push-time gate cannot.
import type { ModelMessage } from 'ai';

export interface WireImageCaps { nativeImageToolResults: boolean; supportsVision: boolean }

const OMITTED_TEXT = '[image omitted: this model cannot view images]';
// Forward-pointing on purpose: classic Cline found "(see the following user
// message...)" measurably outperforms unexplained placeholder text. Called
// once per image, AT that image's own position in the flattened text (so a
// [file, text] result still reads "the image came first"). Carries the same
// `label(f)` the follow-up message's "Image: <label>" part uses, so a
// multi-image result's placeholders map to their attachment by name instead
// of leaving the model to infer the mapping from message order alone.
const forwardText = (label: string) =>
  `(the image "${label}" could not be embedded here — attached in the next message as "Image: ${label}", sent on your behalf)`;
// "(s)" is deliberate, not lazy: this frames a synthetic message that may
// follow one tool-result with one image, or several tool-results each
// contributing images, and the wording must stay true in both cases.
const provenanceText = (n: number) =>
  `Attached below: ${n === 1 ? 'the image' : `the ${n} images`} from the tool result(s) above, delivered automatically because this provider cannot carry images inside tool results. This is not a message the user typed.`;

type AnyPart = { type: string; [k: string]: unknown };

// A tool-output file part's `data` is this tagged union (see
// @ai-sdk/provider-utils' FileData, node_modules/@ai-sdk/provider-utils/dist/index.d.ts
// ~L111-139). @ai-sdk/provider-utils is only a transitive dependency here
// (not in package.json) and 'ai' doesn't re-export the type itself, so the
// shape is redeclared narrowly rather than importing from an undeclared
// package — this is the type that made the Fix-1 bug (`.data.data` on a
// non-'data' variant) a silent `undefined` instead of a compile error.
type ToolResultFileData =
  | { type: 'data'; data: string | Uint8Array | ArrayBuffer | Buffer }
  | { type: 'url'; url: URL }
  | { type: 'reference'; reference: Record<string, unknown> }
  | { type: 'text'; text: string };

interface ToolResultFilePart {
  type: 'file';
  data: ToolResultFileData;
  mediaType: string;
  filename?: string;
  providerOptions?: Record<string, unknown>;
}

interface ToolResultLikePart extends AnyPart {
  type: 'tool-result';
  toolName?: string;
  output?: { type: string; value?: AnyPart[]; providerOptions?: Record<string, unknown> };
}

// One element per part of a content-output `value` array, kept in SOURCE
// ORDER. Lets the renderer below reflect WHERE each part sat instead of
// collecting file parts and text parts into two separately-ordered lists.
type FlatPart =
  | { kind: 'text'; text: string }
  | { kind: 'file'; file: ToolResultFilePart }
  | { kind: 'other'; partType: string };

// Renders a flattened content-output back to a single text blob, in source
// order. `renderFile` supplies the per-branch wording for a `file` part (a
// named omission notice for a non-vision model, a forward-pointing note on
// the split branch) — the two must never say the same thing, so it's a
// parameter rather than baked in here. Anything this module has no
// image-specific handling for (kind: 'other' — the content-output union's
// deprecated file-data/file-url/file-id variants, or a future SDK addition)
// gets a placeholder naming its type, so it can't vanish with zero trace —
// the same silent-payload-loss shape the earlier `.data.data` bug had.
function renderFlat(flat: FlatPart[], renderFile: (f: ToolResultFilePart) => string): string {
  return flat
    .map((p) => {
      if (p.kind === 'text') return p.text;
      if (p.kind === 'file') return renderFile(p.file);
      return `[part omitted: unsupported content type '${p.partType}']`;
    })
    .join('\n');
}

function hasImageParts(m: ModelMessage): boolean {
  const c = (m as { content: unknown }).content;
  if (!Array.isArray(c)) return false;
  return (c as AnyPart[]).some((p) =>
    p?.type === 'file'
    || (p?.type === 'tool-result' && (p as ToolResultLikePart).output?.type === 'content'));
}

export function adaptForWire(messages: ModelMessage[], caps: WireImageCaps): ModelMessage[] {
  // Fast path: an image-free history is returned as-is (byte-identical — the
  // no-image pipeline must not change shape at all). Returning the SAME
  // array reference (not a structurally-equal copy) matters: it's what makes
  // deleting this early return a test failure rather than a silent no-op.
  if (!messages.some(hasImageParts)) return messages;

  const out: ModelMessage[] = [];
  for (const m of messages) {
    const content = (m as { content: unknown }).content;

    if (m.role === 'tool' && Array.isArray(content)) {
      const followUpParts: AnyPart[] = [];
      const newContent = (content as ToolResultLikePart[]).map((part) => {
        if (part?.type !== 'tool-result' || part.output?.type !== 'content') return part;
        const output = part.output;
        const toolName = part.toolName ?? 'tool result';
        // Single ordered walk over `value`, kept in SOURCE POSITION (not
        // split into two independently-ordered lists) — this is what makes
        // a [text, file, text] result render with the image placeholder
        // where the image actually sat, instead of every image sliding to
        // the end of the text regardless of where it appeared.
        const flat: FlatPart[] = (output.value ?? []).map((v): FlatPart => {
          if (v?.type === 'text') return { kind: 'text', text: (v as unknown as { text: string }).text };
          if (v?.type === 'file') return { kind: 'file', file: v as unknown as ToolResultFilePart };
          return { kind: 'other', partType: String(v?.type ?? 'unknown') };
        });
        const fileCount = flat.reduce((n, p) => n + (p.kind === 'file' ? 1 : 0), 0);
        const label = (f: ToolResultFilePart) => f.filename ?? toolName;
        const textOutput = (value: string) => ({
          type: 'text' as const,
          value,
          // Carry the content-output's own providerOptions through instead of
          // silently dropping them when flattening to text.
          ...(output.providerOptions ? { providerOptions: output.providerOptions } : {}),
        });

        // Order is load-bearing:
        // 1. non-vision strip MUST come first — a non-vision model on the
        //    native Anthropic wire still must never see pixels.
        // 2. native pass-through MUST come before the no-files flatten, or a
        //    content output with zero file parts gets needlessly rewritten
        //    to text even on the wire that could carry it untouched.
        // 3. no-files flatten.
        // 4. otherwise: split image(s) into a synthetic follow-up message.
        if (!caps.supportsVision) {
          // One NAMED placeholder per image, at its own position — not one
          // unnamed trailing line no matter how many images the result
          // carried (a 3-image Read result used to say "an image" once,
          // naming none of the three).
          return { ...part, output: textOutput(renderFlat(flat, (f) => `[image omitted: ${label(f)} — this model cannot view images]`)) };
        }
        if (caps.nativeImageToolResults) return part;
        if (!fileCount) {
          // No 'file' part exists on this branch, so the file renderer is
          // never invoked — but if that invariant ever broke, a renderer
          // that quietly returns '' would produce a blank line with zero
          // trace. Throw instead so the failure is loud, not silent. Traced
          // (2026-08-11 review): this IS wrapped — it surfaces as a
          // session-error via describeProviderError, caught at the summary
          // call site, so the session survives — but the app's owner is a
          // non-developer who can see this text, so it must not read like an
          // internal assertion (docs/error-message-standards.md: general +
          // non-committal, since there is no real cause to report here — it
          // truly should never happen).
          return {
            ...part,
            output: textOutput(renderFlat(flat, () => {
              throw new Error('Internal error while preparing an image for this model. Please report this bug.');
            })),
          };
        }

        for (const p of flat) {
          if (p.kind !== 'file') continue;
          // Label each image with what it is so a multi-image turn doesn't
          // hand the model several unlabeled pictures it can't map back to
          // the file/tool that produced them.
          followUpParts.push({ type: 'text', text: `Image: ${label(p.file)}` });
          // Tool-output file parts wrap bytes as the tagged {type:'data',
          // data} form. A user-message FilePart's `data` field also legally
          // accepts that same tagged {type:'data', data} form (FilePart's
          // `data` is FileData | DataContent | URL | ProviderReference) —
          // this unwrap is a NORMALIZATION for consistency, not something
          // the SDK requires. Every other FileData variant (url/reference/
          // text) is passed through untouched — reaching into `.data.data`
          // on those yielded undefined, i.e. a payload-less file part
          // silently sent to the provider.
          followUpParts.push({ ...p.file, data: p.file.data?.type === 'data' ? p.file.data.data : p.file.data });
        }
        // Each image's forward-pointing note sits where the image itself
        // sat, so a [file, text] result still reads "the image came first"
        // instead of silently reordering every image to the end. Labeled
        // with the same `label(f)` the follow-up message's "Image: <label>"
        // part carries, so a multi-image result maps note-to-attachment by
        // name instead of leaving the model to infer it from order.
        return { ...part, output: textOutput(renderFlat(flat, (f) => forwardText(label(f)))) };
      });
      out.push({ ...(m as object), content: newContent } as ModelMessage);
      if (followUpParts.length) {
        const imageCount = followUpParts.filter((p) => p.type === 'file').length;
        // `as any`: the synthetic message's content mixes label/file AnyParts
        // that don't structurally match ModelMessage's strict UserContent
        // union (TextPart | ImagePart | FilePart) — fully typing this fights
        // the SDK's discriminated unions for no safety gain, since the shape
        // is hand-built here, not read from an external source.
        out.push({
          role: 'user',
          content: [{ type: 'text', text: provenanceText(imageCount) }, ...followUpParts],
        } as any);
      }
      continue;
    }

    if (!caps.supportsVision && Array.isArray(content)) {
      // Non-vision protection for every OTHER role with array content — not
      // role-scoped to 'user'. WHY: hasImageParts() above checks EVERY role
      // to decide whether to take the slow path at all, so a role this loop
      // didn't otherwise rewrite (e.g. an assistant message carrying a file
      // part) would reach the provider with real pixels intact. Not leaking
      // pixels to a model that can't see is this module's entire purpose.
      out.push({
        ...(m as object),
        content: (content as AnyPart[]).map((p) => (p?.type === 'file' ? { type: 'text', text: OMITTED_TEXT } : p)),
      } as ModelMessage);
      continue;
    }

    out.push(m);
  }
  return out;
}

// WHY (2026-10 freeze hunt): the AI SDK base64-encodes every image Buffer in the
// request EVERY step, via a JS loop that appends one byte at a time (~65 ms per MB
// plus heavy GC) — with ~35 MB of history images that froze the main process ~4 s
// per tool-result step. The SDK passes an already-base64 STRING through untouched
// (convertToBase64 / detectMediaType both accept strings and yield the same bytes
// on the wire), so we encode once per Buffer with the native encoder and cache it.
// History itself keeps its Buffers (image limits, token estimates and persistence
// read bytes); only the copy handed to streamText carries strings.
const base64Cache = new WeakMap<Uint8Array, string>();
export const wireBase64Stats = { encoded: 0 };
function b64(buf: Uint8Array): string {
  let s = base64Cache.get(buf);
  if (s === undefined) {
    s = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64');
    base64Cache.set(buf, s);
    wireBase64Stats.encoded++;
  }
  return s;
}
const isImageFile = (p: any) => p?.type === 'file' && typeof p.mediaType === 'string' && p.mediaType.startsWith('image/');
// Returns a part with its bytes as base64 text, or the SAME object when nothing to do.
function encodeFilePart(p: any): any {
  if (!isImageFile(p)) return p;
  const d = p.data;
  if (d instanceof Uint8Array) return { ...p, data: { type: 'data', data: b64(d) } };
  if (d && d.type === 'data' && d.data instanceof Uint8Array) return { ...p, data: { type: 'data', data: b64(d.data) } };
  return p;
}
/** Copy-on-write: messages without image bytes keep their identity; history is never mutated. */
export function encodeImagesForWire(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    const content = (m as { content: unknown }).content;
    if (!Array.isArray(content)) return m;
    let mChanged = false;
    const next = (content as any[]).map((part) => {
      if (part?.type === 'file') {
        const e = encodeFilePart(part);
        if (e !== part) mChanged = true;
        return e;
      }
      const v = part?.type === 'tool-result' && part.output?.type === 'content' ? part.output.value : null;
      if (Array.isArray(v) && v.some(isImageFile)) {
        const nv = v.map(encodeFilePart);
        if (nv.some((x: any, i: number) => x !== v[i])) {
          mChanged = true;
          return { ...part, output: { ...part.output, value: nv } };
        }
      }
      return part;
    });
    if (!mChanged) return m;
    changed = true;
    return { ...m, content: next } as ModelMessage;
  });
  return changed ? out : messages;
}
