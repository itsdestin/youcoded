// Turn an IP address into its bytes, so a guard can test RANGES instead of
// comparing spellings.
//
// WHY (live-socket step 3 review, finding 1): an address has many spellings
// ("::1", "0:0:0:0:0:0:0:1", "::0001", "::127.0.0.1", "0:0:0:0:0:ffff:7f00:1"
// are all this computer). A guard that compares text only blocks the spellings
// its author thought of. Parsing to bytes first makes every spelling the same
// thing. Only addresses Node's own `isIP` accepts are parsed, so this never
// has to decide what is "valid" — it only has to read what `isIP` allowed.
import { isIP } from 'node:net';

/** 4 bytes for an IPv4 address, 16 for IPv6 (zone id dropped, `::` expanded,
 *  a trailing dotted IPv4 read as its 4 bytes), or null when it is not an IP. */
export function parseIpBytes(ip: string): Uint8Array | null {
  const kind = isIP(ip);
  if (kind === 4) return Uint8Array.from(ip.split('.').map(Number));
  if (kind !== 6) return null;
  let text = ip.split('%')[0];
  let tail: number[] = [];
  const dot = text.lastIndexOf('.');
  if (dot >= 0) {
    const cut = text.lastIndexOf(':');
    const v4 = text.slice(cut + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !(n >= 0 && n <= 255))) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, cut + 1) + '0:0';          // placeholders; replaced below
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === '' ? [] : s.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < (halves.length === 2 ? 1 : 0) || (halves.length === 1 && fill !== 0)) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...rest].map((g) => parseInt(g, 16));
  if (all.length !== 8 || all.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  if (tail.length) { all[6] = tail[0]; all[7] = tail[1]; }
  const out = new Uint8Array(16);
  all.forEach((g, i) => { out[i * 2] = g >> 8; out[i * 2 + 1] = g & 0xff; });
  return out;
}

/** The IPv4 address hidden inside an IPv6 one — v4-mapped (::ffff:a.b.c.d),
 *  v4-compatible (::a.b.c.d), v4-translated (::ffff:0:a.b.c.d) and NAT64
 *  (64:ff9b::a.b.c.d) — or null for any other IPv6 address. */
export function embeddedIpv4(b: Uint8Array): Uint8Array | null {
  if (b.length !== 16) return null;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const last = b.slice(12, 16);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return last;            // ::ffff:0:0/96
  if (zero(0, 12)) return last;                                               // ::/96
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return last; // ::ffff:0:0:0/96
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return last; // 64:ff9b::/96
  return null;
}
