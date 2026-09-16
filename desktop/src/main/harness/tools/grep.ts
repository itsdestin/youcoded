// Bundled ripgrep (@vscode/ripgrep) — deterministic cross-platform search.
import { spawn } from 'child_process';
import { rgPath as bundledRgPath } from '@vscode/ripgrep';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { defineTool } from './registry';
import { resolveP, toPosix, shellCwdMissHint } from './guards';
import { CREDENTIAL_EXCLUDE_GLOBS } from './credential-paths';
import type { ResultBounds } from './types';

/** Resolve the ripgrep binary the tool will actually spawn.
 *
 * WHY (the real `spawn ENOTDIR` root cause, 2026-07-20): in the packaged app,
 * `@vscode/ripgrep` resolves `rgPath` via `createRequire(...).resolve()` to a
 * path INSIDE `app.asar` — e.g.
 *   /opt/YouCoded/resources/app.asar/node_modules/@vscode/ripgrep-linux-x64/bin/rg
 * `app.asar` is a FILE, not a directory, so that path's prefix component is not
 * a directory. `spawn()` therefore throws `spawn ENOTDIR` SYNCHRONOUSLY (before
 * any 'error' handler can attach), which is why every Grep failed in the
 * packaged app even after the earlier `cwd:` fix. electron-builder DOES unpack
 * the binary to `app.asar.unpacked/` (it auto-unpacks executables), but nothing
 * rewrote rgPath to point there. Mirror the pty-worker fix (session-manager.ts):
 * prefer the unpacked sibling when it exists, else fall back to the bundled
 * path (correct in dev, where there is no asar). Pure + exported for tests. */
export function resolveRgPath(raw: string = bundledRgPath): string {
  const unpacked = raw.replace(/app\.asar(?!\.unpacked)([/\\])/, `app.asar.unpacked$1`);
  if (unpacked !== raw && fs.existsSync(unpacked)) return unpacked;
  return raw;
}

/** Build the failure message from what ripgrep ACTUALLY said.
 *
 *  WHY (2026-08-01 review): the old code appended "Check the regex syntax." to
 *  every exit-2, including a missing-path IO error. A reviewing model got
 *  "No such file or directory ... Check the regex syntax." for a perfectly valid
 *  regex and a mistyped path. Per docs/error-message-standards.md an error is
 *  either specific and accurate or general and non-committal — never a guessed
 *  cause bolted onto a real one. */
export function grepErrorMessage(stderr: string, resolvedPath: string, cwd: string): string {
  const raw = stderr.trim() || 'ripgrep error';
  if (/regex parse error|error: (unclosed|repetition|unrecognized)/i.test(stderr)) {
    return `Grep failed: ${raw}. Check the regex syntax.`;
  }
  if (/unrecognized file type/i.test(stderr)) {
    // G-7: the `type` parameter is passed straight to rg, which is the
    // authority on its own type list — quote its verdict, then say what to do.
    return `Grep failed: ${raw}. \`type\` must be one of ripgrep's built-in type names (e.g. ts, js, py, rust, md); use \`glob\` (e.g. "*.myext") for anything else.`;
  }
  if (/No such file or directory|IO error for operation/i.test(stderr)) {
    // WHY toPosix on resolvedPath but NOT cwd (2026-08-11): `--path-separator /`
    // on the rg invocation (below) only rewrites ripgrep's OWN stdout —
    // resolvedPath never passes through rg at all, it's built locally with
    // Node's `path` module, which uses '\' on Windows. Without normalizing it,
    // a Windows "does not exist" message could read "src\a.ts" while every
    // other harness string (including rg's own matched-file output) speaks
    // forward slashes — that's a target path the model may act on, so it
    // joins the shared vocabulary. `cwd` is different: it's the workspace
    // root, reported for a human/model to recognize their own machine, not to
    // feed back into another tool call — so it keeps its native spelling
    // (Windows CI proved this the hard way when an earlier commit normalized
    // it too and broke a pinned "states the cwd" test).
    return `Grep failed: ${toPosix(resolvedPath)} does not exist. Paths resolve from the workspace root (${cwd}); pass a path relative to it, or omit \`path\` to search the whole workspace.`;
  }
  return `Grep failed: ${raw}`;
}

