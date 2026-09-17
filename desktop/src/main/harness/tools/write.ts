import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { defineTool } from './registry';
import { canonicalize, resolveP } from './guards';
import { toHunks, preserveFormat } from './edit';
import { fingerprintOf } from './file-fingerprint';

// G-10 (2026-08-26 tools investigation): the single most common small-model
// failure in a full-file Write is a placeholder comment standing in for code
// the model could not be bothered to repeat — `// ... rest of code ...` — which
// then REPLACES that code on disk. Modelled on Gemini CLI's
// detectOmissionPlaceholders, but deliberately NARROW: the line must be nothing
// but (optional comment marker) + ellipsis + a short "the rest is elsewhere"
// phrase, so ordinary code (`foo(...args)`), a bare `// ...`, a comment that
// merely says "rest of" without an ellipsis, or prose with a leading ellipsis
// never trips it. A false positive here blocks a legitimate write outright, so
// the bias is toward missing an exotic placeholder over refusing real content.
const COMMENT_MARKER = /^(?:\/\/|#|\/\*+|\*|--|<!--|;|%|"""|''')\s*/;
const COMMENT_CLOSE = /\s*(?:\*+\/|-->|"""|''')$/;
const ELLIPSIS = /^(?:\.\.\.|…)\s*/;
const TRAILING_ELLIPSIS = /\s*(?:\.\.\.|…)$/;
// The phrase between the ellipses: a few filler words at most around one of
// the tell-tale keywords. Bounded on both sides so a real sentence can't match.
const OMISSION_PHRASE = /^(?:[\w'’-]+\s+){0,3}(?:rest of|existing (?:code|content|implementation|logic)|unchanged|remaining|omitted)(?:\s+[\w'’-]+){0,4}$/i;

/** The first line of `content` that is an omission placeholder, or null.
 *  Exported so the shape is unit-testable without touching disk. */
export function detectOmissionPlaceholder(content: string): { line: number; text: string } | null {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].replace(/\r$/, '');
    let s = text.trim();
    if (s.length > 80) continue;
    const marker = COMMENT_MARKER.exec(s);
    const hasMarker = marker !== null;
    if (marker) s = s.slice(marker[0].length);
    s = s.replace(COMMENT_CLOSE, '');
    const leading = ELLIPSIS.test(s);
    if (leading) s = s.replace(ELLIPSIS, '');
    const trailing = TRAILING_ELLIPSIS.test(s);
    if (trailing) s = s.replace(TRAILING_ELLIPSIS, '');
    if (!leading && !trailing) continue;                 // an ellipsis is required
    if (!hasMarker && !(leading && trailing)) continue;  // no marker → needs "... phrase ..."
    if (OMISSION_PHRASE.test(s.trim())) return { line: i + 1, text: text.trim() };
  }
  return null;
}

export const WriteTool = defineTool({
  name: 'Write',
  // Pause handoff §1 (WHY): changes this computer only, so a plan restart checks first.
  effect: 'local',
  // Mirrors Edit's description — same gate, so it must be described the same
  // way (2026-08-11 review round 8; see the WHY above EditTool.description).
  description:
    'Create a new file or fully overwrite an existing one. Overwriting requires that the file '
    + 'have been Read or Written by you in this session, and not have changed on disk since — '
    + 'those tools record the file\'s contents, which is what detects a stale overwrite. '
    + 'Creating a file that does not exist yet needs no prior Read. '
    + 'Always write the complete file — a placeholder like "// ... rest of code ..." is refused; '
    + 'use Edit to change part of an existing file.',
  // Compact form for small local models (simplified presentation, spec §4.2).
  shortDescription: 'Create a new file or completely overwrite an existing one with new content.',
  inputSchema: z.object({ file_path: z.string(), content: z.string() }).strict(), // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
  permissionSubject: (a) => a.file_path,
  async execute(args, ctx) {
    const abs = resolveP(args.file_path, ctx.cwd);
    const canonical = canonicalize(args.file_path, ctx.cwd);
    const exists = fs.existsSync(abs);
    const readFingerprint = ctx.readRegistry.get(canonical);
    if (exists && readFingerprint === undefined) {
      // D-4: mirrors Edit — the registry resets on resume, so name resume as a
      // cause or the model argues with a refusal its memory says is wrong.
      return {
        text: `Write rejected: ${args.file_path} already exists and you have not Read it in this session `
          + '(this also happens after a session resume — earlier reads are forgotten), '
          + 'so you would be replacing content you have not seen. Read it first (a cat/grep does not count '
          + '— the Read tool records the file\'s contents, which is what detects a later change), '
          + 'then retry.',
        isError: true,
      };
    }
    // WHY (2026-08-10 review, Claim 2 -- THE HEADLINE ITEM): Write's guard used
    // to check only registry PRESENCE ("was this path ever Read this session"),
    // never freshness -- so a read from arbitrarily long ago still satisfied it
    // even if the file changed on disk in the interim. Opus 5's transcript
    // demonstrated it concretely: it Read config/settings.toml at tool-call 11,
    // then Wrote over the whole file at tool-call 38 -- 27 calls later, with no
    // intervening touch tracked -- and got no complaint. Edit guards this exact
    // gap; mirroring it here (rather than inventing a second mechanism) keeps
    // Write and Edit internally consistent, since both tools share the same
    // "read it first" contract.
    // 2026-09-16: the comparison moved from mtime to a content fingerprint in
    // BOTH tools at once (the deferred improvement the earlier version of this
    // comment promised) — see tools/file-fingerprint.ts for the two ways mtime
    // lied. The existing bytes are read once here and reused below for the
    // format-preserving rewrite, so the check costs no extra I/O.
    const oldBuf = exists ? fs.readFileSync(abs) : null;
    if (oldBuf && fingerprintOf(oldBuf) !== readFingerprint) {
      return {
        text: `Write rejected: ${args.file_path} changed on disk since you last Read or Wrote it `
          + '(its contents no longer match what you read), so you would be overwriting changes you have '
          + 'not seen. Read it again, then retry.',
        isError: true,
      };
    }
    // G-10: refuse a placeholder-bearing write BEFORE touching disk, on new and
    // existing files alike. Same message for both — on a new file the damage is
    // nil, but the model still meant to write something it didn't, and telling
    // it the same thing keeps the rule learnable. The offending line is quoted
    // verbatim so the model can see exactly what tripped the check.
    const placeholder = detectOmissionPlaceholder(args.content);
    if (placeholder) {
      return {
        text: `Write rejected: content contains an omission placeholder on line ${placeholder.line}: `
          + `"${placeholder.text}". Writing this would replace the real content with that comment. `
          + 'Write the complete file, or use Edit to change just the part that differs.',
        isError: true,
      };
    }
    const old = oldBuf ? oldBuf.toString('utf8') : '';
    // D-5: an existing file keeps its line endings and BOM (Edit already did
    // this; Write silently converted CRLF → LF). A brand-new file is written
    // exactly as given — there is no existing format to preserve.
    const final = exists ? preserveFormat(old, args.content) : args.content;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, final);
    ctx.readRegistry.set(canonical, fingerprintOf(final));
    // Diff in LF/no-BOM space, as Edit does, so the card shows the real change
    // rather than a whole-file \r\n churn on a CRLF file.
    const lf = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).replace(/\r\n/g, '\n');
    return {
      // Says out loud that this Write satisfied the read gate (2026-08-11 review
      // round 8). It always has — the registry line above is what does it — but
      // silently, so Qwen 3.6 35B Wrote a file, Edited it successfully, and
      // reported that "Edit doesn't enforce read-first." The registration is the
      // only part of the gate's state a model can be told about in-band.
      text: `${exists ? 'Overwrote' : 'Created'} ${args.file_path} (${args.content.length} chars). `
        + 'This counts as having Read it — you can Edit it now without reading it first.',
      structuredPatch: toHunks(lf(old), lf(args.content), args.file_path),
    };
  },
});
