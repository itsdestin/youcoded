// @vitest-environment jsdom
// desktop/tests/dialog-shell.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Dialog, DIALOG_WIDTHS, DIALOG_MAX_HEIGHTS } from '../src/renderer/components/ui/Dialog';
import { inScopeFiles, RENDERER, assertScopeIsPopulated } from './helpers/guard-scope';

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
// Source-text, unlike the render assertions above: the failure mode is a future
// session hand-rolling createPortal + Scrim + OverlayPanel in a NEW file, which
// looks fine and only shows up as another bespoke width months later. 49 files
// did exactly that against 7 using the old shell.
//
// SCOPE. The first version of this guard read only `components/*.tsx`, which
// could not see App.tsx or ANY subdirectory -- so it could not enforce even the
// scope the plan declared (which named `ui/` and `development/`). Two App-level
// confirms and all three development popups were sitting outside it, unmigrated
// and unflagged. Scope is now explicit and walked, not implied by a glob.
//
// IN: App.tsx, components/*.tsx, components/development, components/ui.
// OUT (recorded residue, different surfaces with their own visual language):
// marketplace, project-view, game, git, tags, context-menu, buddy.



// Named, with the reason each is NOT a dialog. An exemption you cannot see is
// how the inconsistency this test exists to stop got in.
//
// This list started with FOUR entries and two of them were wrong. SyncPanel and
// QuickChips were both written off as "anchored popover positioned against its
// trigger" on the strength of `className="fixed ..."` alone -- but their style
// objects said `top: 50%, left: 50%, transform: translate(-50%, -50%)`. They
// were centered modals with bespoke widths (520px, 420px) and, in SyncPanel's
// case, exactly the fixed height the shell exists to ban.
//
// The lesson is not "check twice". It is that an exemption written with a
// confident-sounding reason is MORE dangerous than a bare one: the reason is
// what stops the next reader from re-deriving it. Anything added here needs
// evidence from the element's computed position, not from a class string.
const NOT_DIALOGS: Record<string, string> = {
  'ResumeBrowser.tsx': 'L1 drawer — layer={1}, slides from the edge, never centered',
  'ZoomOverlay.tsx': 'L4 system indicator pinned top-right (fixed top-16 right-4), no scrim',
  // components/ui primitives that own an OverlayPanel for a NON-dialog surface.
  'AnchorTip.tsx': 'tooltip anchored to its trigger via computed coordinates',
  'Select.tsx': 'dropdown list anchored under its trigger',
  'Toast.tsx': 'transient notification docked to a screen edge, no scrim',
  // Evidence, not a class string: ZoomPill sets NO position of its own — it has
  // no `fixed`/`absolute`, no top/left, and no transform anywhere in the file.
  // Its one caller (ImageView) anchors it `absolute top-2 left-2` inside the
  // viewer's own relative box. Corner-anchored, no scrim, never centered, never
  // modal — the same shape as ZoomOverlay above, which it shares its look with.
  'ZoomPill.tsx': 'in-pane zoom control anchored to a corner by its caller, no scrim',
  // Evidence, not a class string: the wrapper's top/left come from
  // getBoundingClientRect() of the [data-view-toggle] element, there is no
  // translate(-50%, -50%) anywhere in the file, and it renders no <Scrim>. Same
  // shape as AnchorTip above — a bubble pinned to a control it points at.
  'ViewToggleHint.tsx': 'coach mark anchored to the chat/terminal toggle via computed coordinates',
  // Evidence, not a class string: `pos` comes from getBoundingClientRect() of the
  // mic button (its own triggerRef), the transform is translate(-100%, -100%) — up
  // from the trigger's top edge, never -50%/-50% — and the file renders no <Scrim>.
  // The same shape as AnchorTip and ViewToggleHint: a bubble pinned above the
  // control it belongs to (the first-run download card, the download progress,
  // the "no microphone" reason).
  'VoiceButton.tsx': 'first-run / download / no-mic card anchored above the mic via computed coordinates',
  // Evidence, not a class string: position comes from placeBubble() against the
  // trigger's own getBoundingClientRect(), it is written as plain left/top with
  // no translate anywhere in the file, and it renders no <Scrim> — it is
  // `pointer-events-none`, so it cannot even be clicked. The same shape as
  // AnchorTip, whose positioning it shares: a bubble pinned to the control it
  // describes.
  'Tooltip.tsx': 'hover hint anchored to its control via computed coordinates',
};

describe('dialog shell adoption', () => {
  it('this guard can see what it claims to cover', () => {
    // A source-text guard that matches nothing PASSES and reads as clean.
    // Three of this workstream's worst misses were exactly that.
    assertScopeIsPopulated(inScopeFiles());
  });

  it('nothing in scope hand-rolls the shell', () => {
    const offenders = inScopeFiles()
      .filter((p) => !(p.split(/[\\/]/).pop()! in NOT_DIALOGS))
      .filter((p) => !p.endsWith(join('ui', 'Dialog.tsx')))
      .filter((p) => readFileSync(p, 'utf8').includes('<OverlayPanel'))
      .map((p) => p.replace(RENDERER, ''));
    expect(
      offenders,
      'Centered modals go through <Dialog>. It owns scrim, centering, the width '
        + 'ladder, the header and the scroll body — the last of which two of the old '
        + "shell's seven callers got wrong, producing dialogs that clipped with no way to scroll.",
    ).toEqual([]);
  });

  it('every exempted file still exists and still hand-rolls', () => {
    // An exemption is a liability once it stops being true: if one of these is
    // migrated or deleted, this list should shrink rather than quietly rot.
    const byName = new Map(inScopeFiles().map((p) => [p.split(/[\\/]/).pop()!, p]));
    for (const [file, why] of Object.entries(NOT_DIALOGS)) {
      const abs = byName.get(file);
      expect(abs, `${file} is exempted but no longer in scope — drop it`).toBeTruthy();
      const src = readFileSync(abs!, 'utf8');
      expect(src.includes('<OverlayPanel'), `${file} (${why}) no longer hand-rolls — drop it from NOT_DIALOGS`).toBe(true);
    }
  });
});
