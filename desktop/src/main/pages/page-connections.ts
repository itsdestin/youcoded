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
import type { KeyScheme, PageAccess, PageConnection } from '../../shared/pages-types';

/** Where a key connection's key is attached when the manifest does not say.
 *  A header is the common case and the safer one: a key in a query string is
 *  written into the service's own access logs. */
const DEFAULT_KEY_PLACEMENT = { in: 'header', param: 'authorization', scheme: 'bearer' } as const;

export interface KeyPlacement { in: 'header' | 'query'; param: string; scheme: KeyScheme; }

/** Where this connection wants its key, and the word before it. Always
 *  answers — an author who says nothing gets `Authorization: Bearer <key>`,
 *  the most common shape (Todoist, OpenAI-style APIs, most modern services).
 *  WHY a scheme at all: a bare key in an Authorization header is rejected by
 *  most services, so without it the commonest kind of key never worked. */
export function keyPlacement(c: PageConnection): KeyPlacement {
  if (c.kind !== 'key') return { ...DEFAULT_KEY_PLACEMENT };
  const inQuery = !!c.keyParam && c.keyIn === 'query';
  const param = c.keyParam ?? DEFAULT_KEY_PLACEMENT.param;
  // A query parameter never carries a word; a header takes the author's word,
  // else "Bearer" for Authorization and nothing for any other header.
  const scheme: KeyScheme = inQuery ? 'none' : (c.keyScheme ?? (param === 'authorization' ? 'bearer' : 'none'));
  return { in: inQuery ? 'query' : 'header', param, scheme };
}

/** The header value for a key under a scheme. */
export function applyScheme(scheme: KeyScheme, key: string): string {
  return scheme === 'bearer' ? `Bearer ${key}` : scheme === 'token' ? `token ${key}` : key;
}

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

/** A header name or query-parameter name: RFC 7230 token characters only, so
 *  nothing an author writes can smuggle a second header or a URL fragment in.
 *  Lower-cased, because it is compared against our own header allowlist. */
function cleanParam(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return null;
  return name;
}

function cleanSteps(raw: unknown): { steps: string[] } | undefined {
  const list = (raw as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(list)) return undefined;
  const steps = list.filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim().slice(0, MAX_STEP)).filter(Boolean).slice(0, MAX_STEPS);
  return steps.length ? { steps } : undefined;
}

/** Places on YouCoded's own service where a page may make changes. Each is a
 *  plain path — letters, digits, `-`, `_` and `/` only — so nothing encoded,
 *  no `..`, no query. At most four, sorted, so their order never changes the
 *  fingerprint. (A campaign builder needs one; Destin, 2026-09-23.) */
function cleanWritePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const p of raw) {
    if (typeof p !== 'string') continue;
    const path = p.trim().replace(/\/+$/, '');
    if (!/^(\/[A-Za-z0-9_-]+)+$/.test(path) || path.length > 120) continue;
    out.add(path);
    if (out.size >= 4) break;
  }
  return [...out].sort();
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
      case 'youcoded': {
        c = { id, kind: 'youcoded' };
        const writePaths = cleanWritePaths(o.writePaths);
        if (writePaths.length) c.writePaths = writePaths;
        break;
      }
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
        if (address && service) {
          c = { id, kind: 'key', service, address, access: cleanAccess(o.access), keyHelp: cleanSteps(o.keyHelp) };
          // Where the service takes the key. A bad name is DROPPED rather than
          // corrected, so the default (an Authorization header) applies: a
          // header or parameter name we cannot vouch for must never reach a
          // request, and a page whose key lands in the wrong place simply
          // fails to authenticate — it does not leak the key somewhere else.
          const param = cleanParam(o.keyParam);
          if (param) { c.keyIn = o.keyIn === 'query' ? 'query' : 'header'; c.keyParam = param; }
          if (o.keyScheme === 'bearer' || o.keyScheme === 'token' || o.keyScheme === 'none') c.keyScheme = o.keyScheme;
        }
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
    // Adding or changing a place the page may make changes asks again; a
    // look-up-only YouCoded connection keeps its original fingerprint.
    case 'youcoded': return c.writePaths?.length ? `youcoded|write:${c.writePaths.join(',')}` : 'youcoded';
    case 'open': return 'open';
    case 'github': return `github|${c.access}`;
    case 'public': return `public|${c.address}`;
    case 'key': {
      // The placement rides the fingerprint only when it is NOT the default, so
      // the ordinary key connection keeps the plain four-part string. Moving a
      // key from a header into the URL changes who can see it — the service
      // writes query strings into its own access logs — so that edit lapses the
      // approval and the page asks again.
      const p = keyPlacement(c);
      const moved = p.in === DEFAULT_KEY_PLACEMENT.in && p.param === DEFAULT_KEY_PLACEMENT.param
        ? '' : `|${p.in}:${p.param}`;
      return `key|${c.service}|${c.address}|${c.access}${moved}`;
    }
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
const YOUCODED_HOST = 'api.youcoded.ai';
const GITHUB_HOST = 'api.github.com';

/** Look-up only means the app sends look-ups only; this is the check that
 *  makes "Cannot change anything there" true rather than decorative.
 *  `pathname` is the request's own (already dot-normalised by URL parsing):
 *  a YouCoded connection may change things only at a path it listed, matched
 *  exactly or at a `/` boundary, and never through an encoded path. */
export function methodAllowed(c: PageConnection, method: string, pathname = '/'): boolean {
  const m = method.toUpperCase();
  if (c.kind === 'youcoded') {
    if (m === 'GET' || m === 'HEAD') return true;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) || pathname.includes('%')) return false;
    return (c.writePaths ?? []).some((p) => pathname === p || pathname.startsWith(p + '/'));
  }
  const lookupOnly = c.kind === 'public'
    || ((c.kind === 'key' || c.kind === 'github') && c.access === 'lookup');
  if (!lookupOnly) return ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m);
  return m === 'GET' || m === 'HEAD';
}
