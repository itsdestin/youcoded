// @vitest-environment jsdom
//
// Settings → Buddy Floater, in each of the four states the desktop can report
// (docs/active/design/2026-09-04-linux-buddy-helper/ §4's table).
//
// WHAT THIS FILE IS REALLY GUARDING. The buddy works today on Windows, macOS,
// Linux X11, and on Wayland sessions whose windows are really XWayland ones. For
// all of those the app moves its own windows and no helper is wanted — and the
// popup must look EXACTLY as it looked before any of this existed. An earlier
// draft keyed the whole helper UI off one flag, which on Linux X11 is false for
// the unrelated reason that KWin is not running Wayland: every KDE X11 user
// would have opened this popup to find "Not yet supported on this desktop" and a
// dead switch, instead of the buddy they have been using all along.
//
// | needed | supported | installed | what the user sees                        |
// |--------|-----------|-----------|-------------------------------------------|
// | false  |     —     |   false   | nothing about a helper; the plain switch   |
// | false  |     —     |   true    | ...plus Remove helper, and only that       |
// | true   |   false   |     —     | "Not yet supported on this desktop"        |
// | true   |   true    |     —     | the consent flow, then the switch          |
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { BuddyButton } from '../src/renderer/components/SettingsPanel';

// jsdom in this suite ships no localStorage (same gap buddy-linux-migration.test.ts
// documents), and the buddy switch persists through it.
const store = new Map<string, string>();
const localStorageShim = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'localStorage', {
    value: localStorageShim, configurable: true, writable: true,
  });
}

type Helper = { needed: boolean; supported: boolean; installed: boolean; reason?: string };
type ShowResult = { ok: boolean; reason?: string };

/** Row 1 — Windows, macOS, Linux X11, Wayland-through-XWayland. */
const NO_HELPER_WANTED: Helper = { needed: false, supported: false, installed: false };
/** Row 2 — added on Wayland, now logged into X11. Still in KDE's settings. */
const LEFTOVER_HELPER: Helper = { needed: false, supported: false, installed: true };
/**
 * Row 1 again, and the shape that was MISSING — the one probe Round 7 exists
 * for. A KDE Plasma 6 Wayland desktop where Electron is quietly running through
 * XWayland: KWin says Wayland, so `supported` is TRUE, but the app can move its
 * own windows, so `needed` is false. Every other row-1 fixture happens to carry
 * supported:false, which meant the `needed &&` half of the consent gate could
 * have been deleted with every test still green (B5 review, F4).
 */
const XWAYLAND: Helper = { needed: false, supported: true, installed: false };
/** Row 3 — GNOME, wlroots, Plasma 5. */
const UNSUPPORTED: Helper = { needed: true, supported: false, installed: false };
/** Row 4, before consent. */
const NEEDS_HELPER: Helper = { needed: true, supported: true, installed: false };
/** Row 4, after consent. */
const HELPER_IN_PLACE: Helper = { needed: true, supported: true, installed: true };

type Calls = { show: number; hide: number; install: number; remove: number };

function fakeClaude(
  helper: Helper | 'pending',
  opts: { show?: ShowResult; install?: boolean; remove?: boolean } = {},
): Calls {
  const calls: Calls = { show: 0, hide: 0, install: 0, remove: 0 };
  (window as any).claude = {
    // The Electron-only marker BuddyButton uses to decide it may render at all.
    window: {},
    getPlatform: async () => 'linux',
    buddy: {
      getStatus: async () => ({ dismissed: false, visible: true }),
      onStatusChanged: () => () => {},
      helperStatus: helper === 'pending'
        // A status that never arrives: the state the popup is in for the first
        // moments after it mounts, and the state a failed lookup leaves it in.
        ? () => new Promise<Helper>(() => {})
        : async () => helper,
      show: async () => { calls.show++; return opts.show ?? { ok: true }; },
      hide: async () => { calls.hide++; },
      installHelper: async () => { calls.install++; return { ok: opts.install ?? true }; },
      removeHelper: async () => { calls.remove++; return { ok: opts.remove ?? true }; },
    },
  };
  return calls;
}

