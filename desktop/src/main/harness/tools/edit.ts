import * as fs from 'fs';
import { z } from 'zod';
import { structuredPatch } from 'diff';
import { defineTool } from './registry';
import { canonicalize, resolveP } from './guards';
import type { StructuredPatchHunk } from '../../../shared/types';

/** jsdiff → the reducer's StructuredPatchHunk shape (same fields; keep explicit). */
export function toHunks(oldText: string, newText: string, filePath: string): StructuredPatchHunk[] {
  return structuredPatch(filePath, filePath, oldText, newText).hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }));
}

/** Detect and preserve line endings + BOM (Windows repos — spec §2.3).
 *  Exported (D-5, 2026-08-26) so Write's overwrite path applies the SAME rule —
 *  before that a Write over a CRLF file silently converted it to LF. */
export function preserveFormat(original: string, edited: string): string {
  const hasBom = original.charCodeAt(0) === 0xfeff;
  const crlf = original.includes('\r\n');
  let out = edited;
  // A CRLF file stays UNIFORMLY CRLF regardless of what the model puts in
  // new_string. We normalize any \r\n back to \n first, then expand every \n —
  // so a new_string that itself contains \r\n (or one that's pure \n) both land
  // as clean CRLF. The old `!out.includes('\r\n')` guard skipped re-expansion
  // whenever new_string carried even one \r\n, leaving the unchanged lines as LF
  // (a mixed, corrupted file). Matching already happens in LF space (see execute).
  if (crlf) out = out.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  if (hasBom && out.charCodeAt(0) !== 0xfeff) out = '﻿' + out;
  return out;
}

