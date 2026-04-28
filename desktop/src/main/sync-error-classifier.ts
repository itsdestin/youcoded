/**
 * sync-error-classifier.ts — Pure function that maps rclone/git/iCloud
 * stderr to a typed SyncWarning. UNKNOWN is the default; specific codes
 * only returned on high-confidence substring match.
 *
 * Used by: sync-service.ts (on any push returning errors > 0).
 *
 * Also hosts the pure remote-name decision helper used by pushGithub's
 * self-heal block (kept here, not in sync-service.ts, so it has a unit-test
 * seam that doesn't require constructing a SyncService).
 */

import type { SyncWarning, BackendType, BackendInstance } from './sync-state';

/**
 * Decide which `git remote …` command to run to make `personal-sync` the
 * canonical remote name in a repoDir. Pure — no I/O.
 *
 * Inputs:
 *   - `remoteListStdout`: raw stdout from `git remote` (may be empty, may
 *     contain CRLF on Windows, may contain extra whitespace)
 *   - `syncRepo`: configured remote URL (used only when adding a fresh remote)
 *
 * Returns:
 *   - `null` if `personal-sync` already exists (no action needed)
 *   - `['remote', 'rename', 'origin', 'personal-sync']` if only `origin` exists
 *     (clone-success path, or pre-fix broken installs)
 *   - `['remote', 'add', 'personal-sync', syncRepo]` if neither exists
 *     (rare — empty remotes list, or some unrelated third remote name)
 *
 * Existence checks are exact-match against the trimmed remote name list, so
 * a remote called `personal-syncro` would not be mistaken for `personal-sync`.
 */
export function decidePersonalSyncRemoteAction(
  remoteListStdout: string,
  syncRepo: string,
): string[] | null {
  const remotes = (remoteListStdout || '')
    .split('\n')
    .map(r => r.trim())
    .filter(Boolean);
  if (remotes.includes('personal-sync')) return null;
  if (remotes.includes('origin')) return ['remote', 'rename', 'origin', 'personal-sync'];
  return ['remote', 'add', 'personal-sync', syncRepo];
}

interface Pattern {
  code: string;
  level: 'danger' | 'warn';
  match: (stderr: string) => boolean;
  title: (backendType: BackendType, instance: BackendInstance) => string;
  body: (backendType: BackendType, instance: BackendInstance) => string;
  fixAction: (instance: BackendInstance) => SyncWarning['fixAction'];
}

// Sentinel that rclone()/gitExec() prepend to stderr when Node killed the
// child process due to its own `timeout:` option. The exec error in that case
// has empty `e.stderr` (the child was SIGTERM'd before flushing), so without
// a sentinel the classifier would fall through to UNKNOWN.
export const TIMEOUT_SENTINEL = '[timeout-killed]';

// Universal patterns checked first regardless of backend type — these match
// transport-layer failures (timeouts, missing binaries, local disk full) that
// any backend can hit. Order matters: more specific patterns must come first.
const UNIVERSAL_PATTERNS: Pattern[] = [
  {
    code: 'TIMEOUT',
    level: 'warn',
    match: (s) => s.includes(TIMEOUT_SENTINEL),
    title: (bt) => `${backendLabel(bt)} backup timed out`,
    body: (bt) =>
      `A ${backendLabel(bt)} upload didn't finish in time. This usually means a large file or slow connection. We'll retry on the next sync.`,
    fixAction: (inst) => ({
      label: 'Retry now',
      kind: 'retry',
      payload: { backendId: inst.id },
    }),
  },
  {
    // Local disk full — happens during PULL (writing remote data to local disk)
    // or during git operations (clone/checkout into local repo). Drive pushes
    // hit `storageQuotaExceeded` instead, which is the Drive-side variant.
    code: 'LOCAL_DISK_FULL',
    level: 'danger',
    match: (s) =>
      s.includes('no space left on device') ||
      s.includes('There is not enough space on the disk') ||
      s.includes('ENOSPC'),
    title: () => 'Local disk is full',
    body: () =>
      "Sync can't continue because this device's disk is full. Free up space and we'll retry on the next sync.",
    fixAction: (inst) => ({
      label: 'Retry now',
      kind: 'retry',
      payload: { backendId: inst.id },
    }),
  },
];

