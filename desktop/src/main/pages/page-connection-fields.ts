// The cleaning rules and small shared helpers every connection kind is built from
// (page-kinds.ts). Moved verbatim from page-connections.ts when the kinds became a
// registry (pages-finish step 1): nothing here decides WHICH kind a line is, only
// whether a value written by a page's author can be trusted.
import type { KeyScheme, PageAccess, PageAllowRule, PageChatScope, PageConnection, PageKeyPart, VideoProfile } from '../../shared/pages-types';

/** Where a key connection's key is attached when the manifest does not say.
 *  A header is the common case and the safer one: a key in a query string is
 *  written into the service's own access logs. */
export const DEFAULT_KEY_PLACEMENT = { in: 'header', param: 'authorization', scheme: 'bearer' } as const;

export interface KeyPlacement { in: 'header' | 'query'; param: string; scheme: KeyScheme; }

/** Where this connection wants its key, and the word before it. Always
 *  answers — an author who says nothing gets `Authorization: Bearer <key>`,
 *  the most common shape (Todoist, OpenAI-style APIs, most modern services).
 *  WHY a scheme at all: a bare key in an Authorization header is rejected by
 *  most services, so without it the commonest kind of key never worked. */
export function keyPlacement(c: PageConnection): KeyPlacement {
  if (c.kind !== 'key' && c.kind !== 'device') return { ...DEFAULT_KEY_PLACEMENT };
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
export const MAX_CONNECTIONS = 8;
export const MAX_SERVICE = 40;
const MAX_ADDRESS = 253;   // the longest legal hostname
const MAX_STEPS = 6;
const MAX_STEP = 200;

/** A bare hostname: no scheme, port, path, wildcard, userinfo or space. Lower
 *  case is not required of the author but is what we store and compare. */
export function cleanAddress(raw: unknown): string | null {
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

export function cleanAccess(raw: unknown): PageAccess {
  // Anything unrecognised means look-up only: the narrower reading of an
  // unclear manifest is the safe one.
  return raw === 'full' ? 'full' : 'lookup';
}

/** A header name or query-parameter name: RFC 7230 token characters only, so
 *  nothing an author writes can smuggle a second header or a URL fragment in.
 *  Lower-cased, because it is compared against our own header allowlist. */
export function cleanParam(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return null;
  return name;
}

/** A path on a device where its key is made (Home Assistant:
 *  `/profile/security`). Plain path characters only, so the Open button can
 *  never be pointed anywhere but the allowed device. */
export function cleanKeyPage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const p = raw.trim();
  return /^(\/[A-Za-z0-9_.-]+)+\/?$/.test(p) && p.length <= 120 && !p.includes('..') ? p : undefined;
}

/** A device's socket greeting. Bounded, and the key token at most once: the
 *  app substitutes the key into this one message only, so it is the single
 *  place a key ever enters a socket. Dropped (not trimmed) when it breaks a
 *  rule, so a half-greeting is never sent. */
const MAX_SOCKET_HELLO = 512;
export const SOCKET_KEY_TOKEN = '{{key}}';
export function cleanSocketHello(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_SOCKET_HELLO) return undefined;
  return raw.split(SOCKET_KEY_TOKEN).length <= 2 ? raw : undefined;
}

/** Device-profile cleaning (spec 2026-10-04). Every string is short and plain
 *  so nothing a manifest writes can become a pattern main would run. Anything
 *  that breaks a rule is DROPPED, never trimmed into something else. */
const MAX_PROFILE_WORD = 64;
const MAX_VIDEO_SEND = 2048;
const MAX_SOCKET_DENY = 16;
/** A reply type, e.g. `auth_ok`. */
export function cleanReplyType(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^[A-Za-z0-9_./-]{1,64}$/.test(raw) ? raw : undefined;
}
/** The manifest's extra denied message-type prefixes (e.g. `config/`), lower-
 *  cased, sorted and de-duplicated so order never changes the fingerprint.
 *  WHY strict: the approval card lists exactly this list and main enforces
 *  exactly this list, so a list that is not wholly valid (wrong type, an
 *  odd entry, more than MAX_SOCKET_DENY) must never be half-kept. Returns
 *  `undefined` when the manifest has none, `null` when it is invalid, and the
 *  caller then drops the WHOLE connection (nothing runs on a profile the
 *  person was not shown accurately). */
