// @vitest-environment jsdom
//
// R12 + R13 of the Linux buddy helper contract
// (docs/active/design/2026-09-04-linux-buddy-helper/, §6).
//
// R12: "If your buddy is already on, it is hidden after the update until you turn
// it back on." R13: "The offer to add the helper waits in the buddy's settings; no
// dialog interrupts you after an update."
//
// The hazards this file pins, all of which a user would notice:
//  · running twice — the buddy the user just switched back on disappears again;
//  · running in the buddy's OWN windows, which share the same localStorage;
//  · running on a phone or a remote browser, where there is no buddy and every
//    buddy method throws;
//  · running AFTER the launch path reads the preference, which would re-open the
//    stuck buddy this migration exists to hide;
//  · running for a user whose buddy is NOT broken — a Linux X11 or XWayland
//    session, where the app moves its own windows and the buddy has always
//    worked. Hiding theirs would take away something that was fine, and the
//    switch that brings it back would greet them with a consent card for a
//    helper they do not need (design §4, revision 7).
import { describe, it, expect, beforeEach, vi } from 'vitest';

// jsdom in this suite ships NO localStorage — `window.localStorage` is undefined
// (the gap tests/app-resume-session-listener.test.ts already ran into), and on
// Node 26 the bare `localStorage` global is the runtime's own, disabled unless
// --localstorage-file is passed. The migration is a localStorage one-shot, so the
// test supplies a real one rather than mocking the thing under test.
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

type Calls = { show: number; helperStatus: number; installHelper: number; getPlatform: number };

type Helper = { needed: boolean; supported: boolean; installed: boolean };

/** A native-Wayland KDE session with no helper yet: the buddy appears and cannot
 *  be dragged. THE ONLY state R12 is for. */
const BROKEN_BUDDY: Helper = { needed: true, supported: true, installed: false };
/** The helper is already in the user's KDE settings, so the buddy works. */
const HELPER_IN_PLACE: Helper = { needed: true, supported: true, installed: true };
/** Windows, macOS, Linux X11, and Wayland sessions whose windows are really
 *  XWayland ones. The app moves its own windows; no helper is wanted. */
const NO_HELPER_WANTED: Helper = { needed: false, supported: false, installed: false };

/** The Electron-shaped bridge. `window` (window controls) is the marker the boot
 *  path uses to tell a real desktop app from a remote browser or Android.
 *
 *  `helper` is what the desktop answers about the buddy helper — the fact the
 *  migration now turns on. It defaults to the honest answer for the platform:
 *  a Linux session that needs a helper and has none, anything else not needing
 *  one at all. Pass 'throws' for a bridge that cannot answer. */
function installFakeClaude(
  platform: string,
  opts: { electron?: boolean; helper?: Helper | 'throws' } = {},
): Calls {
  const calls: Calls = { show: 0, helperStatus: 0, installHelper: 0, getPlatform: 0 };
  const helper = opts.helper ?? (platform === 'linux' ? BROKEN_BUDDY : NO_HELPER_WANTED);
  (window as any).claude = {
    ...(opts.electron === false ? {} : { window: {} }),
    getPlatform: async () => { calls.getPlatform++; return platform; },
    buddy: {
      show: async () => { calls.show++; return { ok: true }; },
      hide: async () => {},
      helperStatus: async () => {
        calls.helperStatus++;
        if (helper === 'throws') throw new Error('bridge not ready');
        return helper;
      },
      installHelper: async () => { calls.installHelper++; return { ok: true }; },
    },
  };
  return calls;
}

const ENABLED = 'youcoded-buddy-enabled';
const MARKER = 'youcoded-buddy-linux-hidden-once';

/** Loads App.tsx fresh at a given URL. `buddyMode` is read from the query string
 *  at module scope, so a buddy-window test has to re-import. */
async function loadApp(search = '') {
  window.history.replaceState({}, '', search ? `/?${search}` : '/');
  vi.resetModules();
  return import('../src/renderer/App');
}

beforeEach(() => {
  localStorage.clear();
  delete (window as any).claude;
});

