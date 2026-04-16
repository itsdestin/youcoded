import { describe, it, expect } from 'vitest';
import { resolvePublishState } from '../src/renderer/state/publish-state-resolver';

const baseEntry = {
  slug: 'sunset', author: 'alice', name: 'Sunset', dark: false,
  features: [], manifestUrl: 'x', source: 'community' as const,
  contentHash: 'sha256:abc',
} as any;

describe('resolvePublishState', () => {
  it('draft when no registry hit and no PR', () => {
    expect(resolvePublishState({
      registryEntry: null, openPR: null, recentlyMergedPR: null, localHash: 'sha256:abc',
    })).toEqual({ kind: 'draft' });
  });

  it('in-review when an open PR exists (even with no registry entry)', () => {
    expect(resolvePublishState({
      registryEntry: null,
      openPR: { number: 42, url: 'https://github.com/x/y/pull/42' },
      recentlyMergedPR: null,
      localHash: 'sha256:abc',
    })).toEqual({ kind: 'in-review', prNumber: 42, prUrl: 'https://github.com/x/y/pull/42' });
  });

  it('in-review (with merged PR) bridges the post-merge / pre-CI window', () => {
    expect(resolvePublishState({
      registryEntry: null, openPR: null,
      recentlyMergedPR: { number: 7, url: 'https://github.com/x/y/pull/7' },
      localHash: 'sha256:abc',
    })).toEqual({ kind: 'in-review', prNumber: 7, prUrl: 'https://github.com/x/y/pull/7' });
  });

  it('published-current when registry hit and hashes match', () => {
    expect(resolvePublishState({
      registryEntry: baseEntry, openPR: null, recentlyMergedPR: null,
      localHash: 'sha256:abc',
    })).toEqual({
      kind: 'published-current',
      marketplaceUrl: 'https://github.com/itsdestin/wecoded-themes/tree/main/themes/sunset',
    });
  });

  it('published-drift when registry hit but hashes differ', () => {
    expect(resolvePublishState({
      registryEntry: baseEntry, openPR: null, recentlyMergedPR: null,
      localHash: 'sha256:DIFFERENT',
    })).toEqual({
      kind: 'published-drift',
      marketplaceUrl: 'https://github.com/itsdestin/wecoded-themes/tree/main/themes/sunset',
    });
  });

  it('treats missing contentHash on registry entry as matching (legacy)', () => {
    const legacy = { ...baseEntry, contentHash: undefined };
    expect(resolvePublishState({
      registryEntry: legacy, openPR: null, recentlyMergedPR: null,
      localHash: 'sha256:anything',
    }).kind).toBe('published-current');
  });

  it('open PR wins over registry entry (in-review trumps published)', () => {
    // Edge case: theme is published AND has an open update PR → show in-review
    expect(resolvePublishState({
      registryEntry: baseEntry,
      openPR: { number: 99, url: 'u' },
      recentlyMergedPR: null,
      localHash: 'sha256:abc',
    }).kind).toBe('in-review');
  });

  it('returns unknown when degraded reason is provided', () => {
    expect(resolvePublishState({
      registryEntry: null, openPR: null, recentlyMergedPR: null,
      localHash: 'sha256:abc',
      degradedReason: 'gh not authenticated',
    })).toEqual({ kind: 'unknown', reason: 'gh not authenticated' });
  });
});
