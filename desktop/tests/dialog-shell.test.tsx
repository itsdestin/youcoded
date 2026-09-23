// @vitest-environment jsdom
// desktop/tests/dialog-shell.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { join } from 'node:path';
import { readSource } from './helpers/guard-scope';
import '@testing-library/jest-dom/vitest';
import { Dialog, DIALOG_WIDTHS, DIALOG_MAX_HEIGHTS } from '../src/renderer/components/ui/Dialog';

// Guard for D1 — the one dialog shell.
//
// This is a RENDER test, unlike the other authority tests, because the defect it
// exists to stop is structural rather than textual. SettingsPopup (the shell this
// replaces) set maxHeight on the panel but left the panel a plain block, so every
// caller had to remember `className="flex flex-col"` and wrap its own scroll-fade
// body. TWO OF ITS SEVEN CALLERS FORGOT -- Sound and Session Defaults -- and the
// symptom is a dialog that silently clips its content with no way to scroll to the
// bottom. Destin hit it in the Sound popup on 2026-07-26.
//
// A shell that 2/7 of its own callers can hold wrong is not a shell. The whole
// point of Dialog is that the scroll body is not the caller's job, so that is
// what these assertions pin: you cannot get a Dialog whose body does not scroll.

afterEach(cleanup);

// createPortal renders into document.body; query from there.
function panel(): HTMLElement {
  const el = document.querySelector('[data-layer="2"].layer-surface');
  if (!el) throw new Error('no dialog panel rendered');
  return el as HTMLElement;
}

