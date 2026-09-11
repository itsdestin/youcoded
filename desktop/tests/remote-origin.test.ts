import { describe, it, expect } from 'vitest';
import { isAllowedWsOrigin } from '../src/main/remote-origin';

// The WebSocket Origin allow-list (2026-09-10 security review, #5). A malicious
// page cannot forge its Origin, so "does the Origin's host match the Host header
// the socket arrived on" is the whole test.
describe('isAllowedWsOrigin', () => {
  it('allows a same-origin page (the remote UI we served), including a matching port', () => {
    expect(isAllowedWsOrigin('http://desktop.tailnet.ts.net:9900', 'desktop.tailnet.ts.net:9900')).toBe(true);
    expect(isAllowedWsOrigin('http://100.64.1.2:9900', '100.64.1.2:9900')).toBe(true);
    // A custom /etc/hosts nickname reaches us under that name in BOTH headers.
    expect(isAllowedWsOrigin('http://mydesk:9900', 'mydesk:9900')).toBe(true);
  });

  it('allows the Android WebView, whose page is a bundled file:// document', () => {
    expect(isAllowedWsOrigin('file://', 'desktop.tailnet.ts.net:9900')).toBe(true);
    expect(isAllowedWsOrigin('file:///android_asset/index.html', '100.64.1.2:9900')).toBe(true);
  });

  it('refuses a genuinely cross-origin page (CSWSH)', () => {
    expect(isAllowedWsOrigin('https://evil.com', 'desktop.tailnet.ts.net:9900')).toBe(false);
    // Same hostname, different port is still cross-origin.
    expect(isAllowedWsOrigin('http://desktop.tailnet.ts.net:9901', 'desktop.tailnet.ts.net:9900')).toBe(false);
    // A prefix trick: evil.com is the real origin host.
    expect(isAllowedWsOrigin('http://desktop.tailnet.ts.net.evil.com', 'desktop.tailnet.ts.net:9900')).toBe(false);
  });

  it('allows an opaque origin — null / absent / "null" — because the Android file:// WebView sends it and auth is still required', () => {
    // A file:// document's origin serializes to the header "null"; refusing it
    // would 403 the real phone. Safe: no ambient credential, so the client must
    // still send the password/secret. (2026-09-10 review caught this.)
    expect(isAllowedWsOrigin(undefined, 'desktop:9900')).toBe(true);
    expect(isAllowedWsOrigin(null, 'desktop:9900')).toBe(true);
    expect(isAllowedWsOrigin('', 'desktop:9900')).toBe(true);
    expect(isAllowedWsOrigin('null', 'desktop:9900')).toBe(true);
  });

  it('still refuses a present, cross-origin page even if the Host header is junk', () => {
    // A real page with a real Origin that doesn't match is the case we refuse.
    expect(isAllowedWsOrigin('http://desktop:9900', undefined)).toBe(false);
    expect(isAllowedWsOrigin('http://desktop:9900', '')).toBe(false);
    expect(isAllowedWsOrigin('%%%not-a-url', 'desktop:9900')).toBe(false);
  });

  it('is case-insensitive on the host', () => {
    expect(isAllowedWsOrigin('http://Desktop.Tailnet:9900', 'desktop.tailnet:9900')).toBe(true);
  });
});
