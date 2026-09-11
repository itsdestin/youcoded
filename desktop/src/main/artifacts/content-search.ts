// Project-wide CONTENT search for the Files tab (roadmap follow-up to the
// Tier 1 code editor; design decision 2026-07-22: no name/contents toggle —
// the renderer ranks name matches above these content hits in ONE list).
//
// Engine: the bundled @vscode/ripgrep the agent's Grep tool already uses.
// This module spawns it with --json for STRUCTURED results (grep.ts returns
// raw stdout because its consumer is a model; a UI needs line numbers and
// snippets it can render). The hard-won spawn defenses carry over from
// grep.ts: explicit cwd (never inherit Electron's ambient cwd), resolveRgPath
// (an inside-asar binary path throws spawn ENOTDIR synchronously), and the
// synchronous try/catch around spawn itself.
//
// The QUERY IS LITERAL TEXT (-F), case-insensitive: this is a user typing
// words they remember into a search box, not a regex surface. Desktop-only —
// Android has no ripgrep binary (D2), the Kotlin side is a stub.
import { spawn } from 'child_process';
import { SENSITIVE_SEGMENTS, SENSITIVE_BASENAMES, SENSITIVE_SUBPATHS } from '../../shared/artifacts/editable-path-policy';
import { resolveRgPath } from '../harness/tools/grep';

export interface ContentHit {
  /** Project-relative path, forward slashes. */
  path: string;
  /** 1-indexed line number of the match. */
  line: number;
  /** The matching line, trimmed and capped for display. */
  text: string;
}

export interface ContentSearchResult {
  ok: boolean;
  hits: ContentHit[];
  /** True when a cap cut the result set — the UI should say "showing first N". */
  truncated: boolean;
  error?: string;
}

/** Total hits returned to the renderer — a search box, not an audit tool. */
export const MAX_HITS = 200;
/** Per-file cap so one giant log file cannot eat the whole result budget. */
const MAX_PER_FILE = 20;
/** Stdout accumulation gate (the grep.ts 200KB lesson, scaled for --json
 * verbosity) — kill the process rather than buffer unboundedly. */
const MAX_STDOUT_BYTES = 1_000_000;
/** Wall-clock kill switch; rg is fast, a hung mount should not hang the UI. */
const TIMEOUT_MS = 5000;
const SNIPPET_MAX_CHARS = 200;

/** Parse one line of `rg --json` output into a hit, or null for the other
 * event types (begin/end/summary) and malformed lines. Pure — unit-pinned. */
/**
 * ripgrep globs for the sensitive set (shared/artifacts/editable-path-policy):
 * a bare name matches that file or directory at any depth, the subpaths are
 * anchored with `**`, and dotenv is the same trio isDotenvBasename accepts.
 * Built from the shared sets so the search cannot drift from the reads.
 */
const SENSITIVE_GLOBS: readonly string[] = [
  ...[...SENSITIVE_SEGMENTS].map((seg) => `!${seg}`),
  ...[...SENSITIVE_BASENAMES].map((base) => `!${base}`),
  '!.env', '!.env.*', '!.envrc',
  ...SENSITIVE_SUBPATHS.map((sub) => `!**${sub}**`),
];

export function parseRgJsonLine(line: string): ContentHit | null {
  if (!line) return null;
  let evt: any;
  try {
    evt = JSON.parse(line);
  } catch {
    return null;
  }
  if (evt?.type !== 'match') return null;
  const path = evt.data?.path?.text;
  const lineNumber = evt.data?.line_number;
  const text = evt.data?.lines?.text;
  if (typeof path !== 'string' || typeof lineNumber !== 'number' || typeof text !== 'string') return null;
  return {
    // rg reports "./x" for a "." search root — strip it so paths line up with
    // the artifact records the renderer compares against.
    path: path.replace(/\\/g, '/').replace(/^\.\//, ''),
    line: lineNumber,
    text: text.trim().slice(0, SNIPPET_MAX_CHARS),
  };
}

export function searchProjectContent(projectRoot: string, query: string): Promise<ContentSearchResult> {
  const q = query.trim();
  if (!q) return Promise.resolve({ ok: true, hits: [], truncated: false });

  const rgArgs = [
    '--no-config', '--hidden', '--json',
    '-F', '-i',                          // literal, case-insensitive
    '--max-count', String(MAX_PER_FILE),
    // rg respects .gitignore in git projects; these keep non-git projects from
    // drowning in dependency/bookkeeping noise and match the discovery pass.
    '--glob', '!.git', '--glob', '!.youcoded', '--glob', '!node_modules',
    // The same private paths artifacts:get and read-binary refuse. WHY here
    // too: `--hidden` walks dot-directories, so a search for "BEGIN" inside a
    // root that holds .ssh or .env used to print the matching lines of the very
    // files every other read hides — and over remote access (batch 3) a phone
    // can search a root (2026-09-10 review of T6, finding 1).
    ...SENSITIVE_GLOBS.flatMap((g) => ['--glob', g]),
    '--', q, '.',
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveRgPath(), rgArgs, { cwd: projectRoot, windowsHide: true });
    } catch (e: any) {
      // Surface the REAL failure (error-message-standards) — the renderer
      // shows res.error verbatim when it is present.
      resolve({ ok: false, hits: [], truncated: false, error: `could not start ripgrep (${e?.message ?? e})` });
      return;
    }

    const hits: ContentHit[] = [];
    let truncated = false;
    let bytes = 0;
    let buffer = '';
    let settled = false;

    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(error ? { ok: false, hits, truncated, error } : { ok: true, hits, truncated });
    };
    const timer = setTimeout(() => {
      truncated = true;
      child.kill('SIGKILL');
      finish();
    }, TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => {
      bytes += d.length;
      buffer += d.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const hit = parseRgJsonLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (hit) {
          if (hits.length >= MAX_HITS) {
            truncated = true;
            child.kill('SIGKILL');
            finish();
            return;
          }
          hits.push(hit);
        }
      }
      if (bytes > MAX_STDOUT_BYTES) {
        truncated = true;
        child.kill('SIGKILL');
        finish();
      }
    });
    child.on('error', (e: any) => finish(`ripgrep failed to run (${e?.message ?? e})`));
    child.on('close', (code) => {
      // Exit 1 = no matches (not an error); null = we killed it (caps/timeout).
      const tail = parseRgJsonLine(buffer);
      if (tail && hits.length < MAX_HITS) hits.push(tail);
      if (code !== null && code !== 0 && code !== 1) finish(`ripgrep exited with code ${code}`);
      else finish();
    });
  });
}
