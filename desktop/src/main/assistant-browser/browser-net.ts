// Where a Browser navigation is allowed to go (design review 1 #5, review 2 #5).
//
// Three classes, decided by the RESOLVED address (never the host name's
// spelling — a public name can point at 192.168.1.1):
// - 'never'   — cloud-metadata and link-local addresses, the unspecified address,
//               multicast. No answer from the person can open these: a page or a
//               prompt-injected model has no business there, and 169.254.169.254
//               hands out cloud credentials.
// - 'private' — this computer and the home network (localhost, 127/8, 10/8,
//               172.16/12, 192.168/16, 100.64/10, fc00::/7, *.local). Asks once per
//               chat per host:port — developers test their own sites here.
// - 'public'  — everything else.
//
// Same classification family as the web tools' net-guard.ts, which this reuses.
// Honest limit (stated in the spec): the address is checked, then the browser
// connects by name, so a DNS answer that changes in between is not caught.
import { isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';
import { isPrivateIp } from '../harness/tools/net-guard';
import { embeddedIpv4, parseIpBytes } from '../harness/tools/ip-bytes';

export type AddressClass = 'never' | 'private' | 'public';

export type LookupFn = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true });

/** Metadata / link-local / unspecified / multicast — never openable. */
export function isNeverAddress(ip: string): boolean {
  const b = parseIpBytes(ip);
  if (!b) return false;
  // ::1 is this computer (loopback), not "0.0.0.1": embeddedIpv4 reads the
  // compatible form, which would wrongly make it never-openable.
  if (b.length === 16 && b.slice(0, 15).every((v) => v === 0) && b[15] === 1) return false;
  const v4 = b.length === 4 ? b : embeddedIpv4(b);
  if (v4) {
    const [a, x, y, z] = v4;
    // 0.0.0.0/8, 169.254/16 (holds 169.254.169.254), 224+ multicast/reserved,
    // Alibaba's metadata 100.100.100.200.
    return a === 0 || (a === 169 && x === 254) || a >= 224 || (a === 100 && x === 100 && y === 100 && z === 200);
  }
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xff) return true;                          // multicast
  if (b.every((v) => v === 0)) return true;                // ::
  return b[0] === 0xfd && b[1] === 0x00 && b[2] === 0x0e && b[3] === 0xc2; // fd00:ec2::/32 AWS metadata
}

function classifyIp(ip: string): AddressClass {
  if (isNeverAddress(ip)) return 'never';
  if (isPrivateIp(ip)) return 'private';
  const b = parseIpBytes(ip);
  // ::1 (loopback) is not in net-guard's v6 private list on its own.
  if (b && b.length === 16 && b.slice(0, 15).every((v) => v === 0) && b[15] === 1) return 'private';
  return 'public';
}

const cache = new Map<string, { cls: AddressClass; at: number }>();
const CACHE_MS = 60_000;

/** Classify a URL's host. A host that won't resolve is 'public' (the browser
 *  will show its own "can't reach" page — nothing private was reached). */
export async function classifyUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<AddressClass> {
  let url: URL;
  try { url = new URL(raw); } catch { return 'public'; }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(host)) return classifyIp(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return 'private';
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cls;
  let cls: AddressClass = 'public';
  try {
    const addrs = await lookup(host);
    // The WORST answer wins: one private answer makes the whole name private.
    for (const a of addrs) {
      const c = classifyIp(a.address);
      if (c === 'never') { cls = 'never'; break; }
      if (c === 'private') cls = 'private';
    }
  } catch { /* unresolvable → public */ }
  cache.set(host, { cls, at: Date.now() });
  return cls;
}

/** host:port as the approval key (review 2 #5: approving one local dev server
 *  must not approve the router). */
export function hostPortKey(raw: string): string {
  try {
    const u = new URL(raw);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname.toLowerCase()}:${port}`;
  } catch { return raw; }
}

/** Only http(s) may be opened. Returns the normalised URL or throws a plain message. */
export function normaliseAddress(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { throw new Error(`"${input}" isn't a web address.`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Only http and https addresses can be opened (this one is ${u.protocol.replace(':', '')}).`);
  }
  return u.toString();
}

/** What the person typed in the panel's address box, as an address to open:
 *  an address as given (https:// added when there's no scheme), or anything
 *  else as a web search. null for a scheme the browser must not open from
 *  there (file:, javascript:, chrome:…). */
export function personAddress(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return /^https?:\/\//i.test(t) ? t : null;
  if (/^(javascript|data|file|about|chrome|view-source):/i.test(t)) return null;
  // One word with a dot, or localhost / an address with a port, reads as an address.
  if (!/\s/.test(t) && (/^[^/?#]+\.[a-z0-9-]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(t) || /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i.test(t))) {
    const local = /^(localhost|127\.|10\.|192\.168\.|\[)/i.test(t);
    return `${local ? 'http' : 'https'}://${t}`;
  }
  // WHY DuckDuckGo: a hidden browser searching Google is often shown a "unusual
  // traffic" check instead of results.
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}
