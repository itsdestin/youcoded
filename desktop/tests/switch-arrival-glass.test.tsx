// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { RENDERER, readSource } from './helpers/guard-scope';
import { applyThemeToDom } from '../src/renderer/themes/theme-engine';

// THE BUG (Destin, 2026-09-18): "switching tabs feels weird because the blur/glass
// effect isn't present at the beginning of the animation, then pops-in right as
// the animation ends".
//
// The arrival faded the conversation's WRAPPER. An ancestor with opacity < 1 is a
// backdrop root, and a bubble's backdrop-filter cannot sample past one — so the
// glass was off for the whole fade. The fix has two halves in two languages, which
// is why this is a test and not an ast-grep rule: theme-engine.ts stamps
// `data-bubble-glass` exactly when bubbles are frosted, and motion.css keys a
// glass-safe arrival off it. Either half drifting alone brings the bug back.

const minimalTheme = {
  name: 'Test Theme', slug: 'test-theme', dark: false,
  tokens: {
    canvas: '#F2F2F2', panel: '#EAEAEA', inset: '#E0E0E0', well: '#F7F7F7',
    accent: '#1A1A1A', 'on-accent': '#F2F2F2',
    fg: '#1A1A1A', 'fg-2': '#444444', 'fg-dim': '#666666',
    'fg-muted': '#888888', 'fg-faint': '#AAAAAA',
    edge: '#CFCFCF', 'edge-dim': '#DCDCDC80',
    'scrollbar-thumb': '#C0C0C0', 'scrollbar-hover': '#999999',
  },
};
const glass = { type: 'gradient', value: 'linear-gradient(#000, #fff)', 'panels-blur': 12, 'bubble-blur': 8 };
const stamped = () => document.documentElement.hasAttribute('data-bubble-glass');

beforeEach(() => {
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('data-bubble-glass');
});

describe('data-bubble-glass is stamped exactly when bubbles get a backdrop-filter', () => {
  it('on for a wallpaper theme with bubble blur — and the bubble rule really is there', () => {
    applyThemeToDom({ ...minimalTheme, background: glass } as any, false);
    expect(stamped()).toBe(true);
    expect(document.getElementById('theme-glass')?.textContent).toContain('.in-view .bg-inset');
  });

  it('off with no bubble blur, with Reduce Visual Effects, and on a solid theme', () => {
    applyThemeToDom({ ...minimalTheme, background: { ...glass, 'bubble-blur': 0 } } as any, false);
    expect(stamped()).toBe(false);
    applyThemeToDom({ ...minimalTheme, background: glass } as any, true);
    expect(stamped()).toBe(false);
    applyThemeToDom(minimalTheme as any, false);
    expect(stamped()).toBe(false);
  });

  it('comes off again when the theme changes away from glass', () => {
    applyThemeToDom({ ...minimalTheme, background: glass } as any, false);
    applyThemeToDom(minimalTheme as any, false);
    expect(stamped()).toBe(false);
  });
});

describe('the frosted arrival never fades an ancestor of the glass', () => {
  const css = readSource(join(RENDERER, 'styles', 'motion.css')).replace(/\r/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (selector: string) => {
    const i = css.indexOf(selector);
    expect(i, `missing rule: ${selector}`).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf('}', i));
  };

  it('the wrapper only rises: its keyframes carry a transform and NO opacity', () => {
    expect(block('[data-bubble-glass] .switch-arrival {')).toContain('animation-name: switch-arrival-rise');
    const rise = css.slice(css.indexOf('@keyframes switch-arrival-rise'), css.indexOf('@keyframes switch-arrival-fade'));
    expect(rise).toContain('transform');
    expect(rise).not.toContain('opacity');
  });

  it('the fade sits on the elements that carry the glass, for the same duration, once', () => {
    const fade = block('[data-bubble-glass] .switch-arrival .in-view .bg-inset');
    expect(fade).toContain('.in-view .bg-accent');
    expect(fade).toContain('switch-arrival-fade var(--dur-switch)');
    expect(fade).not.toContain('infinite');
  });

  it('sits inside prefers-reduced-motion: no-preference, because it out-ranks the plain opt-out', () => {
    // globals.css opts out with a bare `.switch-arrival { animation: none }`, which
    // these more specific selectors would beat — so they must not exist at all
    // for someone whose system asks for reduced motion.
    const media = css.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(media).toBeGreaterThan(-1);
    const before = css.slice(0, media);
    expect(before).not.toContain('[data-bubble-glass] .switch-arrival');
    expect(css.slice(media)).toContain('[data-bubble-glass] .switch-arrival {');
  });

  it('is actually loaded, after globals.css', () => {
    const index = readSource(join(RENDERER, 'index.tsx'));
    expect(index.indexOf("import './styles/motion.css'")).toBeGreaterThan(index.indexOf("import './styles/globals.css'"));
  });
});
