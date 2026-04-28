import { describe, it, expect } from 'vitest';
import {
  classifyPushError,
  decidePersonalSyncRemoteAction,
  extractStderr,
  truncateStderr,
  TIMEOUT_SENTINEL,
} from '../src/main/sync-error-classifier';
import type { BackendInstance } from '../src/main/sync-state';

const driveInstance: BackendInstance = {
  id: 'drive-personal',
  type: 'drive',
  label: 'Personal Drive',
  syncEnabled: true,
  config: { DRIVE_ROOT: 'Claude', rcloneRemote: 'gdrive' },
};

describe('classifyPushError', () => {
  it('returns CONFIG_MISSING when rclone reports missing section', () => {
    const stderr = `2026/04/17 14:59:50 CRITICAL: Failed to create file system for "gdrive:": didn't find section in config file ("gdrive")`;
    const w = classifyPushError(stderr, 'drive', driveInstance);
    expect(w.code).toBe('CONFIG_MISSING');
    expect(w.level).toBe('danger');
    expect(w.backendId).toBe('drive-personal');
    expect(w.fixAction?.kind).toBe('open-sync-setup');
    expect(w.dismissible).toBe(false);
    expect(w.stderr).toBeUndefined();
  });

  it('returns AUTH_EXPIRED for invalid_grant stderr', () => {
    const stderr = 'oauth2: "invalid_grant" "Token has been expired or revoked."';
    const w = classifyPushError(stderr, 'drive', driveInstance);
    expect(w.code).toBe('AUTH_EXPIRED');
  });

  it('returns QUOTA_EXCEEDED for storageQuotaExceeded stderr', () => {
    const stderr = 'googleapi: Error 403: storageQuotaExceeded';
    const w = classifyPushError(stderr, 'drive', driveInstance);
    expect(w.code).toBe('QUOTA_EXCEEDED');
    expect(w.fixAction?.kind).toBe('open-external');
  });

  it('returns NETWORK (warn level) for dial tcp stderr', () => {
    const stderr = 'dial tcp: lookup www.googleapis.com: no such host';
    const w = classifyPushError(stderr, 'drive', driveInstance);
    expect(w.code).toBe('NETWORK');
    expect(w.level).toBe('warn');
    expect(w.fixAction?.kind).toBe('retry');
  });

  it('returns RCLONE_MISSING when stderr contains ENOENT', () => {
    const w = classifyPushError('spawn rclone ENOENT', 'drive', driveInstance);
    expect(w.code).toBe('RCLONE_MISSING');
    expect(w.fixAction?.kind).toBe('open-external');
  });

  it('returns UNKNOWN for unrecognized stderr and preserves truncated stderr', () => {
    const stderr = 'some future rclone error we have never seen';
    const w = classifyPushError(stderr, 'drive', driveInstance);
    expect(w.code).toBe('UNKNOWN');
    expect(w.stderr).toBe(stderr);
  });

  it('UNKNOWN preserves stderr truncated to 500 chars', () => {
    const long = 'x'.repeat(600);
    const w = classifyPushError(long, 'drive', driveInstance);
    expect(w.stderr?.length).toBeLessThan(520);
    expect(w.stderr?.endsWith('(truncated)')).toBe(true);
  });

  it('github backend falls through to UNKNOWN for stderr matching no GitHub pattern', () => {
    const ghInstance: BackendInstance = { ...driveInstance, id: 'gh-personal', type: 'github' };
    // Some hypothetical future git error string — not matched by any current pattern.
    const w = classifyPushError('git: undocumented internal failure xyzzy', 'github', ghInstance);
    expect(w.code).toBe('UNKNOWN');
    expect(w.title).toBe('GitHub backup failed');
  });

  it('returns TIMEOUT (warn) when stderr contains the timeout sentinel', () => {
    const stderr = `${TIMEOUT_SENTINEL} child killed by SIGTERM after 600000ms\n`;
    const w = classifyPushError(stderr, 'drive', driveInstance);
    expect(w.code).toBe('TIMEOUT');
    expect(w.level).toBe('warn');
    expect(w.title).toBe('Google Drive backup timed out');
    expect(w.fixAction?.kind).toBe('retry');
  });

  it('TIMEOUT also classifies for github backends (universal pattern)', () => {
    const ghInstance: BackendInstance = { ...driveInstance, id: 'gh-personal', type: 'github' };
    const stderr = `${TIMEOUT_SENTINEL} child killed by SIGTERM after 300000ms\n`;
    const w = classifyPushError(stderr, 'github', ghInstance);
    expect(w.code).toBe('TIMEOUT');
    expect(w.title).toBe('GitHub backup timed out');
  });

  // ---- Universal: LOCAL_DISK_FULL ----

  it('returns LOCAL_DISK_FULL on Linux ENOSPC stderr', () => {
    const w = classifyPushError('write /home/u/.cache/x: no space left on device', 'drive', driveInstance);
    expect(w.code).toBe('LOCAL_DISK_FULL');
    expect(w.level).toBe('danger');
  });

  it('returns LOCAL_DISK_FULL on Windows disk-full stderr (also for github)', () => {
    const ghInstance: BackendInstance = { ...driveInstance, id: 'gh-personal', type: 'github' };
    const w = classifyPushError('There is not enough space on the disk.', 'github', ghInstance);
    expect(w.code).toBe('LOCAL_DISK_FULL');
  });

  // ---- Drive: RATE_LIMITED ----

  it('returns RATE_LIMITED for userRateLimitExceeded stderr', () => {
    const stderr = 'googleapi: Error 403: User Rate Limit Exceeded, userRateLimitExceeded';
    const w = classifyPushError(stderr, 'drive', driveInstance);
    expect(w.code).toBe('RATE_LIMITED');
    expect(w.level).toBe('warn');
  });

  it('RATE_LIMITED does not collide with QUOTA_EXCEEDED (both are 403)', () => {
    const quotaStderr = 'googleapi: Error 403: The user has exceeded their Drive storage quota, storageQuotaExceeded';
    const rateStderr = 'googleapi: Error 403: User Rate Limit Exceeded, userRateLimitExceeded';
    expect(classifyPushError(quotaStderr, 'drive', driveInstance).code).toBe('QUOTA_EXCEEDED');
    expect(classifyPushError(rateStderr, 'drive', driveInstance).code).toBe('RATE_LIMITED');
  });

  // ---- Drive: PERMISSION_DENIED ----

  it('returns PERMISSION_DENIED for insufficientFilePermissions stderr', () => {
    const stderr = 'googleapi: Error 403: The user does not have sufficient permissions for file, insufficientFilePermissions';
    const w = classifyPushError(stderr, 'drive', driveInstance);
    expect(w.code).toBe('PERMISSION_DENIED');
    expect(w.level).toBe('danger');
  });

  // ---- GitHub patterns ----

  const ghInstance: BackendInstance = { ...driveInstance, id: 'gh-personal', type: 'github' };

  it('returns GITHUB_AUTH for fatal: Authentication failed', () => {
    const stderr = 'fatal: Authentication failed for https://github.com/user/repo';
    const w = classifyPushError(stderr, 'github', ghInstance);
    expect(w.code).toBe('GITHUB_AUTH');
    expect(w.fixAction?.kind).toBe('open-sync-setup');
  });

  it('returns GITHUB_AUTH for SSH publickey rejection', () => {
    const stderr = 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.';
    const w = classifyPushError(stderr, 'github', ghInstance);
    expect(w.code).toBe('GITHUB_AUTH');
  });

  it('returns GITHUB_REPO_NOT_FOUND for missing repo', () => {
    const stderr = 'remote: Repository not found.\nfatal: repository not accessible';
    const w = classifyPushError(stderr, 'github', ghInstance);
    expect(w.code).toBe('GITHUB_REPO_NOT_FOUND');
  });

  it('returns GITHUB_LARGE_FILE for GH001', () => {
    const stderr = 'remote: error: GH001: Large files detected. You may want to try Git Large File Storage';
    const w = classifyPushError(stderr, 'github', ghInstance);
    expect(w.code).toBe('GITHUB_LARGE_FILE');
  });

  it('returns GITHUB_PUSH_REJECTED for non-fast-forward', () => {
    const stderr = ' ! [rejected]        main -> main (non-fast-forward)\nUpdates were rejected because the tip of your current branch is behind';
    const w = classifyPushError(stderr, 'github', ghInstance);
    expect(w.code).toBe('GITHUB_PUSH_REJECTED');
    expect(w.level).toBe('warn');
  });

  it('returns GITHUB_NETWORK for resolve-host failures', () => {
    const stderr = 'fatal: unable to access https://github.com/x/y.git: Could not resolve host: github.com';
    const w = classifyPushError(stderr, 'github', ghInstance);
    expect(w.code).toBe('GITHUB_NETWORK');
    expect(w.level).toBe('warn');
  });

  it('SSH connection timeout falls to GITHUB_NETWORK, not GITHUB_REPO_NOT_FOUND', () => {
    // Real git stderr for an SSH transport timeout includes "Could not read
    // from remote repository." as a secondary line. REPO_NOT_FOUND must NOT
    // catch this — it's a transport issue, not a missing repo. Regression
    // guard for the deleted match line in GITHUB_REPO_NOT_FOUND.
    const stderr = 'ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.';
    const w = classifyPushError(stderr, 'github', ghInstance);
    expect(w.code).toBe('GITHUB_NETWORK');
  });

  it('"Could not read from remote repository" alone does NOT match REPO_NOT_FOUND', () => {
    // A bare "Could not read from remote repository" with no other markers is
    // ambiguous — most likely a transport blip. It should fall through to
    // UNKNOWN rather than misleadingly tell the user the repo is missing.
    const stderr = 'fatal: Could not read from remote repository.';
    const w = classifyPushError(stderr, 'github', ghInstance);
    expect(w.code).toBe('UNKNOWN');
  });

  it('GitHub patterns do not leak into drive classification', () => {
    const stderr = 'fatal: Authentication failed for https://github.com/user/repo';
    const w = classifyPushError(stderr, 'drive', driveInstance);
    // Drive classifier must not match github auth strings — falls through to UNKNOWN.
    expect(w.code).toBe('UNKNOWN');
  });
});