describe('R12 — the one-time Linux buddy hide', () => {
  it('switches an already-on buddy off, once, on Linux', async () => {
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux');
    localStorage.setItem(ENABLED, '1');

    expect(await runBuddyLinuxHideMigration()).toBe('hid');
    expect(localStorage.getItem(ENABLED)).toBe('0');
    expect(localStorage.getItem(MARKER)).toBe('1');
  });

  it('never fires a second time — the buddy the user turns back on stays on', async () => {
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux');
    localStorage.setItem(ENABLED, '1');
    await runBuddyLinuxHideMigration();

    // The user goes to Settings and switches the buddy back on.
    localStorage.setItem(ENABLED, '1');

    // Two more launches.
    expect(await runBuddyLinuxHideMigration()).toBe('already-run');
    expect(await runBuddyLinuxHideMigration()).toBe('already-run');
    expect(localStorage.getItem(ENABLED)).toBe('1');
  });

  it('marks itself done even when the buddy was already off', async () => {
    // Otherwise a user whose buddy was off today, and who switches it on next
    // week, would have it switched off again at the following launch.
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux');

    expect(await runBuddyLinuxHideMigration()).toBe('nothing-to-hide');
    expect(localStorage.getItem(MARKER)).toBe('1');

    localStorage.setItem(ENABLED, '1');
    expect(await runBuddyLinuxHideMigration()).toBe('already-run');
    expect(localStorage.getItem(ENABLED)).toBe('1');
  });

  it('leaves Windows and macOS buddies alone', async () => {
    // Those desktops let an app place its own windows, so they answer
    // needed:false and there was never anything wrong with their buddy.
    const { runBuddyLinuxHideMigration } = await loadApp();
    for (const platform of ['win32', 'darwin']) {
      localStorage.clear();
      installFakeClaude(platform);
      localStorage.setItem(ENABLED, '1');

      expect(await runBuddyLinuxHideMigration()).toBe('skipped');
      expect(localStorage.getItem(ENABLED)).toBe('1');
      expect(localStorage.getItem(MARKER)).toBe(null);
    }
  });

  it('does not run inside the buddy\'s own windows', async () => {
    // The mascot, chat and bar are separate windows running this same module
    // against the same profile's localStorage. Without the guard the migration
    // would fire up to three extra times per launch — including after the main
    // window had already let the user switch the buddy back on.
    for (const mode of ['buddy-mascot', 'buddy-chat', 'buddy-bar', 'buddy-overlay']) {
      const { runBuddyLinuxHideMigration } = await loadApp(`mode=${mode}`);
      localStorage.clear();
      installFakeClaude('linux');
      localStorage.setItem(ENABLED, '1');

      expect(await runBuddyLinuxHideMigration()).toBe('skipped');
      expect(localStorage.getItem(ENABLED)).toBe('1');
      expect(localStorage.getItem(MARKER)).toBe(null);
    }
  });

  it('does not run on a remote browser or on Android', async () => {
    // Those clients have no buddy at all, and remote-shim's buddy methods throw
    // rather than no-op. The probe is window.claude.window, the Electron-only
    // window-controls surface the shim deliberately omits.
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux', { electron: false });
    localStorage.setItem(ENABLED, '1');

    expect(await runBuddyLinuxHideMigration()).toBe('skipped');
    expect(localStorage.getItem(ENABLED)).toBe('1');
    expect(localStorage.getItem(MARKER)).toBe(null);
  });

  it('changes nothing when the desktop cannot answer', async () => {
    // A boot-time bridge failure must never cost the user their buddy. Doing
    // nothing leaves them exactly where they were, and the next launch asks
    // again — the marker is deliberately not written.
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux', { helper: 'throws' });
    localStorage.setItem(ENABLED, '1');

    expect(await runBuddyLinuxHideMigration()).toBe('skipped');
    expect(localStorage.getItem(ENABLED)).toBe('1');
    expect(localStorage.getItem(MARKER)).toBe(null);
  });
});

// ─── The gate that keeps a working buddy working (design §4, §6/R12) ────────
describe('R12 — only a buddy that is actually broken is hidden', () => {
  it('leaves a Linux X11 / XWayland buddy switched on', async () => {
    // THE REGRESSION THIS EXISTS TO PREVENT. These users are on Linux, the app
    // moves its own windows, and their buddy has worked all along. Hiding it
    // would be an unexplained loss — and switching it back on would hand them a
    // consent card for a helper they do not need.
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux', { helper: NO_HELPER_WANTED });
    localStorage.setItem(ENABLED, '1');

    expect(await runBuddyLinuxHideMigration()).toBe('skipped');
    expect(localStorage.getItem(ENABLED)).toBe('1');
    // And no marker: if they log into a native Wayland session next week, where
    // the buddy really would be stuck, the one-time hide is still available.
    expect(localStorage.getItem(MARKER)).toBe(null);
  });

  it('hides a native-Wayland buddy that has no helper', async () => {
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux', { helper: BROKEN_BUDDY });
    localStorage.setItem(ENABLED, '1');

    expect(await runBuddyLinuxHideMigration()).toBe('hid');
    expect(localStorage.getItem(ENABLED)).toBe('0');
  });

  it('leaves a Wayland buddy alone once its helper is in place', async () => {
    // The helper is loaded, so the buddy can be dragged and does what it
    // promises. Hiding it here would read as the app losing the buddy for no
    // reason the user could connect to anything they did.
    const { runBuddyLinuxHideMigration } = await loadApp();
    installFakeClaude('linux', { helper: HELPER_IN_PLACE });
    localStorage.setItem(ENABLED, '1');

    expect(await runBuddyLinuxHideMigration()).toBe('skipped');
    expect(localStorage.getItem(ENABLED)).toBe('1');
    expect(localStorage.getItem(MARKER)).toBe(null);
  });

  it('the X11 launch path still re-opens the buddy', async () => {
    // End to end, through the same entry point launch uses: the migration does
    // not fire AND the buddy comes back on screen.
    const { bootBuddyOnLaunch } = await loadApp();
    const calls = installFakeClaude('linux', { helper: NO_HELPER_WANTED });
    localStorage.setItem(ENABLED, '1');

    await bootBuddyOnLaunch();

    expect(calls.show).toBe(1);
    expect(localStorage.getItem(ENABLED)).toBe('1');
  });
});