describe('Dialog shell', () => {
  it('renders nothing when closed', () => {
    render(<Dialog open={false} onClose={() => {}} title="Nope">body</Dialog>);
    expect(document.querySelector('.layer-surface')).toBeNull();
  });

  it('the panel is a flex column so its body can be bounded', () => {
    // This is the exact property SettingsPopup left to the caller.
    render(<Dialog open onClose={() => {}} title="Sound">body</Dialog>);
    expect(panel().className).toContain('flex');
    expect(panel().className).toContain('flex-col');
  });

  it('owns a scrolling body — the caller does not supply one', () => {
    render(<Dialog open onClose={() => {}} title="Sound"><p>tall</p></Dialog>);
    const body = panel().querySelector('.scroll-fade');
    expect(body, 'Dialog must render its own scroll region').not.toBeNull();
    // flex-1 is what gives the scroll region a bounded height inside the column.
    // Without it the body grows to fit content and overflow never engages.
    expect(body!.className).toContain('flex-1');
  });

  it('scrollBody={false} lets a caller own its whole surface', () => {
    // Appearance hands the panel to ThemeScreen; Remote Access swaps in
    // SettingsExplainer. Those own their own scroll regions.
    render(<Dialog open onClose={() => {}} scrollBody={false}><p>custom</p></Dialog>);
    expect(panel().querySelector('.scroll-fade')).toBeNull();
  });

  it('a titled dialog gets an h2 and a close button', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Sound &amp; Notifications">body</Dialog>);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toBeInTheDocument();
    // h2, not h3: section labels inside the body are h3 (K1), so a h3 title
    // would make them siblings of the dialog's own name.
    expect(heading.tagName).toBe('H2');
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('titled dialogs use the selected 16px title and contained 8% divider', () => {
    render(<Dialog open onClose={() => {}} title="About">body</Dialog>);
    const header = panel().firstElementChild as HTMLElement;
    const title = screen.getByRole('heading', { name: 'About' });
    expect(title.className).toContain('text-base font-semibold');
    expect(header.className).toContain('min-h-14');
    expect(header.className).toContain('dialog-header');
    expect(header.className).not.toContain('border-b');
    // WHY: CSS and the rendered hook must agree; jsdom cannot compute mask or
    // gradient styles, so pin their exact shape alongside the real DOM classes.
    const css = readSource(join(__dirname, '..', 'src', 'renderer', 'components', 'ui', 'Dialog.css'));
    expect(css).toMatch(/\.dialog-header::after,\s*\[data-session-files-header\]::after\s*\{[^}]*left:\s*16px;[^}]*right:\s*16px;[^}]*var\(--edge\) 8%, var\(--edge\) 92%/);
  });

  it('only titled scrolling bodies mask content at both edges, leaving untitled bodies unchanged', () => {
    const { rerender } = render(<Dialog open onClose={() => {}} title="About">body</Dialog>);
    expect(panel().querySelector('.dialog-scroll')).toBeInTheDocument();
    const css = readSource(join(__dirname, '..', 'src', 'renderer', 'components', 'ui', 'Dialog.css'));
    expect(css).toMatch(/\.dialog-scroll,\s*\[data-session-files-scroll\]\s*\{[^}]*mask-image:\s*linear-gradient\(to bottom, transparent 0px,[^}]*transparent 100%\),\s*linear-gradient\(to right, #000 0%, transparent 4%, transparent 96%, #000 100%\);[^}]*mask-composite:\s*add/);
    expect(css).toMatch(/\.dialog-scroll\[data-fade-top="true"\],\s*\[data-session-files-scroll\]\[data-fade-top="true"\]\s*\{\s*--dialog-fade-top:\s*42px;/);
    expect(css).toMatch(/\.dialog-scroll\[data-fade-bottom="true"\],\s*\[data-session-files-scroll\]\[data-fade-bottom="true"\]\s*\{\s*--dialog-fade-bottom:\s*42px;/);
    expect(css).toMatch(/\.dialog-scroll::before,\s*\.dialog-scroll::after,\s*\[data-session-files-scroll\]::before,\s*\[data-session-files-scroll\]::after\s*\{\s*display:\s*none;/);
    rerender(<Dialog open onClose={() => {}}>untitled</Dialog>);
    expect(panel().querySelector('.scroll-fade')).toBeInTheDocument();
    expect(panel().querySelector('.dialog-scroll')).toBeNull();
  });

  it('keeps the review Today pane on the original full-width title and painted fade', () => {
    // WHY: once the shared Dialog changes, the pre-approval comparison still
    // needs to show the unchanged old popup rather than two identical panes.
    const demo = readSource(join(__dirname, '..', 'src', 'renderer', 'dev', 'workbench', 'mockups', 'PopupTaperDemo.css'));
    expect(demo).toMatch(/\[data-variant='today'\]\) \[role='dialog'\] > \.dialog-header\s*\{[^}]*border-bottom:\s*1px solid var\(--edge\)/);
    expect(demo).toMatch(/\[data-variant='today'\]\) \[role='dialog'\] > \.dialog-header::after\s*\{[^}]*display:\s*none/);
    expect(demo).toMatch(/\[data-variant='today'\]\) \[role='dialog'\] > \.dialog-header h2\s*\{[^}]*font-size:\s*0\.875rem;[^}]*font-weight:\s*700/);
    expect(demo).toMatch(/\[data-variant='today'\]\) \[role='dialog'\] > \.dialog-scroll\s*\{[^}]*mask-image:\s*none/);
    expect(demo).toMatch(/\[data-variant='today'\]\) \[role='dialog'\] > \.dialog-scroll::before,[\s\S]*?\.dialog-scroll::after\s*\{[^}]*display:\s*block/);
  });

  it('widths are named for what drives them, not t-shirt sizes', () => {
    // The names carry the derivation: a dialog is one of three CONTENT kinds,
    // and each kind's width falls out of reading measure or a control floor.
    // The previous sm/md/lg/xl ladder was fitted to the old values instead,
    // which is how `lg` ended up at 560px -- a width nothing had ever used.
    expect(Object.keys(DIALOG_WIDTHS).sort()).toEqual(['document', 'panel', 'prompt', 'wide']);
    expect(DIALOG_WIDTHS).toEqual({
      prompt: 'min(340px, 88vw)',    // two action buttons side by side: 322px floor
      panel: 'min(420px, 88vw)',     // 59ch at text-2xs, 51ch beside a control
      document: 'min(600px, 88vw)',  // 67ch at text-sm — long-form measure
      // Assistant settings (2026-09-05): a 176px page list beside a page that
      // keeps `document` width. 92vw, not 88: a workspace, not a card.
      wide: 'min(820px, 92vw)',
    });
  });

  it('every size holds the same proportion, not the same pixel height', () => {
    // Height is never a share of the viewport (80vh was ~700px on a laptop and
    // ~1730px on a 4K display -- a different object per monitor), and never one
    // flat number either: a flat cap gives a 340px prompt a 2.0x aspect and a
    // 600px document 1.13x, so it is least right where dialogs are narrowest.
    const RATIO = 1.4;
    for (const size of Object.keys(DIALOG_WIDTHS) as (keyof typeof DIALOG_WIDTHS)[]) {
      const w = Number(DIALOG_WIDTHS[size].match(/(\d+)px/)![1]);
      const h = Number(DIALOG_MAX_HEIGHTS[size].match(/(\d+)px/)![1]);
      // `wide` is the one landscape dialog (a page list beside a page): 1.4x of
      // 820 is taller than any laptop screen, so the viewport clamp would win
      // everywhere and the number would be fiction. It is capped BELOW its
      // width instead — see DIALOG_MAX_HEIGHTS.
      if (size === 'wide') expect(h, 'wide: landscape, capped below its width').toBeLessThan(w);
      else expect(h, `${size}: cap should be ${RATIO}x its ${w}px width`).toBe(Math.round(w * RATIO));
      // Always a constant scrim margin, never a viewport fraction.
      expect(DIALOG_MAX_HEIGHTS[size]).toContain('calc(100vh - 6rem)');
      expect(DIALOG_MAX_HEIGHTS[size]).not.toMatch(/\d+vh\)/);
    }
  });

  // jsdom's CSSOM re-serializes math functions on the way in — since jsdom 30,
  // `min(476px, calc(100vh - 6rem))` reads back as `min(476px, -6rem + 100vh)`
  // (jsdom 29 echoed the source text). Comparing the panel's style to the raw
  // constant therefore pins jsdom's spelling, not the Dialog's behaviour. So:
  // round-trip the constant through the SAME CSSOM and compare against that.
  // The non-empty check keeps this honest — if a future jsdom silently drops
  // the value (jsdom 29 did exactly that for `height`), '' === '' must not pass.
  function cssSerialized(prop: 'height' | 'maxHeight', value: string): string {
    const probe = document.createElement('div');
    probe.style[prop] = value;
    expect(probe.style[prop], `jsdom dropped ${prop}: ${value}`).not.toBe('');
    return probe.style[prop];
  }

  it('applies the cap for its own size and hugs content by default', () => {
    render(<Dialog open onClose={() => {}} title="X" size="prompt">body</Dialog>);
    expect(panel().style.maxHeight).toBe(cssSerialized('maxHeight', DIALOG_MAX_HEIGHTS.prompt));
    expect(panel().getAttribute('style')).not.toContain(`; height:`);
  });

  it('fill holds the full height for dialogs hosting sub-views', () => {
    // Appearance and Remote Access swap between an index and a detail view and
    // would otherwise resize under the cursor. "Always maximum" is the honest
    // version of the invented pixel height they used to set.
    render(<Dialog open onClose={() => {}} title="X" fill>body</Dialog>);
    expect(panel().style.height).toBe(cssSerialized('height', DIALOG_MAX_HEIGHTS.panel));
  });
});

// ── The adoption guard ──────────────────────────────────────────────────────
//
// WHY no source-text cases here any more (Plan B, 2026-09-16): "nothing in scope
// hand-rolls the shell" and "every exempted file still exists and still
// hand-rolls" are now the ast-grep rules no-hand-rolled-dialog-shell and
// no-hand-rolled-dialog-shell-exemption-still-applies (youcoded-dev
// scripts/ast-grep/rules/), which carry the scope and the NOT_DIALOGS
// exemptions this file used to hold.
