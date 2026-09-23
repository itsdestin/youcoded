import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKETPLACE_PLUGINS, MARKETPLACE_THEMES } from '../src/renderer/dev/workbench/fixtures/marketplace/registry';

describe('Marketplace detail live preview', () => {
  it('keeps the live skill and theme examples backed by real workbench registry entries', () => {
    const skill = MARKETPLACE_PLUGINS.find((entry) => entry.id === 'civic-report');
    const theme = MARKETPLACE_THEMES.find((entry) => entry.slug === 'golden-sunbreak');
    expect(skill?.components?.skills).toContain('civic-report');
    expect(skill?.longDescription).toContain('federal official');
    expect(theme?.name).toBe('Golden Sunbreak');
    expect(theme?.description).toContain('Tokyo');
  });

  it('keeps Today as an operable, fixture-backed view of the real popup', () => {
    // WHY: only Today has dev CSS; the selected proposal now lives in the
    // production component, so a copied dev fade could drift from the real one.
    const dir = join(__dirname, '..', 'src', 'renderer', 'dev', 'workbench', 'mockups');
    const demo = readFileSync(join(dir, 'MarketplaceDetailHeaderDemo.tsx'), 'utf8');
    const css = readFileSync(join(dir, 'MarketplaceDetailHeaderDemo.css'), 'utf8');
    expect(demo).toContain('<MarketplaceDetailOverlay target={target} onClose={onClose} />');
    expect(demo).toContain('<ThemeBg />');
    expect(demo).toContain('useMarketplace()');
    expect(demo).toContain('open && entryReady && <MarketplaceDetailOverlay');
    expect(demo).toContain('onClose={() => setOpen(false)}');
    expect(css).toContain('min-height: 570px');
    expect(css).toContain('[data-treatment="today"]');
    expect(css).not.toContain('[data-treatment="proposed"]');
  });
});