describe('extractStderr', () => {
  it('returns sentinel + stderr when child was killed by signal', () => {
    const out = extractStderr({ killed: true, signal: 'SIGTERM', stderr: '' }, 60000);
    expect(out).toContain(TIMEOUT_SENTINEL);
    expect(out).toContain('SIGTERM');
    expect(out).toContain('60000ms');
  });

  it('preserves any partial stderr the child managed to write before kill', () => {
    const out = extractStderr({ killed: true, signal: 'SIGTERM', stderr: 'partial output' }, 60000);
    expect(out).toContain(TIMEOUT_SENTINEL);
    expect(out).toContain('partial output');
  });

  it('returns plain stderr when child exited non-zero (not timed out)', () => {
    const out = extractStderr({ stderr: 'real rclone error' }, 60000);
    expect(out).toBe('real rclone error');
    expect(out).not.toContain(TIMEOUT_SENTINEL);
  });

  it('falls back to message when neither killed nor stderr is set', () => {
    const out = extractStderr({ message: 'Command failed: rclone copy' }, 60000);
    expect(out).toBe('Command failed: rclone copy');
  });
});

describe('truncateStderr', () => {
  it('returns input unchanged when under 500 chars', () => {
    expect(truncateStderr('hello')).toBe('hello');
  });
  it('truncates input over 500 chars with suffix', () => {
    const out = truncateStderr('a'.repeat(501));
    expect(out.length).toBeLessThan(520);
    expect(out.endsWith('(truncated)')).toBe(true);
  });
});

