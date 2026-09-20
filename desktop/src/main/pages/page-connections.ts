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
import type { PageAccess, PageConnection } from '../../shared/pages-types';

/** Caps. A manifest is written by an assistant or a stranger, so every string
 *  is bounded before it reaches a screen or a request. */
const MAX_CONNECTIONS = 8;
const MAX_SERVICE = 40;
const MAX_ADDRESS = 253;   // the longest legal hostname
const MAX_STEPS = 6;
const MAX_STEP = 200;

/** A bare hostname: no scheme, port, path, wildcard, userinfo or space. Lower
 *  case is not required of the author but is what we store and compare. */
function cleanAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // A trailing dot is the same host to DNS but a different string to a naive
  // comparison, so it is stripped here rather than at match time.
  const host = raw.trim().replace(/\.$/, '').toLowerCase();
  if (!host || host.length > MAX_ADDRESS) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  const labels = host.split('.');
  // Every label of a real hostname is at most 63 characters.
  if (labels.some((l) => l.length > 63)) return null;
  // A NAME, never an address literal: 10.0.0.1 satisfies the shape above but
  // no real top-level name is all digits. net-guard refuses private addresses
  // at request time too; this refuses them a manifest entry at all, so the
  // approval screen never shows one.
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return host;
}

function cleanAccess(raw: unknown): PageAccess {
  // Anything unrecognised means look-up only: the narrower reading of an
  // unclear manifest is the safe one.
  return raw === 'full' ? 'full' : 'lookup';
}

function cleanSteps(raw: unknown): { steps: string[] } | undefined {
  const list = (raw as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(list)) return undefined;
  const steps = list.filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim().slice(0, MAX_STEP)).filter(Boolean).slice(0, MAX_STEPS);
  return steps.length ? { steps } : undefined;
}

/** Parse `connections` out of a page.json object. Never throws. An entry it
 *  cannot vouch for is dropped; a list that mixes `open` with a credentialled
 *  connection is dropped WHOLE (rule 2 above). */
export function parseConnections(raw: unknown): PageConnection[] {
  if (!Array.isArray(raw)) return [];
  const out: PageConnection[] = [];
  const ids = new Set<string>();
  for (const item of raw.slice(0, MAX_CONNECTIONS * 2)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim().slice(0, 40) : '';
    if (!id || ids.has(id)) continue;
    let c: PageConnection | null = null;
    switch (o.kind) {
      case 'youcoded': c = { id, kind: 'youcoded' }; break;
      case 'open': c = { id, kind: 'open' }; break;
      case 'github': c = { id, kind: 'github', access: cleanAccess(o.access) }; break;
      case 'public': {
        const address = cleanAddress(o.address);
        if (address) c = { id, kind: 'public', address };
        break;
      }
      case 'key': {
        const address = cleanAddress(o.address);
        const service = typeof o.service === 'string' ? o.service.trim().slice(0, MAX_SERVICE) : '';
        if (address && service) c = { id, kind: 'key', service, address, access: cleanAccess(o.access), keyHelp: cleanSteps(o.keyHelp) };
        break;
      }
      default: break;
    }
    if (!c) continue;
    ids.add(id);
    out.push(c);
    if (out.length >= MAX_CONNECTIONS) break;
  }
  const hasOpen = out.some((c) => c.kind === 'open');
  const hasCredential = out.some((c) => c.kind === 'key' || c.kind === 'youcoded' || c.kind === 'github');
  if (hasOpen && hasCredential) return [];
  return out;
}

/** What an approval is recorded against. Access and address are in it because
 *  widening either must ask again; `keyHelp` and the id are not, because
 *  neither changes what the page can reach. */
export function fingerprint(c: PageConnection): string {
  switch (c.kind) {
    case 'youcoded': return 'youcoded';
    case 'open': return 'open';
    case 'github': return `github|${c.access}`;
    case 'public': return `public|${c.address}`;
    case 'key': return `key|${c.service}|${c.address}|${c.access}`;
  }
}

/** Does this connection cover that hostname? EXACT match, never a suffix: a
 *  suffix test would let `api.example.com.attacker.test` pass for
 *  `api.example.com`. `open` covers anything the network guard allows. */
export function covers(c: PageConnection, hostname: string): boolean {
  const host = hostname.trim().replace(/\.$/, '').toLowerCase();
  switch (c.kind) {
    case 'open': return true;
    case 'public': return c.address === host;
    case 'key': return c.address === host;
    case 'youcoded': return host === YOUCODED_HOST;
    case 'github': return host === GITHUB_HOST;
  }
}

/** The one address each built-in sign-in may be used with. Fixed here, never
 *  taken from the manifest, so a page cannot point the app's own credential at
 *  a host of its choosing. */
export const YOUCODED_HOST = 'api.youcoded.ai';
export const GITHUB_HOST = 'api.github.com';

/** Look-up only means the app sends look-ups only; this is the check that
 *  makes "Cannot send changes" true rather than decorative. */
export function methodAllowed(c: PageConnection, method: string): boolean {
  const m = method.toUpperCase();
  const lookupOnly = c.kind === 'public' || c.kind === 'youcoded'
    || ((c.kind === 'key' || c.kind === 'github') && c.access === 'lookup');
  if (!lookupOnly) return ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m);
  return m === 'GET' || m === 'HEAD';
}