/** Mounts the row and opens its popup. */
async function openPopup(): Promise<void> {
  render(<BuddyButton />);
  // The platform lookup and the helper lookup both resolve on microtasks; the
  // popup must be opened after them or every assertion reads the loading state.
  await waitFor(() => expect(screen.getByText('Buddy Floater')).toBeInTheDocument());
  fireEvent.click(screen.getByText('Buddy Floater'));
  await waitFor(() => expect(screen.getByText('Show buddy floater')).toBeInTheDocument());
}

const toggleSwitch = () => screen.queryByRole('switch', { name: 'Show buddy floater' });
const removeButton = () => screen.queryByRole('button', { name: 'Remove helper' });
const UNSUPPORTED_ROW = /Not yet supported on this desktop/;
const CONSENT_CARD = 'Let the buddy be moved?';

beforeEach(() => {
  localStorage.clear();
  delete (window as any).claude;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('row 1 — no helper is needed here', () => {
  it('says nothing about a helper at all', async () => {
    fakeClaude(NO_HELPER_WANTED);
    await openPopup();

    // The whole point: this is the popup as it was before the helper existed.
    expect(toggleSwitch()).toBeInTheDocument();
    expect(removeButton()).not.toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED_ROW)).not.toBeInTheDocument();
    expect(screen.queryByText(CONSENT_CARD)).not.toBeInTheDocument();
    expect(screen.getByText(/always-on-top mascot/)).toBeInTheDocument();
  });

  it('switches the buddy on with no question asked', async () => {
    const calls = fakeClaude(NO_HELPER_WANTED);
    await openPopup();

    fireEvent.click(toggleSwitch()!);

    await waitFor(() => expect(calls.show).toBe(1));
    expect(screen.queryByText(CONSENT_CARD)).not.toBeInTheDocument();
    expect(toggleSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('youcoded-buddy-enabled')).toBe('1');
  });

  it('reads Off, not "not yet supported", on the settings row', async () => {
    // The collapsed row is what a user sees WITHOUT opening the popup. On Linux
    // X11 the desktop answers supported:false — for the unrelated reason that
    // KWin is not Wayland — and reading that alone put "Not yet supported on
    // this desktop" in front of users whose buddy works.
    fakeClaude(NO_HELPER_WANTED);
    render(<BuddyButton />);

    await waitFor(() => expect(screen.getByText('Off')).toBeInTheDocument());
    expect(screen.queryByText(UNSUPPORTED_ROW)).not.toBeInTheDocument();
  });
});

describe('row 2 — no helper needed, but one is still installed', () => {
  it('shows Remove helper and nothing else about the helper', async () => {
    // R10 promises the helper can be taken out again "any time, from the buddy's
    // own settings". Someone who added it on Wayland and then logged into X11
    // would otherwise have no way back out but hand-editing a KDE config file.
    fakeClaude(LEFTOVER_HELPER);
    await openPopup();

    expect(removeButton()).toBeInTheDocument();
    // ...and nothing else: no consent card, no unsupported row, and the switch
    // is the ordinary one, because the buddy works fine here without a helper.
    expect(screen.queryByText(CONSENT_CARD)).not.toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED_ROW)).not.toBeInTheDocument();
    expect(toggleSwitch()).toBeInTheDocument();
  });

  it('removing it does not switch off a buddy that never needed it', async () => {
    const calls = fakeClaude(LEFTOVER_HELPER);
    localStorage.setItem('youcoded-buddy-enabled', '1');
    await openPopup();

    fireEvent.click(removeButton()!);

    await waitFor(() => expect(removeButton()).not.toBeInTheDocument());
    expect(calls.remove).toBe(1);
    expect(calls.hide).toBe(0);
    expect(localStorage.getItem('youcoded-buddy-enabled')).toBe('1');
  });
});

describe('row 3 — a helper is needed and cannot work here', () => {
  it('is read-only and says so', async () => {
    fakeClaude(UNSUPPORTED);
    await openPopup();

    // Twice over: the collapsed settings row reads it too, which is how a user
    // sees it without opening anything.
    expect(screen.getAllByText(UNSUPPORTED_ROW)).toHaveLength(2);
    expect(screen.getByText(/other desktops do not let apps place their own windows/))
      .toBeInTheDocument();
    // No switch to flip: offering one would be an action that does nothing.
    expect(toggleSwitch()).not.toBeInTheDocument();
    expect(removeButton()).not.toBeInTheDocument();
  });
});