const MAX_COUNT = 500;

/** Which files hit `--max-count`, i.e. whose results are silently short.
 *
 *  WHY per-mode: --max-count means something different in each output mode, and
 *  in files_with_matches it cannot bind at all (`-l` stops at the first match).
 *  Reporting a cap there would be a false alarm; not reporting it in the other
 *  two modes is the silent truncation the 2026-08-01 review missed.
 *
 *  WHY `singleFile` (2026-08-10 review, item 3): ripgrep OMITS the filename
 *  column entirely when the search target is a single file rather than a
 *  directory — content-mode lines come back as bare "N:matchtext", not
 *  "file:N:matchtext" (and count-mode as a bare "500", not "file:500"). The
 *  parsing below reads the first colon-delimited token as the filename, so
 *  without this it silently misread each LINE NUMBER as a distinct one-line
 *  "file" (never reaching maxCount under any single key) — the cap-hit
 *  disclosure note never rendered for single-file Grep calls, even though the
 *  same cap fired identically. Pass the already-known target name in for that
 *  case instead of trying to parse a filename that ripgrep never printed. */
export function filesAtMaxCount(out: string, mode: string, maxCount = MAX_COUNT, singleFile?: string): string[] {
  if (mode === 'files_with_matches') return [];
  const perFile = new Map<string, number>();
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (singleFile) {
      if (mode === 'count') {
        const n = Number(line);
        if (Number.isFinite(n)) perFile.set(singleFile, n);
      } else {
        perFile.set(singleFile, (perFile.get(singleFile) ?? 0) + 1);
      }
      continue;
    }
    if (mode === 'count') {
      const at = line.lastIndexOf(':');
      if (at === -1) continue;
      const n = Number(line.slice(at + 1));
      if (Number.isFinite(n)) perFile.set(line.slice(0, at), n);
    } else {
      const at = line.indexOf(':');
      if (at === -1) continue;
      const f = line.slice(0, at);
      perFile.set(f, (perFile.get(f) ?? 0) + 1);
    }
  }
  return [...perFile.entries()].filter(([, n]) => n >= maxCount).map(([f]) => f);
}

// Fix (2026-08-10 review, following the prior-art doc's Grep-specific
// recommendation — docs/active/investigations/2026-08-10-harness-output-
// truncation-prior-art.md, "Grep / search-result policy"): content-mode Grep
// was the harness's last oversized tool result — a live run measured
// 17,860-17,898 chars from ONE pattern search, flagged BY NAME (Grok 4.5).
// Bash's own fix (~4,000-char head+tail slice, see bash.ts/truncate.ts) does
// NOT apply here: a grep result's value is COMPLETENESS of matches, and
// silently dropping matches from the middle is a correctness risk, not just a
// cost one — the model may believe it saw every occurrence. The doc's
// recommendation (also OpenCode's shipped precedent: a hardcoded 100-match
// cap, no byte cap) is to cap by MATCH COUNT instead, with an honest count of
// what was omitted.
const MAX_CONTENT_MATCHES = 100;
// Safety margin under the generic pipeline's own `maxLines: 250` cap (below,
// in GrepTool's `caps`) — WHY: a heavy -A/-B/-C value can blow past 250 lines
// well before MAX_CONTENT_MATCHES matches are reached (e.g. -C 5 = 11 content
// lines + 1 "--" separator = 12 lines/match; 100 matches = 1,200 lines).
// Without also watching total lines here, the GENERIC pipeline cap in
// registry.ts would fire on top of ours and middle-elide with an 80/20
// head/tail split that can land mid-context — silently discarding the back
// half of a context block we deliberately kept whole below. Stopping at 200
// (not 250) leaves margin so OUR match-aware, context-preserving cut is what
// the model actually sees; the generic cap becomes a rare last-resort backstop.
const CONTENT_LINE_SAFETY = 200;

