// desktop/src/main/dev-tools.ts
// Pure logic + IPC handler bodies for the Settings → Development feature.
// See docs/superpowers/specs/2026-04-21-development-settings-design.md.

import type { DevIssueKind, SessionInfo } from '../shared/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import * as https from 'https';
// WHY: app.getVersion() is only available in the main process. Used by
// submitIssue to embed the accurate YouCoded version in the issue body
// instead of relying on navigator.userAgent from the renderer (Fix 2).
import { app } from 'electron';
import { getShell } from './harness/tools/bash';

const GH_TOKEN_RE = /gh[opsu]_[A-Za-z0-9]{20,}/g;
const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_-]{20,}/g;

// WHY (Fix, v1.2.4 — cross-platform robustness): every subprocess in this file
// was spawned by bare command name (`git`, `gh`, `claude`, `bash`). Two Windows
// hazards: (1) Electron snapshots a stripped PATH at launch, so a bare name may
// not resolve; (2) a Claude Code installed via npm is a `.cmd` shim, and Node's
// CVE-2024-27980 mitigation (18.20.2+ / 20.12.2+ / 21.7.1+) refuses to spawn
// `.cmd`/`.bat` via spawn/execFile unless `shell: true` is set — the failure
// surfaces as an opaque `spawn EINVAL`. resolveCmd() resolves the command to an
// absolute path (via the optional `which` dep) and reports whether the resolved
// extension needs `shell: true`. Mirrors `runCommand` in prerequisite-installer.ts.
// On macOS/Linux it only does the path resolution. `shell: true` is returned
// solely for a `.cmd`/`.bat` target; among these call sites the only such
// target is an npm-installed `claude`, and every `claude` invocation here passes
// static args only — so the relaxed shell quoting carries no injection risk.
let whichSync: ((cmd: string) => string) | null = null;
try { whichSync = require('which').sync; } catch { /* optional dep — fall back to bare name */ }

function resolveCmd(cmd: string): { command: string; shell: boolean } {
  let command = cmd;
  if (whichSync && !path.isAbsolute(cmd)) {
    try { command = whichSync(cmd); } catch { /* not on PATH — keep bare name so spawn errors cleanly */ }
  }
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  return { command, shell };
}

/**
 * Apply minimal, high-confidence redaction to a log excerpt before it
 * leaves the main process. We deliberately avoid aggressive token-shape
 * scrubbing — false positives erode user trust. The editable preview in
 * the renderer is the real safety net.
 */
export function redactLog(text: string, homeDir: string): string {
  let out = text;
  if (homeDir) {
    // Escape regex metachars so backslashes in Windows paths work.
    const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '~');
  }
  out = out.replace(GH_TOKEN_RE, '[REDACTED-GH-TOKEN]');
  out = out.replace(ANTHROPIC_KEY_RE, '[REDACTED-ANTHROPIC-KEY]');
  return out;
}

export interface BuildIssueBodyArgs {
  kind: DevIssueKind;
  summary: string;
  description: string;
  log: string;
  version: string;
  platform: 'desktop' | 'android';
  os: string;
}

/**
 * Assemble the markdown body that ships in the GitHub issue.
 * Bugs include a collapsible log block; features do not.
 * Whatever the caller passes for `log` is what ships — the renderer is
 * responsible for showing the user a preview and letting them edit.
 */
export function buildIssueBody(args: BuildIssueBodyArgs): string {
  const header = [
    args.summary.trim(),
    '',
    '---',
    '**User description:**',
    args.description.trim(),
    '',
    `**Environment:** YouCoded v${args.version} · ${args.platform} · ${args.os}`,
  ].join('\n');

  if (args.kind === 'feature') return header;

  return [
    header,
    '',
    '**Logs:**',
    '<details><summary>desktop.log</summary>',
    '',
    '```',
    args.log,
    '```',
    '',
    '</details>',
  ].join('\n');
}

/**
 * Truncate a log to the last N lines, prepending an omission marker.
 * Used in the URL-prefill fallback path where the full log can't fit
 * under the ~8KB GitHub URL cap.
 */
export function smartTruncateLog(text: string, keepLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= keepLines) return text;
  const omitted = lines.length - keepLines;
  return `… (${omitted} earlier lines omitted)\n${lines.slice(-keepLines).join('\n')}`;
}