export const EditTool = defineTool({
  name: 'Edit',
  // Pause handoff §1 (WHY): changes this computer only, so a plan restart checks first.
  effect: 'local',
  // WHY the gate is spelled out rather than stated as a rule (2026-08-11 review
  // round 8): four of six reviewing models misdiagnosed this gate, and each
  // blamed something different — "Edit doesn't enforce read-first" (it had
  // Written the file, which counts), "the gate is Grep-transparent" (it had Read
  // the file earlier), "enforcement is inconsistent — priority fix" (it had Read
  // a slice, which counts). The gate was correct every time; its STATE is
  // invisible, so a model cannot predict whether an Edit will be accepted and
  // guesses at why one was refused. Naming what satisfies it — and that a
  // `cat` does not, because the stamp is an mtime and only the tools record one
  // — is the whole fix.
  description:
    'Replace an exact string in a file. old_string must match exactly once (or pass replace_all). '
    + 'This file must have been Read or Written by you in this session first, and not have changed on '
    + 'disk since — those tools record the file\'s modification time, which is what detects a stale edit. '
    + 'Viewing the file another way (cat, grep) does not count: it records no timestamp.',
  // Compact form for small local models (simplified presentation, spec §4.2).
  shortDescription: 'Replace an exact string in a file with new text.',
  // G-4 (2026-08-26 tools investigation): these were bare. Every peer harness
  // describes them, and the two rules that matter most live on old_string —
  // Read prints a `%6d\t` line-number prefix that a small model copies verbatim
  // into old_string and then gets "not found" with no hint why; and a huge
  // old_string wastes output tokens for no extra precision.
  inputSchema: z.object({
    file_path: z.string().describe('Absolute or workspace-relative path of the file to edit'),
    old_string: z.string().describe(
      'The exact text to replace. Must match exactly once in the file (or pass replace_all). '
      + 'Do NOT include the line-number prefix that Read prints (the number and the tab after it) — '
      + 'copy only the text after the tab. Keep it minimal: usually 1-3 lines, just enough to be unique.',
    ),
    new_string: z.string().describe('The replacement text (inserted literally, whitespace preserved)'),
    replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match'),
  }).strict(), // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
  permissionSubject: (a) => a.file_path,
  async execute(args, ctx) {
    const abs = resolveP(args.file_path, ctx.cwd);
    const canonical = canonicalize(args.file_path, ctx.cwd);
    // Read-before-edit gate (spec §2.3): the single rule that prevents blind overwrites.
    const readMtime = ctx.readRegistry.get(canonical);
    if (readMtime === undefined) {
      // Says WHICH tools satisfy the gate and why a shell view doesn't — the
      // old message named only Read, and a model that had `cat`'d the file read
      // the refusal as arbitrary. See the WHY above the description.
      // D-4: the registry RESETS on resume (types.ts readRegistry), so this is
      // also the first thing a model sees after resuming a session where it
      // genuinely did Read the file — say so, or it argues instead of re-reading.
      return {
        text: `Edit rejected: ${args.file_path} has not been Read or Written by you in this session `
          + '(this also happens after a session resume — earlier reads are forgotten). '
          + 'Read it first (a cat/grep does not count — the Read tool records the file\'s modification '
          + 'time, which is what detects a later change), then retry.',
        isError: true,
      };
    }
    if (fs.statSync(abs).mtimeMs !== readMtime) {
      return {
        text: `Edit rejected: ${args.file_path} changed on disk since you last Read or Wrote it `
          + '(its modification time no longer matches), so your old_string may be stale. '
          + 'Read it again, then retry.',
        isError: true,
      };
    }
    const original = fs.readFileSync(abs, 'utf8');
    // Strip a BOM for matching so old_string anchors don't mysteriously miss at byte 0.
    const body = original.charCodeAt(0) === 0xfeff ? original.slice(1) : original;
    // Fix (CRLF defect): match in LF space. Read output shows LF only — the model
    // literally cannot see (and so cannot reproduce) the invisible \r in a CRLF
    // file, so a multi-line old_string with \n would ALWAYS miss a \r\n file and
    // fail "old_string not found". We normalize the body to LF for matching +
    // replacement (old_string/new_string stay literal); preserveFormat(original,…)
    // then re-expands the all-LF result back to the file's real endings and
    // restores the BOM. Caveat: a MIXED-endings file that still contains a \r\n
    // after editing skips re-expansion (preserveFormat's `!out.includes('\r\n')`
    // guard), leaving the edited region LF — acceptable, mixed files are already broken.
    const lfBody = body.replace(/\r\n/g, '\n');
    const count = lfBody.split(args.old_string).length - 1;
    if (count === 0)
      return {
        text: 'Edit failed: old_string not found. Re-Read the file and copy the exact text, including whitespace.',
        isError: true,
      };
    if (count > 1 && !args.replace_all) {
      return {
        text: `Edit failed: old_string matches ${count} times. Add surrounding context to make it unique, or pass replace_all: true.`,
        isError: true,
      };
    }
    // Fix (flagged bug): split/join for replace_all AND a REPLACER FUNCTION for the
    // single-replace path — String.prototype.replace treats `$&`/`$1`/`$$` in the
    // replacement string as special patterns, which would corrupt new_string. A
    // function replacer (and split/join) inserts new_string literally.
    const edited = args.replace_all
      ? lfBody.split(args.old_string).join(args.new_string)
      : lfBody.replace(args.old_string, () => args.new_string);
    // Diff the LF pair so hunks show only the real change, not a whole-file \r\n churn.
    const hunks = toHunks(lfBody, edited, args.file_path);
    // WHY (2026-08-10 review, Claim 6): old_string === new_string (or any
    // replacement that happens to produce byte-identical output) used to write
    // the file anyway and return the same generic "Edited X." text a real edit
    // gets -- Grok hit this exact shape (old_string: 'shared token', new_string:
    // 'shared token', replace_all: true) and got no signal anything was wrong.
    // `hunks` already carries the true empty-diff signal (structuredPatch), but
    // that's a side-channel the model doesn't read as prose. Surface it in the
    // text explicitly instead, and skip the pointless identical-bytes rewrite.
    if (hunks.length === 0) {
      return {
        text: `Edited ${args.file_path}: 0 replacements — old_string and new_string are identical, nothing changed.`,
        structuredPatch: hunks,
      };
    }
    const final = preserveFormat(original, edited);
    fs.writeFileSync(abs, final);
    ctx.readRegistry.set(canonical, fs.statSync(abs).mtimeMs); // our own write stays "read"
    return { text: `Edited ${args.file_path}.`, structuredPatch: hunks };
  },
});
