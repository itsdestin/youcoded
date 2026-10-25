// What a page says it wants to reach, and what the app recorded about it.
//
// Design: youcoded-dev/docs/active/specs/2026-09-20-youcoded-pages-phase2-technical-design.md
//
// TWO RULES DECIDE EVERYTHING HERE, both from Destin's Phase 2 questions decks:
//
//   1. Anything not listed and approved is blocked. So parsing is strict and
//      DROPS what it cannot vouch for, and a list that contradicts itself is
//      dropped whole. Refusing costs a page its connections; guessing costs the
//      person a promise the approval screen already made.
//   2. "The whole internet" is never combined with a key or a sign-in on one
//      page, because a page holding both could read private information and
//      send it anywhere.
//
// An approval is recorded against a FINGERPRINT, not an id: widen the access or
// change the address and the old approval no longer matches, so the page asks
// again (deck S-change). Renaming the id alone does not re-ask.
//
// The rules for each KIND of line live in page-kinds.ts (one entry per kind);
// this file keeps the names every caller already imports and the rules that span
// a whole list (ids, the cap, never "open" beside private data).
import type { PageConnection } from '../../shared/pages-types';
import { cleanDeviceAddress } from '../../shared/page-device-address';
import { MAX_CONNECTIONS } from './page-connection-fields';
import { KINDS, kindOf } from './page-kinds';

export { applyScheme, keyPlacement, SOCKET_KEY_TOKEN } from './page-connection-fields';

/** The saved key a connection stands on, as service + address, or null for a
 *  kind that holds no pasted key. One place, so approval, the settings list,
 *  pruning and deletion agree on which connections own a key. */
export function savedKeyTarget(c: PageConnection): { service: string; address: string } | null {
  return kindOf(c).savedKeyTarget?.(c) ?? null;
}

/** Parse `connections` out of a page.json object. Never throws. An entry it
 *  cannot vouch for is dropped; a list that mixes `open` with a line holding
 *  private data is dropped WHOLE (rule 2 above). */
export function parseConnections(raw: unknown): PageConnection[] {
  if (!Array.isArray(raw)) return [];
  const out: PageConnection[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(0, MAX_CONNECTIONS * 2)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim().slice(0, 40) : '';
    if (!id || ids.has(id)) continue;
    const def = typeof o.kind === 'string' && Object.hasOwn(KINDS, o.kind) ? KINDS[o.kind as PageConnection['kind']] : null;
    if (!def) continue;
    if (def.onePerPage && out.some((x) => x.kind === o.kind)) continue;
    const c = (def.parse as (o: Record<string, unknown>, id: string, sofar: readonly PageConnection[]) => PageConnection | null)(o, id, out);
    if (!c) continue;
    ids.add(id);
    out.push(c);
    if (out.length >= MAX_CONNECTIONS) break;
  }
  const hasOpen = out.some((c) => c.kind === 'open');
  if (hasOpen && out.some((c) => KINDS[c.kind].privateData)) return [];
  return out;
}

/** What an approval is recorded against. Access and address are in it because
 *  widening either must ask again; `keyHelp` and the id are not, because
 *  neither changes what the page can reach. */
export function fingerprint(c: PageConnection): string {
  return kindOf(c).fingerprint(c);
}

/** A device connection carries the address the person ALLOWED once approved,
 *  never the manifest's suggestion. Every reader that decides what a page may
 *  reach (the listing, approve, the fetch door) goes through this, so the
 *  suggestion can never be what is actually contacted. An approval with no
 *  usable address leaves the suggestion in place — and fetch() refuses a
 *  device that has none recorded. */
export function withApprovedAddress(c: PageConnection, approvedAddress: string | undefined): PageConnection {
  if (c.kind !== 'device' || !approvedAddress) return c;
  const address = cleanDeviceAddress(approvedAddress);
  return address ? { ...c, address } : c;
}

/** Does this connection cover that hostname? EXACT match, never a suffix: a
 *  suffix test would let `api.example.com.attacker.test` pass for
 *  `api.example.com`. `open` covers anything the network guard allows. */
export function covers(c: PageConnection, target: string | URL): boolean {
  return kindOf(c).covers(c, target);
}

/** Look-up only means the app sends look-ups only; this is the check that
 *  makes "Cannot change anything there" true rather than decorative.
 *  `pathname` is the request's own (already dot-normalised by URL parsing). */
export function methodAllowed(c: PageConnection, method: string, pathname = '/'): boolean {
  return kindOf(c).methodAllowed(c, method, pathname);
}