const URL_CAP_BYTES = 7500; // leave headroom under GitHub's ~8KB practical cap
const REPO_ISSUES_BASE = 'https://github.com/itsdestin/youcoded/issues/new';

export interface BuildPrefillUrlArgs {
  title: string;
  body: string;
  label: 'bug' | 'enhancement';
}

/**
 * Construct the GitHub "new issue" URL with prefilled title/body/label.
 * If the encoded URL would exceed our cap, hard-truncate the body and
 * append a `[truncated]` marker so the user can paste a follow-up
 * comment on the issue once they've created it in their browser.
 */
export function buildPrefillUrl(args: BuildPrefillUrlArgs): string {
  const build = (body: string) => {
    const params = new URLSearchParams({
      title: args.title,
      body,
      labels: args.label,
    });
    return `${REPO_ISSUES_BASE}?${params.toString()}`;
  };

  let url = build(args.body);
  if (url.length <= URL_CAP_BYTES) return url;

  // Binary-style shrink: chop the tail until under the cap.
  let body = args.body;
  while (url.length > URL_CAP_BYTES && body.length > 100) {
    body = body.slice(0, Math.floor(body.length * 0.8));
    url = build(`${body}\n\n[truncated]`);
  }

  // Title can be the dominant contributor when very long. After body
  // shrink, do one more pass that hard-caps the title length so the
  // returned URL always respects URL_CAP_BYTES.
  if (url.length > URL_CAP_BYTES) {
    const safeTitle = args.title.length > 200
      ? `${args.title.slice(0, 200)}…`
      : args.title;
    const params = new URLSearchParams({
      title: safeTitle,
      body: '[body omitted — title was too long to fit URL cap]\n\n[truncated]',
      labels: args.label,
    });
    url = `${REPO_ISSUES_BASE}?${params.toString()}`;
  }

  return url;
}

/**
 * Decide whether an existing directory at the target path is the
 * youcoded-dev workspace, a different git repo we shouldn't touch, or
 * not a git repo at all. Caller already ran `git -C <path> remote
 * get-url origin` and passes the trimmed stdout (or '' on error).
 */
export function classifyExistingWorkspace(
  remoteUrl: string,
): 'workspace' | 'wrong-remote' | 'not-git' {
  if (!remoteUrl.trim()) return 'not-git';
  // Match itsdestin/youcoded-dev across https/git@/with-or-without .git/trailing-slash.
  return /[/:]itsdestin\/youcoded-dev(\.git)?\/?$/.test(remoteUrl.trim())
    ? 'workspace'
    : 'wrong-remote';
}

// ---------------------------------------------------------------------------
// gatherDiagnostics — environment snapshot for bug reports
// ---------------------------------------------------------------------------
//
// The plain log tail tells us what the app DID; this block tells us about the
// environment the app ran in. Mac plugin/integration installs typically fail
// for one of: git missing, claude missing, ~/.claude perms wrong, marketplace
// cache corrupt, or network blocked. Each probe below is best-effort and
// timeout-bounded — one failure must not block the whole report.
//
// Output is human-readable text, not JSON, so a non-technical user can
// review the editable preview before submitting and recognize what's there.

interface DiagProbe {
  ok: boolean;
  text: string;        // one-line summary suitable for a markdown bullet
}

const PROBE_TIMEOUT_MS = 5_000;

function execProbe(cmd: string, args: string[]): Promise<DiagProbe> {
  const { command, shell } = resolveCmd(cmd);
  return new Promise((resolve) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024, shell }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').split('\n')[0].trim();
        resolve({ ok: false, text: `${cmd}: not found / failed (${msg.slice(0, 120)})` });
      } else {
        resolve({ ok: true, text: String(stdout).split('\n')[0].trim() });
      }
    });
  });
}

async function probeFsStat(absPath: string): Promise<DiagProbe> {
  try {
    const st = await fs.promises.stat(absPath);
    const mode = (st.mode & 0o777).toString(8).padStart(3, '0');
    const owner = process.getuid ? (process.getuid() === st.uid ? 'owned by current user' : `uid=${st.uid} (CURRENT USER IS ${process.getuid()})`) : 'n/a (windows)';
    return { ok: true, text: `exists, mode=0${mode}, ${owner}` };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { ok: false, text: 'does not exist' };
    return { ok: false, text: `stat failed: ${String(err?.message || err).slice(0, 120)}` };
  }
}

