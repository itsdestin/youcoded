// One rule for "is this the same service?" — used by the model catalog (main) to match a custom
// endpoint to a models.dev provider, and by Add provider (renderer) to show an edited endpoint as the
// service it is. WHY shared/: the two sides disagreeing would make the picker and the form name
// different services for one address. WHY these rules: models.dev publishes the same service both with
// and without "/v1" and with or without a trailing slash; hosts are case-insensitive; the scheme and
// port are kept because http://x and https://x, or :1234 and :8080, are different servers.

/** The comparable form of an address, or null when it is not an http(s) URL. */
export function normalizeEndpoint(url: string): string | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let path = u.pathname.replace(/\/+$/, '');
  if (path.toLowerCase().endsWith('/v1')) path = path.slice(0, -3);
  path = path.replace(/\/+$/, '');
  // URL already lowercases the host and drops a default port.
  return `${u.protocol}//${u.host}${path}`;
}

/** True when both are addresses and name the same service. */
export function sameEndpoint(a: string, b: string): boolean {
  const na = normalizeEndpoint(a);
  return na !== null && na === normalizeEndpoint(b);
}
