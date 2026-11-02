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

/** Plain pause message when GitHub could not confirm the repo is private. No cause is claimed. */
export function repoUncheckedError(repoName: string): Error {
  return new Error(`Sync is paused because YouCoded couldn't confirm that the GitHub repository "${repoName}" is private. It will check again shortly. If this keeps happening, make sure you're connected to GitHub in the Sync settings.`);
}

/** How long a "still private" answer is trusted before GitHub is asked again. */
export const VISIBILITY_RECHECK_MS = 30 * 60 * 1000;

/**
 * Returns a checker: `await check(remoteUrl)` throws the coded public-repo error when the
 * repo is public, and otherwise returns. A "private" answer is cached for
 * VISIBILITY_RECHECK_MS so the normal 2-minute sync cycle makes at most ~2 extra GitHub
 * calls an hour. A lookup that fails or gives no clear answer (offline, signed out, repo not
 * visible) now PAUSES that sync cycle with a plain message — fail closed (integration review 2026-11-01): "can't tell" must
 * not mean "assume private", because a skipped check is exactly how a public repo goes unnoticed. The next cycle asks
 * again, so a hiccup clears itself. A "public" answer is never cached, so fixing the repo
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
      if (e?.syncErrorCode === GITHUB_AUTH_ERROR_CODE) throw e; // its own plain "reconnect GitHub" message
      throw repoUncheckedError(repo.name);
    }
    if (res.status !== 200) throw repoUncheckedError(repo.name);
    if (res.json?.private === false) throw repoPublicError(repo.name);
    if (res.json?.private !== true) throw repoUncheckedError(repo.name);
    okUntil.set(key, now() + VISIBILITY_RECHECK_MS);
  };
}