async function probeMarketplaceCache(home: string): Promise<DiagProbe> {
  const cacheDir = path.join(home, '.claude', 'youcoded-marketplace-cache', 'wecoded-marketplace');
  try {
    if (!fs.existsSync(cacheDir)) return { ok: false, text: 'not yet cloned' };
    const stampFile = path.join(cacheDir, '.youcoded-last-pull');
    let stamp = 'unknown';
    try {
      const ms = parseInt(await fs.promises.readFile(stampFile, 'utf8'), 10);
      if (!Number.isNaN(ms)) stamp = new Date(ms).toISOString();
    } catch { /* no stamp file */ }
    const gitDir = path.join(cacheDir, '.git');
    const corrupt = !fs.existsSync(gitDir);
    return {
      ok: !corrupt,
      text: corrupt ? `present but .git missing (corrupt — needs reclone)` : `cloned, last pull ${stamp}`,
    };
  } catch (err: any) {
    return { ok: false, text: `probe failed: ${String(err?.message || err).slice(0, 120)}` };
  }
}

function probeNetwork(url: string): Promise<DiagProbe> {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: PROBE_TIMEOUT_MS }, (res) => {
      resolve({ ok: (res.statusCode ?? 0) < 400, text: `${url} → HTTP ${res.statusCode}` });
      res.resume();
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => {
      resolve({ ok: false, text: `${url} → ${String(err.message).slice(0, 120)}` });
    });
    req.end();
  });
}

interface DiagSnapshot {
  timestamp: string;
  appVersion: string;
  platform: string;     // process.platform
  arch: string;         // process.arch
  osRelease: string;    // os.release()
  nodeVersion: string;  // process.version
  electronVersion: string;
  probes: Record<string, DiagProbe>;
}

/**
 * Format a snapshot as a readable text block. Pure — testable without
 * spinning up subprocesses.
 */
export function formatDiagnosticsBlock(snap: DiagSnapshot): string {
  const lines: string[] = [
    '=== YouCoded Diagnostics ===',
    `Timestamp: ${snap.timestamp}`,
    `App version: ${snap.appVersion}`,
    `Platform: ${snap.platform} ${snap.arch} (release ${snap.osRelease})`,
    `Node: ${snap.nodeVersion}, Electron: ${snap.electronVersion}`,
    '',
  ];
  for (const [key, probe] of Object.entries(snap.probes)) {
    const marker = probe.ok ? '  ✓' : '  ✗';
    lines.push(`${marker} ${key}: ${probe.text}`);
  }
  lines.push('=== End Diagnostics ===');
  return lines.join('\n');
}

/**
 * Gather an environment snapshot used by the bug-report flow. Captures
 * the most common failure points for plugin/integration install on Mac
 * and Linux: git/claude on PATH, ~/.claude perms, marketplace cache
 * health, and reachability of the GitHub raw + git endpoints. All
 * probes are timeout-bounded; redaction (home dir → ~, GH/Anthropic
 * tokens) is applied to the final text.
 */
