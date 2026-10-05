import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';

const components = join(__dirname, '..', 'src', 'renderer', 'components', 'marketplace');
const preview = join(__dirname, '..', 'src', 'renderer', 'dev', 'workbench', 'mockups');

describe('Marketplace Details outer shell', () => {
  // WHY (detail redesign 2026-10-04, redesign-backlog row 9): every detail page —
  // plugin, skill, connection, theme, integration — is the shared popup (Dialog: its
  // one-line title, the ✕, the tapered line, Escape), never a hand-made panel with its
  // own header. The integration page had drifted into a second copy once before; this
  // pins that both pages go through the one shell, without pinning any measurement.
  it('builds every detail page on the shared popup', () => {
    const shell = readSource(join(components, 'DetailPage.tsx'));
    expect(shell).toContain("import { CARD_LEVEL_1, Dialog, FoldRow, SectionLabel } from '../ui';");
    expect(shell).toMatch(/<Dialog open onClose=\{onClose\} title=\{title\}/);
    for (const file of ['MarketplaceDetailOverlay.tsx', 'IntegrationDetailOverlay.tsx']) {
      const source = readSource(join(components, file));
      expect(source).toContain('<DetailPage');
      expect(source).not.toContain('OverlayPanel');
    }
  });

  it('closes with the ✕, never the words "Esc · Close"', () => {
    // decisions B-1: Marketplace's "Esc · Close" text conforms to the drawn ✕.
    for (const file of ['DetailPage.tsx', 'MarketplaceDetailOverlay.tsx', 'IntegrationDetailOverlay.tsx', 'FileViewerOverlay.tsx']) {
      expect(readSource(join(components, file))).not.toContain('Esc · Close');
    }
  });

  it('keeps Today as the original header and bare body only in the Workbench', () => {
    const css = readSource(join(preview, 'MarketplaceDetailHeaderDemo.css'));
    expect(css).toMatch(/\[data-treatment="today"\].*header:first-child\s*\{[^}]*border-bottom:\s*1px solid var\(--edge-dim\)/);
    expect(css).toMatch(/\[data-treatment="today"\].*header:first-child h2\s*\{[^}]*font-size:\s*18px;[^}]*font-weight:\s*600/);
    expect(css).toMatch(/\[data-treatment="today"\].*header:first-child \+ div\s*\{[^}]*mask-image:\s*none/);
  });
});