// Rclone-first patterns. Order matters — first match wins.
// Defensive: patterns are long substrings, not loose regex, to avoid misclassification.
const RCLONE_PATTERNS: Pattern[] = [
  {
    code: 'CONFIG_MISSING',
    level: 'danger',
    match: (s) => s.includes("didn't find section in config file"),
    title: () => "Google Drive isn't connected",
    body: () =>
      "The Google Drive connection is missing from rclone. Reconnect to resume backups.",
    fixAction: (inst) => ({
      label: 'Reconnect Google Drive',
      kind: 'open-sync-setup',
      payload: { backendId: inst.id },
    }),
  },
  {
    code: 'AUTH_EXPIRED',
    level: 'danger',
    match: (s) =>
      s.includes('invalid_grant') ||
      s.includes('token has been expired or revoked') ||
      s.includes('401 Unauthorized'),
    title: () => 'Google Drive sign-in expired',
    body: () =>
      'Your Google Drive access expired. Sign in again to resume backups.',
    fixAction: (inst) => ({
      label: 'Sign in again',
      kind: 'open-sync-setup',
      payload: { backendId: inst.id },
    }),
  },
  {
    code: 'QUOTA_EXCEEDED',
    level: 'danger',
    match: (s) =>
      s.includes('storageQuotaExceeded') || s.includes('quotaExceeded'),
    title: () => 'Google Drive is full',
    body: () =>
      "Google Drive is out of space. Free up space or upgrade your storage plan.",
    fixAction: () => ({
      label: 'Open Drive storage',
      kind: 'open-external',
      payload: { url: 'https://one.google.com/storage' },
    }),
  },
  {
    code: 'NETWORK',
    level: 'warn',
    match: (s) =>
      s.includes('dial tcp') ||
      s.includes('no such host') ||
      s.includes('i/o timeout') ||
      s.includes('connection refused'),
    title: () => "Can't reach Google Drive",
    body: () =>
      "Couldn't connect to Google Drive. We'll retry on the next sync.",
    fixAction: (inst) => ({
      label: 'Retry now',
      kind: 'retry',
      payload: { backendId: inst.id },
    }),
  },
  {
    // Google API rate limiting. Surfaces as 403 with a specific reason string
    // — distinct from QUOTA_EXCEEDED (storage full) and PERMISSION_DENIED (ACL).
    // 429 is rare here (Google uses 403 with reason) but we match it defensively.
    code: 'RATE_LIMITED',
    level: 'warn',
    match: (s) =>
      s.includes('rateLimitExceeded') ||
      s.includes('userRateLimitExceeded') ||
      s.includes('Too Many Requests') ||
      s.includes('429 Too Many'),
    title: () => 'Google Drive is throttling',
    body: () =>
      "Google is asking us to slow down on Drive uploads. We'll back off and retry on the next sync.",
    fixAction: (inst) => ({
      label: 'Retry now',
      kind: 'retry',
      payload: { backendId: inst.id },
    }),
  },
  {
    // Permission errors. Distinct from auth (sign-in works) — the account is
    // signed in but lacks rights to write at the destination path. Most common
    // cause: a folder under Backup/personal/ is shared with restricted edit
    // rights, or the destination was moved to a Shared Drive without granting
    // the connected account "Content manager" access.
    code: 'PERMISSION_DENIED',
    level: 'danger',
    match: (s) =>
      s.includes('insufficientFilePermissions') ||
      s.includes('does not have sufficient permissions') ||
      s.includes('cannotModifyViewersCanCopyContent'),
    title: () => "Google Drive denied write access",
    body: () =>
      "Drive accepted the sign-in but blocked the write. The destination folder may be read-only or owned by another account.",
    fixAction: (inst) => ({
      label: 'Open sync settings',
      kind: 'open-sync-setup',
      payload: { backendId: inst.id },
    }),
  },
];

// GitHub-specific patterns. Stderr comes from `git push`/`git pull` invoked
// via gitExec(). Order matters — auth/missing-repo are most actionable, so
// they're matched before the catch-all push-rejected case.
const GITHUB_PATTERNS: Pattern[] = [
  {
    code: 'GITHUB_AUTH',
    level: 'danger',
    match: (s) =>
      s.includes('Authentication failed') ||
      s.includes('could not read Username') ||
      s.includes('Permission denied (publickey)') ||
      s.includes('fatal: Authentication failed') ||
      s.includes('remote: Invalid username or password'),
    title: () => "GitHub sign-in needed",
    body: () =>
      "GitHub rejected our credentials. Reconnect or refresh your token to resume backups.",
    fixAction: (inst) => ({
      label: 'Reconnect GitHub',
      kind: 'open-sync-setup',
      payload: { backendId: inst.id },
    }),
  },
  {
    code: 'GITHUB_REPO_NOT_FOUND',
    level: 'danger',
    // The two `Repository not found` patterns are real GitHub 404s. We
    // intentionally do NOT match `Could not read from remote repository.` —
    // that line appears as a secondary message in transport failures (SSH
    // connection timeouts, etc.) which should fall through to GITHUB_NETWORK
    // or UNKNOWN. The auth case is caught earlier by GITHUB_AUTH on its own
    // markers.
    match: (s) =>
      s.includes('Repository not found') ||
      s.includes('remote: Repository not found'),
    title: () => "GitHub backup repo is missing",
    body: () =>
      "The configured backup repo doesn't exist or isn't accessible. Check the URL or create the repo, then retry.",
    fixAction: (inst) => ({
      label: 'Open sync settings',
      kind: 'open-sync-setup',
      payload: { backendId: inst.id },
    }),
  },
  {
    code: 'GITHUB_LARGE_FILE',
    level: 'danger',
    match: (s) =>
      s.includes("GH001: Large files detected") ||
      s.includes("this exceeds GitHub's file size limit") ||
      s.includes('larger than 100.00 MB'),
    title: () => "GitHub blocked an oversized file",
    body: () =>
      "GitHub rejected the push because a file is over its 100 MB limit. The file needs Git LFS or to be excluded from sync.",
    fixAction: (inst) => ({
      label: 'Retry now',
      kind: 'retry',
      payload: { backendId: inst.id },
    }),
  },
  {
    code: 'GITHUB_PUSH_REJECTED',
    level: 'warn',
    match: (s) =>
      s.includes('! [rejected]') ||
      s.includes('non-fast-forward') ||
      s.includes('Updates were rejected') ||
      s.includes('fetch first'),
    title: () => "GitHub push was rejected",
    body: () =>
      "Another device pushed to the backup repo first. Sync will reconcile on the next pull cycle.",
    fixAction: (inst) => ({
      label: 'Retry now',
      kind: 'retry',
      payload: { backendId: inst.id },
    }),
  },
  {
    code: 'GITHUB_NETWORK',
    level: 'warn',
    match: (s) =>
      s.includes('Could not resolve host') ||
      s.includes('Failed to connect to') ||
      s.includes('Connection timed out') ||
      s.includes('Operation timed out'),
    title: () => "Can't reach GitHub",
    body: () =>
      "Couldn't connect to GitHub. We'll retry on the next sync.",
    fixAction: (inst) => ({
      label: 'Retry now',
      kind: 'retry',
      payload: { backendId: inst.id },
    }),
  },
];