export function cleanSocketDeny(raw: unknown): string[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_SOCKET_DENY) return null;
  const out = new Set<string>();
  for (const p of raw) {
    const v = typeof p === 'string' ? p.trim().toLowerCase() : '';
    if (!/^[a-z0-9_./-]{1,64}$/.test(v)) return null;
    out.add(v);
  }
  return out.size ? [...out].sort() : undefined;
}
/** A dotted path into a reply (`event.answer`). */
function cleanDotted(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length <= MAX_PROFILE_WORD && /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(raw) ? raw : undefined;
}
export function cleanVideoProfile(raw: unknown): VideoProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  // WHY must end with ".": the device's form is `domain.`; a bare letter or word
  // would widen "a camera" to "anything the device has" (step-1 code review, item 5).
  const targetPrefix = typeof o.targetPrefix === 'string' && /^[a-z0-9_.]{1,64}$/.test(o.targetPrefix) && o.targetPrefix.endsWith('.') ? o.targetPrefix : undefined;
  // Where main opens ITS OWN socket for a video; absent means the Home Assistant path.
  const socketPath = typeof o.socketPath === 'string' && /^\/[A-Za-z0-9_./-]{0,127}$/.test(o.socketPath) && !o.socketPath.includes('..') ? o.socketPath : undefined;
  // WHY no {{key}}: the key may enter a socket only through the greeting.
  const send = typeof o.send === 'string' && o.send.length > 0 && Buffer.byteLength(o.send) <= MAX_VIDEO_SEND
    && !o.send.includes(SOCKET_KEY_TOKEN) ? o.send : undefined;
  const answer = cleanDotted(o.answer);
  const candidate = cleanDotted(o.candidate);
  const failed = cleanDotted(o.failed);
  if (!targetPrefix || !send || !answer || !candidate || !failed) return undefined;
  // pages-finish step 1b: what the camera offer receives and which data channel it
  // opens, for cameras other than Nest. Absent keeps today's offer (and fingerprint).
  const tracks = Array.isArray(o.tracks) && o.tracks.length > 0 && o.tracks.length <= 2 && o.tracks.every((t) => t === 'audio' || t === 'video')
    ? [...new Set(o.tracks as Array<'audio' | 'video'>)].sort() : undefined;
  const dataChannel = o.dataChannel === false ? false
    : typeof o.dataChannel === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(o.dataChannel) ? o.dataChannel : undefined;
  return {
    targetPrefix, ...(socketPath ? { socketPath } : {}), send, answer, candidate, failed,
    ...(tracks ? { tracks } : {}), ...(dataChannel !== undefined ? { dataChannel } : {}),
  };
}

export function cleanSteps(raw: unknown): { steps: string[] } | undefined {
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
export function cleanWritePaths(raw: unknown): string[] {
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

/** The cleaned device profile as JSON with sorted keys (so key order in the
 *  manifest never matters), or '' when the connection has none. */
export function profileSegment(c: Extract<PageConnection, { kind: 'device' }>): string {
  const profile: Record<string, unknown> = {};
  // Step 1b: present only when a manifest names them, so a Home Assistant page's
  // fingerprint (and its approval) is what it always was.
  if (c.socketFormat) profile.socketFormat = c.socketFormat;
  if (c.socketTypeField) profile.socketTypeField = c.socketTypeField;
  if (c.socketHello) profile.socketHello = c.socketHello;
  if (c.socketReady) profile.socketReady = c.socketReady;
  if (c.socketAuthFailed) profile.socketAuthFailed = c.socketAuthFailed;
  if (c.socketDeny?.length) profile.socketDeny = c.socketDeny;
  if (c.videoProfile) profile.videoProfile = c.videoProfile;
  if (!Object.keys(profile).length) return '';
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return `|profile:${JSON.stringify(sorted(profile))}`;
}

/** A chat scope as one stable string: projects sorted, so their order in the
 *  manifest never re-asks. */
export function chatScopeKey(s: PageChatScope): string {
  return 'all' in s ? 'all' : 'projects' in s ? `projects:${[...s.projects].sort().join(',')}` : `tag:${s.tag}`;
}

const MAX_SCOPE_ITEMS = 10;
const MAX_SCOPE_NAME = 80;

/** `"all"`, absent, `{ projects: [...] }` or `{ tag: "..." }`; anything else is
 *  null so the line is dropped (a typo must never read as "every chat"). */
export function cleanChatScope(raw: unknown): PageChatScope | null {
  if (raw === undefined || raw === 'all') return { all: true };
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.projects)) {
    const projects = [...new Set(o.projects.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter((p) => p && p.length <= MAX_SCOPE_NAME))];
    return projects.length && projects.length <= MAX_SCOPE_ITEMS ? { projects } : null;
  }
  if (typeof o.tag === 'string' && o.tag.trim() && o.tag.trim().length <= MAX_SCOPE_NAME) return { tag: o.tag.trim() };
  return null;
}

/** A bare file name inside the page's folder: letters, digits, dot, dash and
 *  underscore; not hidden; not page.html/page.json/data.json (the page's own
 *  files are never programs). */
export function cleanProgramFile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const f = raw.trim();
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/.test(f) || f.includes('..')) return null;
  return ['page.html', 'page.json', 'data.json'].includes(f.toLowerCase()) ? null : f;
}

/** The one address each built-in sign-in may be used with. Fixed here, never
 *  taken from the manifest, so a page cannot point the app's own credential at
 *  a host of its choosing. */
