// PTY-less exec (spec §2.3): none of the ConPTY 56-byte machinery applies —
// that is a CC-TUI constraint, not an exec constraint.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
// `which` ships no type declarations and @types/which is not a dependency here.
// Kept as a static import (not require) so the module-mocking layer can reach it
// — that is what makes gitBashCandidates() unit-testable off-Windows.
// @ts-ignore
import * as which from 'which';
import { z } from 'zod';
import { defineTool } from './registry';
import { workspaceRootMissHint } from './guards';
import { spillDirFor, sweepOldSpillFilesOnce } from './spill-paths';
import { takeHeadLines, takeTailLines } from './truncate';
import type { ToolResultPayload } from './types';
import { spawnDetached, killTree, formatElapsed, MAX_EXPLICIT_RUNNING } from '../shell-registry';
import { CWD_SENTINEL, ENV_SENTINEL, stripAnsi, stripSentinelLines } from './shell-text';
// Why re-exported: harness-tools-core.test.ts and other callers import
// stripAnsi from here; moving the implementation into shell-text.ts (so the
// ShellRegistry can use it without an import cycle) must not move the import
// path out from under them.
export { stripAnsi };

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Bash vars that change on EVERY command regardless of what the user's command
 *  did (SHLVL increments per shell, `_`/RANDOM/SECONDS/LINENO are bash-volatile
 *  builtins, PPID is process-identity noise) — diffing them against baseline
 *  would flag "new state" on every single persistent_env call, drowning any
 *  real export in noise. PWD/OLDPWD are excluded for a different reason: they'd
 *  fight ctx.shellCwd, which already owns directory persistence exclusively. */
const ENV_PERSIST_DENYLIST = new Set([
  'PWD', 'OLDPWD', 'SHLVL', '_', 'RANDOM', 'SECONDS', 'LINENO', 'PPID', 'BASH', 'BASHPID',
]);

/** A command whose first word is `sleep` is never handed off (spec §4.1):
 *  backgrounding a sleep is pure churn — it runs to its timeout and reports
 *  as before. Leading whitespace and `time`/`env` prefixes are not special-
 *  cased on purpose; only the plain case is exempt. */
const LEADING_SLEEP = /^\s*sleep\b/;

/** Newline count — the line currency's equivalent of `.length`. Used to measure
 *  how many lines the cwd/env probe's own sentinel added, so the reported line
 *  total describes the command's output and not the harness's plumbing. */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

export interface ShellInfo { cmd: string; args: string[]; label: string }

/** Every place Git Bash might live, best first. Two hardcoded Program Files
 *  paths were the ENTIRE search before 2026-07-19, so a scoop/choco user-scope
 *  install (%LOCALAPPDATA%\Programs\Git), a D:\Git install, or any non-default
 *  location silently fell through to PowerShell — even though `git --version`
 *  passed first-run's prerequisite check and git.exe was right there on PATH. */
function gitBashCandidates(): string[] {
  const out: string[] = [];
  // Claude Code's own documented escape hatch for exactly this problem. Users
  // who already set it for the CLI get correct detection here for free.
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) out.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  // Derive from git.exe on PATH: <root>\cmd\git.exe -> <root>\bin\bash.exe.
  // This is the branch that rescues every non-default install location.
  const git = resolveOnPath('git');
  if (git) {
    // path.win32 explicitly, not `path`: this branch only runs on win32 (where
    // they are the same), and naming it lets the test suite exercise Windows
    // path shapes from a Linux/macOS runner — POSIX dirname() does not treat
    // a backslash as a separator, so `path` here would be untestable off-Windows.
    const root = path.win32.dirname(path.win32.dirname(git));
    out.push(path.win32.join(root, 'bin', 'bash.exe'));
    out.push(path.win32.join(root, 'usr', 'bin', 'bash.exe'));
  }
  out.push('C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe');
  // Last resort: bash on PATH — but NEVER System32\bash.exe. That is the WSL
  // launcher: it would run the command inside a Linux VM against a Windows cwd,
  // so every path the model passed would be wrong. Worse than PowerShell.
  const onPath = resolveOnPath('bash');
  if (onPath && !/[\\/]system32[\\/]/i.test(onPath)) out.push(onPath);
  return out;
}

/** `which`-based resolution, mirroring resolveCommand() in prerequisite-installer.
 *  Returns null (not the bare name) so callers can tell "found" from "guessing". */
function resolveOnPath(cmd: string): string | null {
  try {
    // Static import, not a runtime require(): require() escapes the module
    // mocking layer, which made this branch impossible to unit-test.
    return (which as any).sync(cmd, { nothrow: true }) || null;
  } catch {
    return null;
  }
}

/** Windows shell preference (spec §2.3): Git Bash when present (models write
 *  bash), else PowerShell — and the tool DESCRIPTION states which is live. */
export function detectShell(): ShellInfo {
  if (process.platform !== 'win32') return { cmd: '/bin/bash', args: ['-c'], label: 'bash' };
  const gitBash = gitBashCandidates().find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (gitBash) return { cmd: gitBash, args: ['-c'], label: 'bash (Git Bash)' };
  // Loud, because this degrades the tool: no cwd persistence, and the model is
  // handed a shell its bash-shaped output does not fit. Silence here meant a
  // PowerShell fallback never appeared in a bug report (dev-tools.ts surfaces
  // it as the `harness shell` probe now).
  console.warn(
    '[harness/bash] Git Bash not found — falling back to PowerShell. ' +
      '`cd` will NOT persist between calls. Install Git for Windows, or set ' +
      'CLAUDE_CODE_GIT_BASH_PATH to your bash.exe.',
  );
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-Command'], label: 'PowerShell' };
}

// LAZY + memoized, not module-load-time. First-run installs git via
// `winget install Git.Git` AFTER the app has started (main.ts -> ipc-handlers ->
// this module all import eagerly), so resolving at import pinned a brand-new
// Windows user to PowerShell for their whole first session even though the
// installer had just delivered bash.exe. Resolving on first USE — the earliest
// of buildAiTools() reading .description or an actual execute() — lands after
// first-run completes. Verified import chain: main.ts:8 -> ipc-handlers.ts:31.
let cachedShell: ShellInfo | null = null;
export function getShell(): ShellInfo {
  if (!cachedShell) cachedShell = detectShell();
  return cachedShell;
}
/** Test-only: drop the memo so a test can re-detect under a different platform. */
export function resetShellCache(): void {
  cachedShell = null;
}

/** Only the bash shells get cwd tracking. The PowerShell fallback would need a
 *  different sentinel AND an $LASTEXITCODE dance to preserve exit codes, and it
 *  only ever runs on Windows boxes without Git Bash — not worth the risk, so it
 *  stays stateless and the tool description says so. */
function tracksCwdFor(s: ShellInfo): boolean {
  return s.label.startsWith('bash');
}

