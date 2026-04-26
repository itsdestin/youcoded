import { describe, it, expect } from 'vitest';
import type { ThemeRegistryEntryWithStatus } from '../src/shared/theme-marketplace-types';

describe('ThemeRegistryEntryWithStatus', () => {
  it('accepts isLocal as an optional boolean', () => {
    const entry: ThemeRegistryEntryWithStatus = {
      slug: 'foo', name: 'Foo', author: 'destin', dark: true,
      source: 'community', features: [], manifestUrl: 'https://example/manifest.json',
      installed: true, isLocal: true,
    };
    expect(entry.isLocal).toBe(true);
  });

  it('isLocal is optional — omitting it is valid', () => {
    const entry: ThemeRegistryEntryWithStatus = {
      slug: 'foo', name: 'Foo', author: 'destin', dark: true,
      source: 'community', features: [], manifestUrl: 'https://example/manifest.json',
      installed: true,
    };
    expect(entry.isLocal).toBeUndefined();
  });
});
