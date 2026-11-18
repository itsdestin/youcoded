import { describe, it, expect, vi } from 'vitest';
import { checkInternet, NETWORK_PROBE_HOSTS } from '../src/main/network-check';

// Card #236: "offline" is only said when BOTH probes fail (Destin 2026-09-14, check fails twice).
describe('the app\'s own online check', () => {
  it('is online when only one of the two hosts answers', async () => {
    const lookup = vi.fn(async (host: string) => { if (host === NETWORK_PROBE_HOSTS[0]) throw new Error('ENOTFOUND'); });
    expect(await checkInternet(lookup)).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('is offline only when both hosts fail, and never throws', async () => {
    const lookup = vi.fn(async () => { throw new Error('EAI_AGAIN'); });
    expect(await checkInternet(lookup)).toBe(false);
  });
});
