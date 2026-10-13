// What counts as "a device in your home" for a page's device connection.
//
// Decided on the home-device questions deck (2026-10-01, S-only-home): a device
// connection reaches ONE address, and that address must be inside the home or
// the person's Tailscale network — never a website. Shared by the approval card
// (which checks what the person types as they type it) and main (which checks
// again before anything is stored or fetched), so the two can never disagree
// about which addresses are allowed.
//
// The shape is `host` or `host:port`, where host is either
//   - an IPv4 address in a private range (10/8, 172.16/12, 192.168/16) or
//     Tailscale's range (100.64/10), or
//   - a name that only resolves inside a home: `*.local` (mDNS, e.g.
//     homeassistant.local), `*.lan`, `*.home.arpa`, `*.internal`, or a
//     Tailscale MagicDNS name (`*.ts.net`).
// A name is also re-checked at request time against what it resolves to
// (net-guard's `requirePrivate`), so `foo.ts.net` pointing at a public address
// is still refused.
//
// IPv6 literals are not accepted yet: nobody has asked for one, and the bracket
// syntax is easy to get subtly wrong. Loopback (127.x, localhost) is refused —
// that is this computer, not a device in the home, and the app's own services
// listen there.

/** Name endings that only exist inside a home network or a tailnet. */
const HOME_NAME_ENDINGS = ['.local', '.lan', '.home.arpa', '.internal', '.ts.net'];

/** True for a private or Tailscale IPv4 address. Loopback and link-local are
 *  NOT home devices (this computer / unconfigured), so they are excluded. */
export function isHomeIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // WHY 100.100.100.200 is carved out: it sits inside Tailscale's 100.64/10 but is Alibaba Cloud's metadata
  // address, which the video code's never-dial list (net-guard isNeverDialIp) already refuses. A "home
  // device" there would let a page reach a cloud metadata service. The only never-dial address inside a home range.
  if (a === 100 && b === 100 && c === 100 && d === 200) return false;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale / CGNAT
  return false;
}

/** The host part as a person would type it, lower-cased, no trailing dot. */
function cleanHost(raw: string): string | null {
  const host = raw.trim().replace(/\.$/, '').toLowerCase();
  if (!host || host.length > 253) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isHomeIpv4(host) ? host : null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
  if (host.split('.').some((l) => l.length > 63)) return null;
  return HOME_NAME_ENDINGS.some((e) => host.endsWith(e)) ? host : null;
}

/** `host` or `host:port`, cleaned, or null when it is not a home device.
 *  The port, when given, is kept exactly; when absent the request's own
 *  scheme decides (80 / 443), matching how a browser reads the address. */
export function cleanDeviceAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // A person may paste a whole link from their browser bar; take just the
  // host and port from it rather than refusing something obviously meant.
  let text = raw.trim();
  const linkish = /^https?:\/\//i.test(text);
  if (linkish) {
    try { const u = new URL(text); text = u.port ? `${u.hostname}:${u.port}` : u.hostname; }
    catch { return null; }
  }
  if (!text || /[\s/@?#[\]]/.test(text)) return null;
  const colon = text.lastIndexOf(':');
  let host = text;
  let port: string | null = null;
  if (colon >= 0) {
    host = text.slice(0, colon);
    port = text.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
    port = String(Number(port));
  }
  const h = cleanHost(host);
  if (!h) return null;
  return port ? `${h}:${port}` : h;
}

/** Why an address was refused, in words for the approval card. Only called
 *  when `cleanDeviceAddress` returned null, so it never has to say "fine". */
export function deviceAddressProblem(raw: string): string {
  const text = raw.trim();
  if (!text) return 'Type the address of the device.';
  const host = text.replace(/^https?:\/\//i, '').split(/[:/]/)[0].toLowerCase();
  if (host === 'localhost' || host.startsWith('127.')) return 'That address is this computer, not a device in your home.';
  if (host === '100.100.100.200') return 'That address belongs to a cloud service, not a device in your home.';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'That is not a home or Tailscale address. Home addresses start with 192.168, 10, 172.16–31 or 100.';
  if (host.includes('.')) return 'That looks like a website. Only devices in your home can be used here, such as 192.168.1.20:8123 or homeassistant.local:8123.';
  return 'Type an address like 192.168.1.20:8123 or homeassistant.local:8123.';
}

/** Does a request's URL point at exactly this device address? The port must
 *  match too: a different port on the same box is a different service. */
export function urlMatchesDevice(url: URL, address: string): boolean {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  const [aHost, aPort] = address.includes(':') ? address.split(':') : [address, null];
  if (host !== aHost) return false;
  // An address with no port means "the default for whichever scheme is used".
  return aPort === null ? (port === '80' || port === '443') : port === aPort;
}
