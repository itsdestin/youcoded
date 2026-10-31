// Which hosts the Android app may talk to WITHOUT encryption (ws:// and http://).
//
// WHY (2026-10-30 security audit A1, Destin: "Tailscale only"): the phone used to send its pairing password and conversations in
// plain text to whatever address was saved, including a café's Wi-Fi. Tailscale already encrypts everything between the two devices,
// so plain ws:// is acceptable ONLY there, and to the phone's own backend (loopback). Android's network config cannot name an address
// RANGE, so the rule is enforced in code: here for the page, and in CleartextPolicy.kt for the Kotlin side. Keep the two identical
// (desktop/tests/cleartext-hosts.test.ts and CleartextPolicyTest.kt pin the same cases).

/** What the person sees when a saved or typed address is refused. Plain words; says what to do. */
export const TAILSCALE_ONLY_MESSAGE =
  "YouCoded only connects to your computer over Tailscale, and this address isn’t one. Turn on Tailscale on both devices and add the computer again using its Tailscale address.";

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** First three 16-bit groups of an IPv6 address (expanding "::"), or null when it is not valid IPv6. */
function ipv6Head(host: string): number[] | null {
  if (!/^[0-9a-f:]+$/.test(host) || !host.includes(':')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.slice(0, 3).map((g) => parseInt(g, 16));
}

/** True for the phone itself, a Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48) or a *.ts.net name. */
export function isCleartextAllowedHost(rawHost: string): boolean {
  let host = rawHost.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return false;
  if (host === 'localhost' || host === '::1') return true;
  const v4 = ipv4Octets(host);
  if (v4) return v4[0] === 127 || (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127);
  const v6 = ipv6Head(host);
  if (v6) return v6[0] === 0xfd7a && v6[1] === 0x115c && v6[2] === 0xa1e0;
  // A name: plain letters/digits/dots/dashes only, under ts.net (Tailscale's own domain).
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host);
}

/** Is this ws:// / wss:// / http(s):// address one the Android app may open? Encrypted (wss, https) always may; plain only to allowed hosts. */
export function isConnectionAllowed(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'wss:' || u.protocol === 'https:') return true;
  if (u.protocol !== 'ws:' && u.protocol !== 'http:') return false;
  return isCleartextAllowedHost(u.hostname);
}
