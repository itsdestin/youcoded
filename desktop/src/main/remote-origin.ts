// Deciding whether a WebSocket upgrade may connect, from its Origin header.
//
// WHY (2026-09-10 security review, finding #5): the remote server had no Origin
// check at all, so any web page the user happened to have open could open a
// WebSocket to `ws://<their-tailnet-host>:9900/ws` — a cross-site WebSocket
// hijack (CSWSH). Over Tailscale the address is reachable from the user's other
// machines, and a page running on any of them could reach it. The design doc
// claimed this check existed; it did not.
//
// The check is deliberately simple and needs NO knowledge of the tailnet name:
// a browser sets the Origin header itself and a page cannot forge it, so
// comparing the Origin's host[:port] against the Host header the socket actually
// arrived on answers the whole question.
//   - Same host  → the page IS the remote UI we served (whatever name reached us:
//     a tailnet IP, a MagicDNS name, or a custom /etc/hosts nickname all match,
//     because Host and Origin both carry that same name). Allowed.
//   - file://     → the Android WebView dials the socket out while its page is a
//     bundled file:// document. Allowed.
//   - Different host → a genuinely cross-origin page (evil.com). Refused.
//   - null / absent → a sandboxed iframe or a non-browser client. Refused: a
//     normal page always sends its real Origin, so `null` is the sandbox-iframe
//     CSWSH variant, not a case we need. (If a future native client legitimately
//     sends no Origin, add a User-Agent marker allow-list here — but the phone
//     connects from a WebView, which sends file:// or a real Origin, so today
//     nothing legitimate lands here.)

/** Extract `host:port` (lowercased, default ports dropped) from an Origin or a
 *  Host header value, or null if it can't be parsed. A Host header has no
 *  scheme, so we prepend one before parsing. */
function hostOf(value: string, kind: 'origin' | 'host'): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const u = kind === 'origin' ? new URL(raw) : new URL(`http://${raw}`);
    // `host` includes a non-default port; `hostname` never does. Compare on host
    // so a page served on :9900 does not match a socket dialed to :9901.
    return u.host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Whether a WebSocket upgrade carrying this Origin (against this Host header)
 * may connect. Pure and side-effect free so it can be unit-tested exhaustively
 * without a live server or a phone.
 */
export function isAllowedWsOrigin(origin: string | undefined | null, host: string | undefined | null): boolean {
  const o = (origin ?? '').trim();
  // No Origin at all → refuse (see file header: sandbox-iframe CSWSH variant).
  if (!o) return false;
  // The Android WebView's own bundled page is a file:// document; when it dials
  // the socket out, the browser reports the page origin, which has no host.
  if (o.toLowerCase().startsWith('file:')) return true;
  const originHost = hostOf(o, 'origin');
  const hostHeaderHost = hostOf(host ?? '', 'host');
  if (!originHost || !hostHeaderHost) return false;
  return originHost === hostHeaderHost;
}
