// desktop/src/main/dev-tools.ts
// Pure logic + IPC handler bodies for the Settings → Development feature.
// See docs/superpowers/specs/2026-04-21-development-settings-design.md.

import type { DevIssueKind, SessionInfo } from '../shared/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
// WHY: app.getVersion() is only available in the main process. Used by
// submitIssue to embed the accurate YouCoded version in the issue body
// instead of relying on navigator.userAgent from the renderer (Fix 2).
import { app } from 'electron';

const GH_TOKEN_RE = /gh[opsu]_[A-Za-z0-9]{20,}/g;
const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_-]{20,}/g;

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
export async function summarizeIssue(args: SummarizeArgs): Promise<SummaryResult> {
  const prompt = buildSummarizerPrompt(args);
  try {
    const stdout: string = await new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p'], { timeout: 30_000 });
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
    return parseSummary(stdout, args.description);
  } catch {
    return fallbackSummary(args.description);
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
    };
  } catch {
    return fallbackSummary(fallbackText);
  }
}

function fallbackSummary(description: string): SummaryResult {
  return {
    title: description.slice(0, 80),
    summary: description,
    flagged_strings: [],
  };
}

// ---------------------------------------------------------------------------
// T8: submitIssue (gh primary, URL fallback)
// ---------------------------------------------------------------------------

export interface SubmitArgs {
  kind: 'bug' | 'feature';
  title: string;
  summary: string;
  description: string;
  log?: string;   // optional; bug-only
  label: 'bug' | 'enhancement';
}

export type SubmitResult =
  | { ok: true; url: string }
  | { ok: false; fallbackUrl: string };

/**
 * Submit a GitHub issue via the `gh` CLI when authenticated, otherwise
 * fall back to a prefilled browser URL. The fallback path lets the user
 * review and submit in their browser themselves.
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
    summary: args.summary,
    description: args.description,
    log: args.log ?? '',
    version: app.getVersion(),
    platform: 'desktop',
    os: `${os.platform()} ${os.release()}`,
  });

  const ghAuthed = await isGhAuthenticated();
  if (!ghAuthed) {
    return { ok: false, fallbackUrl: buildPrefillUrl({ title: args.title, body, label: args.label }) };
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `youcoded-issue-${Date.now()}-${process.pid}.md`,
  );
  await fs.promises.writeFile(tmpFile, body, 'utf8');

  try {
    const stdout: string = await new Promise((resolve, reject) => {
      execFile(
        'gh',
        [
          'issue', 'create',
          '--repo', 'itsdestin/youcoded',
          '--title', args.title,
          '--body-file', tmpFile,
          '--label', args.label,
          '--label', 'youcoded-app:reported',
        ],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(String(out || ''))),
      );
    });
    const url = (stdout.match(/https:\/\/github\.com\/[^\s]+/) || [''])[0].trim();
    if (!url) {
      // gh succeeded but didn't print a URL we can parse — treat as opaque success.
      return { ok: true, url: 'https://github.com/itsdestin/youcoded/issues' };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, fallbackUrl: buildPrefillUrl({ title: args.title, body, label: args.label }) };
  } finally {
    fs.promises.unlink(tmpFile).catch(() => undefined);
  }
}

async function isGhAuthenticated(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'status'], { timeout: 5_000 }, (err) => {
      resolve(!err);
    });
  });
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
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoPath, 'remote', 'get-url', 'origin'],
      { timeout: 5_000 },
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
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
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
