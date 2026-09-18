import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { defineTool } from './registry';
import { canonicalize, resolveP, shellCwdMissHint } from './guards';
import { deliverableImageMediaType, UNDELIVERABLE_IMAGE_EXTENSIONS, MAX_ATTACHMENT_BYTES } from '../image-support';
import { readPdfAsToolResult } from '../pdf-text';
import { fingerprintFile, fingerprintOf } from './file-fingerprint';

const BINARY_SNIFF_BYTES = 8000;

// Read runs in the Electron MAIN process, so an unbounded readFileSync is a
// whole-app blast radius: a model reading a multi-hundred-MB log OOMs the app,
// and anything >2 GB throws a raw RangeError from Buffer. Refuse before the read
// (statSync is cheap) with a cap well above any legit source file.
export const MAX_READ_BYTES = 50 * 1024 * 1024; // 50 MB
/** G-5: per-call cap on the numbered text a Read returns ("~50 KB" in the
 *  description). Matches OpenCode / Pi / OpenClaw; cut on a line boundary. */
export const MAX_CHARS = 50_000;
/** D-3: how many entries a Read-on-a-folder lists before declaring the rest. */
const DIR_LIST_LIMIT = 50;

// WHY (2026-08-10 review, Claim 10): Read's isError returns used to speak THREE
// unreconciled dialects -- "Read failed: ..." (thrown exceptions, via
// registry.ts's generic catch-all), "Cannot read ...: ..." (this size refusal
// and the binary refusal below), and a bare "Read <path>: offset N is past the
// end..." (past-EOF -- no "failed"/"Cannot" prefix at all). Opus flagged the
// last one specifically: the prefix is "otherwise a reliable signal for 'did
// this succeed'". Unified into the SAME two prefixes the house style already
// uses elsewhere (Edit: "rejected" for a guard declining to act at all,
// "failed" for a bad request against an otherwise-permitted action): "Read
// rejected: ..." for refusals where we won't read this file at all (too big,
// binary), matching the thrown-exception path's "Read failed: ..." prefix
// family for the past-EOF case below, which is a bad request (invalid offset)
// against a file we DID agree to read.

/** Refusal text if the file is too big to read whole, else null. Exported so the
 *  refusal branch is unit-testable without writing a 50 MB fixture. */
export function readSizeError(sizeBytes: number, filePath: string): string | null {
  if (sizeBytes <= MAX_READ_BYTES) return null;
  const mb = (sizeBytes / (1024 * 1024)).toFixed(0);
  // Honest hint: offset/limit can't help once we refuse the read entirely, so
  // point at tools that stream instead of loading the whole file into memory.
  return `Read rejected: ${filePath}: file is ${mb} MB (limit 50 MB). Use Grep to search it, or Bash head/tail to sample it.`;
}

