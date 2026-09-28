import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSource } from './helpers/guard-scope';

const css = readSource(
  join(__dirname, '..', 'src', 'renderer', 'styles', 'globals.css'),
);

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `missing CSS selector: ${selector}`).toBeTruthy();
  return match![1].replace(/\s+/g, ' ').trim();
}

describe('wide toggle motion policy', () => {
  it('snaps indicator geometry while environmental measurements synchronize', () => {
    expect(ruleBody(".wide-view-toggle[data-geometry-syncing='true'] .wide-view-toggle-indicator"))
      .toContain('transition-duration: 0ms');
  });

  it('disables spatial toggle transitions for the app Reduced Effects setting', () => {
    expect(ruleBody('[data-reduced-effects] .wide-view-toggle-indicator'))
      .toContain('transition-duration: 0ms');
    expect(ruleBody('[data-reduced-effects] .wide-view-toggle-label'))
      .toContain('transition-duration: 0ms');
  });

  it('duplicates the same declarations for the OS reduced-motion preference', () => {
    // globals.css has several prefers-reduced-motion blocks. Scope to the one
    // that owns the toggle, so an unrelated block gaining a transition-duration
    // can't fail this test with a message that points at the toggle.
    const blocks = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g) ?? [];
    const toggleBlock = blocks.find(block => block.includes('.wide-view-toggle-indicator'));
    expect(toggleBlock, 'no prefers-reduced-motion block covers .wide-view-toggle-indicator').toBeTruthy();
    expect(toggleBlock).toContain('.wide-view-toggle-label');
    expect(toggleBlock!.match(/transition-duration:\s*0ms/g)).toHaveLength(2);
  });
});

describe('session drawer file-list motion policy', () => {
  // The list opens/closes by animating width (a layout property). Both the app's
  // Reduced Effects setting and the OS preference must snap it, like the toggle.
  it('snaps the file list width for the app Reduced Effects setting', () => {
    expect(ruleBody('[data-reduced-effects] .drawer-list')).toContain('transition-duration: 0ms');
  });

  it('snaps the file list width for the OS reduced-motion preference', () => {
    const blocks = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g) ?? [];
    const drawerBlock = blocks.find(block => /\.drawer-list[\s,]/.test(block));
    expect(drawerBlock, 'no prefers-reduced-motion block covers .drawer-list').toBeTruthy();
    expect(drawerBlock).toMatch(/\.drawer-list,[^{}]*\{\s*transition-duration:\s*0ms/);
  });

  it('the file list still animates only width at the same duration', () => {
    const drawer = readSource(join(__dirname, '..', 'src', 'renderer', 'components', 'SessionDrawer.tsx'));
    expect(drawer).toMatch(/drawer-list [^`]*transition-\[width\] duration-200/);
  });
});
