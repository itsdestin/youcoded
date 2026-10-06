// @vitest-environment jsdom
// The Home page on glass (owner, 2026-10-05): the room and settings cards turn translucent ONLY when the app says the page is
// see-through (<html data-yc-see-through>); with the flag absent no glass rule matches, so the page is pixel-identical to before.
// The old Background setting (Plain / Frosted / House colours) was removed — the owner: "these are not what i wanted".
import { describe, it, expect, afterEach } from 'vitest';
import { HOME_GLASS_CSS } from '../src/renderer/dev/workbench/fixtures/home-assistant-page-glass';
import { mount, unmount, q, qa, frame } from './home-page-harness';

afterEach(() => { unmount(); });

describe('Home page glass', () => {
  it('every rule sits behind the see-through flag (so plain themes and the switch-off are unchanged)', () => {
    const rules = [...HOME_GLASS_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
    expect(rules.length).toBeGreaterThan(0);
    for (const sel of rules) for (const part of sel.split(',')) expect(part, part).toContain('data-yc-see-through');
  });

  it('makes the cards the theme panel colour at the theme\'s own panel opacity, with no blur of their own', () => {
    expect(HOME_GLASS_CSS).toContain('var(--panel)');
    expect(HOME_GLASS_CSS).toContain('--panels-opacity');
    expect(HOME_GLASS_CSS).not.toMatch(/backdrop-filter/);
  });

  it('the thermostat card is the same light glass, not a solid slab (it was drawn in --inset)', () => {
    expect(HOME_GLASS_CSS).toMatch(/:root\[data-yc-see-through\] \.th-hero \{[^}]*var\(--panel\) calc\(var\(--panels-opacity, 1\) \* 60%\)/);
  });

  it('has no Background setting any more', async () => {
    await mount({});
    q('.gear').click(); await frame();
    expect(qa('.bgopt')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Frosted|House colours/);
  });
});
