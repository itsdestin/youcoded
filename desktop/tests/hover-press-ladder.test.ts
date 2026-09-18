// Destin, 2026-09-18: "ensure all clickable surfaces are properly hover sensitive.
// for example, the minimize/maximize/exit/games/files buttons all lack good hover
// sensitivity, but projects view and settings look good."
//
// The ladder: a control's fill moves one step along the theme's depth ladder on
// hover and one more on press, from wherever it sits (styles/motion.css). This
// file pins the CSS half — a stylesheet is not an ast-grep language here — and
// the Button primitive's half. The TSX half (no header control may fall back to
// the invisible glyph nudge) is ast-grep `chrome-control-no-glyph-nudge-hover`.
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { RENDERER, readSource } from './helpers/guard-scope';
import { buttonClasses, type ButtonVariant } from '../src/renderer/components/ui/Button';
import { ON_INSET_CONTROL, HEADER_ICON_BUTTON } from '../src/renderer/components/header/control-states';

const css = readSource(join(RENDERER, 'styles', 'motion.css')).replace(/\r/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first rule whose selector text is exactly `selector`. */
function rule(selector: string): string {
  const i = css.indexOf(`${selector} {`);
  expect(i, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf('}', i));
}
/** Is the character offset inside an `@media (hover: hover)` block? */
function insideHoverMedia(offset: number): boolean {
  const open = css.lastIndexOf('@media (hover: hover)', offset);
  if (open < 0) return false;
  // The block closes at the first "\n}" after it opens.
  const close = css.indexOf('\n}', open);
  return offset < close;
}

describe('a control inside an inset pill fills with the NEXT step, because inset is invisible on inset', () => {
  it('hover fills edge, and only where a pointer can hover — a tap must not stick', () => {
    const at = css.indexOf('.on-inset-control:hover {');
    expect(at).toBeGreaterThan(-1);
    expect(insideHoverMedia(at)).toBe(true);
    expect(rule('.on-inset-control:hover')).toContain('background-color: var(--edge)');
  });

  it('press goes one step further, and is NOT behind (hover: hover) — a finger gets it too', () => {
    const at = css.indexOf('.on-inset-control:active {');
    expect(at).toBeGreaterThan(-1);
    expect(insideHoverMedia(at)).toBe(false);
    expect(rule('.on-inset-control:active')).toContain('background-color: var(--press-on-inset)');
  });

  it('the step past edge is DERIVED from the theme, in a bare :root no pack can drop', () => {
    const root = rule(':root');
    expect(root).toMatch(/--press-on-inset:\s*color-mix\(in srgb, var\(--edge\) \d+%, var\(--fg\)\)/);
    expect(css).not.toMatch(/\[data-theme[^\]]*\][^{]*\{[^}]*--press-on-inset/);
  });

  it('fades on the motion tokens, never a hand-written duration or curve', () => {
    const base = rule('.on-inset-control');
    expect(base).toContain('var(--dur-hover) var(--ease-reveal)');
    expect(base).not.toMatch(/\d+ms|cubic-bezier|\ball\b/);
  });
});

describe('every control that fills inset on hover presses one step deeper', () => {
  it('one rule covers every hover:bg-inset site, and skips disabled controls', () => {
    expect(rule('.hover\\:bg-inset:active:not(:disabled)')).toContain('background-color: var(--edge)');
  });
});

describe('the shared chrome definitions carry all three states', () => {
  it('a control on an inset pill: the ladder class and a keyboard focus ring', () => {
    expect(ON_INSET_CONTROL).toContain('on-inset-control');
    expect(ON_INSET_CONTROL).toContain('focus-visible:ring-2');
    // The regression itself: a ~10-grey-level glyph nudge as the ONLY feedback.
    expect(ON_INSET_CONTROL).not.toContain('hover:text-fg-2');
  });

  it('an icon button on the header band: fill, full text step, focus ring', () => {
    for (const cls of ['hover:bg-inset', 'hover:text-fg', 'focus-visible:ring-2']) expect(HEADER_ICON_BUTTON).toContain(cls);
  });
});

describe('the Button primitive presses', () => {
  const pressable: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger', 'danger-outline', 'on-accent'];
  it.each(pressable)('%s has an active: fill', (variant) => {
    expect(buttonClasses(variant)).toMatch(/(^|\s)active:bg-/);
  });

  it('press is the hover pushed one step further, not a different colour', () => {
    expect(buttonClasses('primary')).toContain('hover:bg-accent/90');
    expect(buttonClasses('primary')).toContain('active:bg-accent/80');
    expect(buttonClasses('ghost')).toContain('hover:bg-inset');
    expect(buttonClasses('ghost')).toContain('active:bg-edge');
  });

  it('a caller that replaces the fill still gets a button that keeps its press class', () => {
    // mergeClasses drops base tokens per conflict group; a plain bg- override must
    // not silently take the press state with it.
    expect(buttonClasses('ghost', 'md', 'bg-panel')).toContain('active:bg-edge');
  });
});
