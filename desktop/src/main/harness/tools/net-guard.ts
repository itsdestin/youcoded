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
import { isHomeIpv4 } from '../../../shared/page-device-address';
import { embeddedIpv4, parseIpBytes } from './ip-bytes';

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
  // WHY bytes, not text (live-socket step 3 review, finding 1): `new URL` writes
  // an IPv6 literal in one canonical spelling, but a DNS answer or another caller
  // may not, and the v4-compatible form (::127.0.0.1 -> ::7f00:1) was never
  // matched. Parse to bytes so every spelling of an address is the same address.
  // (`new URL` also turns hex/octal/shorthand IPv4 into dotted before it gets here.)
  const bytes = parseIpBytes(ip);
  if (!bytes) return false;
  const v4 = embeddedIpv4(bytes);
  if (v4) return isPrivateIp(Array.from(v4).join('.'));  // mapped / compatible / NAT64 forms of a v4
  if ((bytes[0] & 0xfe) === 0xfc) return true;           // fc00::/7 ULA
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  return false;
}

/** Addresses a camera's WebRTC answer may NEVER make the app dial, whatever
 *  else is allowed: this computer itself, the link-local range (which holds the
 *  cloud-metadata address 169.254.169.254), the unspecified address and the
 *  AWS IPv6 metadata block. Home-network addresses (192.168/16, 10/8, ...) are
 *  fine: that is where a camera lives. Uses the same ranges as PRIVATE_V4
 *  above, narrowed to the ones that are never a camera. */
export function isNeverDialIp(ip: string): boolean {
  // WHY bytes (step 3 review, finding 1): the old text comparison missed
  // "0:0:0:0:0:0:0:1", "::127.0.0.1", "fd00:0ec2::254" and every other spelling
  // of the same address. Test the parsed bytes instead.
  const b = parseIpBytes(ip);
  if (!b) return false;
  if (b.length === 4) return neverDialV4(b);
  const v4 = embeddedIpv4(b);
  if (v4) return neverDialV4(v4);                       // also covers :: and ::1 (as 0.0.0.0 / 0.0.0.1)
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true;                          // ff00::/8 multicast
  return b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2; // fd00:ec2::/32 AWS metadata
}

/** 0/8, loopback, link-local (holds 169.254.169.254), multicast and reserved
 *  (224+, incl. broadcast), and Alibaba's metadata address: never a camera. */
function neverDialV4(b: Uint8Array): boolean {
  const [a, x, y, z] = b;
  return a === 0 || a === 127 || a >= 224 || (a === 169 && x === 254) || (a === 100 && x === 100 && y === 100 && z === 200);
}

/** Scheme + address validation for ONE URL. Throws NetGuardError with an honest,
 *  specific message (docs/error-message-standards.md). Returns the parsed URL. */
export async function assertPublicHttpUrl(raw: string, lookup: LookupFn = defaultLookup, signal?: AbortSignal): Promise<URL> {
  signal?.throwIfAborted();
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
  // WHY: DNS promises do not accept a portable cancellation signal. Settle our
  // wait on abort while consuming any late lookup result/rejection. The listener
  // is scoped to this hop; the same signal/deadline is shared by every hop.
  const resolveHost = () => Promise.resolve().then(() => {
    signal?.throwIfAborted();
    try {
      return Promise.resolve(lookup(host)).catch(() => {
        throw new NetGuardError(`Could not resolve ${host} — check the URL or the network connection.`);
      });
    } catch {
      throw new NetGuardError(`Could not resolve ${host} — check the URL or the network connection.`);
    }
  });
  let addrs: Array<{ address: string }>;
  if (signal) {
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      signal.throwIfAborted();
      addrs = await Promise.race([resolveHost(), aborted]);
    } finally { signal.removeEventListener('abort', onAbort); }
  } else addrs = await resolveHost();
  signal?.throwIfAborted();
  if (addrs.length === 0) throw new NetGuardError(`Could not resolve ${host}.`);
  const bad = addrs.find((a) => isPrivateIp(a.address));
  if (bad) throw new NetGuardError(`${host} resolves to the private/internal address ${bad.address} — fetching it is blocked.`);
  return url;
}