// Wrapper-layer detection: spawn ENOENT fires before any stderr is produced.
// The caller passes the raw Error.code as a hint string (e.g., "ENOENT").
const RCLONE_MISSING: Pattern = {
  code: 'RCLONE_MISSING',
  level: 'danger',
  match: (s) => s.includes('ENOENT'),
  title: () => "rclone isn't installed",
  body: () =>
    "The rclone tool is needed for Google Drive sync but isn't installed. Install it to enable backups.",
  fixAction: () => ({
    label: 'Install rclone',
    kind: 'open-external',
    payload: { url: 'https://rclone.org/install/' },
  }),
};

const UNKNOWN: Pattern = {
  code: 'UNKNOWN',
  level: 'danger',
  match: () => true,
  title: (bt) => `${backendLabel(bt)} backup failed`,
  body: (bt) =>
    `Backups to ${backendLabel(bt)} are failing. See details in the sync panel.`,
  fixAction: (inst) => ({
    label: 'Retry now',
    kind: 'retry',
    payload: { backendId: inst.id },
  }),
};

function backendLabel(t: BackendType): string {
  return t === 'drive' ? 'Google Drive' : t === 'github' ? 'GitHub' : 'iCloud';
}

/**
 * Truncate stderr to 500 chars to bound log/file size.
 * Used both in the SyncWarning.stderr field and in backup.log extras.
 */
export function truncateStderr(stderr: string): string {
  if (stderr.length <= 500) return stderr;
  return stderr.slice(0, 500) + '… (truncated)';
}

/**
 * Build the stderr string surfaced to the classifier from a child_process
 * exec rejection. When Node kills the child via its `timeout:` option the
 * child has no chance to write stderr — the rejection just has `killed: true`
 * and `signal: 'SIGTERM'`. We synthesize a sentinel string so the classifier
 * can recognize the case instead of falling through to UNKNOWN.
 */
export function extractStderr(e: any, timeoutMs: number): string {
  if (e?.killed && e?.signal) {
    return `${TIMEOUT_SENTINEL} child killed by ${e.signal} after ${timeoutMs}ms\n${e.stderr || ''}`;
  }
  return e?.stderr || e?.message || '';
}

/**
 * Classify a push failure into a SyncWarning. Pure function — no I/O.
 * `stderr` may be empty; if it is, we fall through to UNKNOWN.
 */
export function classifyPushError(
  stderr: string,
  backendType: BackendType,
  instance: BackendInstance,
): SyncWarning {
  // Universal patterns first (timeouts and local disk full apply to any backend),
  // then backend-specific. iCloud has no specific patterns yet.
  const backendSpecific =
    backendType === 'drive' ? [RCLONE_MISSING, ...RCLONE_PATTERNS] :
    backendType === 'github' ? GITHUB_PATTERNS :
    [];
  const patterns = [...UNIVERSAL_PATTERNS, ...backendSpecific];
  const picked = patterns.find((p) => p.match(stderr)) || UNKNOWN;

  return {
    code: picked.code,
    level: picked.level,
    backendId: instance.id,
    title: picked.title(backendType, instance),
    body: picked.body(backendType, instance),
    fixAction: picked.fixAction(instance),
    dismissible: false,
    stderr: picked.code === 'UNKNOWN' ? truncateStderr(stderr) : undefined,
    createdEpoch: Math.floor(Date.now() / 1000),
  };
}
