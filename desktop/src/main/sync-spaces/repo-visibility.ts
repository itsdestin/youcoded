// desktop/src/main/sync-spaces/repo-visibility.ts
// Sync must never push someone's conversations or project files to a PUBLIC GitHub repo.
//
// WHY (security hardening 2026-10-30): new sync repos are created private, but (a) an
// already-existing same-named repo used to be adopted without looking at its visibility,
// and (b) a repo flipped public later was never noticed. This module holds the plain
// error and a cached re-check that runs before a sync cycle.
import { GITHUB_AUTH_ERROR_CODE, repoPublicError } from '../github-client';

/** `https://github.com/owner/name(.git)` -> { owner, name }, else null. */
export function parseGithubRepoUrl(url: string): { owner: string; name: string } | null {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return m ? { owner: m[1], name: m[2] } : null;
}

type Api = (method: string, apiPath: string) => Promise<{ status: number; json: any }>;

/** How long a "still private" answer is trusted before GitHub is asked again. */
export const VISIBILITY_RECHECK_MS = 30 * 60 * 1000;

/**
 * Returns a checker: `await check(remoteUrl)` throws the coded public-repo error when the
 * repo is public, and otherwise returns. A "private" answer is cached for
 * VISIBILITY_RECHECK_MS so the normal 2-minute sync cycle makes at most ~2 extra GitHub
 * calls an hour. A failed lookup (offline, signed out, repo not visible) NEVER blocks
 * sync: those cases already surface through the sync's own errors, and a hiccup must not
 * look like a privacy problem. A "public" answer is never cached, so fixing the repo
 * resumes sync on the very next cycle.
 */
export function makeRepoVisibilityChecker(api: Api, now: () => number = Date.now) {
  const okUntil = new Map<string, number>();
  return async function check(remoteUrl: string): Promise<void> {
    const repo = parseGithubRepoUrl(remoteUrl);
    if (!repo) return; // not a github.com remote (dev/test setups): nothing to ask
    const key = `${repo.owner}/${repo.name}`.toLowerCase();
    if ((okUntil.get(key) ?? 0) > now()) return;
    let res: { status: number; json: any };
    try {
      res = await api('GET', `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`);
    } catch (e: any) {
      if (e?.syncErrorCode === GITHUB_AUTH_ERROR_CODE) return; // sign-in problems are reported by sync itself
      return;
    }
    if (res.status !== 200) return;
    if (res.json?.private === false) throw repoPublicError(repo.name);
    if (res.json?.private === true) okUntil.set(key, now() + VISIBILITY_RECHECK_MS);
  };
}