// A NUL byte in the first 8 KB is our binary heuristic — matches CC's refusal.
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const ReadTool = defineTool({
  name: 'Read',
  // Pause handoff §1 (WHY): changes nothing, so a plan may re-run it after a cut-off.
  effect: 'read',
  // T-3 / G-5 (2026-08-26 tools investigation): the frugality sentence is the
  // one every peer harness carries and frontier models measurably honour; the
  // "~50 KB" clause states the per-call char cap (execute() below) so a model
  // can plan a paged read instead of discovering the cap in a notice.
  description:
    'Read a TEXT file from the filesystem. Returns numbered lines. Use offset and limit for '
    + 'large files — output is capped at 2000 lines or ~50 KB, whichever comes first. '
    + 'When you already know which part you need, read only that part with offset/limit. '
    + 'Images and other binary files are refused. '
    + 'PDFs return their text layer page by page (pages="1-5", max 20 per call; offset/limit '
    + 'do not apply); scanned pages have no text and are reported.',
  // Compact form for small local models (simplified presentation, spec §4.2).
  // Kept under the 120-char short-tier pin: the PDF clause is one short phrase.
  shortDescription: "Read a file's contents by path, with optional line offset/limit. PDFs: text per page (pages=\"1-5\").",
  // Vision models are TOLD Read handles images; text-only models keep the
  // refusal-only wording. See NativeTool.descriptionFor.
  descriptionFor: (caps) => caps.supportsVision
    ? 'Read a file from the filesystem. Text files return numbered lines; use offset and '
      + 'limit for large files — output is capped at 2000 lines or ~50 KB, whichever comes '
      + 'first. When you already know which part you need, read only that part with '
      + 'offset/limit. Image files (png, jpg, gif, webp) are delivered to you as the actual '
      + 'picture alongside the result — Read is how you look at a screenshot or image the '
      + 'user mentions by path. '
      + 'PDFs return their text layer page by page (pages="1-5", max 20 per call; offset/limit '
      + 'do not apply); scanned pages have no text and are reported — render those to PNG and Read them.'
    : undefined,
  // Same fix as descriptionFor, scoped to the SHORT text (simplified presentation
  // for small local models, spec §4.2). Without this a small local vision model
  // keeps the static shortDescription below and never learns Read handles images —
  // the exact Roo Code #10440 gap, just on the tier schema-budget trims for.
  // Kept to one short clause: shortDescription exists to be small.
  shortDescriptionFor: (caps) => caps.supportsVision
    ? "Read a file's contents by path, with optional line offset/limit."
      + ' Images come back as the actual picture. PDFs: text per page (pages="1-5").'
    : undefined,
  inputSchema: z.object({
    file_path: z.string().describe('Absolute or workspace-relative path'),
    offset: z.number().int().min(1).optional().describe('1-based first line to read'),
    limit: z.number().int().min(1).optional().describe('Max lines to return'),
    pages: z.string().optional().describe('PDF only: page or range to return, e.g. "3" or "1-5" (max 20 per call)'),
  }).strict(), // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
  caps: { maxChars: 100_000 },
  // Static fallback for composeNotice's no-bounds branch (Task 19): `bounds`
  // below is only set when the requested slice stops before EOF (`more`).
  // A full-length read (offset 1, default limit, file exactly 2000 lines) sets
  // `more: false` — but MAX_LINE (2000 chars/line) means the numbered text can
  // still be ~4M chars, well past `caps.maxChars`, with no bound declared.
  // NOT verbatim from `bounds.moreHint` below: that string interpolates the
  // NEXT offset (`use offset=${offset + limit}...`), a per-call number this
  // static property can't carry. Same vocabulary (offset/limit), generalized.
  moreHint: 'use offset and limit to read a smaller slice of the file (for a PDF, a narrower pages range)',
  permissionSubject: (a) => a.file_path,
  async execute(args, ctx) {
    const abs = resolveP(args.file_path, ctx.cwd);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(abs); // off the main thread (2026-09-16 C4 review)
    } catch (err: any) {
      // Fix (two independent 2026-08 harness reviews, Grok 4.5 + Qwen 3.8 Max —
      // see guards.ts's WHY block above shellCwdMissHint): Read always resolves
      // a relative path from the workspace root, but the model may have just
      // `cd`-moved Bash's cwd and assumed Read followed it. Before letting the
      // raw ENOENT stand alone, check whether the SAME path exists relative to
      // the shell's actual persisted cwd — only ever named when confirmed on
      // disk. Any other stat failure (permission, etc.) is unrelated to this
      // asymmetry and falls through unchanged to defineTool's generic catch.
      if (err?.code === 'ENOENT') {
        const hint = shellCwdMissHint(args.file_path, ctx, (p) => {
          try {
            return fs.statSync(p).isFile();
          } catch {
            return false;
          }
        });
        return { text: `Read failed: ${err.message}${hint}`, isError: true };
      }
      throw err;
    }
    // D-3 (2026-08-26 tools investigation): a folder used to fall through to
    // readFileSync and surface Node's raw "EISDIR: illegal operation on a
    // directory" via defineTool's generic catch — an error code, not a tool
    // message. Small models Read folders often. Say what it is, say what to use
    // instead, and show the first entries so the call still bought something.
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = (await fs.promises.readdir(abs, { withFileTypes: true }))
          .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
          .sort((a, b) => a.localeCompare(b));
      } catch {
        // Unreadable folder (permissions): the "is a folder" message still stands on its own.
      }
      const shown = names.slice(0, DIR_LIST_LIMIT);
      const head = `Read rejected: ${args.file_path} is a folder, not a file — use Glob to find files in it, or Bash \`ls\`.`;
      return {
        text: shown.length ? `${head}\n${shown.join('\n')}` : head,
        isError: true,
        bounds: names.length > shown.length
          ? { shown: shown.length, total: names.length, unit: 'files' as const, moreHint: 'use Glob or Bash ls to see the rest' }
          : undefined,
      };
    }
    const sizeErr = readSizeError(st.size, args.file_path);
    if (sizeErr) return { text: sizeErr, isError: true };
    // IMAGES (2026-08-11 spec): a vision model gets the actual picture — the tool
    // returns the PATH; the driver builds the parts, so promise and delivery are
    // decided against the same stat. Order: image-shaped check (deliverable OR
    // undeliverable format) → vision gate → format/size specifics → promise.
    // Every refusal names the real reason (no "binary file" lies). This branch
    // runs BEFORE readFileSync below — the driver reads the bytes at delivery
    // time, so Read must never slurp a large image into memory itself.
    const imageMediaType = deliverableImageMediaType(args.file_path);
    const undeliverableExt = UNDELIVERABLE_IMAGE_EXTENSIONS.has(path.extname(args.file_path).toLowerCase());
    // WHY the vision gate is hoisted above the deliverable/undeliverable split
    // (2026-08-11 review, Fix 1): it used to live only inside the deliverable
    // branch, so a text-only model reading diagram.svg fell straight into the
    // undeliverable branch's "convert it to PNG and Read the copy" advice —
    // real, actionable-sounding advice that dead-ends, because converting
    // produces a PNG the SAME text-only model still cannot see. That is a Bash
    // round-trip spent chasing a fix that does not exist. Checking vision first
    // for ANY image-shaped file means every no-vision model gets the one true
    // reason (no vision) regardless of format.
    if ((imageMediaType || undeliverableExt) && !ctx.supportsVision) {
      return { text: `Read rejected: ${args.file_path} is an image and the current model cannot view images. Continue without it, or ask the user to describe it.`, isError: true };
    }
    if (imageMediaType) {
      if (st.size > MAX_ATTACHMENT_BYTES) {
        return { text: `Read rejected: ${args.file_path} is a ${(st.size / (1024 * 1024)).toFixed(1)} MB image (limit ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB).`, isError: true };
      }
      ctx.readRegistry.set(canonicalize(args.file_path, ctx.cwd), await fingerprintFile(abs));
      return { text: `Read image ${args.file_path} (${Math.max(1, Math.round(st.size / 1024))} KB, ${imageMediaType}).`, images: [abs] };
    }
    if (undeliverableExt) {
      return { text: `Read rejected: ${args.file_path} is a ${path.extname(args.file_path).slice(1)} image — a format that cannot be delivered to the model. Convert it to PNG (e.g. Bash: magick in.svg out.png) and Read the copy.`, isError: true };
    }
    // PDFs (ledger G-6, 2026-08-27): a PDF is full of NUL bytes, so without this
    // branch the NUL sniff below would call every PDF "a binary file" — true but
    // useless. Extraction lives in ../pdf-text.ts (lazy pdf.js, serialized,
    // scanned pages named); this branch only records the read. Placed BEFORE
    // readFileSync so a PDF is never slurped twice. `offset`/`limit` are ignored
    // for PDFs — `pages` is the paging vocabulary — and the description says so.
    if (path.extname(args.file_path).toLowerCase() === '.pdf') {
      const r = await readPdfAsToolResult(abs, { displayPath: args.file_path, pages: args.pages, supportsVision: !!ctx.supportsVision });
      if (!r.isError) ctx.readRegistry.set(canonicalize(args.file_path, ctx.cwd), await fingerprintFile(abs));
      return r;
    }
    const offset = args.offset ?? 1;
    const limit = Math.min(args.limit ?? 2000, 2000);
    const canonical = canonicalize(args.file_path, ctx.cwd);
    // G-11 (2026-08-26 tools investigation): the same slice of an UNCHANGED file
    // was already served this session — the model still has it (the session
    // forgets these marks whenever history is discarded or shrunk, so this is
    // never claimed across a compaction or resume). A short notice beats a
    // second copy: Claude Code and Hermes both do this. Checked BEFORE the file
    // is read so the repeat costs a stat and nothing else. Still counts as a
    // Read for the edit gate — the registry stamp happens here as well as on the
    // full path below (a binary file is only stamped AFTER it passes the binary
    // refusal, so a refused Read never satisfies the gate; a dedupe hit can
    // only be for a file that already passed it).
    const servedKey = `${canonical}|${offset}|${limit}`;
    const prior = ctx.servedReads?.get(servedKey);
    if (prior && prior.mtimeMs === st.mtimeMs) {
      ctx.readRegistry.set(canonical, prior.fingerprint);
      const ago = ctx.toolCallIndex !== undefined ? ctx.toolCallIndex - prior.callIndex : undefined;
      const when = ago !== undefined ? `(${ago} call${ago === 1 ? '' : 's'} ago)` : '(earlier this session)';
      return {
        text: `Read ${args.file_path}: lines ${prior.from}–${prior.to} — `
          + `Unchanged since your earlier Read this session ${when} — the content you already have is current. `
          + 'Use a different offset/limit to see another part of the file.',
      };
    }
    // fs.promises (2026-09-16 C4): up to MAX_READ_BYTES used to be read
    // synchronously on the main thread, several times per turn.
    const buf = await fs.promises.readFile(abs);
    if (looksBinary(buf)) return { text: `Read rejected: ${args.file_path}: it is a binary file.`, isError: true };
    const raw = buf.toString('utf8');
    const all = raw.split('\n');
    // A trailing newline yields a phantom empty final element ("a\nb\n" → 3, not
    // 4) — drop it so line counts and the paging trailer are honest.
    if (raw.endsWith('\n')) all.pop();
    const totalLines = all.length;
    // Record for the read-before-edit gate (a content fingerprint, so a later
    // external change invalidates it and a mere touch does not) — the file
    // exists and was readable, so it counts as read even if the requested page
    // is past EOF.
    const fingerprint = fingerprintOf(buf);
    ctx.readRegistry.set(canonical, fingerprint);
    if (offset > totalLines) {
      return { text: `Read failed: ${args.file_path}: offset ${offset} is past the end of the file (${totalLines} lines).`, isError: true };
    }
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const MAX_LINE = 2000;
    // G-5: a second, per-call cap in CHARS on top of the line cap — 2,000 lines
    // of long lines is megabytes of numbered text, which used to sail through to
    // defineTool's generic 100k pipeline notice with no exact way to continue.
    // Cut on a line boundary (never mid-line; always at least one line) and say
    // precisely where to resume. The pipeline cap stays as a backstop but is now
    // unreachable for text reads (≤ 50,000 + one notice line).
    const numberedLines: string[] = [];
    let chars = 0;
    let charCapped = false;
    for (let i = 0; i < slice.length; i++) {
      const l = slice[i];
      const line = `${String(offset + i).padStart(6)}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…[line truncated]' : l}`;
      const cost = line.length + (i > 0 ? 1 : 0); // +1 for the '\n' joining it on
      if (i > 0 && chars + cost > MAX_CHARS) { charCapped = true; break; }
      numberedLines.push(line);
      chars += cost;
    }
    const shownLines = numberedLines.length;
    const last = offset + shownLines - 1;
    ctx.servedReads?.set(servedKey, { mtimeMs: st.mtimeMs, fingerprint, callIndex: ctx.toolCallIndex ?? 0, from: offset, to: last });
    // WHY a declared bound instead of the hand-written trailer this used to carry:
    // every tool now reports paging the same way, and the "use offset=N" advice is
    // Read's own vocabulary rather than a shared string other tools inherited.
    const more = last < totalLines;
    return {
      text: numberedLines.join('\n'),
      bounds: more
        ? {
          shown: shownLines,
          total: totalLines,
          unit: 'lines' as const,
          moreHint: charCapped
            ? `~50 KB cap reached at line ${last}; use offset=${last + 1} to continue`
            : `use offset=${last + 1} to continue`,
        }
        : undefined,
    };
  },
});
