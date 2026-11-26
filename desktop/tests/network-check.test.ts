import { describe, it, expect, vi } from 'vitest';
import { checkInternet, NETWORK_PROBE_URLS } from '../src/main/network-check';

// Card #236: "offline" is only said when BOTH probes fail (Destin 2026-09-14, check fails twice).
// Release 1.3.4 (deck L-2): the probes are real HTTPS requests, so any reply means online.
describe('the app\'s own online check', () => {
  it('asks two different HTTPS addresses', () => {
    expect(NETWORK_PROBE_URLS).toHaveLength(2);
    for (const u of NETWORK_PROBE_URLS) expect(u.startsWith('https://')).toBe(true);
    expect(new URL(NETWORK_PROBE_URLS[0]).host).not.toBe(new URL(NETWORK_PROBE_URLS[1]).host);
  });

  it('is online when only one of the two addresses answers', async () => {
    const probe = vi.fn(async (url: string) => { if (url === NETWORK_PROBE_URLS[0]) throw new Error('fetch failed'); });
    expect(await checkInternet(probe)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('is offline only when both addresses fail, and never throws', async () => {
    const probe = vi.fn(async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED'); });
    expect(await checkInternet(probe)).toBe(false);
  });
});