export const YOUCODED_HOST = 'api.youcoded.ai';
export const GITHUB_HOST = 'api.github.com';

// ── Service recipes (pages-finish step 1, technical design §2) ─────────────────

const MAX_ALLOW = 16;
const MAX_DOES = 80;
/** Methods a recipe may never name: CONNECT opens a tunnel, TRACE/TRACK echo the
 *  request (credentials included) back to the page. */
const NEVER_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);

/** A recipe path: plain segments only — no `%`, no `..`, no query — so what the card
 *  shows is the only thing that can match. `/` alone means the whole service. */
function cleanRecipePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (p === '/') return '/';
  const path = p.replace(/\/+$/, '');
  if (path.length > 200 || !/^(\/[A-Za-z0-9_.~@:-]+)+$/.test(path)) return null;
  return path.split('/').some((seg) => seg === '.' || seg === '..') ? null : path;
}

/** A recipe's `allow` list. `undefined` when the manifest has none, `null` when any
 *  entry is invalid — the caller then drops the WHOLE line, because the card must
 *  show exactly what main enforces (the same rule as `socketDeny`). */
export function cleanAllow(raw: unknown): PageAllowRule[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ALLOW) return null;
  const out: PageAllowRule[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null;
    const o = r as Record<string, unknown>;
    const method = typeof o.method === 'string' ? o.method.trim().toUpperCase() : '';
    const path = cleanRecipePath(o.path);
    const does = typeof o.does === 'string' ? o.does.trim() : '';
    if (!/^[A-Z]{3,16}$/.test(method) || NEVER_METHODS.has(method) || !path || !does || does.length > MAX_DOES) return null;
    out.push({ method, path, does });
  }
  return out;
}

/** The allow list as it rides a fingerprint: method + path pairs, sorted and
 *  de-duplicated, WITHOUT the `does` words — rewording does not re-ask; changing what
 *  is allowed does. '' when there is none, so a line without one keeps its old string. */
export function allowSegment(allow: readonly PageAllowRule[] | undefined): string {
  if (!allow?.length) return '';
  return `|allow:${[...new Set(allow.map((r) => `${r.method} ${r.path}`))].sort().join(',')}`;
}

/** Does a request fit one of the recipe's rules? Same method, and the request's own
 *  path (already dot-normalised by URL parsing) equal to the rule's or under it at a
 *  `/` boundary. Anything encoded (`%`), a `;` path parameter, a backslash or an empty
 *  segment (`//`) is refused outright (design review 1, finding 7): a server may read
 *  any of them as a path the rule does not cover, and the YouCoded write rule refuses
 *  `%` for the same reason. */
export function allowMatches(allow: readonly PageAllowRule[], method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (/[%;\\]|\/\//.test(pathname)) return false;
  return allow.some((r) => r.method === m && (r.path === '/' || pathname === r.path || pathname.startsWith(r.path + '/')));
}

const PART_IN = new Set(['header', 'query', 'basic-user', 'basic-password']);

/** A multi-part sign-in. `undefined` when absent, `null` (drop the line) when it
 *  breaks a rule: 2–4 parts, unique plain ids, a named header or parameter for the
 *  ones that need one, and Basic's two halves both present or both absent. */
export function cleanParts(raw: unknown): PageKeyPart[] | undefined | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) return null;
  const out: PageKeyPart[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null;
    const o = r as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    const where = typeof o.in === 'string' ? o.in : '';
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(id) || ids.has(id) || !label || label.length > 40 || !PART_IN.has(where)) return null;
    const part: PageKeyPart = { id, label, in: where as PageKeyPart['in'] };
    if (where === 'header' || where === 'query') {
      const param = cleanParam(o.param);
      if (!param) return null;
      part.param = param;
    }
    if (typeof o.hint === 'string' && o.hint.trim()) part.hint = o.hint.trim().slice(0, 160);
    if (o.secret === true) part.secret = true;
    ids.add(id);
    out.push(part);
  }
  const users = out.filter((p) => p.in === 'basic-user').length;
  const passwords = out.filter((p) => p.in === 'basic-password').length;
  if (users > 1 || passwords > 1 || users !== passwords) return null;
  return out;
}

/** A parts layout as one comparable string (ids, places and names, sorted). The
 *  saved record and the line must agree on it before a saved value is used. */
export function partsLayout(parts: ReadonlyArray<{ id: string; in: string; param?: string }> | undefined): string {
  return (parts ?? []).map((p) => `${p.id}:${p.in}:${p.param ?? ''}`).sort().join(',');
}

/** The parts as they ride a fingerprint: where each value goes, never its label. */
export function partsSegment(parts: readonly PageKeyPart[] | undefined): string {
  if (!parts?.length) return '';
  return `|parts:${parts.map((p) => `${p.id}:${p.in}${p.param ? `:${p.param}` : ''}`).sort().join(',')}`;
}
