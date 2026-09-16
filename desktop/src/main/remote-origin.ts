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
//   - null / absent / the literal "null" → an OPAQUE origin: the Android WebView
//     (its page is a file:// document, whose origin serializes to `null` in the
//     header), or a non-browser client. ALLOWED. WHY this is safe: this socket
//     carries NO ambient credential — there is no cookie or HTTP auth the browser
//     attaches automatically; every client must send the password (or a stored
//     device secret it can only have from a prior pairing) as its FIRST message.
//     A cross-site page cannot read the victim's stored secret and cannot know
//     the password, so it gains nothing by connecting. The Origin check is
//     therefore defense-in-depth against a normal visited page opening pre-auth
//     sockets (that page has a real, non-matching Origin and is refused); it must
//     NOT refuse the opaque-origin case, or it breaks the phone — the very client
//     this feature exists for. (2026-09-10 review caught that refusing `null`
//     would 403 the real Android WebView.)

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
  // Opaque origin — absent, empty, or the literal "null" a file:// document
  // sends. This is the Android WebView (and other non-browser clients). Allowed:
  // it still can't authenticate without the password/secret, and refusing it
  // would break the phone. See the file header for why this is safe.
  if (!o || o.toLowerCase() === 'null') return true;
  // Some engines report the page's own file:// URL instead of "null" — same case.
  if (o.toLowerCase().startsWith('file:')) return true;
  const originHost = hostOf(o, 'origin');
  const hostHeaderHost = hostOf(host ?? '', 'host');
  if (!originHost || !hostHeaderHost) return false;
  return originHost === hostHeaderHost;
}
