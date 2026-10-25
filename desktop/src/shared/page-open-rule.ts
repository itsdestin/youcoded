// When a page asks to open an address in the browser: open it at once, ask the
// person first, or refuse (pages-finish deck 1 Q-popups "ask, unless the site is
// already approved"; approved screen S-open-website; design review 1, finding 4).
//
// ONE pure rule, so the screen that decides and the tests that pin it cannot
// disagree. Silent only where the person has already said yes to that exact site:
//   - an approved public / key / YouCoded / GitHub connection whose address IS the
//     link's host (the page can already send there, so opening adds nothing), or
//   - a site the person told this page not to ask about again.
// Never silent for a whole-internet page (it "reaches" everything, but nobody chose
// THIS address), a home device or a bank. A mailto: link always asks and has no
// site to remember. Anything that is not http(s) or mailto is refused.
import type { PageConnectionStatus } from './pages-types';

export type PageOpenDecision =
  | { action: 'open'; url: string; site: string }
  | { action: 'ask'; url: string; site: string | null }
  | { action: 'refuse' };

/** The name the host gives every page frame, so main's frame guard knows which
 *  frames are pages (main/pages/page-frame-guard.ts). */
export const PAGE_FRAME_NAME = 'youcoded-page';

/** Longest address the app will open for a page. */
export const MAX_PAGE_OPEN_URL = 2000;

const SILENT_KINDS = new Set<PageConnectionStatus['kind']>(['public', 'key', 'youcoded', 'github']);
const FIXED_HOST: Partial<Record<PageConnectionStatus['kind'], string>> = { youcoded: 'api.youcoded.ai', github: 'api.github.com' };

/** A hostname as connections and remembered sites compare it. */
export function siteOf(hostname: string): string {
  return hostname.trim().replace(/\.$/, '').toLowerCase();
}

export function decidePageOpen(raw: unknown, connections: readonly PageConnectionStatus[], openSites: readonly string[]): PageOpenDecision {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PAGE_OPEN_URL) return { action: 'refuse' };
  let url: URL;
  try { url = new URL(raw); } catch { return { action: 'refuse' }; }
  if (url.protocol === 'mailto:') return { action: 'ask', url: url.toString(), site: null };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { action: 'refuse' };
  // A user name or password inside the address hides where it really goes.
  if (url.username || url.password) return { action: 'refuse' };
  const site = siteOf(url.hostname);
  const known = openSites.includes(site) || connections.some((c) => c.approved && SILENT_KINDS.has(c.kind)
    && (c.kind === 'public' || c.kind === 'key' ? c.address === site : FIXED_HOST[c.kind] === site));
  return { action: known ? 'open' : 'ask', url: url.toString(), site };
}
