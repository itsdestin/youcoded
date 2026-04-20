import { describe, it, expect } from 'vitest';
import { classifyPushError, truncateStderr } from '../src/main/sync-error-classifier';
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

  it('github backend falls through to UNKNOWN (no github patterns shipped)', () => {
    const ghInstance: BackendInstance = { ...driveInstance, id: 'gh-personal', type: 'github' };
    const w = classifyPushError('remote: Invalid username or password.', 'github', ghInstance);
    expect(w.code).toBe('UNKNOWN');
    expect(w.title).toBe('GitHub backup failed');
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
