// desktop/src/main/dev-tools.ts
// Pure logic + IPC handler bodies for the Settings → Development feature.
// See docs/superpowers/specs/2026-04-21-development-settings-design.md.

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

import type { DevIssueKind } from '../shared/types';

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
    '**Logs (last N lines):**',
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
  return url;
}
