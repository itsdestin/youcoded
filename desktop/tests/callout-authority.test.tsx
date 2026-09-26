// @vitest-environment jsdom
// desktop/tests/callout-authority.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Callout } from '../src/renderer/components/ui/Callout';
import { inScopeFiles, readSource, stripComments } from './helpers/guard-scope';

// Guard for K4 — the callout, THE notice box.
//
// Superseded rule (2026-09-25, decisions.md P-2/P-4): a callout used to be
// strictly passive, with no action slot, and a notice with a button had to be a
// K5 status strip. Destin ruled the opposite — every warning/error/info notice
// is this one tinted box, and a notice's own buttons (Try again, Show details,
// Resume…) go INSIDE it, at the right. What this guard now pins is that rule:
// one geometry, the buttons inside the box, and colour only in the box and the
// title (never red body text).

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

  it('collapsible: the title is the one visible line and the body opens under it', () => {
    render(<Callout tone="warning" collapsible title="2 conversations not syncing">body</Callout>);
    const summary = screen.getByText('2 conversations not syncing').closest('summary') as HTMLElement;
    expect(summary).not.toBeNull();
    // The arrow is the summary's LAST child — on the right, not the left.
    expect(summary.lastElementChild?.tagName.toLowerCase()).toBe('svg');
    const details = summary.parentElement as HTMLDetailsElement;
    expect(details.tagName).toBe('DETAILS');
    expect(details.open).toBe(false);
    for (const cls of ['rounded-lg', 'p-3', 'border', 'bg-amber-500/10']) expect(details.className).toContain(cls);
  });

  it('body text is the normal grey in every tone, danger included — colour lives in the box and title', () => {
    // Design guide "Status and notices": never red or coloured body text. The
    // danger tone used to write its body in text-destructive-fg.
    for (const tone of ['info', 'warning', 'danger'] as const) {
      cleanup();
      render(<Callout tone={tone} title="Heading">body</Callout>);
      const body = screen.getByText('body');
      expect(body.className, tone).toContain('text-fg-2');
      expect(body.className, tone).not.toMatch(/text-(destructive|red|amber)/);
    }
    cleanup();
    render(<Callout tone="danger" title="Couldn't sync">body</Callout>);
    expect(screen.getByText("Couldn't sync").className).toContain('text-destructive-fg');
  });

  it("a notice's buttons sit INSIDE the box, after the text (at the right)", () => {
    render(
      <Callout tone="danger" title="Couldn't sync" actions={<><button>Show details</button><button>Try again</button></>}>
        body
      </Callout>,
    );
    const box = screen.getByText('body').closest('.rounded-lg') as HTMLElement;
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(box.contains(retry), 'the action is inside the tinted box').toBe(true);
    // Text first, buttons after it in the same row — i.e. on the right.
    expect(screen.getByText('body').compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((retry.parentElement as HTMLElement).className).toContain('ml-auto');
    // Same geometry as a callout without buttons.
    for (const cls of ['rounded-lg', 'p-3', 'border', 'bg-destructive/10']) expect(box.className).toContain(cls);
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
// amber-700 / green-400 / red-400 are the app's own status colors (globals.css @theme).
// The 2026-09-16 design-check pass moved stock tints onto them; without them here every
// migrated block vanished from this guard's count instead of still being checked.
const TINT = /bg-(amber-500|amber-700|accent|destructive|red-500|red-400|green-500|green-400|emerald-500)\/(10|5)\b/g;

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
 *
 * Adding or removing a file here means editing the ast-grep rule
 * no-hand-rolled-callout-tint's `ignores:` too — youcoded-dev's check.sh fails if
 * the two lists differ.
 */
const NOT_CALLOUTS: Record<string, { count: number; why: string }> = {
  'Button.tsx': { count: 1, why: "danger-outline's hover fill — a control's own state" },
  // A REAL hand-rolled warning callout, found 2026-09-16: it wrote its amber as a raw
  // #FF9800, which this pattern could not see, until the design-check pass moved it onto
  // the status amber (same colour). Moving it onto <Callout tone="warning"> changes its
  // look, so it waits for its own review — filed in docs/roadmap (youcoded-dev).
  'ModelPickerPopup.tsx': { count: 1, why: "Fast mode's \u26a0 Billed Per Token box — a hand-rolled warning callout, follow-up filed" },
  'ThemeShareSheet.tsx': { count: 1, why: 'an <a> styled as a button — it has a hover fill' },
  'AssistantTurnBubble.tsx': { count: 1, why: 'the Plan card in the chat timeline — not a menu surface at all' },
  'SessionContextBanner.tsx': {
    count: 1,
    why: 'the strip above a conversation saying what the assistant started with — the whole row '
      + 'IS the button into the panel (Destin, 2026-09-10), and that panel is the ONLY way in '
      + '(review-5 Q-1 chose "never" for opening by itself), so it is a K5 status strip rather '
      + 'than passive text',
  },
  // 3 -> 2 (fix batch 2, 2026-09-26): the Remote Access setup banner lost its
  // outer box — the intro is plain text and the status strip stands alone.
  'SettingsPanel.tsx': {
    count: 2,
    why: 'the phone\'s "Connected to X" banner (green, with a Disconnect button — not yet moved onto '
      + '<Callout actions>, outside fix batch 2\'s screens) and the Package Tier option selected state',
  },
  // 4 -> 2 (fix batch 2, 2026-09-26): the warnings list is now <Callout actions>
  // (a notice's buttons go INSIDE the notice — decisions.md P-2), so its two
  // hand-rolled tints are gone.
  'SyncPanel.tsx': {
    count: 2,
    why: 'the K6 backend rows\' state tints (red when failing, green when healthy) — a list row\'s '
      + 'own state, not a notice',
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
  // "this guard can see what it claims to cover" and "no in-scope file grows
  // a new hand-rolled callout" moved to ast-grep (Plan B, 2026-09-16): rule
  // no-hand-rolled-callout-tint (a tint and a border in one class string, or
  // split across one className attribute). The former was a non-vacuity
  // self-test of TINT/inScopeFiles(); the fixture pass now proves that.

  it('every exemption still exists and still applies', () => {
    // An exemption is a liability the moment it stops being true. In the dialog
    // guard, two of four turned out to be simply wrong — written off on a class
    // string without reading the style object underneath.
    // WHY still a text read: each exempt file must hold EXACTLY `count` tinted
    // blocks — a per-file total, which an ast-grep rule (it reports shapes, and
    // exempts whole files) cannot assert.
    const byName = new Map(inScopeFiles().map((p) => [p.split(/[\\/]/).pop()!, p]));
    for (const [file, { count, why }] of Object.entries(NOT_CALLOUTS)) {
      const abs = byName.get(file);
      expect(abs, `${file} is exempted but no longer in scope — drop it`).toBeTruthy();
      expect(
        tintedBlocks(readSource(abs!)),
        `${file} (${why}) no longer has ${count} — update or drop the exemption`,
      ).toBe(count);
    }
  });
});