export async function gatherDiagnostics(): Promise<string> {
  const home = os.homedir();
  // Run independent probes in parallel — total wall-clock stays ≤ ~6s
  // even on a slow network because each individual probe times out at 5s.
  const [git, claude, claudeAuth, claudeDir, pluginCache, integrationsFile, marketplaceCache, networkRaw, networkGit] =
    await Promise.all([
      execProbe('git', ['--version']),
      execProbe('claude', ['--version']),
      execProbe('claude', ['auth', 'status']),
      probeFsStat(path.join(home, '.claude')),
      probeFsStat(path.join(home, '.claude', 'plugins', 'installed_plugins.json')),
      probeFsStat(path.join(home, '.claude', 'integrations.json')),
      probeMarketplaceCache(home),
      probeNetwork('https://raw.githubusercontent.com/itsdestin/wecoded-marketplace/master/integrations/index.json'),
      probeNetwork('https://github.com/itsdestin/wecoded-marketplace.git/info/refs?service=git-upload-pack'),
    ]);

  const snap: DiagSnapshot = {
    timestamp: new Date().toISOString(),
    appVersion: (() => { try { return app.getVersion(); } catch { return 'unknown'; } })(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version,
    electronVersion: process.versions.electron || 'n/a',
    probes: {
      'git': git,
      // Which shell the native harness resolved. A silent PowerShell fallback
      // (no Git Bash found) degrades every local/OpenRouter session — no cwd
      // persistence, bash-shaped commands fed to PowerShell — and was
      // previously invisible in bug reports.
      'harness shell': (() => {
        try {
          const s = getShell();
          // ok:false for PowerShell — it IS a degraded state worth flagging in
          // a report, not merely informational.
          return { ok: s.label.startsWith('bash'), text: `${s.label} (${s.cmd})` };
        } catch (err: any) {
          return { ok: false, text: `detection failed: ${err?.message ?? String(err)}` };
        }
      })(),
      'claude': claude,
      'claude auth': claudeAuth,
      '~/.claude': claudeDir,
      '~/.claude/plugins/installed_plugins.json': pluginCache,
      '~/.claude/integrations.json': integrationsFile,
      'marketplace cache': marketplaceCache,
      'network: raw.githubusercontent.com': networkRaw,
      'network: github.com (git protocol)': networkGit,
    },
  };

  return redactLog(formatDiagnosticsBlock(snap), home);
}

// ---------------------------------------------------------------------------
// T6: readLogTail
// ---------------------------------------------------------------------------

/**
 * Read the last N lines of ~/.claude/desktop.log, with redaction
 * applied. Returns '' if the log doesn't exist yet (fresh install).
 */
export async function readLogTail(maxLines: number): Promise<string> {
  const home = os.homedir();
  const logPath = path.join(home, '.claude', 'desktop.log');
  let raw: string;
  try {
    raw = await fs.promises.readFile(logPath, 'utf8') as string;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
  const lines = raw.split('\n');
  const tail = lines.slice(-maxLines).join('\n');
  return redactLog(tail, home);
}

// ---------------------------------------------------------------------------
// T7: summarizeIssue (shells out to claude -p)
// ---------------------------------------------------------------------------

export interface SummarizeArgs {
  kind: DevIssueKind;
  description: string;
  log?: string;
}

export interface SummaryResult {
  title: string;
  summary: string;
  flagged_strings: string[];
  /** False when nothing rewrote the text — the fields above are the user's own
   *  words, unchanged. The caller MUST say so rather than present them as a
   *  result (design review F17). */
  assisted?: boolean;
  /** Why it did not run, when it did not. Only ever the reason we actually have. */
  unavailable?: string;
}

/**
 * Ask claude -p to produce a structured summary of the user's bug
 * report or feature request. The prompt is piped via stdin rather than
 * passed as a positional CLI arg — this avoids Windows shell-escaping
 * hazards and the ~32KB arg-length cap when the user's description or
 * log excerpt is large. On any failure (CLI missing, not authenticated,
 * JSON parse error) we degrade gracefully to a fallback envelope built
 * from the user's description — submission still works.
 */
/**
 * WHY this reports whether it ran (design review F17, and Destin 2026-09-10 on
 * native sessions): it used to `catch { return fallbackSummary(...) }`, and the
 * fallback is the user's OWN text with the title sliced off the front. So when
 * nothing was available to ask — no Claude Code CLI on the machine, which is the
 * normal state for someone using YouCoded's own assistant — pressing "improve this
 * with the assistant" handed back what the user already wrote and said it had
 * worked. A button that silently does nothing is the defect this feature exists to
 * remove, and it was in the feature's own screen.
 *
 * `assisted: false` means the text is unchanged and the caller must say so.
 */
export async function summarizeIssue(args: SummarizeArgs): Promise<SummaryResult> {
  const prompt = buildSummarizerPrompt(args);
  try {
    const { command, shell } = resolveCmd('claude');
    const stdout: string = await new Promise((resolve, reject) => {
      const child = spawn(command, ['-p'], { timeout: 30_000, shell });
      let out = '';
      let err = '';
      child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
      child.on('error', reject);
      child.on('close', (code: number | null) => {
        if (code === 0) resolve(out);
        else reject(new Error(`claude -p exited with code ${code}: ${err.slice(0, 500)}`));
      });
      // Write prompt to stdin; stdin.end() signals EOF so claude -p
      // starts processing once stdin closes.
      child.stdin.write(prompt);
      child.stdin.end();
    });
    // NOT `{...parseSummary(), assisted: true}`: parseSummary falls back to the
    // user's own text when the reply will not parse, and spreading true over that
    // would restore the exact lie this change removes. It sets the flag itself.
    return parseSummary(stdout, args.description);
  } catch (e: any) {
    return {
      ...fallbackSummary(args.description),
      assisted: false,
      // Say which thing was not there. Never a guessed cause.
      unavailable: String(e?.message || e).includes('ENOENT')
        ? 'No assistant is set up on this computer to rewrite it.'
        : `The assistant could not be reached: ${String(e?.message || e).slice(0, 200)}`,
    };
  }
}

function buildSummarizerPrompt(args: SummarizeArgs): string {
  const intro =
    args.kind === 'bug'
      ? 'You are summarizing a bug report from a YouCoded user for a GitHub issue.'
      : 'You are summarizing a feature request from a YouCoded user for a GitHub issue.';
  const logBlock =
    args.kind === 'bug' && args.log
      ? `\n\nThe last lines of their app log are:\n\`\`\`\n${args.log}\n\`\`\``
      : '';
  return [
    intro,
    `\n\nThe user wrote:\n«${args.description}»`,
    logBlock,
    '\n\nProduce a JSON object with fields:',
    '  - title: a one-line GitHub-issue title (≤80 chars)',
    "  - summary: a one-paragraph summary that captures the user's intent",
    '  - flagged_strings: an array of strings from the log that look sensitive (paths, IDs, possible secrets)',
    '\n\nRespond with JSON only — no prose, no markdown fences.',
  ].join('');
}

function parseSummary(stdout: string, fallbackText: string): SummaryResult {
  // Be lenient: strip ``` fences if the model added them anyway.
  const cleaned = stdout.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      title: String(parsed.title || fallbackText.slice(0, 80)),
      summary: String(parsed.summary || fallbackText),
      flagged_strings: Array.isArray(parsed.flagged_strings)
        ? parsed.flagged_strings.map(String)
        : [],
      assisted: true,
    };
  } catch {
    return {
      ...fallbackSummary(fallbackText),
      unavailable: 'The assistant replied with something this screen could not read, so your wording is unchanged.',
    };
  }
}

