import { describe, it, expect } from 'vitest';
import { versionPillTooltip } from '../src/renderer/components/version-pill-tooltip';

// Card #186: the pill's hover words must agree with the popup for an install owned by another package.
describe('versionPillTooltip', () => {
  const base = { current: '1.0.0', latest: '1.1.0', update_available: true };
  it('keeps the usual words for a normal install', () => {
    expect(versionPillTooltip(base)).toBe('Update available: v1.1.0 — click to download');
    expect(versionPillTooltip({ ...base, downloaded: true })).toBe('v1.1.0 is downloaded — click to restart and update');
    expect(versionPillTooltip({ ...base, update_available: false })).toBe('YouCoded v1.0.0');
  });
  it('points an install owned by another package at its package manager, not a download', () => {
    const t = versionPillTooltip({ ...base, managed_by_other_package: true });
    expect(t).toBe('Update available: v1.1.0 — update it with your package manager');
    expect(t).not.toContain('click to download');
  });
  it('says nothing special when there is no update', () => {
    expect(versionPillTooltip({ ...base, update_available: false, managed_by_other_package: true })).toBe('YouCoded v1.0.0');
  });
});
