import { describe, it, expect } from 'vitest';
import {
  classifyPushError,
  decidePersonalSyncRemoteAction,
  extractStderr,
  truncateStderr,
  TIMEOUT_SENTINEL,
  matchGitCorruption,
  isNetworkFailureStderr,
  stderrTail,
  REPO_CORRUPT_ERROR_CODE,
} from '../src/main/sync-error-classifier';
import type { BackendInstance } from '../src/main/sync-state';

const driveInstance: BackendInstance = {
  id: 'drive-personal',
  type: 'drive',
  label: 'Personal Drive',
  syncEnabled: true,
  config: { DRIVE_ROOT: 'Claude', rcloneRemote: 'gdrive' },
};

const ghInstance: BackendInstance = { ...driveInstance, id: 'gh-personal', type: 'github' };
const instanceFor = (type: 'drive' | 'github') => (type === 'drive' ? driveInstance : ghInstance);

describe('classifyPushError', () => {
  // [case, backend, stderr, fields the warning must carry]
  it.each([
    ['AUTH_EXPIRED on invalid_grant', 'drive', 'oauth2: "invalid_grant" "Token has been expired or revoked."', { code: 'AUTH_EXPIRED' }],
    ['QUOTA_EXCEEDED on storageQuotaExceeded', 'drive', 'googleapi: Error 403: storageQuotaExceeded', { code: 'QUOTA_EXCEEDED', fixAction: { kind: 'open-external' } }],
    ['NETWORK (warn) on dial tcp', 'drive', 'dial tcp: lookup www.googleapis.com: no such host', { code: 'NETWORK', level: 'warn', fixAction: { kind: 'retry' } }],
    ['RCLONE_MISSING on ENOENT', 'drive', 'spawn rclone ENOENT', { code: 'RCLONE_MISSING', fixAction: { kind: 'open-external' } }],
    ['TIMEOUT (warn) on the timeout sentinel', 'drive', `${TIMEOUT_SENTINEL} child killed by SIGTERM after 600000ms\n`, { code: 'TIMEOUT', level: 'warn', title: 'Google Drive backup timed out', fixAction: { kind: 'retry' } }],
    ['TIMEOUT also for github (universal pattern)', 'github', `${TIMEOUT_SENTINEL} child killed by SIGTERM after 300000ms\n`, { code: 'TIMEOUT', title: 'GitHub backup timed out' }],
    ['LOCAL_DISK_FULL on Linux ENOSPC', 'drive', 'write /home/u/.cache/x: no space left on device', { code: 'LOCAL_DISK_FULL', level: 'danger' }],
    ['LOCAL_DISK_FULL on Windows disk-full (also github)', 'github', 'There is not enough space on the disk.', { code: 'LOCAL_DISK_FULL' }],
    ['RATE_LIMITED on userRateLimitExceeded', 'drive', 'googleapi: Error 403: User Rate Limit Exceeded, userRateLimitExceeded', { code: 'RATE_LIMITED', level: 'warn' }],
    // Both are HTTP 403, so the two patterns must not collide.
    ['QUOTA_EXCEEDED, not RATE_LIMITED, for a storage-quota 403', 'drive', 'googleapi: Error 403: The user has exceeded their Drive storage quota, storageQuotaExceeded', { code: 'QUOTA_EXCEEDED' }],
    ['PERMISSION_DENIED on insufficientFilePermissions', 'drive', 'googleapi: Error 403: The user does not have sufficient permissions for file, insufficientFilePermissions', { code: 'PERMISSION_DENIED', level: 'danger' }],
    ['GITHUB_AUTH on Authentication failed', 'github', 'fatal: Authentication failed for https://github.com/user/repo', { code: 'GITHUB_AUTH', fixAction: { kind: 'open-sync-setup' } }],
    ['GITHUB_AUTH on SSH publickey rejection', 'github', 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', { code: 'GITHUB_AUTH' }],
    ['GITHUB_REPO_NOT_FOUND for a missing repo', 'github', 'remote: Repository not found.\nfatal: repository not accessible', { code: 'GITHUB_REPO_NOT_FOUND' }],
    ['GITHUB_LARGE_FILE for GH001', 'github', 'remote: error: GH001: Large files detected. You may want to try Git Large File Storage', { code: 'GITHUB_LARGE_FILE' }],
    ['GITHUB_PUSH_REJECTED (warn) for non-fast-forward', 'github', ' ! [rejected]        main -> main (non-fast-forward)\nUpdates were rejected because the tip of your current branch is behind', { code: 'GITHUB_PUSH_REJECTED', level: 'warn' }],
    ['GITHUB_NETWORK (warn) for resolve-host failures', 'github', 'fatal: unable to access https://github.com/x/y.git: Could not resolve host: github.com', { code: 'GITHUB_NETWORK', level: 'warn' }],
    // An SSH transport timeout carries "Could not read from remote repository." as a secondary line;
    // REPO_NOT_FOUND must not claim it.
    ['GITHUB_NETWORK, not REPO_NOT_FOUND, for an SSH timeout', 'github', 'ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.', { code: 'GITHUB_NETWORK' }],
    // Bare line is ambiguous (likely a transport blip): UNKNOWN rather than telling the user the repo is missing.
    ['UNKNOWN for a bare "Could not read from remote repository"', 'github', 'fatal: Could not read from remote repository.', { code: 'UNKNOWN' }],
    ['UNKNOWN for stderr matching no GitHub pattern', 'github', 'git: undocumented internal failure xyzzy', { code: 'UNKNOWN', title: 'GitHub backup failed' }],
    ['UNKNOWN: GitHub patterns do not leak into drive', 'drive', 'fatal: Authentication failed for https://github.com/user/repo', { code: 'UNKNOWN' }],
  ] as const)('%s', (_case, backend, stderr, expected) => {
    expect(classifyPushError(stderr, backend, instanceFor(backend))).toMatchObject(expected);
  });

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

  it('UNKNOWN preserves the stderr, truncated to 500 chars', () => {
    const stderr = 'some future rclone error we have never seen';
    expect(classifyPushError(stderr, 'drive', driveInstance)).toMatchObject({ code: 'UNKNOWN', stderr });
    const w = classifyPushError('x'.repeat(600), 'drive', driveInstance);
    expect(w.stderr?.length).toBeLessThan(520);
    expect(w.stderr?.endsWith('(truncated)')).toBe(true);
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
  const RENAME = ['remote', 'rename', 'origin', 'personal-sync'];
  const ADD = ['remote', 'add', 'personal-sync', REPO];

  // CRLF: Windows git emits `\r\n`-separated remotes; the trim must strip `\r` or the exact match fails.
  // `personal-syncro`: matching is exact equality, not substring. `upstream`: a custom remote is left alone.
  it.each([
    ['personal-sync already exists (fresh init)', 'personal-sync\n', null],
    ['personal-sync and another remote exist', 'origin\npersonal-sync\n', null],
    ['only origin exists → rename it', 'origin\n', RENAME],
    ['no remotes (empty stdout) → add', '', ADD],
    ['only an unrelated remote → add alongside', 'upstream\n', ADD],
    ['CRLF: origin only → rename', 'origin\r\n', RENAME],
    ['CRLF: personal-sync exists', 'personal-sync\r\n', null],
    ['stray whitespace and empty lines', '  origin  \n\n', RENAME],
    ['personal-syncro is not personal-sync', 'personal-syncro\n', ADD],
  ])('%s', (_case, stdout, expected) => {
    expect(decidePersonalSyncRemoteAction(stdout, REPO)).toEqual(expected);
  });
});

describe('classifyGitFailure primitives', () => {
  it('recognizes the crash-corruption signatures', () => {
    // Real stderr captured from the 2026-07-27 Z13 incident.
    expect(matchGitCorruption('error: object file .git/objects/32/5153…bf8b94c is empty\nfatal: bad object HEAD')).toContain('is empty');
    expect(matchGitCorruption('fatal: bad object refs/heads/main')).toContain('bad object');
    expect(matchGitCorruption('error: unable to read 3251535497a31d0436ae0f81533468121bf8b94c')).toContain('unable to read');
    expect(matchGitCorruption('fatal: index file corrupt')).toContain('index file corrupt');
    expect(matchGitCorruption('fatal: not a git repository: /x/.youcoded/sync.git')).toContain('not a git repository');
    expect(matchGitCorruption('error: Unknown object type for 12ac40…')).toContain('Unknown object type');
    expect(matchGitCorruption('fatal: bad ref for refs/heads/main')).toContain('bad ref');
    expect(matchGitCorruption('error: loose object 99d1… is corrupt')).toContain('corrupt');
  });

  it('does NOT flag benign / unrelated failures as corruption', () => {
    // First push: origin/main doesn't exist yet — the ahead-probe's expected failure.
    expect(matchGitCorruption('fatal: Invalid revision range origin/main..main')).toBeNull();
    expect(matchGitCorruption("fatal: couldn't find remote ref main")).toBeNull();
    expect(matchGitCorruption('nothing to commit, working tree clean')).toBeNull();
    expect(matchGitCorruption("fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com")).toBeNull();
    expect(matchGitCorruption('')).toBeNull();
  });

  it('does NOT flag remote-authored corruption-shaped lines as LOCAL repo damage', () => {
    // The server writes `remote:`-prefixed lines verbatim into our stderr on
    // fetch/push. A misconfigured or corrupt SERVER-side repo must never
    // trigger THIS device's repair() — that would reset a perfectly healthy
    // local `main` to origin/main and discard readable local commits over a
    // problem that isn't local at all.
    expect(matchGitCorruption('remote: error: unable to read object 123')).toBeNull();
    expect(matchGitCorruption('remote: fatal: bad object HEAD')).toBeNull();
    // Same text, un-prefixed (i.e. actually ours), must still match.
    expect(matchGitCorruption('error: unable to read object 123')).toContain('unable to read');
    expect(matchGitCorruption('fatal: bad object HEAD')).toContain('bad object');
  });

  it('does NOT flag a missing/unmounted space root (cwd-read fatal) as repo corruption', () => {
    // "unable to read current working directory" is git failing to resolve
    // its OWN cwd (the space root was deleted or an external drive was
    // unmounted mid-cycle) — not an object/ref integrity problem. It happens
    // to contain the substring "unable to read" too. Misclassifying it would
    // call repair(), whose Tier 2 fallback recreates <root>/.youcoded via a
    // recursive mkdir — silently rebuilding the deleted/unmounted mount point
    // as a plain local directory and then repopulating it from the remote at
    // the WRONG path.
    expect(matchGitCorruption('fatal: unable to read current working directory: No such file or directory')).toBeNull();
    // The object-integrity "unable to read" must still match.
    expect(matchGitCorruption('error: unable to read 3251535497a31d0436ae0f81533468121bf8b94c')).toContain('unable to read');
  });

  it('recognizes network failures (the silent-offline allowlist)', () => {
    expect(isNetworkFailureStderr('fatal: unable to access …: Could not resolve host: github.com')).toBe(true);
    expect(isNetworkFailureStderr('fatal: unable to access …: Connection timed out')).toBe(true);
    expect(isNetworkFailureStderr('ssh: connect to host github.com port 22: Network is unreachable')).toBe(true);
    expect(isNetworkFailureStderr("fatal: couldn't find remote ref main")).toBe(true); // empty remote: first device, pre-first-push
    expect(isNetworkFailureStderr('fatal: bad object HEAD')).toBe(false);
    expect(isNetworkFailureStderr('remote: Repository not found.')).toBe(false);
  });

  it('stderrTail keeps the end of long stderr (where git puts the fatal line)', () => {
    const s = 'error: line1\n'.repeat(200) + 'fatal: the actual cause';
    expect(stderrTail(s)).toContain('fatal: the actual cause');
    expect(stderrTail(s).length).toBeLessThanOrEqual(300);
    expect(stderrTail('short')).toBe('short');
    expect(REPO_CORRUPT_ERROR_CODE).toBe('repo-corrupt');
  });
});
