/**
 * sync-error-classifier.ts — Pure function that maps rclone/git/iCloud
 * stderr to a typed SyncWarning. UNKNOWN is the default; specific codes
 * only returned on high-confidence substring match.
 *
 * Used by: sync-service.ts (on any push returning errors > 0).
 */

import type { SyncWarning, BackendType, BackendInstance } from './sync-state';

interface Pattern {
  code: string;
  level: 'danger' | 'warn';
  match: (stderr: string) => boolean;
  title: (backendType: BackendType, instance: BackendInstance) => string;
  body: (backendType: BackendType, instance: BackendInstance) => string;
  fixAction: (instance: BackendInstance) => SyncWarning['fixAction'];
}

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
 * Classify a push failure into a SyncWarning. Pure function — no I/O.
 * `stderr` may be empty; if it is, we fall through to UNKNOWN.
 */
export function classifyPushError(
  stderr: string,
  backendType: BackendType,
  instance: BackendInstance,
): SyncWarning {
  // Patterns only wired up for rclone/Drive in this release; other backends
  // skip straight to UNKNOWN with raw stderr shown in the panel.
  const patterns = backendType === 'drive' ? [RCLONE_MISSING, ...RCLONE_PATTERNS] : [];
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