function fallbackSummary(description: string): SummaryResult {
  // Deliberately the user's own words: there is nothing better to say, and
  // inventing a summary would be worse. `assisted` is what tells the caller so.
  return {
    title: description.slice(0, 80),
    summary: description,
    flagged_strings: [],
    assisted: false,
  };
}

// ---------------------------------------------------------------------------
// T8: submitIssue (gh primary, URL fallback)
// ---------------------------------------------------------------------------

export interface SubmitArgs {
  kind: 'bug' | 'feature';
  title: string;
  /** Optional: AI help is a separate choice, so a ticket can be sent without one (R12). */
  summary?: string;
  description: string;
  log?: string;   // optional; bug-only
  label: 'bug' | 'enhancement';
  /**
   * The attachment route (R13/R14). GitHub uploads a file the moment it is attached,
   * so that ticket has to be finished in the browser — creating it here first would
   * file it before the user attached anything. Signed in or not, this returns the
   * prefilled URL and creates nothing.
   */
  browserOnly?: boolean;
}

/**
 * WHY three outcomes and not two (audit E-02/E-07, contract R23): every failure
 * used to return the same `{ ok:false, fallbackUrl }`, and the catch swallowed the
 * reason entirely. So "you are not signed in to GitHub" — an ordinary, expected
 * branch — was indistinguishable from "GitHub refused this" and from "the network
 * is down", and the screen answered all three by opening a browser tab and saying
 * "Opening GitHub in your browser…". A failure dressed as a normal outcome.
 *
 *  - sent            the issue exists; the url is the user's copy of it
 *  - needs-browser   NOT an error: no credential, so the ticket is finished in the
 *                    browser. `truncated` says whether the prefilled URL had to drop
 *                    part of the body to fit GitHub's cap, so the screen can disclose
 *                    it rather than silently lose the evidence.
 *  - failed          a real failure, with the reason the operation gave. The draft is
 *                    kept and the user can retry.
 */
export type SubmitResult =
  | { ok: true; url: string }
  | { ok: false; needsBrowser: true; fallbackUrl: string; truncated: boolean }
  | { ok: false; error: string; fallbackUrl: string };

