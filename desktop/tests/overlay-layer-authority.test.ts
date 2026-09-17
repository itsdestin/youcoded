import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import {
  RENDERER,
  readStripped,
  relPath,
  lineAt,
  assertScopeIsPopulated,
  assertPatternMatches,
} from './helpers/guard-scope';

// Guards for tranche 4 (changes 26 + 30): Overlay.tsx is the ONLY place a layer
// number is decided (design rule 11).
//
// These are source-text assertions rather than render assertions on purpose. The
// failure mode being guarded is a future session pasting a magic z-index back in
// to "fix" a stacking bug — which renders fine in isolation and only breaks the
// system-wide ordering. A render test of one component cannot see that; grepping
// the source can.


// Match a z-index utility only where it is APPLIED — inside a className string.
// The first draft of this test grepped raw source and failed on its own WHY
// comments, which name the values they replaced. The invariant is about what
// ships in the class list, not about what the prose is allowed to mention.
function appliedClassNames(src: string): string[] {
  return src.match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) ?? [];
}

function appliedZIndexes(src: string): string[] {
  return appliedClassNames(src).flatMap((c) => c.match(/\bz-\[\d+\]/g) ?? []);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('overlay layer authority', () => {
  it('ProjectView renders at the shared screen layer, not above overlays', () => {
    const src = readFileSync(join(RENDERER, 'components', 'project-view', 'ProjectView.tsx'), 'utf8');

    // Change 26: Marketplace, Library and ProjectView are ONE layer. At the old
    // z-[8000] a Toast/ContextMenu/AnchorTip fired while Projects was open
    // painted underneath it and was silently swallowed.
    // bg-panel since 2026-09-17: the view frames a bg-canvas pane under the
    // shared ScreenBand, like the page view. The layer is what this pins.
    expect(src).toContain('fixed inset-0 bg-panel z-40');
    expect(appliedZIndexes(src)).not.toContain('z-[8000]');
  });

  it('the three screens agree on their z-index', () => {
    const screens = [
      ['marketplace', 'MarketplaceScreen.tsx'],
      ['library', 'LibraryScreen.tsx'],
    ] as const;
    for (const [dir, file] of screens) {
      const src = readFileSync(join(RENDERER, 'components', dir, file), 'utf8');
      expect(src, `${file} must stay on the screen layer`).toContain('fixed inset-0 z-40');
    }
  });

  it('project-view has no hardcoded 9000-band z-index', () => {
    // ProjectHero's kebab menu used z-[9000] SOLELY to clear ProjectView's old
    // z-[8000]. With ProjectView at z-40 that value would float a narrow-mode
    // menu above every overlay in the app.
    for (const file of walk(join(RENDERER, 'components', 'project-view'))) {
      const applied = appliedZIndexes(readFileSync(file, 'utf8'));
      expect(
        applied.filter((z) => /^z-\[9\d{3}\]$/.test(z)),
        `${file} must not hardcode a 9000-band z-index`,
      ).toEqual([]);
    }
  });

  it('no renderer component hand-rolls a scrim (bg-black/N in a className)', () => {
    // Repo-wide closure of the class the named-file checks above kept missing:
    // UnsavedChangesDialog's `fixed inset-0 z-50 ... bg-black/40` shipped
    // uncaught (PR #298 review) precisely because this suite only scanned
    // specific files. Scrims come from <Scrim layer={N}> — theme-tinted
    // var(--scrim), never cold bg-black (react-renderer rule / renderer-chrome
    // doc). Scan every renderer source file so the NEXT hand-rolled scrim
    // fails here instead of in review.
    const files = walk(RENDERER);
    assertScopeIsPopulated(files);

    const SCRIM_TINT = /\bbg-black\/\d+\b/g;
    assertPatternMatches(
      SCRIM_TINT,
      'className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"',
      'a hand-rolled fixed-overlay scrim',
    );

    const offenders = files.flatMap((file) => {
      // readStripped: WHY comments in already-migrated files quote the exact
      // idiom they replaced (DiscardConfirmDialog names bg-black/40) — the
      // guard must read what ships, not the prose about it.
      const src = readStripped(file);
      return appliedClassNames(src).flatMap((c) => {
        const hits = c.match(SCRIM_TINT) ?? [];
        return hits.map((h) => `${relPath(file)}:${lineAt(src, src.indexOf(c))} ${h}`);
      });
    });

    expect(
      offenders,
      'Hand-rolled scrim tint. Use <Scrim layer={1|2|3|4}> from components/overlays/Overlay.tsx '
        + '(+ <OverlayPanel> for the panel) — see DiscardConfirmDialog.tsx for the pattern.',
    ).toEqual([]);
  });

  it('SettingsPanel has no hand-rolled overlay z-index', () => {
    // Change 30: seven `layer-surface fixed z-[61]` popups became <SettingsPopup>
    // and two identical `z-[9999]` donate modals became <DonateConfirm>.
    const applied = appliedZIndexes(readFileSync(join(RENDERER, 'components', 'SettingsPanel.tsx'), 'utf8'));
    expect(applied).not.toContain('z-[61]');
    expect(applied).not.toContain('z-[9999]');
  });
});