describe('row 4 — a helper is needed and can work here', () => {
  it('asks before adding anything to the desktop (R1-R3)', async () => {
    const calls = fakeClaude(NEEDS_HELPER);
    await openPopup();

    fireEvent.click(toggleSwitch()!);

    await waitFor(() => expect(screen.getByText(CONSENT_CARD)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Add helper' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    // Nothing has happened to the desktop yet, and no buddy has appeared.
    expect(calls.install).toBe(0);
    expect(calls.show).toBe(0);
  });

  it('shows Remove helper once the helper is in place', async () => {
    fakeClaude(HELPER_IN_PLACE);
    await openPopup();

    expect(toggleSwitch()).toBeInTheDocument();
    expect(removeButton()).toBeInTheDocument();
    expect(screen.queryByText(CONSENT_CARD)).not.toBeInTheDocument();
  });
});

describe('the status is still unknown', () => {
  it('leaves the switch alone rather than inventing a state', async () => {
    // A lookup that has not answered yet must not be read as "unsupported": the
    // desktop that cannot answer is most often one where nothing is needed, and
    // main refuses the buddy on its own if it turns out one is (design §5).
    fakeClaude('pending');
    await openPopup();

    expect(toggleSwitch()).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED_ROW)).not.toBeInTheDocument();
    expect(removeButton()).not.toBeInTheDocument();
  });
});

describe('the app refuses to show the buddy (design §5)', () => {
  it('does not leave the switch sitting in the on position', async () => {
    // A switch that reads "on" with nothing on the desktop is a switch that
    // lies, and there is no way for the user to tell which is true.
    const calls = fakeClaude(NO_HELPER_WANTED, {
      show: { ok: false, reason: 'The buddy needs its KDE helper on this desktop, and the helper is not running.' },
    });
    await openPopup();

    fireEvent.click(toggleSwitch()!);

    await waitFor(() => expect(toggleSwitch()).toHaveAttribute('aria-checked', 'false'));
    expect(calls.show).toBe(1);
    expect(localStorage.getItem('youcoded-buddy-enabled')).toBe('0');
  });

  it('shows the desktop\'s own reason, word for word', async () => {
    // Never a guess made in the renderer (docs/error-message-standards.md): the
    // process that refused is the only one that knows why.
    const reason = 'KWin is not running a Wayland session.';
    fakeClaude(NO_HELPER_WANTED, { show: { ok: false, reason } });
    await openPopup();

    fireEvent.click(toggleSwitch()!);

    await waitFor(() => expect(screen.getByText(reason)).toBeInTheDocument());
  });
});

describe('the two gates that would otherwise survive deletion', () => {
  it('asks no question on XWayland, where KDE supports a helper but none is needed', async () => {
    // If the consent gate lost its `needed &&` half, THIS is the user who would
    // suddenly be asked to change their desktop settings for a buddy that
    // already works — and be refused one if they said no.
    const calls = fakeClaude(XWAYLAND);
    render(<BuddyButton />);
    fireEvent.click(screen.getByRole('button', { name: /buddy floater/i }));
    await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy());
    expect(screen.queryByText(/Let the buddy be moved/i)).toBeNull();
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.queryByText(/Let the buddy be moved/i)).toBeNull();
    await waitFor(() => expect(calls.show).toBe(1));
    expect(calls.install).toBe(0);
  });

  it('switches the buddy off when the helper it depends on is removed', async () => {
    // R10's threshold is "Remove helper takes it out of KDE's settings AND the
    // buddy switches off". Only the negative half (row 2, a buddy that never
    // needed a helper is left alone) was pinned.
    localStorage.setItem('youcoded-buddy-enabled', '1');
    const calls = fakeClaude(HELPER_IN_PLACE);
    render(<BuddyButton />);
    fireEvent.click(screen.getByRole('button', { name: /buddy floater/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /remove helper/i })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /remove helper/i }));
    await waitFor(() => expect(calls.remove).toBe(1));
    await waitFor(() => expect(calls.hide).toBe(1));
    expect(localStorage.getItem('youcoded-buddy-enabled')).toBe('0');
  });
});
