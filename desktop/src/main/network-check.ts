// network-check.ts — "is this computer online?", answered by the app itself.
//
// WHY (card #236, 2026-11-18): the sign-in buttons, the first-run screen and a chat message that
// failed all need to tell "you are offline" apart from "something is wrong with your account".
// The sync service already had a private DNS probe for its "No internet" warning; it moved here so
// every caller shares ONE definition of "online" (it used to be one lookup that a WiFi that is still
// connecting could fail).
//
// Rule (Destin 2026-09-14, "S-honest": the check fails twice before we say offline): online means at
// least ONE of two different hosts resolved; offline means BOTH failed. Two hosts, not the same one
// twice, so one site's outage cannot read as "your internet is down".
//
// It never throws and never blocks: `dns.lookup` runs on libuv's thread pool and answers by
// callback, so the main process stays free while it waits (performance.md rule 1).
import dns from 'dns';

/** How long one lookup may take. WHY 5s: the value the sync probe already used. Past it the host
 *  is treated as unreachable (a hung resolver is as good as no network for this question). */
const NETWORK_PROBE_TIMEOUT_MS = 5000;

/** The two hosts asked. github.com is the sync service's old probe; cloudflare.com is an
 *  unrelated provider so one company's outage cannot look like "no internet". */
export const NETWORK_PROBE_HOSTS = ['github.com', 'cloudflare.com'] as const;

/** One lookup, injectable so tests never touch DNS. Resolves on success, rejects on failure. */
export type HostLookup = (host: string) => Promise<void>;

const defaultLookup: HostLookup = (host) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), NETWORK_PROBE_TIMEOUT_MS);
    dns.lookup(host, (err) => {
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    });
  });

/** True when at least one of the two probes succeeded. Never throws. */
export async function checkInternet(lookup: HostLookup = defaultLookup): Promise<boolean> {
  // Both are asked at once: an offline machine learns "no" after one timeout, not two in a row.
  const results = await Promise.allSettled(NETWORK_PROBE_HOSTS.map((h) => lookup(h)));
  return results.some((r) => r.status === 'fulfilled');
}
