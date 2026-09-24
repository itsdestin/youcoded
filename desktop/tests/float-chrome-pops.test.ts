// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { RENDERER, readSource } from './helpers/guard-scope';
import { applyThemeToDom } from '../src/renderer/themes/theme-engine';

// The 'float' chrome style (styles/float-chrome.css) is a NEW option a theme can
// select. Destin's requirement for shipping it (2026-09-23): "our changes should
// only be noticeable if/when a user selects this new minimal chrome style." These
// tests pin that isolation, and the approved look, from the source.

const TOKENS = {
  canvas: '#0D1117', panel: '#161B22', inset: '#21262D', well: '#0D1117',
  accent: '#B1BAC4', 'on-accent': '#0D1117',
  fg: '#E6EDF3', 'fg-2': '#C9D1D9', 'fg-dim': '#8B949E',
  'fg-muted': '#6E7681', 'fg-faint': '#484F58',
  edge: '#343A41', 'edge-dim': '#3F454C80',
  'scrollbar-thumb': '#30363D', 'scrollbar-hover': '#484F58',
};

const wallpaper = {
  type: 'image' as const,
  value: 'assets/wallpaper.jpg',
  'panels-blur': 22,
  'panels-opacity': 0.58,
};

const theme = (layout: Record<string, string>) => ({
  name: 'Float Test', slug: 'float-test', dark: true,
  tokens: TOKENS, layout, background: wallpaper,
});

/** float-chrome.css, comments stripped so a selector mentioned in prose cannot
 *  stand in for a rule. */
const floatCSS = () =>
  readSource(join(RENDERER, 'styles', 'float-chrome.css')).replace(/\/\*[\s\S]*?\*\//g, '');

/** Every top-level selector list in a stylesheet, @media/@keyframes unwrapped. */
function selectorLists(css: string): string[] {
  const out: string[] = [];
  let depth = 0; let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      const head = css.slice(start, i).trim();
      if (!head.startsWith('@')) out.push(head);
      depth++; start = i + 1;
    } else if (css[i] === '}') { depth--; start = i + 1; }
  }
  return out;
}

beforeEach(() => { document.head.innerHTML = ''; document.body.removeAttribute('data-chrome-style'); });

describe('float chrome never reaches another chrome style', () => {
  it('every rule is gated on the float chrome style (bar the hidden fade element)', () => {
    const lists = selectorLists(floatCSS()).filter(s => !/^(from|to|\d+%)/.test(s));
    expect(lists.length).toBeGreaterThan(20);
    for (const list of lists) {
      if (list === '.chat-edge-fade') continue; // `display: none` for the one element this file adds
      // Split on top-level commas only (commas inside :is(...) belong to one selector).
      let depth = 0; let from = 0; const parts: string[] = [];
      for (let i = 0; i < list.length; i++) {
        if (list[i] === '(') depth++;
        else if (list[i] === ')') depth--;
        else if (list[i] === ',' && depth === 0) { parts.push(list.slice(from, i)); from = i + 1; }
      }
      parts.push(list.slice(from));
      for (const selector of parts) expect(selector, selector).toContain("[data-chrome-style='float']");
    }
  });

  it('the theme engine injects nothing float-specific and leaves the floating-input glass as it was', () => {
    const engine = readSource(join(RENDERER, 'themes/theme-engine.ts'));
    // WHY: an earlier draft rewrote these selectors with :not([data-chrome-style='float']),
    // which raised their specificity for EVERY floating-input theme.
    expect(engine).toContain("[data-wallpaper] [data-input-style='floating'] .input-bar-container,");
    expect(engine).not.toMatch(/data-chrome-style='float'/);
    expect(engine).not.toMatch(/data-(veil|pop|header-lens)/);
  });

  it('sets no float attribute on a theme that does not select it', () => {
    applyThemeToDom(theme({ 'chrome-style': 'default', 'input-style': 'floating' }) as any, false);
    expect(document.body.getAttribute('data-chrome-style')).toBe('default');
    for (const attr of ['data-veil', 'data-pop', 'data-header-lens']) expect(document.body.hasAttribute(attr)).toBe(false);
  });

  it('sets data-chrome-style=float when a theme selects it', () => {
    applyThemeToDom(theme({ 'chrome-style': 'float' }) as any, false);
    expect(document.body.getAttribute('data-chrome-style')).toBe('float');
  });

  it('the component hooks are class names and data attributes only', () => {
    // WHY: these components render for every theme; a hook must not change what
    // any other chrome style paints.
    expect(readSource(join(RENDERER, 'components/QuickChips.tsx'))).toContain('quick-chip-edit shrink-0');
    expect(readSource(join(RENDERER, 'components/tags/SessionTagsChip.tsx'))).toContain('className="status-chip flex');
    expect(readSource(join(RENDERER, 'components/HeaderBar.tsx'))).toContain('className="caption-buttons flex bg-inset');
    expect(readSource(join(RENDERER, 'components/SessionStrip.tsx'))).toContain('data-status={color} className={`session-dot ');
    expect(readSource(join(RENDERER, 'components/ScreenBand.tsx'))).toContain('className="header-controls-left flex');
    expect(readSource(join(RENDERER, 'components/game/GamePanel.tsx'))).toContain('className="game-panel relative');
    expect(readSource(join(RENDERER, 'components/TerminalView.tsx'))).toContain('className="terminal-wallpaper"');
  });
});

