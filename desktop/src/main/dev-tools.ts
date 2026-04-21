// desktop/src/main/dev-tools.ts
// Pure logic + IPC handler bodies for the Settings → Development feature.
// See docs/superpowers/specs/2026-04-21-development-settings-design.md.

import type { DevIssueKind } from '../shared/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { spawn } from 'child_process';

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
 * report or feature request. We pass the prompt as the final positional
 * argument and instruct the CLI to emit JSON only. On any failure
 * (CLI missing, not authenticated, JSON parse error) we degrade
 * gracefully to a fallback envelope built from the user's description
 * — submission still works.
 */
export async function summarizeIssue(args: SummarizeArgs): Promise<SummaryResult> {
  const prompt = buildSummarizerPrompt(args);
  try {
    const stdout: string = await new Promise((resolve, reject) => {
      execFile(
        'claude',
        ['-p', prompt],
        { timeout: 30_000, maxBuffer: 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(String(out || ''))),
      );
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