/** Wrap the command so the shell prints its final $PWD without clobbering the
 *  exit code. Newline-separated (not `;`) so trailing `&`, `# comments`, and
 *  heredocs in the user's command don't turn into syntax errors.
 *
 *  `captureEnv` (opt-in persistence, 17/17 harness reviews): when true, ALSO
 *  writes the child's full exported-var set to a bash-generated temp file and
 *  announces its path via ENV_SENTINEL, mirroring the cwd probe exactly. Two
 *  deliberate choices, both load-bearing:
 *  - `mktemp` generates the path INSIDE bash, never Node. A Node-side path (e.g.
 *    from os.tmpdir()) is a Windows path like `C:\Users\...`; embedding that text
 *    into a Git Bash script and hoping its POSIX layer translates it correctly is
 *    exactly the class of fragility `pwd -W` below was already built to dodge.
 *  - The dump is NUL-delimited (`printf '...\0'`), never newline-joined and never
 *    GNU `env -0` (BSD `env` on macOS has no `-0`). A shell var cannot contain a
 *    NUL byte, so `\0` is the one delimiter that can never collide with a real
 *    value — including embedded newlines or binary bytes, which a newline-joined
 *    dump would silently corrupt. */
function withCwdProbe(command: string, captureEnv: boolean): string {
  // The announced path goes through `cygpath -w` when that exists. WHY: under
  // Git Bash (MSYS) on Windows, `mktemp` prints a POSIX path like /tmp/tmp.XXXX,
  // but MSYS's `/tmp` is a virtual mount that really lives under %TEMP% — so
  // Node's readFileSync on the Windows side resolves it as C:\tmp\tmp.XXXX,
  // finds nothing, and the best-effort catch below silently persisted nothing
  // (Windows CI: "carries an exported var to the NEXT call" got `got:` empty).
  // `cygpath -w` is the MSYS translator (ships with every Git for Windows /
  // MSYS2) and prints the C:\Users\...\Temp\tmp.XXXX spelling Node can open.
  // Absent on Linux/macOS, where the `||` fallback keeps the raw path — stderr
  // suppressed so "command not found" can't reach the output, the same trick
  // `pwd -W` uses below. Only the PRINTED path changes; the shell still writes
  // to and (later) Node still unlinks the one file.
  const envPart = captureEnv
    ? `__yc_envfile=$(mktemp 2>/dev/null || printf '/tmp/yc-env-%s' "$$")\n` +
      `{ for __yc_v in $(compgen -e); do printf '%s=%s\\0' "$__yc_v" "\${!__yc_v}"; done; } > "$__yc_envfile" 2>/dev/null\n` +
      `printf '\\n${ENV_SENTINEL}%s\\n' "$(cygpath -w "$__yc_envfile" 2>/dev/null || printf '%s' "$__yc_envfile")"\n`
    : '';
  // TRAILING newline is load-bearing: a background writer ('cmd &') can flush to
  // the pipe AFTER the sentinel, and without a terminator that text concatenates
  // onto the path — yielding a garbage cwd, a spurious reset notice, and output
  // silently dropped from the result. Verified 2026-07-18.
  // `pwd -W` is the MSYS/Git Bash builtin that prints a WINDOWS-style path
  // (C:/Users/...). Without it $PWD is /c/Users/... which path.resolve() on
  // Windows turns into C:\\c\\Users\\... — never inside ctx.cwd, so EVERY call
  // would emit a bogus reset notice. Invalid on Linux/macOS bash, where the
  // `|| pwd` fallback takes over (stderr suppressed so it can't reach output).
  return `${command}\n__yc_rc=$?\nprintf '\\n${CWD_SENTINEL}%s\\n' "$(pwd -W 2>/dev/null || pwd)"\n${envPart}exit $__yc_rc`;
}

/** Split the sentinel back off the combined stdout+stderr. Returns the text the
 *  model should see and the reported cwd (null when the command exited early,
 *  timed out, or was killed — all cases where cwd simply doesn't change). */
function extractCwd(out: string): { text: string; cwd: string | null } {
  const at = out.lastIndexOf(`\n${CWD_SENTINEL}`);
  if (at === -1) return { text: out, cwd: null };
  const after = out.slice(at + 1 + CWD_SENTINEL.length);
  const nl = after.indexOf('\n');
  const reported = (nl === -1 ? after : after.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : after.slice(nl + 1);
  return { text: out.slice(0, at) + rest, cwd: reported || null };
}

/** Canonical on-disk form: expands Windows 8.3 short names AND resolves
 *  symlinks, so two spellings of ONE directory compare equal.
 *  .native FIRST: plain realpathSync does NOT expand Windows 8.3 short names.
 *  ctx.cwd arrives short (C:\Users\RUNNER~1\...) while `pwd -W` may report the
 *  SAME directory long (C:\Users\runneradmin\...), so startsWith() judged a
 *  plain `cd sub` "outside the workspace" and the scope guard reverted EVERY
 *  cd on Windows — persistence looked broken and each call emitted a bogus
 *  reset notice. .native canonicalizes both sides via GetFinalPathNameByHandle.
 *  Confirmed on windows-latest 2026-07-19 (short/long forms observed side by side). */
function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    /* not on disk (yet) — fall back */
  }
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Re-express the cwd the shell reported in the SPELLING the model was given,
 *  or null when it is not inside `root`.
 *
 *  `pwd` prints the PHYSICAL path. On a symlinked root (macOS /var →
 *  /private/var, or any symlinked project directory) or a Windows 8.3 short
 *  root, that names the same directory a different way than ctx.cwd does.
 *  Reporting it raw hands the model a workspace root it was never told about,
 *  which defeats the whole point of the `[cwd: …]` metadata line below — that
 *  line exists so the model can relate Bash's cwd to the file tools' root, and
 *  it only works if both speak one vocabulary.
 *
 *  The containment check runs BEFORE the rebase and that order is load-bearing:
 *  an outside path yields a `..`-prefixed relative, and path.join would quietly
 *  pull it back inside the root — silently turning the scope guard into a
 *  no-op. Never reorder these. */
export function rebaseReportedCwd(root: string, reported: string): string | null {
  const realRoot = realPath(root);
  const realReported = realPath(reported);
  if (realReported !== realRoot && !realReported.startsWith(realRoot + path.sep)) return null;
  const rel = path.relative(realRoot, realReported);
  return rel ? path.join(root, rel) : root;
}

/** Same shape as extractCwd but for the env-probe's temp-file marker. MUST run
 *  BEFORE extractCwd on the same buffer: withCwdProbe prints ENV_SENTINEL AFTER
 *  CWD_SENTINEL, so it sits closer to the tail — extracting cwd first would
 *  leave this line stuck inside cwd's "rest" text instead of being stripped. */
