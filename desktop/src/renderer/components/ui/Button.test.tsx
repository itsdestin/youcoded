import { describe, it, expect } from 'vitest';
import { mergeClasses, buttonClasses } from './Button';

// WHY: mergeClasses is a hand-rolled stand-in for tailwind-merge (see the long
// comment above CONFLICT_GROUPS in Button.tsx). A 2026-07-20 bug had its single
// padding group treating px- and py- as interchangeable, so the welcome CTAs
// (`<Button size="lg" className="px-8 ...">`) silently rendered with NO vertical
// padding — buttons collapsed to text height in the beta build even though the
// size token said py-2. These tests pin the per-axis independence that fix
// restored, plus the p-N shorthand's cross-axis behavior.
//
// Assertions compare whole tokens (split + toContain), never substrings —
// "py-2" is a substring of "py-2.5" and substring checks false-positive on it.

function tokens(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

describe('mergeClasses padding conflict groups', () => {
  it('keeps base py- when the override only sets px- (the welcome-CTA regression)', () => {
    // lg base is "text-sm px-4 py-2". Overriding px must not drop py.
    const t = tokens(mergeClasses('text-sm px-4 py-2', 'px-8 text-base'));
    expect(t).toContain('py-2');
    expect(t).toContain('px-8');
    expect(t).not.toContain('px-4');
    expect(t).toContain('text-base');
    expect(t).not.toContain('text-sm');
  });

  it('keeps base px- when the override only sets py-', () => {
    const t = tokens(mergeClasses('text-sm px-4 py-2', 'py-2.5'));
    expect(t).toContain('px-4');
    expect(t).toContain('py-2.5');
    expect(t).not.toContain('py-2');
  });

  it('lets a p-N shorthand override beat both base px- and py-', () => {
    const t = tokens(mergeClasses('text-sm px-4 py-2', 'p-4'));
    expect(t).toContain('p-4');
    expect(t).not.toContain('px-4');
    expect(t).not.toContain('py-2');
  });

  it('lets axis overrides beat a base p-N shorthand', () => {
    const t = tokens(mergeClasses('p-2 text-sm', 'py-3'));
    expect(t).toContain('py-3');
    expect(t).not.toContain('p-2');
    expect(t).toContain('text-sm');
  });

  it('still treats same-axis overrides as conflicts (py- replaces py-)', () => {
    const t = tokens(mergeClasses('px-4 py-2', 'py-3'));
    expect(t).toContain('py-3');
    expect(t).not.toContain('py-2');
    expect(t).toContain('px-4');
  });
});

describe('buttonClasses end-to-end', () => {
  it('size=lg with a wider px- override keeps vertical padding', () => {
    // Mirrors App.tsx welcome "New Session": panel-glass w-full px-8 text-base
    const t = tokens(buttonClasses('primary', 'lg', 'panel-glass w-full px-8 text-base'));
    expect(t).toContain('py-2');
    expect(t).toContain('px-8');
    expect(t).toContain('text-base');
    expect(t).toContain('bg-accent');
    expect(t).toContain('panel-glass');
  });

  it('size=lg with an explicit py- override uses the override', () => {
    const t = tokens(buttonClasses('secondary', 'lg', 'panel-glass w-full px-6 py-3'));
    expect(t).toContain('py-3');
    expect(t).not.toContain('py-2');
    expect(t).toContain('px-6');
  });
});

describe('sizes that carry their own shape (2026-09-16)', () => {
  // WHY: Tailwind picks between rounded-full and rounded-lg by CSS source order,
  // and rounded-lg is emitted later — so a size's rounded-full only wins if the
  // base rounded-lg is REMOVED, not merely listed first. Same for font weight.
  it('xl is a semibold pill: the base radius and weight are replaced', () => {
    const t = tokens(buttonClasses('secondary', 'xl', 'w-full'));
    expect(t).toContain('rounded-full');
    expect(t).not.toContain('rounded-lg');
    expect(t).toContain('font-semibold');
    expect(t).not.toContain('font-medium');
    expect(t).toEqual(expect.arrayContaining(['text-base', 'px-6', 'py-3', 'w-full']));
  });

  it('icon-xs is round and keeps the touch-size hit area', () => {
    const t = tokens(buttonClasses('raised', 'icon-xs', 'absolute top-1 right-1'));
    expect(t).toContain('rounded-full');
    expect(t).not.toContain('rounded-lg');
    expect(t).toContain('coarse-hit');
    expect(t).toEqual(expect.arrayContaining(['w-4', 'h-4', 'bg-panel', 'border-edge', 'absolute']));
  });

  it('sizes without their own shape still get the base radius and weight', () => {
    for (const size of ['sm', 'md', 'lg', 'icon', 'icon-sm'] as const) {
      const t = tokens(buttonClasses('primary', size));
      expect(t).toContain('rounded-lg');
      expect(t).toContain('font-medium');
    }
  });
});

describe('disabled is never a fill (UI audit 2026-08-25, P-12 decision)', () => {
  // The dark built-ins are monochrome by design: "selected/primary" is signalled
  // by the accent FILL, "disabled" by dimming with no fill. That only stays
  // unambiguous while the disabled treatment never paints a background — the
  // moment it does, a disabled control and a primary one become the same grey
  // block. Destin rejected adding an accent colour to fix this (2026-08-25); the
  // baseline convention is the rule, and this pins it.
  it('Button disables by opacity only — no disabled:bg-* utility', () => {
    const classes = buttonClasses('primary', 'md');
    expect(classes).toMatch(/\bdisabled:opacity-\d+\b/);
    expect(classes).not.toMatch(/\bdisabled:bg-/);
  });
});

describe('display conflict group (ROADMAP L173)', () => {
  // Tailwind resolves competing utilities by CSS source order, and v4 emits
  // `.hidden` before `.inline-flex` — so without a display group the base
  // `inline-flex` beat every caller's `hidden` and "hidden sm:inline-flex"
  // buttons rendered at phone width too (LibraryScreen / ProjectView exits).
  it('a caller hidden replaces the base inline-flex and keeps the sm: variant', () => {
    const t = tokens(buttonClasses('ghost', 'md', 'hidden sm:inline-flex text-sm'));
    expect(t).toContain('hidden');
    expect(t).not.toContain('inline-flex');
    expect(t).toContain('sm:inline-flex');
  });

  it('a caller flex replaces inline-flex; flex-1 does not (it is a sizing token)', () => {
    expect(tokens(buttonClasses('primary', 'md', 'flex'))).not.toContain('inline-flex');
    const t = tokens(buttonClasses('primary', 'md', 'flex-1'));
    expect(t).toContain('inline-flex');
    expect(t).toContain('flex-1');
  });
});