// ─── A refused show() (design §5) ──────────────────────────────────────────
describe('the launch path does not claim a buddy that was refused', () => {
  it('clears the stored preference when the desktop says no', async () => {
    // Otherwise Settings → Buddy Floater would read "On" with nothing on the
    // desktop: the helper went missing since the last launch (the user switched
    // the script off in KDE's own settings), main refuses, and the row lies.
    const { bootBuddyOnLaunch } = await loadApp();
    installFakeClaude('linux', { helper: HELPER_IN_PLACE });
    (window as any).claude.buddy.show = async () => ({ ok: false, reason: 'no helper' });
    localStorage.setItem(ENABLED, '1');

    await bootBuddyOnLaunch();

    expect(localStorage.getItem(ENABLED)).toBe('0');
  });
});

describe('R12 — the migration runs BEFORE the launch path reads the preference', () => {
  it('a previously-on Linux buddy is not re-opened at launch', async () => {
    // This is the whole point of the ordering: if the boot path read
    // youcoded-buddy-enabled first, it would call show() and put the stuck buddy
    // back on screen, and only THEN hide it for next time.
    const { bootBuddyOnLaunch } = await loadApp();
    const calls = installFakeClaude('linux');
    localStorage.setItem(ENABLED, '1');

    await bootBuddyOnLaunch();

    expect(calls.show).toBe(0);
    expect(localStorage.getItem(ENABLED)).toBe('0');
  });

  it('still re-opens the buddy at launch on every other platform', async () => {
    // Guard against "fixing" R12 by breaking the feature it sits in front of.
    const { bootBuddyOnLaunch } = await loadApp();
    const calls = installFakeClaude('darwin');
    localStorage.setItem(ENABLED, '1');

    await bootBuddyOnLaunch();

    expect(calls.show).toBe(1);
  });

  it('re-opens a Linux buddy the user has switched back on', async () => {
    const { bootBuddyOnLaunch } = await loadApp();
    const calls = installFakeClaude('linux');
    localStorage.setItem(ENABLED, '1');
    await bootBuddyOnLaunch();            // the update launch: hidden
    localStorage.setItem(ENABLED, '1');   // the user switches it back on

    await bootBuddyOnLaunch();            // the next launch

    expect(calls.show).toBe(1);
    expect(localStorage.getItem(ENABLED)).toBe('1');
  });
});

describe('R13 — no dialog interrupts you after an update', () => {
  it('the launch path only stores a preference; it never asks anything', async () => {
    // The helper offer lives in Settings → Buddy Floater and is reached by
    // switching the buddy on. Launch must not reach for it: no helper status
    // call, no install, no window shown.
    const { bootBuddyOnLaunch } = await loadApp();
    const calls = installFakeClaude('linux');
    localStorage.setItem(ENABLED, '1');

    await bootBuddyOnLaunch();

    // It DOES ask the desktop one question — "does the buddy need a helper here,
    // and is one missing?" — because that is what decides whether this user's
    // buddy is broken at all. A silent read is not an interruption; changed
    // 2026-09-04 when the migration stopped firing for every Linux user. What
    // R13 forbids is still pinned below: nothing is installed, nothing is shown,
    // and no card, dialog or offer appears anywhere at launch.
    expect(calls.helperStatus).toBe(1);
    expect(calls.installHelper).toBe(0);
    expect(calls.show).toBe(0);
    // The only thing that changed is the stored preference.
    expect(localStorage.getItem(ENABLED)).toBe('0');
  });
});