/**
 * Submit a GitHub issue via the shared github-client (REST — app token or gh
 * token, Phase 3 2026-07-22, no gh CLI required), otherwise fall back to a
 * prefilled browser URL. The fallback path lets the user review and submit
 * in their browser themselves, and stays the guaranteed exit for machines
 * with no GitHub credential at all.
 *
 * WHY: Body is assembled here (main process) using the canonical
 * buildIssueBody helper so the Environment line contains the real
 * app version and OS string rather than navigator.userAgent from the
 * renderer (Fix 2 — code review feedback).
 */
export async function submitIssue(args: SubmitArgs): Promise<SubmitResult> {
  // Build body in the main process where app.getVersion() and os info are available.
  const body = buildIssueBody({
    kind: args.kind,
    // No AI summary is the normal case now (R12), not a missing field.
    summary: args.summary ?? '',
    description: args.description,
    log: args.log ?? '',
    version: app.getVersion(),
    platform: 'desktop',
    os: `${os.platform()} ${os.release()}`,
  });
  const fallbackUrl = buildPrefillUrl({ title: args.title, body, label: args.label });
  // The prefill drops body when the URL would exceed GitHub's cap; buildPrefillUrl
  // marks what it cut. Report it so the screen can say so (E-07) — the full draft
  // is still in the renderer either way.
  const truncated = fallbackUrl.includes('%5Btruncated%5D') || fallbackUrl.includes('[truncated]');

  if (args.browserOnly) return { ok: false, needsBrowser: true, fallbackUrl, truncated };

  let client: Awaited<ReturnType<typeof import('./github-client')['getGithubClient']>> | null = null;
  try {
    const mod = await import('./github-client');
    client = mod.getGithubClient();
  } catch (e: any) {
    return { ok: false, error: `Could not load the GitHub connection: ${String(e?.message || e)}`, fallbackUrl };
  }

  const token = client ? await client.getToken().catch(() => null) : null;
  // Not an error: nobody is signed in, so the ticket is finished in the browser.
  if (!client || !token) return { ok: false, needsBrowser: true, fallbackUrl, truncated };

  try {
    // Labels must exist on itsdestin/youcoded (ipc-bridge rule) — the REST
    // create applies them in the same call the old `gh issue create` did.
    const res = await client.api('POST', '/repos/itsdestin/youcoded/issues', {
      title: args.title,
      body,
      labels: [args.label, 'youcoded-app:reported'],
    });
    if (res.status === 201 && res.json?.html_url) {
      return { ok: true, url: String(res.json.html_url) };
    }
    // A real refusal. Say what GitHub said; never guess why
    // (docs/error-message-standards.md).
    const detail = String(res.json?.message || '').trim();
    return {
      ok: false,
      error: detail
        ? `GitHub did not create the ticket (${res.status}): ${detail}`
        : `GitHub did not create the ticket (${res.status}).`,
      fallbackUrl,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e), fallbackUrl };
  }
}

// ---------------------------------------------------------------------------
// T9: installWorkspace (clone/update + progress streaming)
// ---------------------------------------------------------------------------

const WORKSPACE_REPO = 'https://github.com/itsdestin/youcoded-dev';

export interface InstallResult {
  path: string;
  alreadyInstalled: boolean;
}

let installInFlight = false;

/** Test helper — DO NOT call from production code. */
export function _resetInstallGuard(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetInstallGuard is a test-only helper');
  }
  installInFlight = false;
}

/**
 * Clone-or-update the youcoded-dev workspace at ~/youcoded-dev, then
 * run setup.sh to fetch all sub-repos. Streams progress lines through
 * the supplied callback (which the IPC layer forwards as
 * `dev:install-progress` events to the renderer).
 *
 * Throws if a clone is already in flight (concurrency guard).
 * Throws with a stable message if the target dir exists with a wrong
 * remote — caller maps the message to UI text.
 */