/** Classify one line of ripgrep CONTENT-mode output.
 *
 *  WHY a repeated-delimiter regex, not `line.indexOf(':')` (this fix):
 *  ripgrep's own format is POSITIONAL — a match line is `path:N:text` (or
 *  bare `N:text` for a single-file target, matching filesAtMaxCount's own
 *  singleFile branch above); a `-A`/`-B`/`-C` CONTEXT line is `path-N-text`
 *  (or bare `N-text`) — same shape, hyphen instead of colon. A path
 *  containing its own ':' or '-' (a Windows drive letter, a hyphenated
 *  filename) can't produce a false match: requiring the SAME delimiter both
 *  before and after a run of digits only lines up at the real line-number
 *  field, and JS regex backtracking finds that position even past an earlier
 *  false delimiter earlier in the line. A lone "--" is ripgrep's own group
 *  separator between non-adjacent context windows. */
function classifyContentLine(line: string, singleFile?: string): 'match' | 'context' | 'separator' | 'other' {
  if (line === '--') return 'separator';
  if (singleFile) {
    const m = /^(\d+)([:-])/.exec(line);
    if (!m) return 'other';
    return m[2] === ':' ? 'match' : 'context';
  }
  const m = /^.*?([:-])(\d+)\1/.exec(line);
  if (!m) return 'other';
  return m[1] === ':' ? 'match' : 'context';
}

export interface ContentCapResult {
  text: string;
  /** Matches actually kept. */
  matchesShown: number;
  /** Matches present in `out` BEFORE capping — see the `total` honesty note
   *  at the call site: this is only the TRUE global total when nothing else
   *  (the char/line capture buffer, or ripgrep's own --max-count) already
   *  trimmed `out` before this function ever saw it. */
  matchesTotal: number;
  truncated: boolean;
}

/** Trim CONTENT-mode ripgrep output to at most `maxMatches` matches, never
 *  cutting a KEPT match's context short.
 *
 *  The cut only ever lands at a MATCH or SEPARATOR line — context lines
 *  (from -A/-B/-C) are always let through once their match has been counted,
 *  so an included match's full requested context is always intact. This also
 *  means a single "group" with many matches close enough for ripgrep to merge
 *  their context windows (no "--" between them) can push slightly past
 *  `maxMatches` or `CONTENT_LINE_SAFETY` — accepted, because the alternative
 *  (splitting mid-group) is the exact honesty problem this function exists to
 *  avoid. Two independent stop conditions: `maxMatches` (the common case, no
 *  or light context) and `CONTENT_LINE_SAFETY` (a heavy -C run that would
 *  otherwise blow past hundreds of lines before reaching `maxMatches`
 *  matches) — see CONTENT_LINE_SAFETY's own WHY comment above. */
export function capContentMatches(out: string, maxMatches: number, singleFile?: string): ContentCapResult {
  const lines = out.split('\n');
  let matchesTotal = 0;
  for (const line of lines) if (classifyContentLine(line, singleFile) === 'match') matchesTotal++;
  // Fix: the short-circuit used to check ONLY matchesTotal, which misses the
  // exact scenario CONTENT_LINE_SAFETY exists for — a heavy -C run can stay
  // well under `maxMatches` matches while its context lines push `lines.length`
  // past the line-safety margin (60 matches * (11 context + 1 separator) =
  // 720 lines, way over 200, while 60 < 100 matches). Both conditions must
  // hold for "nothing to cap" to be true.
  if (matchesTotal <= maxMatches && lines.length <= CONTENT_LINE_SAFETY) {
    return { text: out, matchesShown: matchesTotal, matchesTotal, truncated: false };
  }
  const kept: string[] = [];
  let matchesShown = 0;
  for (const line of lines) {
    const kind = classifyContentLine(line, singleFile);
    if (kind === 'match' || kind === 'separator') {
      // Only a match/separator line can END the kept region — this is what
      // guarantees a kept match's context (pure 'context'/'other' lines,
      // which fall to the `else` below) is never partially included.
      if (matchesShown >= maxMatches || kept.length >= CONTENT_LINE_SAFETY) break;
      if (kind === 'match') matchesShown++;
    }
    kept.push(line);
  }
  return { text: kept.join('\n'), matchesShown, matchesTotal, truncated: true };
}

