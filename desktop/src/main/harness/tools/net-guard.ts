// SSRF guard for the web tools (spec §3.1): private/localhost/RFC-1918 blocked
// by default, http/https only, and — because redirects are followed MANUALLY —
// EVERY hop is re-validated (a public URL 302ing to http://192.168.1.1/ is the
// classic bypass). Same guard family as the secret-path denial in guards.ts.
//
// HONESTY LIMIT (PITFALLS): we validate the DNS answer, then fetch by hostname,
// so a TOCTOU DNS-rebind between check and fetch is theoretically possible.
// Honest friction, not a security boundary — the accepted Phase 2 posture.
import { isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';

export class NetGuardError extends Error {}

type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true });

const PRIVATE_V4: ReadonlyArray<readonly [RegExp, string]> = [
  [/^0\./, '0.0.0.0/8'], [/^10\./, '10/8'], [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local'], [/^192\.168\./, '192.168/16'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'CGNAT 100.64/10'],
];

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    if (PRIVATE_V4.some(([re]) => re.test(ip))) return true;
    const second = Number(ip.split('.')[1]);
    return ip.startsWith('172.') && second >= 16 && second <= 31;
  }
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;    // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true;                             // fe80::/10 link-local
  // v4-mapped IPv6 (::ffff:0:0/96) — CRITICAL: `new URL` NORMALIZES the embedded
  // v4 to HEX groups, so http://[::ffff:127.0.0.1]/ arrives as `::ffff:7f00:1`,
  // NOT the dotted form. The old dotted-only regex missed every real request and
  // let ::ffff:169.254.169.254 (cloud metadata) through — the classic bypass.
  // Decode BOTH encodings: a dotted remainder is used as-is; otherwise the
  // trailing hex group(s) ARE the embedded v4 (its low 32 bits), which we rebuild
  // into a dotted-quad (each ≤4-digit hex group is 2 octets) and re-check.
  if (lower.startsWith('::ffff:')) {
    const rest = lower.slice('::ffff:'.length);                        // e.g. '7f00:1' or '127.0.0.1'
    if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return isPrivateIp(rest);
    const groups = rest.split(':').filter(Boolean);                    // '::ffff:0:7f00:1' → ['0','7f00','1']
    if (groups.length >= 1 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const low = parseInt(groups[groups.length - 1], 16);             // low 16 bits → last two octets
      const high = groups.length >= 2 ? parseInt(groups[groups.length - 2], 16) : 0; // high 16 bits → first two
      const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isPrivateIp(v4);
    }
  }
  return false;
}

/** Scheme + address validation for ONE URL. Throws NetGuardError with an honest,
 *  specific message (docs/error-message-standards.md). Returns the parsed URL. */
