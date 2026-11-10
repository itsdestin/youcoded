// Same-website guard for downloads that follow links (review deck round 3, Q-7 "same-site", 2026-11-02).
//
// WHY this exists: a saved "downloads from github.com only" rule is decided BEFORE the command runs, and a rule cannot see
// where the website will send curl. So when such a rule allows a link-following download, the session calls this first:
//  1. walk the links ourselves, one hop at a time, WITHOUT fetching a body (headers only);
//  2. every hop must be the exact same website (github.com is not objects.githubusercontent.com), https must not drop to
//     http, no user:password@ or port, at most MAX_HOPS hops;
//  3. the command that really runs is then re-issued with link-following switched OFF (download-host.ts
//     sameSiteDownloadCommand) and pointed at the final same-website address. So even if the website answers differently
//     the second time, the real curl/wget has no way to reach another website — the worst case is a "moved" answer.
// A hop to another website is never requested: we read the Location header and stop.
//
// Network trouble during the walk is not a stop: the command then runs with links switched off and fails by itself.
import { downloadHostVerdict, sameSiteDownloadCommand, strictHostOf } from '../../shared/download-host';

export const MAX_HOPS = 10;

export type GuardOutcome =
  | { kind: 'run'; command: string }
  | { kind: 'stopped'; message: string };

type FetchLike = (url: string, init: { method: string; redirect: 'manual'; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body?: { cancel(): Promise<void> | void } | null;
}>;

// Words from a website's address that are safe to put in a message (the address came from a stranger's server).
const printable = (h: string) => h.replace(/[^a-z0-9.\-:[\]]/gi, '?').slice(0, 80);

/** Walk the links of `command`'s download and return the command to really run, or why it was stopped. */
export async function guardDownload(
  command: string,
  approvedHost: string,
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<GuardOutcome> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  // Re-derive the address from the same parser the rule used, and refuse if it names a different website than the rule:
  // a mismatch must never run unguarded.
  const v = downloadHostVerdict(command);
  if (!v || !v.ok || !v.followsRedirects || v.host !== approvedHost) {
    return { kind: 'stopped', message: 'Stopped: this download could not be limited to one website, so it was not run. Ask the person before running it.' };
  }
  const startUrl = v.url;
  // -I / --head asks with HEAD; everything else with GET (headers only are read, the body is cancelled).
  const method = /(^|\s)(-[A-Za-z]*I[A-Za-z]*|--head)(\s|$)/.test(command) ? 'HEAD' : 'GET';
  let current = startUrl;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    let res;
    try {
      res = await fetchImpl(current, { method, redirect: 'manual', signal: opts.signal, headers: { 'User-Agent': 'curl/8', Accept: '*/*' } });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      break; // network trouble: run with links off (below); it fails or succeeds on its own, never leaving the website
    }
    try { await res.body?.cancel(); } catch { /* body already gone */ }
    const location = res.status >= 300 && res.status < 400 && res.status !== 304 ? res.headers.get('location') : null;
    if (!location) break; // a final answer: this is the address to download
    if (hop === MAX_HOPS) {
      return { kind: 'stopped', message: `Stopped: the download was redirected more than ${MAX_HOPS} times, so it was not run.` };
    }
    let next: URL;
    try { next = new URL(location, current); } catch {
      return { kind: 'stopped', message: 'Stopped: the download was redirected to an address that could not be read, so it was not run.' };
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      return { kind: 'stopped', message: 'Stopped: the download was redirected to something that is not a web address, so it was not run.' };
    }
    if (next.hostname !== approvedHost) {
      const other = printable(next.hostname);
      return { kind: 'stopped', message: `Stopped: the download was redirected to ${other}, a different website than the one allowed (${approvedHost}). Ask before downloading from ${other}.` };
    }
    if (new URL(current).protocol === 'https:' && next.protocol === 'http:') {
      return { kind: 'stopped', message: `Stopped: ${approvedHost} redirected the download from a secure (https) to a plain (http) address, so it was not run.` };
    }
    // Same website, but user:password@, a port or an odd spelling: the strict parser must vouch for it, as it did for the first address.
    if (strictHostOf(next.href) !== approvedHost) {
      return { kind: 'stopped', message: `Stopped: ${approvedHost} redirected the download to an address with an unusual spelling, so it was not run.` };
    }
    current = next.href;
  }
  const finalCommand = sameSiteDownloadCommand(command, current);
  if (finalCommand === null) return { kind: 'stopped', message: 'Stopped: the download could not be limited to one website, so it was not run.' };
  return { kind: 'run', command: finalCommand };
}
