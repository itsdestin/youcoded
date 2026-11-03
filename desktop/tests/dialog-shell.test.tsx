// @vitest-environment jsdom
// desktop/tests/dialog-shell.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Dialog, DIALOG_MAX_HEIGHTS } from '../src/renderer/components/ui/Dialog';
import { EscCloseProvider } from '../src/renderer/hooks/use-esc-close';

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
    const body = panel().querySelector('.scroll-mask');
    expect(body, 'Dialog must render its own scroll region').not.toBeNull();
    // flex-1 is what gives the scroll region a bounded height inside the column.
    // Without it the body grows to fit content and overflow never engages.
    expect(body!.className).toContain('flex-1');
  });

  it('scrollBody={false} lets a caller own its whole surface', () => {
    // Appearance hands the panel to ThemeScreen; Remote access swaps in
    // SettingsExplainer. Those own their own scroll regions.
    render(<Dialog open onClose={() => {}} scrollBody={false}><p>custom</p></Dialog>);
    expect(panel().querySelector('.scroll-mask')).toBeNull();
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

  it('every body, titled or not, has a scroll region', () => {
    const { rerender } = render(<Dialog open onClose={() => {}} title="About">body</Dialog>);
    const titled = panel().querySelector('.dialog-scroll');
    expect(titled).toBeInTheDocument();
    expect(titled!.className).toContain('scroll-mask');
    rerender(<Dialog open onClose={() => {}}>untitled</Dialog>);
    expect(panel().querySelector('.scroll-mask')).toBeInTheDocument();
    expect(panel().querySelector('.dialog-scroll')).toBeNull();
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
    // Appearance and Remote access swap between an index and a detail view and
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

// Escape closes a Dialog — the shell's job, not each caller's. Ten dialogs never
// registered (2026-09-26): Escape did nothing (quit warning, first-time warnings), or
// closed the panel UNDER the dialog and left the dialog up (Donate, Assistant settings,
// Create a page), or closed two layers at once (Manage tags). A sweep of every shoot
// screen found none left after this.
describe('Dialog — Escape', () => {
  it('closes the dialog, and only the top one', async () => {
    const { EscCloseProvider } = await import('../src/renderer/hooks/use-esc-close');
    const { fireEvent } = await import('@testing-library/react');
    const under = vi.fn(); const over = vi.fn();
    render(
      <EscCloseProvider>
        <Dialog open onClose={under} title="Under"><p>a</p></Dialog>
        <Dialog open onClose={over} title="Over" layer={3}><p>b</p></Dialog>
      </EscCloseProvider>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(over).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
  });

  it('a caller with its own layered Escape keeps it (its entry sits above the shell)', async () => {
    const { EscCloseProvider, useEscClose } = await import('../src/renderer/hooks/use-esc-close');
    const { fireEvent } = await import('@testing-library/react');
    const close = vi.fn(); const peel = vi.fn();
    function Caller() {
      useEscClose(true, peel);   // e.g. "close the sub-view first"
      return <Dialog open onClose={close} title="Layered"><p>c</p></Dialog>;
    }
    render(<EscCloseProvider><Caller /></EscCloseProvider>);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(peel).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });
});

// A popup opened over another popup on the same layer must put its scrim (the blur and dim)
// ABOVE the first popup's panel (final-review#CT-8, Destin: "these popups are stacking with no
// blur"). Both used to share the same two numbers, so the first panel (61) sat above the second
// scrim (60) and stayed sharp.
const z = (el: Element | null | undefined) => Number((el as HTMLElement | null)?.style.zIndex ?? NaN);

describe('a popup over a popup', () => {
  it('lifts the second scrim above the first popup panel, and gives the depth back on close', () => {
    const { rerender } = render(
      <EscCloseProvider>
        <Dialog open onClose={() => {}} title="First" noScreen="test">first</Dialog>
        <Dialog open onClose={() => {}} title="Second" noScreen="test">second</Dialog>
      </EscCloseProvider>,
    );
    const scrims = document.querySelectorAll('.layer-scrim');
    const panels = document.querySelectorAll('[role="dialog"]');
    expect(scrims).toHaveLength(2);
    const firstContent = panels[0].parentElement; // the centring wrapper carries the z-index
    const secondContent = panels[1].parentElement;
    expect(z(scrims[1])).toBeGreaterThan(z(firstContent));
    expect(z(secondContent)).toBeGreaterThan(z(scrims[1]));

    // Close both, open one: it is back at the base numbers.
    rerender(<EscCloseProvider><Dialog open={false} onClose={() => {}} title="First" noScreen="test">x</Dialog></EscCloseProvider>);
    rerender(<EscCloseProvider><Dialog open onClose={() => {}} title="Again" noScreen="test">again</Dialog></EscCloseProvider>);
    expect(z(document.querySelector('.layer-scrim'))).toBe(z(scrims[0]));
  });
});
