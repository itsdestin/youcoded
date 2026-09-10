// @vitest-environment jsdom
// desktop/tests/callout-authority.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Callout } from '../src/renderer/components/ui/Callout';
import { inScopeFiles, stripComments, assertScopeIsPopulated, assertPatternMatches } from './helpers/guard-scope';

// Guard for K4 — the callout.
//
// A callout is PASSIVE: it states something and offers nothing to press. The
// moment it grows a button it is a K5 status strip, which is a different role
// with a different geometry. Keeping the two apart is the entire reason K4 is
// its own kit entry, so the API is what enforces it: Callout has no action slot.

afterEach(cleanup);

// The body slot is a <div>, so the surface is its PARENT — not `closest('div')`,
// which would return the body itself.
function surface(): HTMLElement {
  return screen.getByText('body').parentElement as HTMLElement;
}

describe('Callout', () => {
  it('has one geometry across all three tones', () => {
    const structural = new Set<string>();
    for (const tone of ['info', 'warning', 'danger'] as const) {
      cleanup();
      render(<Callout tone={tone}>body</Callout>);
      const el = surface();
      for (const cls of ['rounded-lg', 'p-3', 'border']) {
        expect(el.className, `${tone} missing ${cls}`).toContain(cls);
      }
      // Everything except the tone's own color pair (the classes carrying "/").
      structural.add(el.className.split(/\s+/).filter((c) => c && !c.includes('/')).sort().join(' '));
    }
    expect(structural.size, 'tones must not diverge in geometry').toBe(1);
  });

  it('each tone carries its own surface and border', () => {
    // Preserves change 14's rule (accent = info, amber = warning) and adds the
    // danger tone the old set was missing — which is why SyncPanel had to
    // hand-roll one.
    const expected: Record<string, string[]> = {
      info: ['bg-accent/10', 'border-accent/25'],
      warning: ['bg-amber-500/10', 'border-amber-500/25'],
      danger: ['bg-destructive/10', 'border-destructive/50'],
    };
    for (const [tone, classes] of Object.entries(expected)) {
      cleanup();
      render(<Callout tone={tone as 'info'}>body</Callout>);
      for (const c of classes) expect(surface().className, tone).toContain(c);
    }
  });

  it('defaults to info', () => {
    render(<Callout>body</Callout>);
    expect(surface().className).toContain('bg-accent/10');
  });

  it('an optional title sits above the body', () => {
    render(<Callout tone="warning" title="Before scanning:">Download Tailscale first.</Callout>);
    const title = screen.getByText('Before scanning:');
    const body = screen.getByText('Download Tailscale first.');
    expect(title.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// ── Adoption ────────────────────────────────────────────────────────────────


/**
 * A tinted, bordered block — the shape a callout wears.
 *
 * The spec described K4 as "3 geometries". The survey found more, and matching
 * only the three named ones would have missed most of them: the app also had
 * `bg-red-500/10` at TWO border opacities (/20 and /25) around text that already
 * used the `destructive` TOKEN, and a `bg-green-500/10` success block that the
 * spec's three tones cannot express at all. Matching the SHAPE rather than a
 * list of known-bad recipes is the same correction K1 needed after a
 * known-orderings grep found 3 of its 6 violations.
 */
const TINT = /bg-(amber-500|accent|destructive|red-500|green-500|emerald-500)\/(10|5)\b/g;

/**
 * Tinted blocks in scope that are NOT callouts, counted per file.
 *
 * A count, not a bare file list, because SettingsPanel legitimately has both:
 * it holds migrated callouts AND three blocks that are something else. A
 * file-level exemption would let a fourth hand-rolled callout in without a word.
 *
 * Two categories here, and the distinction is the one thing K4 exists to
 * protect: **a block that states something and offers a button to resolve it is
 * a K5 status strip, not a callout.** Those are deferred to tranche 4 with the
 * rest of K5, not overlooked.
 */
const NOT_CALLOUTS: Record<string, { count: number; why: string }> = {
  'Button.tsx': { count: 1, why: "danger-outline's hover fill — a control's own state" },
  'ThemeShareSheet.tsx': { count: 1, why: 'an <a> styled as a button — it has a hover fill' },
  'AssistantTurnBubble.tsx': { count: 1, why: 'the Plan card in the chat timeline — not a menu surface at all' },
  'SettingsPanel.tsx': {
    count: 3,
    why: 'the Remote setup banner and the "Connected to X" banner both carry buttons, so both are K5; '
      + 'the third is the Package Tier option selected state',
  },
  'SyncPanel.tsx': {
    count: 4,
    why: 'two are K6 backend-row state tints, two are the warnings list (Fix/Dismiss buttons, so K5) '
      + 'and its context-menu danger hover',
  },
  'SpecialistsChip.tsx': {
    count: 2,
    why: "StatusPill's Needs-you and Failed variants — rounded-full inline state badges, peers of the "
      + 'same switch\'s untinted Stopped/Finished pills, not standalone passive text (Callout is rounded-lg/p-3)',
  },
};

/**
 * A tint paired with a border, in either order.
 *
 * Order matters and cost a pass: the first version required the tint to appear
 * BEFORE `border`, which silently scored Button.tsx as zero — its recipe reads
 * `border border-destructive/50 … hover:bg-destructive/10`. A guard that misses
 * a violation because of class ORDER is the exact failure K1 had, so this looks
 * both ways within one class string's worth of characters.
 */
function tintedBlocks(src: string): number {
  const clean = stripComments(src);
  let n = 0;
  for (const m of clean.matchAll(TINT)) {
    const window = clean.slice(Math.max(0, m.index - 150), m.index + 150);
    if (/\bborder\b/.test(window)) n++;
  }
  return n;
}

describe('callout adoption', () => {
  it('this guard can see what it claims to cover', () => {
    // A source-text guard that matches nothing PASSES and reads as clean.
    // Three of this workstream's worst misses were exactly that.
    assertScopeIsPopulated(inScopeFiles());
    assertPatternMatches(TINT, 'border border-destructive/50 text-destructive-fg hover:bg-destructive/10',
      'a border-FIRST tinted surface — the order that scored Button.tsx at zero');
  });

  it('no in-scope file grows a new hand-rolled callout', () => {
    const drift: string[] = [];
    for (const file of inScopeFiles()) {
      const name = file.split(/[\\/]/).pop()!;
      if (name === 'Callout.tsx') continue;  // where the three tones are defined
      const n = tintedBlocks(readFileSync(file, 'utf8'));
      const allowed = NOT_CALLOUTS[name]?.count ?? 0;
      if (n !== allowed) drift.push(`${name}: ${n} tinted blocks, expected ${allowed}`);
    }
    expect(
      drift,
      'Passive information goes through <Callout>. If the block carries a button it is a K5 '
        + 'status strip — add it to NOT_CALLOUTS with the reason rather than hand-rolling either one.',
    ).toEqual([]);
  });

  it('every exemption still exists and still applies', () => {
    // An exemption is a liability the moment it stops being true. In the dialog
    // guard, two of four turned out to be simply wrong — written off on a class
    // string without reading the style object underneath.
    const byName = new Map(inScopeFiles().map((p) => [p.split(/[\\/]/).pop()!, p]));
    for (const [file, { count, why }] of Object.entries(NOT_CALLOUTS)) {
      const abs = byName.get(file);
      expect(abs, `${file} is exempted but no longer in scope — drop it`).toBeTruthy();
      expect(
        tintedBlocks(readFileSync(abs!, 'utf8')),
        `${file} (${why}) no longer has ${count} — update or drop the exemption`,
      ).toBe(count);
    }
  });
});
