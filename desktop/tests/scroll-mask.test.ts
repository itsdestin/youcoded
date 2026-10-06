import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, it, expect } from 'vitest';

// New scrolling lists use the MASKED fade (`.scroll-mask`), not the painted band (`.scroll-fade`).
//
// WHY (project-switcher friction, proposal 9): `useScrollFade`'s name points at `.scroll-fade`,
// and the project switcher's first draft took it — its `::before` band became a flex item with a
// negative margin and the list opened already scrolled ~60px. Destin has asked for the masked
// fade twice (the sessions menu, the project switcher): the content itself fades, so it blends
// into wallpaper and glass instead of painting a panel-coloured strip over it. Both read the
// same hook, so moving a list is a one-word change.
//
// A RATCHET: the files below still use the painted band and may keep it; a file not listed may
// not start. When a file moves to `.scroll-mask`, delete its line (the second test says which).
// Why a test and not an ast-grep rule: a rule can ignore the listed files, but it cannot fail
// when a listed file stops using the class, so the list could never shrink.
const SRC = join(__dirname, '..', 'src', 'renderer');
const STILL_PAINTED = new Set([
  'components/assistant-settings/AssistantSettings.tsx',
  'components/CommandDrawer.tsx',
  'components/development/ContributionWalkthrough.tsx',
  'components/FolderSwitcher.tsx',
  'components/InputBar.tsx',
  'components/QuickChips.tsx',
  'components/ResumeBrowser.tsx',
  'components/SessionDrawer.tsx',
  'components/SessionStrip.tsx',
  'components/SettingsPanel.tsx',
  'components/SyncPanel.tsx',
  'components/SyncSetupWizard.tsx',
  'components/ui/Dialog.tsx',
  'components/UnsavedBeforeQuit.tsx',
]);
// The class word itself, not `scroll-fade-x` (the sideways chip-row twin) or `--scroll-fade-pad`.
const PAINTED = /['"` ]scroll-fade(?![-\w])/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') && !full.endsWith('.test.tsx') ? [full] : [];
  });
}

describe('new lists use the masked fade', () => {
  const users = walk(SRC).filter((f) => PAINTED.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f).split('\\').join('/'));

  it('no new file takes the painted .scroll-fade', () => {
    const added = users.filter((f) => !STILL_PAINTED.has(f));
    expect(added, `These files use the painted .scroll-fade band:\n  ${added.join('\n  ')}\n\n` +
      'Use .scroll-mask instead (styles/scroll-mask.css) — same useScrollFade hook, the content itself fades. ' +
      'The painted band paints a panel-coloured strip over wallpaper/glass, and in a flex column its ::before ' +
      'is a flex item that opens the list already scrolled.').toEqual([]);
  });

  it('the list only shrinks: a file that moved to .scroll-mask leaves it', () => {
    expect(users.length, 'non-vacuity: the scan found the known callers').toBeGreaterThan(5);
    const moved = [...STILL_PAINTED].filter((f) => !users.includes(f));
    expect(moved, `No longer use .scroll-fade — delete their lines from STILL_PAINTED:\n  ${moved.join('\n  ')}`).toEqual([]);
  });
});