describe('decidePersonalSyncRemoteAction', () => {
  const REPO = 'https://github.com/user/youcoded-personal-sync.git';

  it('returns null when personal-sync already exists (fresh-init case)', () => {
    expect(decidePersonalSyncRemoteAction('personal-sync\n', REPO)).toBeNull();
  });

  it('returns null when both personal-sync and another remote exist', () => {
    expect(decidePersonalSyncRemoteAction('origin\npersonal-sync\n', REPO)).toBeNull();
  });

  it('renames origin when only origin exists (the #74 bug state)', () => {
    expect(decidePersonalSyncRemoteAction('origin\n', REPO)).toEqual([
      'remote', 'rename', 'origin', 'personal-sync',
    ]);
  });

  it('adds personal-sync when no remotes exist (empty stdout)', () => {
    expect(decidePersonalSyncRemoteAction('', REPO)).toEqual([
      'remote', 'add', 'personal-sync', REPO,
    ]);
  });

  it('adds personal-sync when only an unrelated remote exists', () => {
    // User manually renamed `origin` to something custom — we add a fresh
    // personal-sync alongside rather than disturbing their setup.
    expect(decidePersonalSyncRemoteAction('upstream\n', REPO)).toEqual([
      'remote', 'add', 'personal-sync', REPO,
    ]);
  });

  it('handles Windows CRLF line endings from `git remote`', () => {
    // On Windows git emits `\r\n`-separated remote lists. The trim step
    // strips the trailing `\r`; without it `Array.includes` would fail.
    expect(decidePersonalSyncRemoteAction('origin\r\n', REPO)).toEqual([
      'remote', 'rename', 'origin', 'personal-sync',
    ]);
    expect(decidePersonalSyncRemoteAction('personal-sync\r\n', REPO)).toBeNull();
  });

  it('handles whitespace and empty lines gracefully', () => {
    expect(decidePersonalSyncRemoteAction('  origin  \n\n', REPO)).toEqual([
      'remote', 'rename', 'origin', 'personal-sync',
    ]);
  });

  it('does NOT confuse `personal-syncro` (substring) with `personal-sync` (exact)', () => {
    // Defensive: Array.includes is exact equality, not substring. Pin it.
    expect(decidePersonalSyncRemoteAction('personal-syncro\n', REPO)).toEqual([
      'remote', 'add', 'personal-sync', REPO,
    ]);
  });
});
