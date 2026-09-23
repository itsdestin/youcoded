import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';

const components = join(__dirname, '..', 'src', 'renderer', 'components', 'marketplace');
const preview = join(__dirname, '..', 'src', 'renderer', 'dev', 'workbench', 'mockups');

describe('Marketplace Details outer shell', () => {
  it('uses the approved compact header and contained divider without changing the entry title', () => {
    // WHY: this is the shared shell used for both skill and theme entries;
    // the separate entry title inside each scroll body is not a dialog title.
    const source = readSource(join(components, 'MarketplaceDetailOverlay.tsx'));
    const css = readSource(join(components, 'MarketplaceDetailOverlay.css'));
    expect(source).toContain('data-marketplace-detail-header className="flex items-center justify-between p-3 sm:p-4"');
    expect(source).toContain('<h2 className="text-base font-medium text-fg">Details</h2>');
    expect(css).toMatch(/\[data-marketplace-detail-header\]::after\s*\{[^}]*left:\s*16px;[^}]*right:\s*16px;[^}]*var\(--edge\) 8%, var\(--edge\) 92%/);
    expect(source).toContain('<h1 className="text-xl sm:text-2xl font-semibold text-fg">{entry.displayName}</h1>');
    expect(source).toContain('<h1 className="text-xl sm:text-2xl font-semibold text-fg">{entry.name}</h1>');
  });

  it('masks scroll content only at edges with hidden room', () => {
    const source = readSource(join(components, 'MarketplaceDetailOverlay.tsx'));
    const css = readSource(join(components, 'MarketplaceDetailOverlay.css'));
    expect(source).toContain('useScrollFade<HTMLDivElement>()');
    expect(source).toContain('ref={scrollRef} data-marketplace-detail-scroll className="flex-1 overflow-y-auto p-3 sm:p-6"');
    expect(css).toContain('mask-image:');
    expect(css).toContain('mask-composite: add;');
    expect(css).toContain('transparent 4%, transparent 96%');
    expect(css).toMatch(/\[data-marketplace-detail-scroll\]\[data-fade-top="true"\]\s*\{\s*--detail-fade-top:\s*42px;/);
    expect(css).toMatch(/\[data-marketplace-detail-scroll\]\[data-fade-bottom="true"\]\s*\{\s*--detail-fade-bottom:\s*42px;/);
  });

  it('keeps Today as the original header and bare body only in the Workbench', () => {
    const css = readSource(join(preview, 'MarketplaceDetailHeaderDemo.css'));
    expect(css).toMatch(/\[data-treatment="today"\].*header:first-child\s*\{[^}]*border-bottom:\s*1px solid var\(--edge-dim\)/);
    expect(css).toMatch(/\[data-treatment="today"\].*header:first-child h2\s*\{[^}]*font-size:\s*18px;[^}]*font-weight:\s*600/);
    expect(css).toMatch(/\[data-treatment="today"\].*header:first-child \+ div\s*\{[^}]*mask-image:\s*none/);
  });
});
