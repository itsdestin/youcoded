import { describe, it, expect, vi, afterEach } from 'vitest';
import { isPrivateIp, assertPublicHttpUrl, guardedFetch, readBodyCapped, NetGuardError } from '../src/main/harness/tools/net-guard';

describe('isPrivateIp', () => {
  it.each([
    ['127.0.0.1', true], ['10.1.2.3', true], ['192.168.1.1', true],
    ['172.16.0.1', true], ['172.31.255.255', true], ['172.32.0.1', false],
    ['169.254.169.254', true],           // link-local / cloud metadata
    ['100.64.0.1', true],                // CGNAT (includes Tailscale 100.x)
    ['0.0.0.0', true], ['8.8.8.8', false], ['93.184.216.34', false],
    ['::1', true], ['fd00::1', true], ['fc00::1', true], ['fe80::1', true],
    ['::ffff:192.168.1.1', true],        // v4-mapped v6 (dotted form) re-checked as v4
    // HEX-encoded v4-mapped forms — the shapes `new URL` ACTUALLY produces (C1 bypass):
    ['::ffff:7f00:1', true],             // 127.0.0.1
    ['::ffff:a00:1', true],              // 10.0.0.1
    ['::ffff:a9fe:a9fe', true],          // 169.254.169.254 (cloud metadata)
    ['2606:2800:220:1:248:1893:25c8:1946', false],
  ])('%s → %s', (ip, expected) => expect(isPrivateIp(ip as string)).toBe(expected));
});

describe('assertPublicHttpUrl', () => {
  const resolves = (ips: string[]) => async () => ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd', resolves(['1.2.3.4']))).rejects.toThrow(NetGuardError);
    await expect(assertPublicHttpUrl('ftp://example.com/', resolves(['1.2.3.4']))).rejects.toThrow(/http/);
  });
  it('rejects literal private IPs without a DNS call', async () => {
    const lookup = vi.fn();
    await expect(assertPublicHttpUrl('http://192.168.1.1/admin', lookup)).rejects.toThrow(/private|internal/i);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects hostnames that resolve to ANY private address', async () => {
    await expect(assertPublicHttpUrl('https://evil.example/', resolves(['93.184.216.34', '10.0.0.5']))).rejects.toThrow(NetGuardError);
  });
  it('rejects localhost by name', async () => {
    await expect(assertPublicHttpUrl('http://localhost:9950/', resolves(['127.0.0.1']))).rejects.toThrow(NetGuardError);
  });
  it('accepts a public URL', async () => {
    const url = await assertPublicHttpUrl('https://example.com/page', resolves(['93.184.216.34']));
    expect(url.hostname).toBe('example.com');
  });
  it('rejects v4-mapped IPv6 literals in the HEX form new URL emits (C1)', async () => {
    // new URL('http://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]' — the
    // dotted form NEVER reaches us in production, so these must be caught in hex.
    const nope = vi.fn(); // must resolve as a literal IP: no DNS call
    await expect(assertPublicHttpUrl('http://[::ffff:127.0.0.1]/', nope)).rejects.toThrow(/private|internal/i);
    await expect(assertPublicHttpUrl('http://[::ffff:10.0.0.1]/', nope)).rejects.toThrow(/private|internal/i);
    await expect(assertPublicHttpUrl('http://[::ffff:169.254.169.254]/', nope)).rejects.toThrow(/private|internal/i);
    expect(nope).not.toHaveBeenCalled();
  });
  it('rejects decimal/hex/octal literal encodings of a private IP', async () => {
    // These all normalize to 127.0.0.1 via new URL — good today but previously untested.
    const nope = vi.fn();
    await expect(assertPublicHttpUrl('http://2130706433/', nope)).rejects.toThrow(/private|internal/i);   // decimal
    await expect(assertPublicHttpUrl('http://0x7f000001/', nope)).rejects.toThrow(/private|internal/i);   // hex
    await expect(assertPublicHttpUrl('http://017700000001/', nope)).rejects.toThrow(/private|internal/i); // octal
    expect(nope).not.toHaveBeenCalled();
  });
});

