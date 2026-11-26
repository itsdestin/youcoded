// network-check.ts — "is this computer online?", answered by the app itself.
//
// WHY (card #236, 2026-11-18): the sign-in buttons, the first-run screen and a chat message that
// failed all need to tell "you are offline" apart from "something is wrong with your account".
// The sync service already had a private probe for its "No internet" warning; it moved here so
// every caller shares ONE definition of "online".
//
// Rule (Destin 2026-09-14, "S-honest": the check fails twice before we say offline): online means at
// least ONE of two different hosts answered; offline means BOTH failed. Two hosts, not the same one
// twice, so one site's outage cannot read as "your internet is down".
//
// WHY a real HTTPS request, not a DNS lookup (release 1.3.4 review; Destin, deck release-1-4-late
// L-2: "the simplest/most correct way possible — if just 1 better check would suffice, we should do
// that"): the first version only asked DNS. On school or office networks that reach the internet
// through a proxy, and on some VPNs, a DNS lookup from this computer fails while the internet works —
// so a student could be stuck at first-run behind "No internet connection" with Try again repeating
// the same wrong answer. One HTTPS request asks the question we actually care about ("can the app
// reach the internet?"), and Electron's `net.fetch` goes through the system proxy the way the
// browser does. ANY reply — 200, 404, a redirect, a captive-portal page — counts as online: we only
// say "No internet" when nothing answered at all.
//
// It never throws and never blocks the main process: the request is asynchronous.
//
// WHY no electron import here: the runtime core (create-runtime.ts and everything it pulls in,
// which includes this file) must not load Electron — the phone app runs it in plain Node
// (tests/create-runtime.test.ts). So the fetch is handed in: main.ts installs Electron's
// `net.fetch`, which goes through the system proxy like the browser; on the phone it stays
// Node's own fetch (the same one the headless electron shim's `net.fetch` uses).

/** How long one request may take. WHY 5s: the value the old DNS probe used. Past it the host
 *  is treated as unreachable (a hung connection is as good as no network for this question). */
const NETWORK_PROBE_TIMEOUT_MS = 5000;

/** The two addresses asked. Both are tiny, unauthenticated, and from unrelated companies, so
 *  one company's outage cannot look like "no internet". */
export const NETWORK_PROBE_URLS = ['https://api.github.com/', 'https://www.cloudflare.com/'] as const;

/** One request, injectable so tests never touch the network. Resolves when anything answered,
 *  rejects when nothing did. */
export type HostProbe = (url: string) => Promise<void>;

type ProbeFetch = (url: string, init: { method: string; cache: 'no-store'; signal: AbortSignal }) => Promise<unknown>;
let probeFetch: ProbeFetch = (url, init) => fetch(url, init);

/** Called once by the desktop main process with Electron's `net.fetch` (see the header). */
export function useFetchForNetworkCheck(fn: ProbeFetch): void { probeFetch = fn; }

const defaultProbe: HostProbe = async (url) => {
  await probeFetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(NETWORK_PROBE_TIMEOUT_MS) });
};

/** True when at least one of the two probes got any reply. Never throws. */
export async function checkInternet(probe: HostProbe = defaultProbe): Promise<boolean> {
  // Both are asked at once: an offline machine learns "no" after one timeout, not two in a row.
  const results = await Promise.allSettled(NETWORK_PROBE_URLS.map((u) => probe(u)));
  return results.some((r) => r.status === 'fulfilled');
}
