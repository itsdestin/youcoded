// Pins: sync refuses a public GitHub repo and re-checks on a cadence (security hardening 2026-10-30).
import { describe, it, expect, vi } from 'vitest';
import { makeRepoVisibilityChecker, parseGithubRepoUrl, VISIBILITY_RECHECK_MS } from '../src/main/sync-spaces/repo-visibility';

const URL_ = 'https://github.com/dana/youcoded-sync-personal.git';

describe('repo visibility re-check', () => {
  it('parses github clone URLs only', () => {
    expect(parseGithubRepoUrl(URL_)).toEqual({ owner: 'dana', name: 'youcoded-sync-personal' });
    expect(parseGithubRepoUrl('/tmp/remote.git')).toBeNull();
    expect(parseGithubRepoUrl('https://evil.example/a/b.git')).toBeNull();
  });

  it('throws the coded plain-language error when the repo is public, and does not cache that', async () => {
    const api = vi.fn(async () => ({ status: 200, json: { private: false } }));
    const check = makeRepoVisibilityChecker(api);
    await expect(check(URL_)).rejects.toMatchObject({ syncErrorCode: 'repo-public' });
    await expect(check(URL_)).rejects.toMatchObject({ syncErrorCode: 'repo-public' });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('caches a private answer, then asks again after the window (catches a repo flipped public later)', async () => {
    let t = 1_000;
    const answers = [{ private: true }, { private: false }];
    const api = vi.fn(async () => ({ status: 200, json: answers.shift()! }));
    const check = makeRepoVisibilityChecker(api, () => t);
    await check(URL_);
    t += 60_000; await check(URL_);               // inside the window: no new call
    expect(api).toHaveBeenCalledTimes(1);
    t += VISIBILITY_RECHECK_MS;                    // window over
    await expect(check(URL_)).rejects.toMatchObject({ syncErrorCode: 'repo-public' });
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('pauses sync (fails closed) when GitHub cannot be asked or gives no clear answer', async () => {
    await expect(makeRepoVisibilityChecker(async () => { throw new Error('ENOTFOUND'); })(URL_)).rejects.toThrow(/couldn't confirm/);
    await expect(makeRepoVisibilityChecker(async () => ({ status: 404, json: {} }))(URL_)).rejects.toThrow(/couldn't confirm/);
    await expect(makeRepoVisibilityChecker(async () => ({ status: 200, json: {} }))(URL_)).rejects.toThrow(/couldn't confirm/);
    // and a later good answer resumes it
    let ok = false;
    const check = makeRepoVisibilityChecker(async () => (ok ? { status: 200, json: { private: true } } : { status: 500, json: {} }));
    await expect(check(URL_)).rejects.toThrow();
    ok = true;
    await expect(check(URL_)).resolves.toBeUndefined();
  });
});