export async function installWorkspace(
  onProgress: (line: string) => void,
): Promise<InstallResult> {
  if (installInFlight) {
    throw new Error('Install already in progress');
  }
  installInFlight = true;
  try {
    const targetPath = path.join(os.homedir(), 'youcoded-dev');
    const exists = fs.existsSync(targetPath);

    let alreadyInstalled = false;

    if (exists) {
      const remote = await getGitRemote(targetPath).catch(() => '');
      const status = classifyExistingWorkspace(remote);
      if (status === 'wrong-remote' || status === 'not-git') {
        throw new Error(
          `${targetPath} already exists but isn't the YouCoded dev workspace. ` +
            `Move or rename it and try again.`,
        );
      }
      // status === 'workspace' — update path
      alreadyInstalled = true;
      onProgress('Found existing workspace, pulling latest…');
      await runStreamed('git', ['-C', targetPath, 'pull', '--ff-only'], onProgress);
    } else {
      onProgress('Cloning workspace…');
      await runStreamed(
        'git',
        ['clone', '--depth', '50', WORKSPACE_REPO, targetPath],
        onProgress,
      );
    }

    onProgress('Cloning sub-repos (this may take a minute)…');
    await runStreamed('bash', ['setup.sh'], onProgress, { cwd: targetPath });

    return { path: targetPath, alreadyInstalled };
  } finally {
    installInFlight = false;
  }
}

async function getGitRemote(repoPath: string): Promise<string> {
  const { command, shell } = resolveCmd('git');
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ['-C', repoPath, 'remote', 'get-url', 'origin'],
      { timeout: 5_000, shell },
      (err, out) => (err ? reject(err) : resolve(String(out || '').trim())),
    );
  });
}

function runStreamed(
  cmd: string,
  args: string[],
  onProgress: (line: string) => void,
  opts: { cwd?: string } = {},
): Promise<void> {
  const { command, shell } = resolveCmd(cmd);
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: opts.cwd, env: process.env, shell });
    proc.stdout?.on('data', (b) => splitLines(b.toString()).forEach(onProgress));
    proc.stderr?.on('data', (b) => splitLines(b.toString()).forEach(onProgress));
    proc.on('error', reject);
    // 'close' fires after stdio is fully drained; 'exit' can fire while
    // buffers still have data, silently dropping the last lines of progress.
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function splitLines(s: string): string[] {
  return s.split(/\r?\n/).filter((l) => l.length > 0);
}

// --- dev:open-session-in logic ---
// Extracted here (rather than inline in ipc-handlers.ts) so it can be unit-
// tested without importing the full Electron IPC handler registration chain.
//
// Reads saved defaults (skipPermissions, model) from the defaults JSON file,
// merges with safe fallbacks, then calls sessionManager.createSession.

/** Minimal interface for the sessionManager dependency — avoids importing the
 *  full SessionManager class (which transitively pulls in Electron). */
export interface CreateSessionDeps {
  defaultsPrefPath: string;
  sessionManager: {
    createSession(opts: {
      name: string;
      cwd: string;
      skipPermissions: boolean;
      model?: string;
      initialInput?: string;
    }): SessionInfo;
  };
  homedir: () => string;
}

/** Safe fallback values when the defaults file is absent or unreadable. */
const DEV_SESSION_DEFAULTS = { skipPermissions: false, model: 'sonnet' };

/**
 * Creates a Development session in the given directory, inheriting
 * skipPermissions and model from the user's saved defaults file.
 * Exported for unit testing independent of IPC registration.
 */
export function openDevSessionIn(
  args: { cwd: string; initialInput?: string },
  deps: CreateSessionDeps,
): SessionInfo {
  let saved: Record<string, any> = {};
  try {
    // Apply DEV_SESSION_DEFAULTS spread so any future-added defaults fields
    // always have a safe fallback, matching the pattern in 'defaults:get'.
    saved = JSON.parse(fs.readFileSync(deps.defaultsPrefPath, 'utf-8'));
  } catch {
    // File absent or unreadable — fall back to DEV_SESSION_DEFAULTS below.
  }
  const merged = { ...DEV_SESSION_DEFAULTS, ...saved };
  const skipPermissions = merged.skipPermissions === true;
  const model = typeof merged.model === 'string' ? merged.model : undefined;
  return deps.sessionManager.createSession({
    name: 'Development',
    cwd: args.cwd ?? deps.homedir(),
    skipPermissions,
    model,
    initialInput: args.initialInput,
  });
}