function extractEnvFile(out: string): { text: string; envFile: string | null } {
  const at = out.lastIndexOf(`\n${ENV_SENTINEL}`);
  if (at === -1) return { text: out, envFile: null };
  const after = out.slice(at + 1 + ENV_SENTINEL.length);
  const nl = after.indexOf('\n');
  const filePath = (nl === -1 ? after : after.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : after.slice(nl + 1);
  return { text: out.slice(0, at) + rest, envFile: filePath || null };
}

/** Parse the NUL-delimited `NAME=VALUE` dump the probe wrote. Malformed entries
 *  (no `=`) are skipped rather than guessed at — this reads a file OUR OWN probe
 *  wrote, so a malformed entry means something unexpected happened, not that we
 *  should invent a value. */
function parseEnvDump(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/** What should actually carry to the next call: only vars that are NEW or
 *  CHANGED relative to `baseline` (the exact env object this child was spawned
 *  with — ambient process.env plus whatever was already persisted). This is the
 *  security-relevant filter: an ambient credential inherited from process.env is
 *  identical in `dump` and `baseline`, so it's filtered out here and never
 *  crosses into `shellEnv` — only a var the command's OWN `export`/`source`
 *  actually touched gets captured. `prevPersisted` entries the command unset
 *  (no longer in `dump`) are dropped so a stale value doesn't linger forever. */
function diffPersistableEnv(
  dump: Record<string, string>,
  baseline: Record<string, string | undefined>,
  prevPersisted: Record<string, string>,
): Record<string, string> {
  const next: Record<string, string> = { ...prevPersisted };
  for (const [name, value] of Object.entries(dump)) {
    if (ENV_PERSIST_DENYLIST.has(name)) continue;
    if (baseline[name] !== value) next[name] = value;
  }
  for (const name of Object.keys(prevPersisted)) {
    if (!(name in dump)) delete next[name];
  }
  return next;
}

/** The warning half of the fix (17/17 harness reviews, more commonly requested
 *  than the persistence escape hatch): best-effort regex heuristic, not a shell
 *  parser — it under-warns on cleverly-quoted or multi-line commands rather than
 *  risk a false positive, since a warning that fires on CORRECT usage is exactly
 *  the noise the reviews complained about elsewhere in this tool.
 *
 *  - `export FOO=...` only warns if FOO is never referenced ($FOO / ${FOO})
 *    anywhere else in this same call — using it later in the same call is
 *    correct usage, not the mistake this warns about.
 *  - `source foo` / `. foo` only warns when it is the LAST statement in the
 *    call — chaining the command that needs it (`source venv/bin/activate &&
 *    pytest`) already consumes it inside the same live shell. `./foo` (no space
 *    after the dot) is a plain execution, not a source, and is intentionally NOT
 *    matched — a subshell it runs in cannot export anything back to this shell
 *    regardless. */
function unpersistedEnvCulprits(command: string): string[] {
  const culprits: string[] = [];
  const exportRe = /\bexport\s+([A-Za-z_][A-Za-z0-9_]*)=/g;
  let m: RegExpExecArray | null;
  while ((m = exportRe.exec(command))) {
    const name = m[1];
    const usedElsewhere = new RegExp(`\\$\\{?${name}\\b`).test(command);
    if (!usedElsewhere) culprits.push(`export ${name}`);
  }
  const statements = command
    .split(/\n|;|&&|\|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  const last = statements[statements.length - 1];
  if (last && /^(?:source|\.)\s+\S/.test(last)) {
    culprits.push(last.length > 60 ? `${last.slice(0, 57)}...` : last);
  }
  return culprits;
}

/** Built per-read so it reflects the LAZILY resolved shell (see getShell). A
 *  module-level string would bake in whatever was detected at import — i.e.
 *  "PowerShell" for a user whose git arrived during first-run. */
function bashDescription(): string {
  const s = getShell();
  return (
    `Run a shell command (${s.label} on this machine). ` +
    (tracksCwdFor(s)
      ? 'The working directory PERSISTS between calls: a `cd` carries to your next Bash call. ' +
        'Changing directory outside the workspace root is reverted (you get a reset notice). ' +
        // Fix (2026-08-10 review): 5 of 5 reviewing models flagged this asymmetry as a
        // trap even though it was already documented — buried in a longer sentence
        // wasn't enough. Its own labeled sentence states it plainly: cwd survives
        // between calls, nothing else about the shell does.
        'ASYMMETRY: only the working directory persists. Environment variables, aliases, ' +
        'and shell functions do NOT carry to your next call (e.g. `export FOO=bar` here is ' +
        'gone by your next call, unless you pass `persistent_env: true` to carry exported ' +
        'vars — not aliases/functions — forward) — every call is a fresh shell that inherits ' +
        'your `cd` and nothing else. ' +
        'Note that the other tools (Read/Edit/Write/Glob/Grep) resolve relative paths from the ' +
        'workspace root, NOT from this shell directory — prefer absolute paths with them. '
      : 'Each call starts fresh in the workspace directory — `cd` does NOT carry to the next call, ' +
        'so use absolute paths or chain with `cd X && ...` in one command. Environment variables ' +
        'never carry over either. ') +
    // Fix (2026-08-10 review, Claim 7): verified against a real transcript — this
    // runs plain `bash -c`, no `set -e`/`pipefail` injected. `false; echo hi` reports
    // exit 0 because the LAST command decides the code, same as typing the chain into
    // a real terminal. Not a bug (Claude Code's own Bash tool works the same way);
    // stated here so it stops getting re-reported as one.
    'No `set -e`: a multi-command chain (`a; b; c`) reports the LAST command\'s exit code, ' +
    'so an earlier failure in the middle can be silently absorbed — use `&&` between commands, ' +
    'or check intermediate results yourself, when that matters. ' +
    // Fix (2026-08-10 review): cap tightened from ~28,000 to ~4,000 chars — reviewers
    // measured a `seq 1 20000` costing ~7k tokens of pure noise, "more expensive than
    // everything else combined." The visible slice shrank; nothing is lost — the full
    // output is always saved to disk when it overflows, path included in the result.
    // Fix (2026-08-11 review round 8): this sentence named only the char cap, but
    // truncation trips on EITHER cap (see the `truncated` arithmetic in finish()) —
    // and the line cap is the one that usually fires first, since 100 lines of
    // ordinary command output is well under 4,000 chars. A model that had been told
    // only about chars read a truncated 900-char result as complete.
    'Output over ~4,000 chars OR ~100 lines shows only the first and last ~50 lines — ' +
    'whichever cap trips first, so a 120-line result is truncated even when it is short. ' +
    'The FULL output is then always saved to a file, with its path in the result — Read ' +
    'that file rather than guessing from the truncated preview; do not just re-run the ' +
    'same command hoping for more. ' +
    // D-1 (2026-08-26 tools investigation): this used to say "re-run the ORIGINAL
    // command piped through head/tail/grep" — which contradicts the `set -e`
    // sentence above. There is no `pipefail` either, so `npm test | tail -50`
    // reports tail's exit 0 and HIDES a failing test run. If a re-run is really
    // needed, redirect to a file and print the exit code instead.
    'If you must re-run it, redirect to a file and print the exit code ' +
    `(\`cmd > out.txt 2>&1; echo exit=${tracksCwdFor(s) ? '$?' : '$LASTEXITCODE'}\`) — ` +
    'there is no `pipefail`, so `cmd | tail` reports tail\'s exit 0 and hides a failure. ' +
    // G-13 (same investigation): every peer harness says this up front; here the
    // model only found out indirectly when Edit refused a file it had `cat`-ed.
    // The rationale is reviewability and the permission UI, not capability —
    // Claude Code drops this sentence in bypass-permissions mode for that reason.
    // descriptionFor() only knows `supportsVision`, not the permission mode, so
    // this is unconditional for now (plumbing the mode through is a separate item).
    'Prefer the dedicated tools for files — Read (not cat/head/tail), Grep (not grep/rg), ' +
    'Glob (not find/ls), Edit (not sed/awk) — they are reviewable and permission-aware, ' +
    'and Edit only accepts files seen via Read. ' +
    // G-1 (2026-08-28): a time limit is no longer a kill. The old "SIGKILL /
    // exit 124" sentence is gone on purpose — a foreground command that is
    // still running at its timeout is handed off to the background (Task 4);
    // only a leading `sleep` still simply times out.
    'Long commands: pass `run_in_background: true` to start a command and return at once with a ' +
    'shell id — for servers, long builds, anything over a couple of minutes. You are told when it ' +
    'finishes; BashOutput reads its new output (or lists your background commands); KillShell stops it. ' +
    'A foreground command still running at its timeout (default 2 minutes, max 10 via `timeout`) is ' +
    'handed off to the background the same way instead of being killed — except a leading `sleep`, ' +
    'which simply times out. Only a foreground command changes your working directory; a background ' +
    'or handed-off command never changes it and never carries `persistent_env`. ' +
    // Destin's workbench draft (2026-09-04): a command waiting on a y/N prompt
    // sits until the timeout hands it to the background, and nothing ever
    // answers it.
    'A command that might prompt for input hangs: pass its non-interactive flag ' +
    '(`-y`, `--yes`, `--non-interactive`, or the tool\'s equivalent) whenever a command could ask a question.'
  );
}

// Spill paths live in ./spill-paths so guards.ts can recognize one without
// importing this file (2026-08-10 review — see the recommendation in
// docs/active/investigations/2026-08-10-harness-output-truncation-prior-art.md).

export const BashTool = defineTool({
  name: 'Bash',
  // Placeholder: the real text comes from the getter installed below, which
  // resolves the shell on first read (harness-session.ts buildAiTools()).
  description: '',
  // Compact form for small local models (simplified presentation, spec §4.2).
  // MERGE RECONCILIATION: stays a plain static string rather than joining the
  // lazy-getter dance — it names no shell, so there is nothing to resolve.
  shortDescription: 'Run a shell command and return its output.',
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().int().optional().describe('Timeout in milliseconds'),
    description: z.string().optional().describe('One line: what this command does'),
    // Opt-in escape hatch (17/17 harness reviews across four rounds asked for
    // this): default OFF so existing behavior (fresh env every call) is
    // unchanged unless a call explicitly asks otherwise.
    persistent_env: z
      .boolean()
      .optional()
      .describe('Carry this call\'s exported env vars (not aliases/functions) to your next Bash call. Default off.'),
    // G-1 (2026-08-28): start the command and return at once with a shell id.
    run_in_background: z
      .boolean()
      .optional()
      .describe('Start the command and return at once with a shell id; you are told when it finishes. For servers, long builds, anything over a couple of minutes.'),
  }).strict(), // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
  caps: { maxChars: 30_000 },
  // Static fallback for composeNotice's no-bounds branch (Task 19): Bash's own
  // visible budget (HEAD_CHARS_TARGET + TAIL_CHARS_TARGET = 4,000 chars, see
  // execute() below) keeps its own `bounds` the sole authority in the common
  // case, but the reset notice + metadata trailer embed ctx.cwd TWICE and sit
  // OUTSIDE that budget — an extreme workspace root path could in theory still
  // push the pipeline cap (30k) past its limit while `truncated` stays false.
  // This is generic advice for that now-rarer edge case, not a copy of the
  // per-call `bounds.moreHint` built in execute() (which names the real spill
  // path and can't be known statically).
  // D-1 (2026-08-26 tools investigation, closed out 2026-08-28): this static
  // fallback used to say "pipe through head/tail" — the same pipe advice the
  // description and the per-call notice dropped, because with no `pipefail`
  // `cmd | tail` reports tail's exit 0 and hides a failing build.
  moreHint: 'Read the saved full-output file; if you must re-run, redirect to a file and print the exit code (cmd > out.txt 2>&1; echo exit=$?)',
  permissionSubject: (a) => a.command,
  async execute(args, ctx) {
    const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    // A tracked dir can be deleted out from under us (rm -rf, worktree remove);
    // falling back to the root beats spawning into ENOENT.
    const tracked = ctx.shellCwd;
    const startCwd =
      tracked && tracked !== ctx.cwd && fs.existsSync(tracked) && fs.statSync(tracked).isDirectory() ? tracked : ctx.cwd;
    // Skip the probe when the command's last line would ABSORB ours: a trailing
    // line-continuation, or a dangling `&&`/`||`/`|` (which swallows the
    // `__yc_rc=$?` line, so a FAILED command would exit 0 — verified 2026-07-18).
    // Such commands are malformed anyway; skipping restores the plain behavior.
    const shell = getShell();
    const probe = tracksCwdFor(shell) && !/(\\|&&|\|\||\|)\s*$/.test(args.command);
    // Opt-in persistence only runs where the cwd probe already runs (real bash,
    // no dangling operator) — same platform gate `tracksCwdFor` already applies
    // to cwd tracking, not worth a second stateful mechanism on the PowerShell
    // fallback. `captureEnv` (not the raw request flag) is what actually gates
    // the warning below too, so a request that silently can't be honored still
    // gets an honest "won't persist" note instead of a false all-clear.
    const captureEnv = probe && args.persistent_env === true;
    // The exact env this child is spawned with — process.env plus whatever a
    // PRIOR persistent_env call already captured, minus nothing. Doubles as the
    // diff baseline in finish(): only a var that changed FROM this becomes
    // newly-persisted, so an ambient credential merely inherited from
    // process.env (identical before/after) never crosses into shellEnv.
    const shellEnvIn = ctx.shellEnv ?? {};
    const spawnEnv = { ...process.env, ...shellEnvIn, NO_COLOR: '1', FORCE_COLOR: '0' };
    // Warn at the moment of the mistake (17/17 harness reviews, more commonly
    // requested than persistence itself): computed once, up front, since it
    // depends only on the command text and whether persistence is actually
    // active for this call — never on anything the child process does.
    const envCulprits = captureEnv ? [] : unpersistedEnvCulprits(args.command);
    const envNotice = envCulprits.length
      ? `\nNote: ${envCulprits.join(', ')} won't persist to your next Bash call (env resets each call) — pass persistent_env: true to carry it forward, or use it in this same command.`
      : '';
    // G-1: an explicit background start (spec §4.1). No cwd probe, no env
    // capture (D6) — the registry runs the bare command; stdin is closed
    // there (D4). The call resolves with the launch acknowledgment; the
    // finished notice arrives on its own at the next idle boundary.
    if (args.run_in_background) {
      if (args.persistent_env) {
        return { text: 'Bash rejected: persistent_env cannot be combined with run_in_background — a background command never reports its environment back. Drop one of the two.', isError: true };
      }
      if (!ctx.shells) {
        return { text: 'Bash rejected: background execution is not available in this session.', isError: true };
      }
      const started = ctx.shells.start({
        toolUseId: ctx.toolCallId ?? 'unknown', command: args.command, cwd: startCwd,
        shellCmd: shell.cmd, shellArgs: shell.args, env: spawnEnv,
      });
      if (!started.ok) {
        if (started.reason === 'cap') {
          return { text: `${MAX_EXPLICIT_RUNNING} background commands are already running (${started.running.join(', ')}). Stop one with KillShell before starting another.`, isError: true };
        }
        return { text: `Failed to start shell: ${started.detail} (shell=${shell.cmd}; cwd=${startCwd})`, isError: true };
      }
      return {
        text: `Started in the background (shell id ${started.run.shellId}). You'll be told when it finishes. BashOutput reads new output (or lists runs); KillShell stops it. Running now: ${started.runningExplicit} of ${MAX_EXPLICIT_RUNNING}.`,
      };
    }

    return new Promise((resolve) => {
      // spawn() throws SYNCHRONOUSLY when the shell path or startCwd has a
      // non-directory prefix (e.g. a stale/deleted tracked cwd that raced past
      // the existsSync check above). That throw fires before the 'error' handler
      // at the bottom of this executor can attach, so catch it here — otherwise
      // it escapes to defineTool as a bare `Bash failed: spawn <CODE>`.
      // G-1: when the command actually started, for the hand-off's "still
      // running after N" — the real elapsed, never the configured limit.
      const startedAt = Date.now();
      let child;
      try {
        // G-1 (a behaviour change): spawnDetached gives the command its own
        // process GROUP, so an interrupt reaches everything it started. The old
        // plain spawn put it in ours, and child.kill() then reached only the
        // outer bash — a `node` it had launched lived on as an orphan (spec §1).
        // windowsHide is set inside spawnDetached.
        child = spawnDetached(shell.cmd, [...shell.args, probe ? withCwdProbe(args.command, captureEnv) : args.command], {
          cwd: startCwd,
          // Ask tools to emit plain output rather than stripping it after the fact
          // where possible — cleaner, and it keeps byte counts honest.
          env: spawnEnv,
        });
      } catch (e: any) {
        resolve({ text: `Failed to start shell: ${e?.message ?? e} (shell=${shell.cmd}; cwd=${startCwd})`, isError: true });
        return;
      }
      // Bounded head + rolling tail + an UNCONDITIONAL byte counter.
      //
      // WHY this replaced a flat 200KB accumulator (2026-08-06): the old buffer
      // retained 200KB only for defineTool to cut it to 30k, and — worse — the
      // truncation notice reported the CAPPED buffer's length as the original
      // size. A 5MB command was announced as "204800 chars total", a number
      // nothing had measured. Counting every chunk whether or not we keep it makes
      // the reported total true.
      //
      // WHY independent head/tail buffers, not one accumulator with overflow
      // (2026-08-10 review, cap tightened ~28,000 -> ~4,000 chars — reviewers
      // measured a `seq 1 20000` costing ~7k tokens of pure noise, "more
      // expensive than everything else combined"): the OLD single-accumulator
      // design ("fill head, then overflow into a rolling tail") had a real gap —
      // if total output stayed under the head cap but exceeded the LINE budget
      // (many short lines), the tail buffer would never receive anything, losing
      // "how it ended" entirely. `headBuf` (grows once, stops at its cap, never
      // shrinks) and `tailBuf` (a rolling window of the last N raw chars,
      // ALWAYS fed regardless of whether headBuf is still filling) are now two
      // independent, unconditionally-maintained buffers — each is simply "the
      // true first ~4,000 chars" and "the true last ~4,000 chars" of whatever
      // has streamed so far, which also eliminates the old "dead zone" bug
      // class outright rather than just shrinking it.
      const HEAD_RETAIN_CHARS = 4_000; // margin over the 2,000-char visible target below, so a line-aware trim always has real lines to choose from
      const TAIL_RETAIN_CHARS = 4_000;
      const HEAD_CHARS_TARGET = 2_000;
      const HEAD_LINES_TARGET = 50;
      const TAIL_CHARS_TARGET = 2_000;
      const TAIL_LINES_TARGET = 50;
      let headBuf = '';
      let tailBuf = '';
      let totalChars = 0;
      let totalNewlines = 0;
      // Separate uncapped 4KB tail purely for the cwd sentinel: a chatty command
      // ("cd sub && <huge output>") would otherwise push the sentinel out of the
      // retained text and silently lose the cd.
      let probeTail = '';
      // Full-output spill (2026-08-10 review: 4 of 5 surveyed harnesses with a
      // real cap pair a small visible slice with a mandatory disk spill — see
      // docs/active/investigations/2026-08-10-harness-output-truncation-prior-art.md).
      // Started the MOMENT headBuf can no longer capture everything (inside
      // cap() below), not lazily at finish() — by finish() any un-retained
      // middle content is already gone from memory, so waiting would spill an
      // incomplete file. spillDirFor/sweepOldSpillFilesOnce come from
      // spill-paths.ts, which owns both the layout and the 7-day sweep.
      let spillStream: fs.WriteStream | null = null;
      let spillPath: string | null = null;
      let spillError: string | null = null;
      const startSpill = () => {
        try {
          const dir = spillDirFor(ctx.sessionId);
          fs.mkdirSync(dir, { recursive: true });
          sweepOldSpillFilesOnce();
          spillPath = path.join(dir, `bash-${Date.now()}-${randomUUID()}.txt`);
          spillStream = fs.createWriteStream(spillPath);
          spillStream.on('error', (e) => {
            spillError = e.message;
          });
          // Backfill with everything captured so far — headBuf is complete up to
          // this exact instant (nothing has been dropped yet), so the file
          // starts with zero gap. ANSI-stripped so the spilled file reads the
          // same clean way the visible slice does.
          spillStream.write(stripAnsi(headBuf));
        } catch (e: any) {
          spillError = e?.message ?? String(e);
          spillStream = null;
          spillPath = null;
        }
      };
      const cap = (s: string) => {
        totalChars += s.length;
        for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) totalNewlines++;
        if (headBuf.length < HEAD_RETAIN_CHARS) {
          const room = HEAD_RETAIN_CHARS - headBuf.length;
          if (s.length <= room) {
            headBuf += s;
          } else {
            headBuf += s.slice(0, room);
            // headBuf just became full and can never capture anything past this
            // point — the earliest moment we KNOW the middle will be lost from
            // memory, so start the spill now rather than at finish(), by which
            // point the un-retained middle is already gone.
            if (!spillStream && !spillError) startSpill();
            spillStream?.write(stripAnsi(s.slice(room)));
          }
        } else {
          if (!spillStream && !spillError) startSpill();
          spillStream?.write(stripAnsi(s));
        }
        tailBuf = (tailBuf + s).slice(-TAIL_RETAIN_CHARS);
        if (probe) probeTail = (probeTail + s).slice(-4096);
      };
      child.stdout.on('data', (d) => cap(String(d)));
      child.stderr.on('data', (d) => cap(String(d)));
      let done = false;
      /** G-1: set by the timeout timer once the registry adopted this process. */
      let handedOffTo: string | null = null;
      // `timedOut` distinguishes a SIGKILL-on-timeout result from a normal
      // non-zero exit (2026-08-10 review: 3 of 5 models found the old `exit ?`
      // opaque; Opus wanted to know whether the process died cleanly or was
      // force-killed — "matters when deciding whether a partial write may have
      // been left behind"). Codex CLI's approach, adopted here: a sentinel exit
      // code (124, matching `timeout(1)`) + a typed flag + explicit prose, all
      // three at once rather than picking one.
      const finish = (prefix: string, isError: boolean, code?: number | null, timedOut?: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);

        const totalLines = totalNewlines + 1;
        // The ONLY authoritative truncation decision: if the true total exceeds
        // what head+tail can EVER cover (their combined budgets), something in
        // the middle is unavoidably elided — no heuristic, just arithmetic.
        const truncated = totalChars > HEAD_CHARS_TARGET + TAIL_CHARS_TARGET || totalLines > HEAD_LINES_TARGET + TAIL_LINES_TARGET;

        let notice = '';
        // Bytes consumed by the probe's OWN generated sentinel line — harness
        // plumbing, not command output. Subtracted from the reported total so a
        // command that printed exactly N bytes is announced as N, not
        // N-plus-however-long-the-cwd-path-happens-to-be.
        let sentinelOverhead = 0;
        /** The same overhead counted in lines — see where it is assigned. */
        let sentinelLineOverhead = 0;
        let reportedCwd: string | null = null;
        let resetTo: string | null = null;

        // G-1: a handed-off call must not apply the probe's results — the cwd
        // and env belong to a command still running in the background (D6, and
        // the registry unlinks the env temp file when it finally exits). The
        // sentinels are stripped for display only. Guarded rather than left to
        // timing: the timer can fire in the same instant the command finishes,
        // and then the sentinel IS in the buffer.
        if (probe && handedOffTo) {
          headBuf = stripSentinelLines(headBuf);
          tailBuf = stripSentinelLines(tailBuf);
        } else if (probe) {
          // The sentinel is always the LAST thing printed (withCwdProbe), so it
          // always lives in whichever buffer holds the true tail: tailBuf when
          // truncated (headBuf can't see it — it stopped growing long ago), or
          // headBuf when not (headBuf holds 100% of the output in that case,
          // sentinel included — see the cap() invariant: totalChars <=
          // HEAD_RETAIN_CHARS implies headBuf never dropped a single char).
          const sentinelSource = truncated ? tailBuf : headBuf;
          // Env sentinel is printed AFTER the cwd one (withCwdProbe), so it sits
          // closer to the tail — extract it FIRST or its line stays stuck inside
          // the cwd extraction's "rest" text instead of being stripped.
          let working = sentinelSource;
          let envFileFromStream: string | null = null;
          if (captureEnv) {
            const envParsed = extractEnvFile(working);
            working = envParsed.text;
            envFileFromStream = envParsed.envFile;
          }
          const parsed = extractCwd(working);
          sentinelOverhead = sentinelSource.length - parsed.text.length;
          // Same subtraction in the line currency, for the same reason the char
          // one exists: the probe's own sentinel lines are harness plumbing, not
          // command output. Without this, `seq 1 120` reported "123 lines".
          sentinelLineOverhead = countNewlines(sentinelSource) - countNewlines(parsed.text);
          if (truncated) tailBuf = parsed.text;
          else headBuf = parsed.text;
          const reported = parsed.cwd ?? extractCwd(probeTail).cwd;
          const envFilePath = captureEnv ? envFileFromStream ?? extractEnvFile(probeTail).envFile : null;
          if (reported) {
            // Rebase FIRST, compare after: the old code compared
            // path.resolve(reported) against path.resolve(startCwd), and
            // resolve() follows neither symlinks nor Windows 8.3 names — so two
            // spellings of one directory read as a change and the canonical form
            // was stored and printed. Comparing the REBASED value means a
            // spelling difference is correctly a no-op and only a real `cd`
            // registers.
            const rebased = rebaseReportedCwd(ctx.cwd, reported);
            if (rebased === null) {
              // Scope guard: don't let the session wander out of the workspace,
              // and TELL the model — a silent revert is the exact failure mode
              // the Claude Code issues (#35058 et al.) complain about.
              // The notice names the RAW reported path on purpose: it is outside
              // the root, so there is no root-relative spelling of it, and the
              // physical path is the truthful thing to show.
              ctx.setShellCwd?.(ctx.cwd);
              resetTo = ctx.cwd;
              notice = `\nShell cwd was reset to ${ctx.cwd} (${reported} is outside the workspace).`;
            } else if (rebased !== startCwd) {
              reportedCwd = rebased;
              ctx.setShellCwd?.(reportedCwd);
            }
          }
          // Opt-in persistence (17/17 harness reviews): read the temp file
          // bash's own `mktemp` wrote — never the stdout/stderr stream — so a
          // multi-KB env dump can never corrupt the command's own output or trip
          // the truncation/spill path built for THAT. Deleted immediately after
          // reading either way, so the full-environment snapshot it briefly held
          // (same data any Bash call could already get by running `env` itself)
          // doesn't linger on disk longer than it has to.
          if (captureEnv && envFilePath) {
            try {
              const dump = parseEnvDump(fs.readFileSync(envFilePath, 'utf8'));
              ctx.setShellEnv?.(diffPersistableEnv(dump, spawnEnv, shellEnvIn));
            } catch {
              // Best-effort: a vanished/unreadable temp file just means nothing
              // new persists from this call — not worth failing the command over.
            } finally {
              try {
                fs.unlinkSync(envFilePath);
              } catch {
                /* best-effort cleanup */
              }
            }
          }
        }

        const trueTotal = totalChars - sentinelOverhead;
        // The line-currency twin of trueTotal, and the ONLY line total anything
        // below may report. Two corrections on top of the raw `totalLines`:
        //   1. the probe's own sentinel lines (harness plumbing, as for chars);
        //   2. the `totalNewlines + 1` trailing-blank overcount — output that
        //      ends in a newline has no partial final line, so `seq 1 120`
        //      counted 121.
        // Reporting only: `truncated` above still decides on the raw counts, so
        // this changes no behaviour, only the numbers the model is told.
        const trailingBlank = (truncated ? tailBuf : headBuf).endsWith('\n') ? 1 : 0;
        const trueLines = Math.max(1, totalLines - sentinelLineOverhead - trailingBlank);
        let body: string;
        // `shown` measured pre-ANSI-strip (same currency as `totalChars`, which
        // accumulated raw chunks including colour codes) — mixing currencies here
        // was a real bug: a coloured run printed "showing 21491 of 117000 bytes"
        // where 117000 counted escape sequences 21491 did not.
        let preAnsiShown: number;
        // Tracked alongside preAnsiShown so the metadata line can report BOTH
        // dimensions (2026-08-11 review round 8): truncation trips on chars OR
        // lines, but the result only ever quoted chars — a line-capped result
        // announced "900 chars output, showing 900" and read as complete.
        let shownLines: number;
        let outputPath: string | undefined;
        let moreHintText: string | undefined;

        if (truncated) {
          const headResult = takeHeadLines(headBuf, HEAD_CHARS_TARGET, HEAD_LINES_TARGET);
          const tailResult = takeTailLines(tailBuf, TAIL_CHARS_TARGET, TAIL_LINES_TARGET);
          preAnsiShown = headResult.chars + tailResult.chars;
          shownLines = headResult.lines + tailResult.lines;
          const elidedLines = Math.max(0, trueLines - headResult.lines - tailResult.lines);
          body = `${stripAnsi(headResult.text)}\n[...]\n${stripAnsi(tailResult.text)}`;

          if (spillPath && (spillStream || handedOffTo)) {
            outputPath = spillPath;
          } else if (!spillError) {
            // truncated=true but the streaming trigger in cap() never fired —
            // only possible when totalChars <= HEAD_RETAIN_CHARS (the LINE
            // budget alone tripped `truncated`), which by the same invariant
            // means headBuf/tailBuf both hold the complete, gap-free output.
            // Write it out now instead of leaving the model with no file.
            try {
              const dir = spillDirFor(ctx.sessionId);
              fs.mkdirSync(dir, { recursive: true });
              sweepOldSpillFilesOnce();
              const p = path.join(dir, `bash-${Date.now()}-${randomUUID()}.txt`);
              fs.writeFileSync(p, stripAnsi(tailBuf));
              outputPath = p;
            } catch (e: any) {
              spillError = e?.message ?? String(e);
            }
          }

          // Fix: never claim a spill succeeded when it did not — a fabricated
          // path would be a misleading result (see the project's error-message
          // standards). Honest either way: name the real path, or say plainly
          // that the save failed and why.
          const linesPart = `${elidedLines} line${elidedLines === 1 ? '' : 's'} elided`;
          // D-1: same fix as the description — no "pipe through head/tail/grep"
          // advice, because without `pipefail` the pipe hides the real exit code.
          moreHintText = outputPath
            ? `${linesPart} — full output saved to ${outputPath}. Read that file (e.g. with the Read tool); if you must re-run, redirect to a file and print the exit code (cmd > out.txt 2>&1; echo exit=$?) rather than piping through tail.`
            : `${linesPart} — full output could NOT be saved to disk (${spillError ?? 'unknown error'}); re-run redirected to a file (cmd > out.txt 2>&1; echo exit=$?) and Read that file instead.`;
        } else {
          preAnsiShown = headBuf.length;
          shownLines = totalLines;
          body = stripAnsi(headBuf);
          // Nothing to keep — this call's spill (if the streaming trigger ever
          // somehow started one, which the truncated=false arithmetic above
          // guarantees it did not) would be a wasted file; there is none here.
        }

        // ONE metadata line, always. Four of five reviewing models independently
        // asked for this (2026-08-01): file tools resolve relative paths from the
        // workspace root while Bash resolves from its own persistent cwd, and with
        // no cwd echoed back the only safe habit was prefixing every single call
        // with `cd <root> &&`. This line costs ~15 tokens and removes that ritual.
        // It ABSORBS the old `(exit code N)` prefix rather than adding to it.
        const effectiveCwd = resetTo ?? reportedCwd ?? startCwd;
        // A handed-off call has no exit yet — say so, and name the log the
        // registry keeps growing (the model's way to the rest of the output).
        const meta = [`cwd: ${effectiveCwd}`, handedOffTo ? `still running in the background · log: ${spillPath}` : `exit ${code ?? '?'}`];
        // Fix: label matches what's actually counted — UTF-16 code units (JS
        // string .length), never real UTF-8 byte counts. Calling that "bytes"
        // was wrong for any multi-byte output: 60,000 CJK characters (180,000
        // real UTF-8 bytes) were reported as "60005 bytes".
        // The line dimension appears exactly when LINES are why the output was
        // trimmed — see the WHY on `shownLines`. Not unconditionally: one
        // 60,000-char line trips only the char cap, head/tail then take a partial
        // line each, and "showing 0 lines" beside 4,000 visible chars is worse
        // than saying nothing about lines at all.
        if (truncated) {
          const lineCapped = totalLines > HEAD_LINES_TARGET + TAIL_LINES_TARGET;
          meta.push(lineCapped
            ? `${trueTotal} chars / ${trueLines} lines output, showing ${preAnsiShown} chars / ${shownLines} lines`
            : `${trueTotal} chars output, showing ${preAnsiShown}`);
        }
        // Fix: when a command exits with genuinely no output (e.g. `exit 3`),
        // `${prefix}${body}` was '' — trimming that and prepending the metadata
        // line produced a result that STARTED with a blank line and said nothing
        // happened, silently dropping the original "(no output, exit N)" fallback
        // text when this block was rewritten around the metadata line. `(no
        // output)` restores that signal without duplicating `exit N`, which the
        // metadata line below already states.
        const combined = `${prefix}${body}`.trim() || '(no output)';
        // Requirement B / the harder mirror of Read-Glob-Grep's shellCwdMissHint
        // (guards.ts): the shell's cwd persists across calls, so a `cd` several
        // calls earlier can make a plain, previously-safe relative path
        // suddenly miss with no clue why (Qwen 3.8 Max hit exactly this — a
        // `cd config` several calls back turned `grep -n port config/app.toml`
        // into a confusing ENOENT). The failure happens INSIDE the child
        // process, so all the harness ever sees is a non-zero exit and the
        // child's OWN stderr text, not a structured path error — deliberately
        // narrow per the 2026-08-10 review requirement, to avoid a false "did
        // you mean" on arbitrary command text: fires only when (a) this is a
        // genuine non-zero close, not a timeout/abort/spawn-error prefix, (b)
        // the output names a missing path in the ONE unambiguous coreutils
        // shape (`tool: path: No such file or directory`), and (c) that exact
        // path is CONFIRMED to exist under the workspace root.
        let shellCwdMiss = '';
        if (code != null && code !== 0 && !timedOut) {
          const missingPathLine = /^[\w./-]+: ([^\n:]+): No such file or directory$/m.exec(combined);
          if (missingPathLine) {
            shellCwdMiss = workspaceRootMissHint(missingPathLine[1], startCwd, ctx, (p) => fs.existsSync(p));
          }
        }
        // The cwd-reset notice LEADS (2026-08-11 review round 8). It used to trail
        // the output, which meant a model reading top-down consumed up to 4,000
        // chars of results from a directory it no longer sits in before reaching
        // the line saying so — and on a truncated result the notice landed after
        // an elision marker, which reads like a footnote. It changes how
        // everything below it should be interpreted, so it goes above it.
        // `notice` carries a leading \n for the trailing position; strip it here.
        const leadNotice = notice ? notice.replace(/^\n/, '') + '\n\n' : '';
        const text = (leadNotice + combined + shellCwdMiss + envNotice).trim() + `\n[${meta.join(' · ')}]`;
        const payload: ToolResultPayload & { truncated: boolean; outputPath?: string; timedOut: boolean; handedOffTo?: string } = {
          text,
          isError,
          truncated,
          outputPath,
          timedOut: !!timedOut,
          ...(handedOffTo ? { handedOffTo } : {}),
          bounds: truncated
            ? {
                shown: preAnsiShown,
                total: trueTotal,
                unit: 'chars' as const,
                moreHint: moreHintText!,
              }
            : undefined,
        };
        // Flush the spill file to disk before resolving — otherwise the model
        // could Read the path from the notice before the write stream's buffer
        // has actually landed on disk.
        // After a hand-off the REGISTRY owns the stream and ends it when the
        // command exits — ending it here would truncate a live run's log.
        if (spillStream && !handedOffTo && !(spillStream as fs.WriteStream).destroyed) {
          (spillStream as fs.WriteStream).end(() => resolve(payload));
        } else {
          resolve(payload);
        }
      };
      const timer = setTimeout(() => {
        // G-1 (spec §5.5): the time limit is when to HAND OFF, not when to
        // kill. The same process is adopted by the session's registry — never
        // restarted — and this call resolves with the output so far. Two
        // cases keep the old kill: no registry in this context (tests,
        // one-off tools), and a leading `sleep` (backgrounding a sleep is churn).
        if (!ctx.shells || LEADING_SLEEP.test(args.command)) {
          killTree(child, { graceMs: 0 });
          finish(
            `Command timed out after ${timeout}ms. The process was force-killed (SIGKILL) — if it was mid-write to a file, that write may be incomplete.\n`,
            true,
            124,
            true,
          );
          return;
        }
        // From here the registry reads the pipes; this call must stop
        // listening or every byte would be counted twice.
        child.stdout.removeAllListeners('data');
        child.stderr.removeAllListeners('data');
        child.removeAllListeners('close');
        child.removeAllListeners('error');
        // D4: a handed-off command can no longer be answered — close stdin so
        // a prompt fails fast with its own error instead of hanging forever.
        try { child.stdin?.end(); } catch { /* already closed */ }
        const run = ctx.shells.adopt({
          toolUseId: ctx.toolCallId ?? 'unknown', command: args.command, cwd: startCwd, child, startedAt,
          // headBuf is complete when no spill has started (nothing dropped yet);
          // otherwise the spill stream already holds everything.
          seedLog: spillStream ? null : headBuf,
          recent: tailBuf,
          logPath: spillPath, logStream: spillStream,
          captureEnv,
        });
        handedOffTo = run.shellId;
        spillPath = run.logPath;
        finish(
          // Real elapsed, not the configured limit: the two differ (the timer
          // fires late under load), and "after 2m" must describe the command,
          // not the setting.
          `Still running after ${formatElapsed(Date.now() - startedAt)} — handed off to the background (shell id ${run.shellId}). You'll be told when it finishes. Output so far:\n`,
          false,
          undefined,
          false,
        );
      }, timeout);
      // Interrupt kills the child (spec §2.1 interrupt-mid-tool ruling) and
      // resolves NOW — we can't wait for 'close', because on Windows a surviving
      // grandchild (e.g. bash → node) keeps the stdout pipe open, so 'close'
      // would never fire and the turn would hang.
      const onAbort = () => {
        // Kill the FAMILY and resolve NOW (the comment above explains why we
        // cannot wait for 'close'); the SIGTERM->SIGKILL escalation runs on
        // after this call returns, so nothing here blocks the turn.
        killTree(child);
        finish('Canceled: the user interrupted this operation.\n', true);
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      // If the signal already fired before we attached (once:true won't replay), kill now.
      if (ctx.signal.aborted) onAbort();
      // Async spawn failure (the path Windows takes for a bad cwd): name the
      // shell + cwd actually used, not just Node's bare `spawn <cmd> <CODE>` —
      // same diagnosability contract as the sync catch above.
      child.on('error', (err) => finish(`Failed to start shell: ${err.message} (shell=${shell.cmd}; cwd=${startCwd})\n`, true));
      // WHY no exit-code prefix here anymore: the metadata line above now states
      // `exit N` for every result, so a leading "(exit code N)" duplicated the
      // same fact in two places. The timeout/abort handlers keep their prefixes —
      // those are messages, not exit codes.
      child.on('close', (code) => finish('', code !== 0, code));
    });
  },
});

// Installed AFTER defineTool because that helper spreads its input ({...def}),
// and a spread EVALUATES getters — declaring this inline would freeze the text
// at import, defeating the lazy resolve. buildAiTools() reads .description once
// per session (harness-session.ts), which is the moment we want detection.
Object.defineProperty(BashTool, 'description', {
  get: bashDescription,
  enumerable: true,
  configurable: true,
});
