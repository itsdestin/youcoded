// Pins the phone's "plain connections only to the phone itself or Tailscale" rule (2026-10-30 audit A1).
// CleartextPolicyTest.kt (app/src/test) holds the same cases for the Kotlin copy.
import { describe, it, expect } from 'vitest';
import { isCleartextAllowedHost, isConnectionAllowed } from '../src/shared/cleartext-hosts';

describe('cleartext hosts', () => {
  it.each(['localhost', '127.0.0.1', '127.8.8.8', '[::1]', '100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12:4843:cd96:6200:1', 'my-pc.tail1234.ts.net', 'MY-PC.TS.NET.'])(
    'allows %s', (h) => expect(isCleartextAllowedHost(h)).toBe(true));
  it.each(['192.168.1.20', '10.0.0.5', '172.16.0.1', '100.63.255.255', '100.128.0.1', '8.8.8.8', 'example.com', 'ts.net', 'evil-ts.net', 'a.ts.net.evil.com',
    'fd7a:115c:a1e1::1', 'fe80::1', '999.1.1.1', '', 'host name.ts.net', '0::1'])(
    'refuses %s', (h) => expect(isCleartextAllowedHost(h)).toBe(false));
  it('judges the real address the URL parser reads, not the typed text', () => {
    expect(isConnectionAllowed('ws://100.64.1.2:9900/ws')).toBe(true);
    expect(isConnectionAllowed('ws://192.168.1.2:9900/ws')).toBe(false);
    expect(isConnectionAllowed('ws://100.64.1.2@192.168.1.2:9900/ws')).toBe(false);
    expect(isConnectionAllowed('ws://0x64.0x40.1.1:9900/ws')).toBe(true); // parser turns this into 100.64.1.1
    expect(isConnectionAllowed('ws://3232235777:9900/ws')).toBe(false); // 192.168.1.1 written as one number
    expect(isConnectionAllowed('wss://example.com/ws')).toBe(true);
    expect(isConnectionAllowed('ftp://100.64.1.2/')).toBe(false);
  });
});