describe('guardedFetch', () => {
  afterEach(() => vi.restoreAllMocks());
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

  it('follows redirects manually and validates EVERY hop', async () => {
    // Public URL 302s to a private target — the classic SSRF bypass. Must throw.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/admin' } }),
    );
    await expect(
      guardedFetch('https://example.com/start', { signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/private|internal/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('caps the redirect chain at 5 hops', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://example.com/next' } }),
    );
    await expect(
      guardedFetch('https://example.com/a', { signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/redirect/i);
    expect(fetchMock).toHaveBeenCalledTimes(6); // initial + 5 hops
    // I1: ONE deadline shared across hops (total budget), not a fresh 30s per hop.
    const signals = fetchMock.mock.calls.map((c) => c[1].signal);
    expect(new Set(signals).size).toBe(1);
  });

  it('returns the final response + finalUrl on success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://example.com/final' } }))
      .mockResolvedValueOnce(new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const { res, finalUrl } = await guardedFetch('https://example.com/start', {
      signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect(finalUrl).toBe('https://example.com/final');
  });

  // The redirect hole design review 1 (finding 4) found: the guard used to
  // spread the caller's headers into EVERY hop and re-check only that the hop
  // was public, so one 302 handed a page's API key to whatever host answered.
  describe('a credential does not walk to a redirect target', () => {
    const redirectThen200 = (location: string) => vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    it('drops the credential header on a hop to a different host', async () => {
      const fetchMock = redirectThen200('https://collector.test/steal');
      await guardedFetch('https://api.example.com/v1', {
        signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch,
        headers: { accept: 'application/json' },
        credentialHeaders: { authorization: 'Bearer sk-page-secret' },
        allowHost: () => ({ ok: true }),
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer sk-page-secret');
      expect(fetchMock.mock.calls[1][1].headers.authorization).toBeUndefined();
      // The ordinary headers still ride along — the request survives, the key does not.
      expect(fetchMock.mock.calls[1][1].headers.accept).toBe('application/json');
    });

    it('keeps the credential on a hop that stays on the same host', async () => {
      const fetchMock = redirectThen200('https://api.example.com/v2');
      await guardedFetch('https://api.example.com/v1', {
        signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch,
        credentialHeaders: { authorization: 'Bearer sk-page-secret' },
      });
      expect(fetchMock.mock.calls[1][1].headers.authorization).toBe('Bearer sk-page-secret');
    });

    it('strips a credential carried in the query string when the host changes', async () => {
      const fetchMock = redirectThen200('https://collector.test/steal?appid=sk-in-the-url&q=x');
      const { finalUrl } = await guardedFetch('https://api.example.com/v1?appid=sk-in-the-url', {
        signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch,
        credentialQueryParams: ['appid'],
      });
      expect(fetchMock.mock.calls[1][0]).toBe('https://collector.test/steal?q=x');
      // finalUrl is the address actually requested, so it cannot echo the key back.
      expect(finalUrl).not.toContain('sk-in-the-url');
    });
  });

  describe('allowHost', () => {
    it('is consulted before the very first request, not only before a redirect', async () => {
      const fetchMock = vi.fn();
      await expect(guardedFetch('https://api.example.com/v1', {
        signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch,
        allowHost: () => ({ ok: false, message: 'not allowed to reach api.example.com' }),
      })).rejects.toThrow(/not allowed to reach/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a hop to a host it does not cover, rather than following it', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/x' } }));
      await expect(guardedFetch('https://api.example.com/v1', {
        signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch,
        allowHost: (host) => host === 'api.example.com' ? { ok: true } : { ok: false, message: `sent on to ${host}` },
      })).rejects.toThrow(/sent on to elsewhere.test/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('method and body on a redirect', () => {
    it('turns a redirected POST into a GET and drops its body, as a browser would', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://api.example.com/v2' } }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await guardedFetch('https://api.example.com/v1', {
        signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch,
        method: 'POST', body: '{"a":1}',
      });
      expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"a":1}' });
      expect(fetchMock.mock.calls[1][1].method).toBe('GET');
      expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
    });

    it('repeats the write on a 307, which is what 307 means', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'https://api.example.com/v2' } }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await guardedFetch('https://api.example.com/v1', {
        signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch,
        method: 'POST', body: '{"a":1}',
      });
      expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{"a":1}' });
    });
  });

  it('reads the body up to maxBytes and reports truncation', async () => {
    const big = 'x'.repeat(2048);
    const fetchMock = vi.fn().mockResolvedValue(new Response(big, { status: 200 }));
    const { res } = await guardedFetch('https://example.com/big', {
      signal: new AbortController().signal, lookup: publicLookup, fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const { text, truncated } = await readBodyCapped(res, 1024);
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(truncated).toBe(true);
  });
});