/** The mirror image of assertPublicHttpUrl, for a page's device connection
 *  (home-device deck, S-only-home: "only addresses inside your home or your
 *  Tailscale network"). The address must be a home IPv4 literal, or a name
 *  whose EVERY answer is one — so a `.ts.net` or `.local` name that resolves
 *  to the public internet is refused, and the connection can never be turned
 *  into a way out. IPv6 answers are ignored rather than trusted: no home
 *  device in scope needs one, and link-local fe80:: answers are unusable
 *  without a zone anyway. Same DNS-rebind honesty limit as above. */
export async function assertHomeHttpUrl(raw: string, lookup: LookupFn = defaultLookup, signal?: AbortSignal): Promise<URL> {
  signal?.throwIfAborted();
  let url: URL;
  try { url = new URL(raw); } catch { throw new NetGuardError(`"${raw}" is not a valid URL.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetGuardError(`Only http and https URLs can be fetched (got ${url.protocol.replace(':', '')}).`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) {
    if (!isHomeIpv4(host)) throw new NetGuardError(`${host} is not an address inside your home or Tailscale network.`);
    return url;
  }
  let addrs: Array<{ address: string; family: number }>;
  try { addrs = await lookup(host); }
  catch { throw new NetGuardError(`Could not find ${host} on your network. Check the device is on and the address is right.`); }
  signal?.throwIfAborted();
  const v4 = addrs.filter((a) => a.family === 4 || /^\d+\.\d+\.\d+\.\d+$/.test(a.address));
  if (v4.length === 0) throw new NetGuardError(`Could not find ${host} on your network. Check the device is on and the address is right.`);
  const outside = v4.find((a) => !isHomeIpv4(a.address));
  if (outside) throw new NetGuardError(`${host} points at ${outside.address}, which is outside your home network — reaching it is blocked.`);
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
  /** `url` is the whole hop address, for a caller whose rule includes the
   *  port (a page's device connection: one service on one box). */
  allowHost?: (hostname: string, hop: number, url: URL) => HostDecision;
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
  /**
   * `public` (default): every hop must be on the public internet — the guard
   * every web tool and page connection has always had. `home`: every hop must
   * be INSIDE the home or Tailscale network, for a page's approved device
   * connection only. Never both: a request that could reach either is exactly
   * the bridge from the internet into the home the default exists to stop.
   */
  reach?: 'public' | 'home';
}

/** Fetch with MANUAL redirect following: every hop re-runs assertPublicHttpUrl.
 *  Caller abort / deadline (AbortError / TimeoutError) also ends DNS waiting;
 *  neither is a NetGuardError or proof that OS resolution was canceled. */
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
    const url = opts.reach === 'home'
      ? await assertHomeHttpUrl(current, lookup, deadline)
      : await assertPublicHttpUrl(current, lookup, deadline);
    const host = url.hostname.toLowerCase();
    if (originHost === null) originHost = host;
    const decision = opts.allowHost?.(url.hostname, hop, url);
    if (decision && !decision.ok) throw new NetGuardError(decision.message);
    // Off-host: the request goes on, the credential does not. Both the header
    // form and the in-the-URL form, because a service that redirects while
    // preserving the query string would otherwise carry the key across.
    const onOrigin = host === originHost;
    if (!onOrigin) for (const p of opts.credentialQueryParams ?? []) url.searchParams.delete(p);
    const target = url.toString();
    deadline.throwIfAborted(); // no dispatch after DNS or allowHost used the remaining budget
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
  const { bytes, truncated } = await readBytesCapped(res, maxBytes);
  return { text: bytes.toString('utf8'), truncated };
}

/** The same capped read, as bytes — for a camera snapshot, where decoding to
 *  text would corrupt the picture. */
export async function readBytesCapped(res: Response, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!res.body) return { bytes: Buffer.from(await res.arrayBuffer()), truncated: false };
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
  return { bytes: Buffer.concat(chunks), truncated };
}