describe('the approved float look', () => {
  it('gives every control, including the message box, one light frosted surface', () => {
    const css = floatCSS();
    for (const hook of ['.session-strip', '.quick-chip, .quick-chip-edit', '.status-bar > button, .status-bar .status-chip', '.input-bar-container form']) {
      expect(css).toContain(hook);
    }
    expect(css).toContain('background: color-mix(in srgb, var(--inset) 16%, transparent) !important;');
  });

  it('frosts the message box harder than the small controls, and the small-control blur does not name it', () => {
    const css = floatCSS();
    expect(css).toMatch(/\.input-bar-container form \{\s*backdrop-filter: blur\(16px\)/);
    // WHY: with `form` in the :is() list the list's higher specificity won and
    // the 16px rule never applied (caught 2026-09-23 in the cleanup's pixel diff).
    const small = css.match(/:is\(([^{]*)\)\s*\{\s*backdrop-filter: blur\(6px\)/)?.[1] ?? '';
    expect(small).not.toBe('');
    expect(small).not.toContain('form');
  });

  it('shows no full-width header band', () => {
    const css = floatCSS();
    expect(css).not.toMatch(/\.chrome-wrapper[^{}]*::after/);
    expect(css).toMatch(/\.chrome-wrapper:not\(\.chrome-wrapper--bottom\) \{[^}]*position: absolute/);
  });

  it('marks selected Files/Games and the selected Chat segment with the solid bright pill', () => {
    const css = floatCSS();
    expect(css).toMatch(/button\.bg-accent,\s*\[data-chrome-style='float'\] \.header-bar \.wide-view-toggle-indicator,[^{]*button\[aria-pressed='true'\]:not\(\.wide-view-toggle \*\) \{\s*background: color-mix\(in srgb, var\(--panel\) 85%/);
  });

  it('floats Session Files / Games, Projects, Pages and the terminal as frosted sheets', () => {
    const css = floatCSS();
    // WHY bubble density, not the controls' 16%: a file list's text vanished over dark wallpaper.
    expect(css).toContain('--float-sheet-fill: color-mix(in srgb, var(--panel) calc(var(--panels-opacity, 1) * 100%), transparent);');
    for (const sheet of ['.framed-shell > .drawer-pane {', '.screen-pane {', '.terminal-overlay-scroll {']) expect(css).toContain(sheet);
    expect(css).toMatch(/\.drawer-pane :is\(\.drawer-aside, \.game-panel\) \{\s*background-color: transparent/);
    // The terminal card is desktop-only: on phones the message box sits under it.
    expect(css).toMatch(/html\[data-platform="electron"\] \[data-chrome-style='float'\] \.terminal-overlay-scroll \{/);
    // WHY no inset: an inset left an untinted strip between the card edge and the grid.
    expect(css).toContain('--terminal-side-inset: 0px;');
    expect(css).toMatch(/\.terminal-overlay-scroll \.xterm \{\s*padding:/);
  });

  it('gives the session menu the switcher\'s surface and restyles every scroll bar', () => {
    const css = floatCSS();
    // See-through only over a wallpaper; a flat theme keeps the solid panel.
    expect(css).toMatch(/\[data-wallpaper\] \[data-chrome-style='float'\] \.session-menu\.glass-overlay \{\s*background-color: color-mix\(in srgb, var\(--inset\) 24%/);
    // The list's ends fade to clear (a mask), not under a painted panel band.
    expect(css).toMatch(/\.session-menu \.scroll-fade::after \{\s*display: none/);
    expect(readSource(join(RENDERER, 'components/SessionStrip.tsx'))).toContain('className="session-menu glass-overlay');
    // WHY the fill is restated: Golden Sunbreak's custom_css paints its own gold thumb.
    expect(css).toMatch(/::-webkit-scrollbar-thumb \{\s*background: var\(--scrollbar-thumb\)/);
  });

  it('fades messages out between the message box and the status buttons', () => {
    expect(floatCSS()).toContain('--float-fade-end: 27px;');
  });

  it('the screen band shares the header ink without touching the chat\'s bottom controls', () => {
    expect(readSource(join(RENDERER, 'components/ScreenBand.tsx'))).toContain('useWallpaperHeaderInk(headerRef, { inkBottom: false });');
    expect(readSource(join(RENDERER, 'hooks/use-wallpaper-header-ink.ts'))).toContain('if (inkBottom) for (const element of');
  });

  it('draws the window buttons as three separate chips', () => {
    const css = floatCSS();
    expect(css).toMatch(/\.caption-buttons \{[^}]*background: transparent !important/);
    expect(css).toMatch(/\.caption-buttons > button:last-child:is\(:hover, :active\)/);
  });

  it('centres the narrowed composer even on floating-input themes', () => {
    expect(floatCSS()).toMatch(/\.input-bar-container \{[^}]*margin-inline: auto !important/);
  });

  it('draws status dots bare: no glow, ring or backing', () => {
    const css = floatCSS();
    expect(css).not.toMatch(/\.session-dot[^{}]*\{[^}]*box-shadow:\s*0 0/s);
    expect(css).not.toMatch(/\.session-dot[^{}]*::before/);
    for (const key of ['red', 'green', 'blue', 'amber']) {
      expect(css).toContain(`[data-status='${key}'] { background-color: var(--wallpaper-status-${key}) !important; }`);
    }
  });

  it('keeps meaningful chip colours and swaps only plain theme text', () => {
    const css = floatCSS();
    expect(css).toContain(".status-bar > button[data-bottom-ink]:is(:not([style*='color']), [style*='color: var(--fg'])");
  });

  it('fades messages with a wallpaper copy above the transcript, never a mask on it', () => {
    const css = floatCSS();
    const view = readSource(join(RENDERER, 'components/ChatView.tsx'));
    expect(view).toContain('visible && <ChatEdgeFade belowFindRow={findOpen || !!stripStatus} />');
    // A mask on any bubble ancestor creates a backdrop root and kills bubble glass.
    expect(css).not.toMatch(/\.chat-scroll[^{}]*\{[^}]*mask-image:/s);
    expect(css).toMatch(/\.chat-edge-fade \{[^}]*pointer-events: none/s);
  });
});