// --- Managed development workspace (contract R9/R10) -------------------------
//
// Deliberately NOT installWorkspace() above. That one clones into a fixed
// ~/youcoded-dev, PULLS into it when it recognises the remote, and throws when it
// does not — all three ruled out by R9 ("an existing development folder is left
// untouched and the screen explains the new project is separate").
//
// WHERE it goes, and why not under Projects/: `sync-spaces/managed-roots.ts`
// turns EVERY directory under ~/YouCoded/Projects into a synced space, and the
// transport stages with `git add -A` (git-transport.ts). This workspace is ~1GB
// with five nested .git directories, so putting it there would silently push a
// gigabyte of source to the user's backup — while the approved screen says nothing
// about backup at all. ~/YouCoded/Development is inside the app's own folder (so it
// reads as app-managed) and outside both sync roots, so nothing is uploaded.
//
// State lives HERE, in main, not in the dialog: the screen tells the user "you can
// close this — setup keeps going". That is only true if closing the dialog cannot
// cancel it and reopening can ask where it got to.

export type WorkspaceSetupStatus = {
  state: 'idle' | 'running' | 'ready' | 'failed';
  path?: string;
  error?: string;
};

let setupStatusState: WorkspaceSetupStatus = { state: 'idle' };
let setupInFlight: Promise<{ ok: true; path: string } | { ok: false; error: string }> | null = null;

export function workspaceSetupStatus(): WorkspaceSetupStatus {
  return setupStatusState;
}

/**
 * WHY this exists (code review C12): the status was never cleared, so after one
 * failure every later open of the Contribute screen showed that same old failure and
 * the "Set up development workspace" button became unreachable for the rest of the
 * session. A 'ready' state outlived the folder the same way. The screen clears it
 * when the user acknowledges the outcome.
 */
export function clearWorkspaceSetupStatus(): void {
  if (setupInFlight) return;   // never lose sight of a run still going
  setupStatusState = { state: 'idle' };
}

/** A folder under ~/YouCoded/Development that does not exist yet. Never reuses one. */
function freeWorkspacePath(): string {
  const root = path.join(os.homedir(), 'YouCoded', 'Development');
  const base = 'youcoded-workspace';
  for (let n = 0; n < 100; n++) {
    const candidate = path.join(root, n === 0 ? base : `${base}-${n + 1}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Too many development workspaces already exist in YouCoded/Development.');
}

export function setupManagedWorkspace(
  registerFolder: (absPath: string) => void,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  // A second press joins the first run rather than starting a rival clone or
  // failing with "already exists" (design review F16).
  if (setupInFlight) return setupInFlight;
  setupInFlight = (async () => {
    setupStatusState = { state: 'running' };
    let target = '';
    // WHY the output is kept (code review C10): both steps used to stream into a
    // no-op, so a failure surfaced as "git exited with code 128" — the ONE number
    // that says nothing — while git's actual sentence ("could not resolve host",
    // "Permission denied") was captured and thrown away. The tail is what the user
    // is shown, so keep the last lines and nothing more.
    const output: string[] = [];
    const keep = (line: string) => { output.push(line); if (output.length > 40) output.shift(); };
    const withOutput = (e: unknown) => {
      const base = String((e as { message?: unknown })?.message ?? e);
      const tail = output.filter(l => l.trim()).slice(-3).join(' ').trim();
      return tail ? `${base} — ${tail}` : base;
    };
    try {
      target = freeWorkspacePath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await runStreamed('git', ['clone', '--depth', '50', WORKSPACE_REPO, target], keep);
      await runStreamed('bash', ['setup.sh'], keep, { cwd: target });
      registerFolder(target);
      setupStatusState = { state: 'ready', path: target };
      return { ok: true as const, path: target };
    } catch (e: unknown) {
      // The reason is the one the failing step gave. Never a guessed cause
      // (docs/error-message-standards.md).
      const error = withOutput(e);
      // WHY the partial tree goes (code review C11): a half-finished clone used to
      // stay on disk, so the next attempt walked past it to a NEW name and the user
      // silently accumulated broken copies — up to 100 of them. The screen tells them
      // "nothing was left behind, so trying again starts cleanly"; this is what makes
      // that true. Only ever the folder THIS run created.
      if (target) {
        try { fs.rmSync(target, { recursive: true, force: true }); }
        catch { /* a tree we cannot remove is not worth failing the report over */ }
      }
      setupStatusState = { state: 'failed', error };
      return { ok: false as const, error };
    } finally {
      setupInFlight = null;
    }
  })();
  return setupInFlight;
}
