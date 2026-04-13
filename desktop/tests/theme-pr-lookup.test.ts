import { describe, it, expect, beforeEach } from 'vitest';
import { ThemePRLookup } from '../src/main/theme-pr-lookup';

describe('ThemePRLookup', () => {
  let calls: string[][];
  let stubResults: Record<string, string>;
  let lookup: ThemePRLookup;

  beforeEach(() => {
    calls = [];
    stubResults = {};
    const fakeExec = async (_bin: string, args: string[]) => {
      calls.push(args);
      const key = args.join(' ');
      return { stdout: stubResults[key] ?? '[]' };
    };
    lookup = new ThemePRLookup({ execFile: fakeExec as any, ttlMs: 60_000, now: () => 1_000 });
  });

  it('returns null when gh returns empty list', async () => {
    const result = await lookup.findOpenPR('sunset', 'alice');
    expect(result).toBeNull();
  });

  it('returns first matching PR', async () => {
    const args = ['pr', 'list', '--repo', 'itsdestin/destinclaude-themes',
      '--author', 'alice', '--state', 'open', '--search', 'sunset',
      '--json', 'number,url'];
    stubResults[args.join(' ')] = JSON.stringify([{ number: 42, url: 'https://x/42' }]);
    const result = await lookup.findOpenPR('sunset', 'alice');
    expect(result).toEqual({ number: 42, url: 'https://x/42' });
  });

  it('caches results within the TTL window', async () => {
    await lookup.findOpenPR('sunset', 'alice');
    await lookup.findOpenPR('sunset', 'alice');
    expect(calls.length).toBe(1);
  });

  it('refetches after invalidation', async () => {
    await lookup.findOpenPR('sunset', 'alice');
    lookup.invalidate('sunset', 'alice');
    await lookup.findOpenPR('sunset', 'alice');
    expect(calls.length).toBe(2);
  });

  it('searches recently merged PRs (5 minute window)', async () => {
    await lookup.findRecentlyMergedPR('sunset', 'alice');
    expect(calls[0]).toContain('--state');
    expect(calls[0]).toContain('merged');
    // Search includes a merged:>= filter; just confirm it's present
    const search = calls[0][calls[0].indexOf('--search') + 1];
    expect(search).toContain('sunset');
    expect(search).toMatch(/merged:>=/);
  });

  it('falls back to null on gh failure', async () => {
    const failing = new ThemePRLookup({
      execFile: (async () => { throw new Error('gh not found'); }) as any,
      ttlMs: 60_000, now: () => 1_000,
    });
    const result = await failing.findOpenPR('sunset', 'alice');
    expect(result).toBeNull();
  });
});