export const GrepTool = defineTool({
  name: 'Grep',
  description:
    'Search file contents with a regex (ripgrep). output_mode: "content" (matching lines), "files_with_matches" (default), or "count". ' +
    // Fix (2026-08-10 review — this fix, see MAX_CONTENT_MATCHES above): a
    // live run measured 17,860-17,898 chars of content-mode output from ONE
    // search, flagged by name (Grok 4.5). Stated here so the model knows the
    // shape of the limit up front rather than discovering it after the call.
    'In "content" mode, output stops after the first 100 matches (each with its full requested ' +
    'context, never cut short) — narrow the pattern, add a `glob` filter, or use output_mode: "count" for an exhaustive total.',
  // Compact form for small local models (simplified presentation, spec §4.2).
  shortDescription: 'Search file contents with a regular expression.',
  // Fix (2026-08-10 review, item 5): `path`, `pattern`, and `output_mode` had
  // no `.describe()` at all — DeepSeek inferred a (nonexistent) difference
  // between Grep's `path` and Glob's `path` purely from that absence, since
  // verification showed both mean the identical thing (the search-root
  // directory) in code. `path` here uses the SAME wording as Glob's for that
  // reason. `-A`/`-B`/`-C` (item 4) are named to match Claude Code's own
  // parameter shape exactly, not a synthesized `context` field, since our
  // tool surface is explicitly meant to mirror CC's.
  inputSchema: z.object({
    pattern: z.string().describe('Regular expression pattern to search for in file contents (Rust regex syntax, via ripgrep).'),
    path: z.string().optional().describe('The directory to search in (relative to the working directory). Defaults to the current directory.'),
    glob: z.string().optional().describe('Filter files, e.g. "*.ts"'),
    output_mode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe('"content" prints matching lines, "files_with_matches" (default) lists file paths only, "count" reports an exhaustive match total per file.'),
    '-A': z.number().int().nonnegative().optional().describe('Number of lines of context to show AFTER each match (like ripgrep/grep -A). Only affects output_mode: "content".'),
    '-B': z.number().int().nonnegative().optional().describe('Number of lines of context to show BEFORE each match (like ripgrep/grep -B). Only affects output_mode: "content".'),
    '-C': z.number().int().nonnegative().optional().describe('Number of lines of context to show before AND after each match (like ripgrep/grep -C). Only affects output_mode: "content".'),
    // Ledger G-7 (2026-08-26 native-tools investigation): the four ripgrep
    // flags every other harness exposes and models keep trying to send. All
    // straight pass-throughs; names match Claude Code's so a CC-trained model
    // guesses right. Strict schema (D-2) means a wrong guess is now an error
    // naming these, not a silently case-sensitive search.
    ignore_case: z.boolean().optional().describe('Case-insensitive search (ripgrep -i). Default: case-sensitive.'),
    literal: z.boolean().optional().describe('Treat `pattern` as a fixed string, not a regex (ripgrep -F) — for text containing . ( [ * etc.'),
    type: z.string().min(1).optional().describe('Search only files of this ripgrep type, e.g. "ts", "js", "py", "rust", "md" (ripgrep --type). Use `glob` for anything not in ripgrep\'s built-in type list.'),
    multiline: z.boolean().optional().describe('Let the pattern span lines: `.` also matches a newline (ripgrep -U --multiline-dotall). Default: one line at a time.'),
  }).strict(), // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
  caps: { maxChars: 30_000, maxLines: 250 },
  // Static fallback for composeNotice's no-bounds branch (Task 19): this is the
  // MEASURED common case, not a rare edge — a one-file, 400-match, content-mode
  // search never sets `bounds` (nothing was dropped at the FILE/match level),
  // but `maxLines: 250` above still caps the pipeline's LINE count while
  // composeNotice only had a char count to report. Verbatim copy of the
  // `bounds.moreHint` string below.
  moreHint: 'narrow the pattern, add a glob filter, or use output_mode: "count"',
  permissionSubject: (a) => a.path ?? '.',
  async execute(args, ctx) {
    const mode = args.output_mode ?? 'files_with_matches';
    // `--path-separator /` (2026-08-11): rg prints paths with the PLATFORM
    // separator, so Windows returned `src\a.ts` while Glob returned `src/a.ts`
    // for the same file — one file, two shapes, unpipeable between the tools.
    // Set here at construction so it covers every output_mode. Do NOT
    // hand-normalize rg's stdout instead: in content mode a line is
    // `path:line:text` and the MATCHED TEXT can itself contain backslashes and
    // colons, so string surgery would corrupt real matches. Inert on
    // Linux/macOS, which already print '/'.
    const rgArgs = ['--no-config', '--hidden', '--glob', '!.git', '--path-separator', '/'];
    // Fix (2026-08-10 review, item 2): `--max-count` used to be passed
    // UNCONDITIONALLY, including for count mode — so ripgrep itself stopped
    // counting a file at 500 matches, and the true total (e.g. 2,400 in the
    // review battery's fixture) was never computed anywhere in the pipeline.
    // That is not a display cap on an already-complete count; there was no
    // real number to recover after the fact. Claude Code's count mode is an
    // exhaustive total (its docs: the count "covers every match even when
    // head_limit/offset truncate the listed entries"), so we only cap what is
    // PRINTED (content/files_with_matches), never what is COUNTED.
    if (mode !== 'count') rgArgs.push('--max-count', String(MAX_COUNT));
    if (mode === 'files_with_matches') rgArgs.push('-l');
    if (mode === 'count') rgArgs.push('--count');
    if (mode === 'content') rgArgs.push('-n');
    if (args.glob) rgArgs.push('--glob', args.glob);
    // Fix (2026-08-10 review, item 4): straight pass-through to ripgrep's own
    // flags, matching Claude Code's exact parameter names. Verified these are
    // harmless no-ops when combined with --count/-l (ripgrep 15.0.0: `rg -C 1
    // --count` still prints a bare count, `rg -C 1 -l` still lists just the
    // path) — no need to gate these by output_mode ourselves.
    if (args['-C'] != null) rgArgs.push('-C', String(args['-C']));
    if (args['-A'] != null) rgArgs.push('-A', String(args['-A']));
    if (args['-B'] != null) rgArgs.push('-B', String(args['-B']));
    // G-7 flags — pass-throughs, only ever added when set, so an omitted flag
    // leaves the rg command line byte-identical to before.
    if (args.ignore_case) rgArgs.push('-i');
    if (args.literal) rgArgs.push('-F');
    // `--type=NAME` as ONE token (not `--type NAME`): a type value that itself
    // starts with "-" can then never be read by rg as a separate flag. rg
    // validates the name and reports an unknown one on stderr (see
    // grepErrorMessage) — no local copy of `rg --type-list` to drift.
    if (args.type) rgArgs.push(`--type=${args.type}`);
    if (args.multiline) rgArgs.push('-U', '--multiline-dotall');
    // Credential-directory exclusions (2026-09-10 security review). `--hidden`
    // above means a search rooted at a PARENT of ~/.aws (whose own path the guard
    // let through) would otherwise read the secret file. Pushed LAST so ripgrep,
    // which lets the last matching glob win, cannot have them re-included by a
    // caller glob like `**/.aws/credentials`.
    for (const glob of CREDENTIAL_EXCLUDE_GLOBS) rgArgs.push('--glob', glob);
    // Hoisted so the exit-2 error message (below) can name the exact path that
    // failed, instead of a context-free "ripgrep error".
    const resolvedTarget = resolveP(args.path ?? '.', ctx.cwd);
    // WHY a relative target: rg echoes back whatever form it was given, so an
    // absolute target made Grep print absolute paths while Glob printed relative
    // ones — the same file, two shapes, unpipeable between tools (2026-08-01
    // review). rg already runs with `cwd: ctx.cwd`, so a relative target is
    // equivalent. Targets OUTSIDE the workspace (reachable via the
    // external_directory ask) stay absolute, which is the truthful form there.
    // path.relative returns '' when the target IS cwd — map that to '.' rather
    // than falling through to the (also correct, but needlessly verbose) absolute form.
    const rel = path.relative(ctx.cwd, resolvedTarget);
    // Fix (Critical 2, 2026-08-06 review): rg echoes back exactly the path
    // argument it was given, and the old code passed '.' explicitly for the
    // "target is cwd" case — so a default, whole-workspace Grep printed
    // "./src/a.ts" while Glob (which never passes a path to fs.readdir)
    // printed "src/a.ts" for the SAME file: one file, two shapes, unpipeable
    // between the tools. Omitting the path argument entirely lets rg default
    // to its own cwd (already pinned via `cwd: ctx.cwd` in spawn() below) and
    // emit the same bare relative form Glob uses. Explicit relative/absolute
    // targets are unaffected — still passed through so rg reports them as-is.
    const searchTarget = rel === '' ? null : (!rel.startsWith('..') && !path.isAbsolute(rel) ? rel : resolvedTarget);
    if (searchTarget !== null) rgArgs.push('--', args.pattern, searchTarget);
    else rgArgs.push('--', args.pattern);
    // Fix (2026-08-10 review, item 3): ripgrep drops the filename column
    // entirely when the search target is a single FILE rather than a
    // directory — filesAtMaxCount() (above) can't recover a name that was
    // never printed, so give it the one we already know. `searchTarget` is
    // guaranteed non-null here whenever this branch matters: the only way it
    // is null is `rel === ''` (target IS ctx.cwd), and a cwd is always a
    // directory, never a file. Best-effort: a race between rg exiting and
    // this stat (file deleted mid-search) just means the note falls back to
    // its prior (safe) behavior of not firing, not a crash.
    let singleFileLabel: string | undefined;
    try {
      // WHY toPosix here (2026-08-11): same gap as grepErrorMessage above —
      // `--path-separator /` only reaches rg's stdout, and this label is built
      // from `searchTarget`/`resolvedTarget` (Node's `path` module, platform
      // separator on Windows), not parsed out of rg's output. singleFileLabel
      // flows into the filesAtMaxCount/capContentMatches truncation notes, so
      // without this a Windows nested-file search could print `src\a.ts` in
      // the disclosure note while rg's own matched lines print `src/a.ts`.
      if (fs.statSync(resolvedTarget).isFile()) singleFileLabel = toPosix(searchTarget ?? resolvedTarget);
    } catch {
      /* raced delete or genuinely gone — treat as not-a-single-file */
    }
    return new Promise((resolve) => {
      // Two spawn defenses, both learned from `spawn ENOTDIR` (2026-07-20):
      //  1. `cwd: ctx.cwd` explicitly — never inherit the Electron main process's
      //     ambient cwd (the original PR #172 fix; still correct).
      //  2. `resolveRgPath()` — rewrite an inside-asar rgPath to the unpacked
      //     binary (the ACTUAL root cause; see resolveRgPath above).
      const rgBin = resolveRgPath();
      // spawn() throws SYNCHRONOUSLY when the command path or cwd has a
      // non-directory prefix (e.g. an inside-asar binary path). That throw happens
      // before the 'error' handler below can attach, so it must be caught here —
      // otherwise it escapes to defineTool as a context-free `Grep failed: spawn
      // <CODE>` that hides which path/cwd was at fault.
      let child;
      try {
        // stdin: 'ignore' — WHY (found while verifying Critical 2's fix): with
        // Node's default stdio, fd 0 is an open, un-piped-into pipe. When no
        // path argument is present (the new omit-path branch above), ripgrep's
        // own heuristic is "no path + stdin is not a tty ⇒ search stdin, not
        // the cwd" — so the child spawned and then blocked forever waiting for
        // stdin input that would never arrive, hanging every default Grep
        // call. Explicit path/absolute targets never hit this (rg only applies
        // the heuristic when no path is given), so this is safe for those too.
        child = spawn(rgBin, rgArgs, { cwd: ctx.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e: any) {
        resolve({ text: `Grep failed: could not start ripgrep (${e?.message ?? e}; rg=${rgBin}; cwd=${ctx.cwd}).`, isError: true });
        return;
      }
      // Same honest-total scheme as Bash: count every byte, retain a bounded
      // head + tail. The old flat 200k ceiling made the reported total a lie —
      // it silently dropped everything past 200k with no notice at all.
      let head = '';
      let tailBuf = '';
      let totalChars = 0;
      let err = '';
      child.stdout.on('data', (d) => {
        const s = String(d);
        totalChars += s.length;
        if (head.length < 24_000) head += s;
        else tailBuf = (tailBuf + s).slice(-6_000);
      });
      child.stderr.on('data', (d) => {
        err += String(d);
      });
      const onAbort = () => child.kill('SIGKILL');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      // Surface a spawn-level failure (rg missing, bad cwd) with the cwd actually
      // used, instead of letting it escape to defineTool's catch as a bare
      // `spawn <CODE>` — which hid this bug's cause for a whole session.
      child.on('error', (e) => {
        ctx.signal.removeEventListener('abort', onAbort);
        resolve({ text: `Grep failed: could not start ripgrep (${e.message}; cwd=${ctx.cwd}).`, isError: true });
      });
      child.on('close', (code) => {
        ctx.signal.removeEventListener('abort', onAbort);
        // An interrupt SIGKILLs rg → exit code null (not 2). Surface it as a
        // cancellation like Bash does, rather than resolving the partial output
        // as a successful search.
        if (ctx.signal.aborted) {
          resolve({ text: 'Canceled: the user interrupted this search.', isError: true });
          return;
        }
        // rg exit 1 = no matches (not an error); 2 = real error.
        if (code === 2) {
          let msg = grepErrorMessage(err, resolvedTarget, ctx.cwd);
          // Fix (two independent 2026-08 harness reviews, Grok 4.5 + Qwen 3.8
          // Max — see guards.ts's WHY block above shellCwdMissHint): only worth
          // checking when ripgrep's OWN message says the path is missing (the
          // same test grepErrorMessage uses internally, just re-run here since
          // grepErrorMessage's 3-arg signature is pinned by existing tests) — a
          // regex-syntax exit-2 has nothing to do with cwd resolution, and
          // firing there would be exactly the "wrong suggestion worse than
          // none" failure mode the reviews warned about.
          if (/No such file or directory|IO error for operation/i.test(err)) {
            const hint = shellCwdMissHint(args.path ?? '.', ctx, (p) => fs.existsSync(p));
            msg += hint;
          }
          resolve({ text: msg, isError: true });
          return;
        }
        // Fix (Critical 1, 2026-08-06 review): the old `dropped` check compared
        // `totalChars` (a raw byte/char count) against `out.length` where `out`
        // is `.trim()`-ed — and ripgrep always terminates non-empty stdout with
        // a trailing '\n', which trim() strips on EVERY successful run whether
        // or not anything was actually dropped. That made `totalChars ===
        // out.length + 1` universally true, firing a fabricated truncation
        // notice ("showing 10 of 11 chars — narrow the pattern...") on 100% of
        // non-empty results, including ones that returned everything. Compare
        // against the UNTRIMMED accumulator instead: head/tailBuf together
        // equal every char received UNLESS the head cap was actually exceeded
        // (tailBuf only holds a bounded rolling window in that case) — the same
        // scheme bash.ts uses for its own `rawLen` check.
        const joined = tailBuf ? `${head}\n[...]\n${tailBuf}` : head;
        const dropped = totalChars > joined.length;
        const out = joined.trim();
        // Fix (2026-08-10 review, item 2/3): count mode no longer passes
        // `--max-count` (see above), so it is exhaustive and there is nothing
        // to disclose — calling filesAtMaxCount for it would be checking a
        // cap that no longer applies. The disclosure note is still needed for
        // content mode (files_with_matches never sets it; filesAtMaxCount
        // already excludes that mode internally), where --max-count still
        // caps what gets PRINTED.
        const capped = mode === 'count' ? [] : filesAtMaxCount(out, mode, MAX_COUNT, singleFileLabel);
        if (!out) {
          resolve({ text: 'No matches found.' });
          return;
        }

        // Fix (2026-08-10 review — this fix, see MAX_CONTENT_MATCHES above):
        // content mode used to hand back everything up to the GENERIC
        // pipeline caps (30,000 chars / 250 lines) with no bounds of its own —
        // this is what let the 17,860-char case through. Cap by MATCH COUNT
        // instead, computed on the ORIGINAL `out` (same input filesAtMaxCount
        // already used above) so the per-file --max-count disclosure keeps
        // working unchanged — only the DISPLAYED text is trimmed further.
        let displayText = out;
        let matchBounds: ResultBounds | undefined;
        if (mode === 'content') {
          const capResult = capContentMatches(out, MAX_CONTENT_MATCHES, singleFileLabel);
          if (capResult.truncated) {
            displayText = capResult.text;
            matchBounds = {
              shown: capResult.matchesShown,
              // Only claim an EXACT total when NOTHING else already trimmed
              // `out` before this ran: not the char/line capture buffer
              // (`dropped`), and not ripgrep's own per-file --max-count
              // (`capped.length`). Either one means capResult.matchesTotal is
              // a FLOOR, not the real total — composeNotice's `total: null`
              // path already renders "more may exist — exact total unknown"
              // for exactly this case (2026-08-06 review precedent), so reuse
              // it rather than inventing a number we didn't measure.
              total: !dropped && capped.length === 0 ? capResult.matchesTotal : null,
              unit: 'matches',
              moreHint: 'narrow the pattern, add a glob filter, or use output_mode: "count"',
            };
          }
        }

        resolve({
          text: capped.length
            ? `${displayText}\n\nNote: these files hit the ${MAX_COUNT}-matches-per-file limit and have more: ${capped.join(', ')}`
            : displayText,
          // matchBounds (content mode's own match-count cap) takes priority
          // over the char-drop bounds below — when BOTH could apply (a
          // pathological single huge match line blowing the char buffer AND
          // exceeding the match cap), the match-count framing is the more
          // useful and specific one for a search tool; the char-drop branch
          // stays as the fallback for cases matchBounds never fires (e.g.
          // files_with_matches/count modes, or a content search under 100
          // matches whose lines are individually enormous).
          bounds:
            matchBounds ??
            (dropped
              ? {
                  // Fix: `out.length` used to include the synthetic "\n[...]\n"
                  // separator (7 chars) inserted between head and tail — that
                  // separator is harness plumbing, not ripgrep output, so
                  // counting it overstated how much real content was shown.
                  shown: out.length - 7,
                  total: totalChars,
                  unit: 'chars' as const,
                  moreHint: 'narrow the pattern, add a glob filter, or use output_mode: "count"',
                }
              : undefined),
        });
      });
    });
  },
});