export async function assertPublicHttpUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new NetGuardError(`"${raw}" is not a valid URL.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetGuardError(`Only http and https URLs can be fetched (got ${url.protocol.replace(':', '')}).`);
  }
  // strip v6 brackets, then a FQDN trailing dot ('localhost.' / 'foo.local.')
  // so it can't slip past the localhost/.local name checks below.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new NetGuardError(`${host} is a private/internal address — fetching it is blocked.`);
    return url;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new NetGuardError(`${host} is a local address — fetching it is blocked.`);
  }
  let addrs: Array<{ address: string }>;
  try { addrs = await lookup(host); } catch {
    throw new NetGuardError(`Could not resolve ${host} — check the URL or the network connection.`);
  }
  if (addrs.length === 0) throw new NetGuardError(`Could not resolve ${host}.`);
  const bad = addrs.find((a) => isPrivateIp(a.address));
  if (bad) throw new NetGuardError(`${host} resolves to the private/internal address ${bad.address} — fetching it is blocked.`);
  return url;
}

const MAX_REDIRECTS = 5;

/** An allowHost answer. A refusal carries the sentence the caller shows; it is
 *  never invented here, because only the caller knows what the host was asked
 *  to reach (docs/error-message-standards.md). */
export type HostDecision = { ok: true } | { ok: false; message: string };

export interface GuardedFetchOpts {
  signal: AbortSignal;
  timeoutMs?: number;              // per-request; default 30s
  lookup?: LookupFn;               // test injection
  fetchImpl?: typeof fetch;        // test injection
  headers?: Record<string, string>;
  /** Default GET. Anything else is the caller's business to authorise first. */
  method?: string;
  /** Sent with the first hop only; see the redirect rule in guardedFetch. */
  body?: string;
  /**
   * Consulted BEFORE every hop's request, including the first. Refusing throws
   * a NetGuardError carrying the message.
   *
   * WHY (design review 1, finding 4): this function followed redirects by hand
   * and re-checked only that each hop was PUBLIC. A caller that attached a
   * credential to `headers` had it spread into every hop, so one 302 handed a
   * page's API key to whatever host the answer named. Public is not the same
   * question as allowed.
   */
  allowHost?: (hostname: string, hop: number) => HostDecision;
  /**
   * Headers sent ONLY while the hop's host still equals hop 0's. A redirect to
   * a different host keeps the request and loses these — the credential does
   * not walk with it.
   */
  credentialHeaders?: Record<string, string>;
  /**
   * Query parameters carrying a credential (a key some services take in the
   * URL). Stripped from the address on any off-host hop, for the same reason,
   * and because the stripped address is what `finalUrl` reports.
   */
  credentialQueryParams?: readonly string[];
}

/** Fetch with MANUAL redirect following: every hop re-runs assertPublicHttpUrl.
 *  Timeout/abort surfaces as a DOMException (AbortError) from fetch — NOT a
 *  NetGuardError — which the tool layer translates for the user (spec §3.1). */
export async function guardedFetch(rawUrl: string, opts: GuardedFetchOpts): Promise<{ res: Response; finalUrl: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;
  // ONE deadline for the WHOLE call: 30s is the TOTAL wall-clock budget ACROSS
  // all redirect hops, not per-hop. Built once before the loop — building it
  // inside would give 6 hops × 30s = up to 180s, defeating the cap.
  const deadline = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 30_000)]);
  let current = rawUrl;
  let originHost: string | null = null;
  let method = (opts.method ?? 'GET').toUpperCase();
  let body = opts.body;
  for (let hop = 0; ; hop++) {
    const url = await assertPublicHttpUrl(current, lookup);
    const host = url.hostname.toLowerCase();
    if (originHost === null) originHost = host;
    const decision = opts.allowHost?.(url.hostname, hop);
    if (decision && !decision.ok) throw new NetGuardError(decision.message);
    // Off-host: the request goes on, the credential does not. Both the header
    // form and the in-the-URL form, because a service that redirects while
    // preserving the query string would otherwise carry the key across.
    const onOrigin = host === originHost;
    if (!onOrigin) for (const p of opts.credentialQueryParams ?? []) url.searchParams.delete(p);
    const target = url.toString();
    const res = await fetchImpl(target, {
      redirect: 'manual',
      method,
      ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
      headers: {
        'User-Agent': 'YouCoded', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        ...opts.headers,
        ...(onOrigin ? opts.credentialHeaders : undefined),
      },
      signal: deadline,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new NetGuardError(`${url.hostname} answered ${res.status} with no Location header.`);
      if (hop >= MAX_REDIRECTS) throw new NetGuardError(`Gave up after ${MAX_REDIRECTS} redirects (last: ${target}).`);
      // The redirect rule browsers use, written out because we follow by hand:
      // 303 always becomes a GET, and 301/302 on a write becomes one too. Only
      // 307/308 repeat the method and the body. Replaying a POST body to a
      // redirect target nobody named is how a "harmless" follow becomes a
      // second write.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET';
        body = undefined;
      }
      current = new URL(location, url).toString(); // relative Location supported
      await res.body?.cancel().catch(() => { /* already closed */ }); // release the socket before the next hop
      continue;
    }
    return { res, finalUrl: target };
  }
}

/** Stream the body up to maxBytes; flag truncation instead of buffering unbounded.
 *  Note: the cap is a BYTE cut, so a multi-byte UTF-8 codepoint straddling the
 *  boundary decodes to a single U+FFFD replacement char — acceptable for a
 *  truncated preview; the tool layer already signals truncation to the user. */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0; let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.slice(0, value.byteLength - (total - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => { /* stream already closed */ });
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}
