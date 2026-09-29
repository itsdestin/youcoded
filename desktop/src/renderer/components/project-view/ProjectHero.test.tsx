// @vitest-environment jsdom
//
// Pins the hero's action collapse. The management actions (rename, the sync
// action, and the destructive one) moved off the card and behind a cog menu;
// only "New conversation" stays visible. These tests exist so a later change
// can't quietly strand one of them with no entry point — which is exactly how
// Connect 4 became unreachable on narrow viewports.
//
// "Open in File Explorer" and "Open <owner>/<name> on GitHub" are NOT part of
// that collapse — they're inline links on the path/repo row instead, rendered
// at every width (2026-07-23), so they're covered separately below rather
// than through the cog-menu tests.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ProjectHero } from './ProjectHero';

vi.mock('../../platform', () => ({ getPlatform: () => 'electron' }));

// The collapse is narrow-ONLY, so every test has to state which width it's
// describing. jsdom has no matchMedia at all, so useNarrowViewport would throw
// on the optional-call fallback path without this.
function setViewport(narrow: boolean) {
  (window as any).matchMedia = (query: string) => ({
    matches: narrow,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

const baseProject = { path: '/home/d/proj', name: 'proj' } as any;
// 2026-07-23: `artifacts` dropped from HeroStats when the Artifacts tab merged
// into Files — this fixture no longer carries it (see ProjectHero.tsx).
const baseStats = {
  files: 2, conversations: 3, contextFiles: 4, activeLabel: 'today',
};

function renderHero(over: Record<string, any> = {}) {
  const props = {
    project: baseProject,
    displayName: null,
    stats: baseStats,
    repo: null,
    onOpenSwitcher: vi.fn(),
    onNewConversation: vi.fn(),
    sync: null,
    onTurnOnSync: vi.fn(),
    onSyncNow: vi.fn(),
    onRenamed: vi.fn(),
    canRemove: true,
    onRemove: vi.fn(),
    ...over,
  };
  return { props, ...render(<ProjectHero {...(props as any)} />) };
}

const openCog = () => fireEvent.click(screen.getByLabelText('Project settings'));
const menuLabels = () =>
  within(screen.getByRole('menu')).getAllByRole('menuitem').map(b => b.textContent ?? '');

beforeEach(() => {
  cleanup();
  setViewport(true); // narrow by default; the desktop block opts out
  (window as any).claude = {
    shell: { openPath: vi.fn(), openExternal: vi.fn() },
    // setDescription joins rename on the folders surface, and syncSpaces gains
    // its own setProjectDescription — the description commit picks between the
    // two, so BOTH have to exist on the stub or the routing test can't tell a
    // wrong branch from a missing mock.
    folders: {
      rename: vi.fn().mockResolvedValue(undefined),
      setDescription: vi.fn().mockResolvedValue(true),
    },
    syncSpaces: { setProjectDescription: vi.fn().mockResolvedValue(undefined) },
  };
});

// The description slot. Its commit picks between two DIFFERENT storage channels
// based on whether the project syncs, and a wrong branch fails silently: the
// local-folder channel finds no matching entry for a synced project, returns
// false, and ProjectHero's `.catch(() => {})` swallows it — the user types a
// description, the card refreshes, and their text is gone with no error. These
// tests are the only thing standing between that branch and a silent data loss.
describe('ProjectHero description', () => {
  beforeEach(() => setViewport(false));

  const syncedProps = {
    canRemove: false,
    // syncedFolderName is recovered from the `project:` space id — that prefix
    // is what marks a project as synced, so the routing hinges on it.
    sync: { dot: { color: 'green' }, spaceId: 'project:proj', lastSynced: null, errorMessage: null, stopped: false },
  };

  const editDescription = (text: string) => {
    const field = screen.getByLabelText('Project description') as HTMLInputElement;
    fireEvent.change(field, { target: { value: text } });
    fireEvent.keyDown(field, { key: 'Enter' });
  };

  it('renders the description on the card', () => {
    renderHero({ description: 'notes about this project' });
    expect(screen.getByText(/notes about this project/)).toBeTruthy();
    // The "add" affordance must be gone once there IS one, or the card offers
    // two entry points for the same field.
    expect(screen.queryByText('Add a description')).toBeNull();
  });

  it('offers the add affordance when there is no description', () => {
    renderHero({ description: null });
    expect(screen.getByText('Add a description')).toBeTruthy();
  });

  it('opens the editor from the add affordance', () => {
    renderHero({ description: null });
    expect(screen.queryByLabelText('Project description')).toBeNull();
    fireEvent.click(screen.getByText('Add a description'));
    expect(screen.getByLabelText('Project description')).toBeTruthy();
  });

  // THE routing branch, synced side. Must go to the registry channel keyed by
  // the FOLDER NAME (the immutable sync identity), never the local path.
  it('routes a synced project through syncSpaces.setProjectDescription', async () => {
    renderHero({ ...syncedProps, description: null });
    fireEvent.click(screen.getByText('Add a description'));
    editDescription('synced words');
    const c = (window as any).claude;
    expect(c.syncSpaces.setProjectDescription).toHaveBeenCalledWith('proj', 'synced words');
    expect(c.folders.setDescription).not.toHaveBeenCalled();
  });

  // THE routing branch, local side. Must go to the saved-folders channel keyed
  // by PATH — there is no registry record to write for an unsynced folder.
  it('routes a plain local folder through folders.setDescription', async () => {
    renderHero({ description: null }); // sync: null → not a synced project
    fireEvent.click(screen.getByText('Add a description'));
    editDescription('local words');
    const c = (window as any).claude;
    expect(c.folders.setDescription).toHaveBeenCalledWith('/home/d/proj', 'local words');
    expect(c.syncSpaces.setProjectDescription).not.toHaveBeenCalled();
  });

  // An unchanged value must write nothing — the setters skip no-op writes to
  // avoid watcher churn, and the UI shouldn't undo that by always calling.
  it('writes nothing when the text is unchanged', () => {
    renderHero({ ...syncedProps, description: 'same' });
    fireEvent.click(screen.getByTitle('Edit description'));
    editDescription('same');
    expect((window as any).claude.syncSpaces.setProjectDescription).not.toHaveBeenCalled();
  });
});

// The collapse is a narrow-viewport accommodation, NOT a redesign. Desktop has
// the room for every action and must keep them one click away.
describe('ProjectHero on desktop', () => {
  beforeEach(() => setViewport(false));

  it('shows the management actions inline, with no cog', () => {
    renderHero();
    expect(screen.queryByLabelText('Project settings')).toBeNull();
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(screen.getByText('Remove from YouCoded')).toBeTruthy();
    expect(screen.getByText('New conversation')).toBeTruthy();
  });

  it('keeps the sync action inline on the card', () => {
    renderHero({
      canRemove: false,
      sync: { dot: { color: 'green' }, spaceId: 'project:x', lastSynced: null, errorMessage: null, stopped: false },
    });
    // MOCKUP (2026-08-05): the action moved into the sync pill's popover, so
    // the assertion is now "pill on the card, action one click inside it".
    // The guard's INTENT is unchanged and still enforced — the sync action is
    // reachable from the card itself, never only from the narrow-only cog.
    const pill = screen.getByLabelText('Sync status: Synced');
    expect(pill).toBeTruthy();
    fireEvent.click(pill);
    expect(screen.getByText('Sync now')).toBeTruthy();
  });

  // The state whose action had no home in the refresh-icon shape. Pinned so a
  // later trim can't strand "Turn on sync" behind the narrow cog again.
  it('offers Turn on sync for an unsynced project', () => {
    renderHero({
      canRemove: false,
      sync: { dot: { color: 'gray' }, spaceId: null, lastSynced: null, errorMessage: null, stopped: false },
    });
    fireEvent.click(screen.getByLabelText('Sync status: Only on this computer'));
    expect(screen.getByText('Turn on sync for this project')).toBeTruthy();
  });

  // Stop-syncing moved from the actions row into the sync popover (2026-08-05).
  // It must still ARM the on-card confirm rather than acting immediately — the
  // consequence copy is too long for a 288px popover, and stopping is permanent.
  it('arms the stop-syncing confirm from the sync popover', () => {
    renderHero({
      canRemove: false,
      sync: { dot: { color: 'green' }, spaceId: 'project:proj', lastSynced: null, errorMessage: null, stopped: false },
    });
    // Not on the actions row any more — the popover is the only entry point.
    expect(screen.queryByText('Stop syncing')).toBeNull();
    fireEvent.click(screen.getByLabelText('Sync status: Synced'));
    fireEvent.click(screen.getByText('Stop syncing'));
    expect(screen.getByText(/no longer sync between them/)).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  // A stopped project is a permanent tombstone — never re-offer the action.
  it('hides Stop syncing once the project is already stopped', () => {
    renderHero({
      canRemove: false,
      sync: { dot: { color: 'gray' }, spaceId: 'project:proj', lastSynced: null, errorMessage: null, stopped: true },
    });
    fireEvent.click(screen.getByLabelText('Sync status: Sync stopped'));
    expect(screen.queryByText('Stop syncing')).toBeNull();
  });

  // The red state must surface the ENGINE's message, never a hardcoded guess
  // (error-message-standards.md).
  it('surfaces the real sync error message in the popover', () => {
    renderHero({
      canRemove: false,
      sync: {
        dot: { color: 'red' }, spaceId: 'project:x', lastSynced: null,
        errorMessage: 'remote contains work you do not have locally', stopped: false,
      },
    });
    fireEvent.click(screen.getByLabelText('Sync status: Sync problem'));
    expect(screen.getByText(/remote contains work you do not have locally/)).toBeTruthy();
  });
});

describe('ProjectHero action collapse (narrow)', () => {
  it('keeps New conversation on the card and nothing else', () => {
    renderHero();
    expect(screen.getByText('New conversation')).toBeTruthy();
    // The old always-visible management buttons are gone from the card body.
    expect(screen.queryByText('Rename')).toBeNull();
    expect(screen.queryByText('Remove from YouCoded')).toBeNull();
  });

  it('collapses rename and remove into the cog menu', () => {
    renderHero();
    openCog();
    const labels = menuLabels();
    expect(labels).toContain('Rename');
    expect(labels).toContain('Remove from YouCoded');
  });

  // 'Open in File Explorer' / 'Open <owner>/<name> on GitHub' used to be cog
  // rows too — they're gone from the menu because the path/repo row (below)
  // covers the same actions at every width, cog included.
  it('does not duplicate the path/repo links in the cog menu', () => {
    renderHero({ repo: { webUrl: 'https://github.com/a/b', owner: 'a', name: 'b' } });
    openCog();
    const labels = menuLabels();
    expect(labels.some(l => /File Explorer/.test(l))).toBe(false);
    expect(labels.some(l => /GitHub|repository/.test(l))).toBe(false);
  });

  // One sync ACTION per sync state — the cog no longer carries it (2026-08-06),
  // so the guard now runs the other way: prove the cog stays silent AND the
  // pill popover still offers the action, at narrow width, for every state.
  // The popover trigger sits in the same (syncPill || !narrow) row as before,
  // so it survives the narrow collapse — this is what keeps each state's one
  // action from being stranded.
  // cogLabel is the row this task deletes; popoverLabel is what the popover
  // actually renders for that state — the red state's copy already differed
  // ("Try syncing again" on the old cog row vs. "Try again" on the popover
  // button, ProjectHero.tsx's syncPill definition) before this task touched
  // either, so the two are asserted separately rather than assumed equal.
  it.each([
    ['green', 'sp', 'Sync now', 'Sync now'],
    ['red', 'sp', 'Try syncing again', 'Try again'],
    ['gray', null, 'Turn on sync for this project', 'Turn on sync for this project'],
  ])('does not offer the %s-state sync action from the cog, but the pill popover does', (color, spaceId, cogLabel, popoverLabel) => {
    renderHero({
      canRemove: false,
      sync: { dot: { color }, spaceId, lastSynced: null, errorMessage: null, stopped: false },
    });
    openCog();
    expect(menuLabels()).not.toContain(cogLabel);
    // fireEvent bypasses visual hit-testing, so the still-open cog portal
    // doesn't block this click — no need to close it first.
    fireEvent.click(screen.getByLabelText(/^Sync status:/));
    expect(screen.getByText(popoverLabel)).toBeTruthy();
  });

  // Was routed through the cog; now the pill popover is the only entry point
  // (2026-08-06) — same assertion, new (and only remaining) trigger, still
  // exercised at narrow width to prove it isn't desktop-only.
  it('routes the sync action to onSyncNow with the space id, via the pill popover', () => {
    const onSyncNow = vi.fn();
    renderHero({
      onSyncNow, canRemove: false,
      sync: { dot: { color: 'green' }, spaceId: 'project:x', lastSynced: null, errorMessage: null, stopped: false },
    });
    fireEvent.click(screen.getByLabelText('Sync status: Synced'));
    fireEvent.click(screen.getByText('Sync now'));
    expect(onSyncNow).toHaveBeenCalledWith('project:x');
  });

  it('swaps the name heading for a field when renaming', () => {
    renderHero();
    expect(screen.queryByLabelText('Project nickname')).toBeNull();
    openCog();
    fireEvent.click(screen.getByText('Rename'));
    expect(screen.getByLabelText('Project nickname')).toBeTruthy();
  });

  // The cog is management-only now (2026-08-06) — every sync action, including
  // Stop syncing, lives behind the pill popover at every width instead, so
  // there is no second entry point left to pin here. Rename stays as proof the
  // cog itself still works, not just that it's emptied of sync rows.
  it('leaves sync actions to the pill popover, not the cog', () => {
    renderHero({
      canRemove: false,
      sync: { dot: { color: 'green' }, spaceId: 'project:proj', lastSynced: null, errorMessage: null, stopped: false },
    });
    openCog();
    expect(screen.queryByText('Stop syncing')).toBeNull();
    expect(screen.queryByText('Sync now')).toBeNull();
    expect(screen.getByText('Rename')).toBeTruthy();
  });

  it('closes the menu after choosing an item', () => {
    renderHero();
    openCog();
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByText('Rename'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

// The path/repo row is NOT gated by useNarrowViewport — unlike the old
// "Open in File Explorer" / "Open repo" buttons (desktop-only / hidden below
// 640px), these links must stay reachable at every width. Covered at both
// widths on purpose; see the file-header note.
describe.each([
  ['desktop', false],
  ['narrow', true],
])('ProjectHero path/repo links (%s)', (_label, narrow) => {
  beforeEach(() => setViewport(narrow));

  it('opens the file explorer when the path is clicked', () => {
    renderHero();
    fireEvent.click(screen.getByTitle('Open in File Explorer'));
    expect((window as any).claude.shell.openPath).toHaveBeenCalledWith('/home/d/proj');
  });

  it('renders no repo link when the project has no web URL', () => {
    renderHero();
    expect(screen.queryByTitle(/on GitHub$/)).toBeNull();
  });

  it('opens the repo on GitHub when the repo slug is clicked', () => {
    renderHero({ repo: { webUrl: 'https://github.com/a/b', owner: 'a', name: 'b' } });
    fireEvent.click(screen.getByTitle('Open a/b on GitHub'));
    expect((window as any).claude.shell.openExternal).toHaveBeenCalledWith('https://github.com/a/b');
  });
});
