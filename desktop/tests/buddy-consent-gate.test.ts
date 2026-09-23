import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * The buddy's consent gate lives in the MAIN process, not in the settings screen
 * (design §5 of docs/active/design/2026-09-04-linux-buddy-helper/).
 *
 * What it protects, in plain terms: on a KDE Wayland desktop the buddy cannot
 * move himself — a small script inside the window manager has to do it. The
 * product promise is "say no to that script and you get no buddy at all". A
 * check in the settings screen cannot keep that promise, because the settings
 * screen is not the only thing that turns the buddy on: the app also brings him
 * back at launch from a saved preference, and that path never asked. So the
 * refusal has to happen where the buddy is actually created.
 *
 * The other half is just as important and is why half these cases exist: a user
 * who never needed the script — Windows, macOS, Linux on X11, or a Linux Wayland
 * desktop where the app is quietly running through XWayland and CAN move its own
 * windows — must never be refused a buddy that already works for them. A
 * regression there is worse than the bug being fixed.
 */

// Same electron mock the ipc-handlers suite uses, and for the same reason:
// importing ipc-handlers transitively loads main.ts, which touches Electron at
// module scope. whenReady must never resolve or main.ts runs its whole launch.
vi.mock('electron', () => {
  const BrowserWindowMock: any = vi.fn(() => ({ loadURL: vi.fn(), on: vi.fn(), webContents: { send: vi.fn() } }));
  BrowserWindowMock.getAllWindows = vi.fn(() => []);
  return {
    app: {
      isPackaged: false, getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0-test'),
      whenReady: vi.fn(() => new Promise(() => {})), on: vi.fn(), quit: vi.fn(),
      setAppUserModelId: vi.fn(), commandLine: { appendSwitch: vi.fn() },
      getGPUInfo: vi.fn(() => new Promise(() => {})),
    },
    ipcMain: { handle: vi.fn(), on: vi.fn() },
    BrowserWindow: BrowserWindowMock,
    Menu: { setApplicationMenu: vi.fn() },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    dialog: { showOpenDialog: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    nativeImage: {},
    shell: { openExternal: vi.fn() },
    powerSaveBlocker: { start: vi.fn(() => 0), stop: vi.fn() },
    screen: { on: vi.fn(), getAllDisplays: vi.fn(() => []), getPrimaryDisplay: vi.fn(() => ({ id: 1 })) },
  };
});

// The real one talks to KDE over DBus. Every answer below is supplied by hand so
// the whole gate is testable on any machine, including CI, with no desktop.
const helperStatusMock = vi.fn();
vi.mock('../src/main/kwin-helper', () => ({
  helperStatus: () => helperStatusMock(),
  installHelper: vi.fn(async () => ({ ok: true })),
  removeHelper: vi.fn(async () => ({ ok: true })),
  syncHelperOnLaunch: vi.fn(async () => {}),
  setExperimentKwinDisabled: vi.fn(),
  helperPluginId: vi.fn(() => 'youcodedbuddyhelper-test'),
}));

type Gate = typeof import('../src/main/ipc-handlers');

/** A fresh module registry, so the cached status starts empty in each test. */
async function freshGate(): Promise<Gate> {
  vi.resetModules();
  return import('../src/main/ipc-handlers');
}

describe('BUDDY_SHOW consent gate — when the buddy is refused', () => {
  // buddyShowRefusal is PURE — it is handed the status rather than looking one
  // up — so these share one module. Only the test that exercises the remembered
  // answer needs a registry of its own.
  let gate: Gate;
  beforeAll(async () => { gate = await freshGate(); });
  beforeEach(() => { helperStatusMock.mockReset(); });

  it('refuses when a helper is needed and it is not running', () => {
    const refusal = gate.buddyShowRefusal({ needed: true, supported: true, installed: false });
    expect(refusal).toBeTruthy();
  });

  it('refuses when a helper is needed and the desktop cannot run one, and says why', () => {
    // This is the state a KDE Plasma 5 or GNOME user is in. The reason comes
    // from the support check itself — it is never a guess at a cause.
    const refusal = gate.buddyShowRefusal({
      needed: true, supported: false, installed: false,
      reason: 'KWin is not running a Wayland session.',
    });
    expect(refusal).toBe('KWin is not running a Wayland session.');
  });

  it('refuses when the status lookup failed, so the answer about the helper is unknown', () => {
    // The shape the real status call produces when KDE does not answer over
    // DBus: we know a helper IS needed here, and we do NOT know that one is
    // running. That has to refuse — treating "do not know" as "yes" is exactly
    // the hole that let an early click switch the buddy on with no ask.
    const refusal = gate.buddyShowRefusal({
      needed: true, supported: false, installed: false,
      reason: 'KWin did not answer over DBus, so this desktop could not be checked.',
    });
    expect(refusal).toBe('KWin did not answer over DBus, so this desktop could not be checked.');
  });

  it('still refuses after a lookup THROWS, once we already knew a helper was needed', async () => {
    gate = await freshGate();
    helperStatusMock.mockResolvedValueOnce({ needed: true, supported: true, installed: true });
    expect(gate.buddyShowRefusal(await gate.refreshBuddyHelperStatus())).toBeNull();

    // KDE stops answering mid-session. The buddy must not keep being allowed on
    // the strength of a stale "yes, the helper is running".
    helperStatusMock.mockRejectedValueOnce(new Error('qdbus6 timed out after 4000ms'));
    const after = await gate.refreshBuddyHelperStatus();
    expect(after).toMatchObject({ needed: true, installed: false });
    expect(gate.buddyShowRefusal(after)).toContain('qdbus6 timed out');
  });

  it('never invents a cause it has not been told', () => {
    // No reason from the support check → a plain statement of the fact, and
    // nothing more (docs/error-message-standards.md).
    const refusal = gate.buddyShowRefusal({ needed: true, supported: true, installed: false });
    expect(refusal).toBe('The buddy needs its KDE helper on this desktop, and the helper is not running.');
  });
});

describe('BUDDY_SHOW consent gate — when the buddy is NOT refused', () => {
  let gate: Gate;
  beforeAll(async () => { gate = await freshGate(); });
  beforeEach(() => { helperStatusMock.mockReset(); });

  // The regression this file exists to prevent. `needed: false` is what every
  // one of these platforms reports, and every one of them must behave exactly
  // as it did before this feature existed.
  const NO_HELPER_NEEDED = [
    'Windows',
    'macOS',
    'Linux on X11',
    'Linux on Wayland, but the app is running through XWayland',
    'a remote browser',
  ];
  for (const platform of NO_HELPER_NEEDED) {
    it(`allows the buddy on ${platform}`, () => {
      expect(gate.buddyShowRefusal({ needed: false, supported: false, installed: false })).toBeNull();
    });
  }

  it('allows the buddy where a helper is needed AND running', () => {
    expect(gate.buddyShowRefusal({ needed: true, supported: true, installed: true })).toBeNull();
  });

  it('allows the buddy when a helper is somehow installed on a desktop that does not need one', () => {
    // A user who added the script on Wayland and then logged into X11. The
    // script is inert there (it only ever touches windows carrying our own
    // naming pattern, which X11 never writes), and refusing would take away a
    // buddy that works.
    expect(gate.buddyShowRefusal({ needed: false, supported: false, installed: true })).toBeNull();
  });

  it('allows the buddy when there is no answer at all', async () => {
    gate = await freshGate();
    // Design §4's failing-safe rule, stated as a test so it is a decision and
    // not an accident: if the very first lookup throws before deciding
    // anything, prefer "no helper needed here". That error costs a Wayland user
    // exactly today's behaviour — a buddy that cannot be dragged — while the
    // opposite error TAKES AWAY a working buddy from everyone else.
    helperStatusMock.mockRejectedValueOnce(new Error('profile directory unreadable'));
    const status = await gate.refreshBuddyHelperStatus();
    expect(status).toMatchObject({ needed: false });
    expect(gate.buddyShowRefusal(status)).toBeNull();
    expect(gate.buddyShowRefusal(null)).toBeNull();
  });
});

describe('the cached status the drag path reads', () => {
  let gate: Gate;
  beforeEach(async () => {
    helperStatusMock.mockReset();
    gate = await freshGate();   // the cache is module state; each case starts empty
  });

  it('is empty until something asks, and never calls out on its own', () => {
    expect(gate.cachedBuddyHelperStatus()).toBeNull();
    expect(helperStatusMock).not.toHaveBeenCalled();
  });

  it('remembers the last answer so the drag loop never has to wait', async () => {
    helperStatusMock.mockResolvedValue({ needed: true, supported: true, installed: true });
    await gate.refreshBuddyHelperStatus();
    const calls = helperStatusMock.mock.calls.length;
    for (let frame = 0; frame < 60; frame++) gate.cachedBuddyHelperStatus();
    expect(helperStatusMock.mock.calls.length).toBe(calls);
  });
});

// The unit tests above prove the RULE. The proof that main.ts actually applies it
// (a correct gate nothing calls is the same bug with extra steps) is ast-grep
// since Plan B (2026-09-16), in scripts/ast-grep/rules/:
// buddy-show-consults-refusal-gate (asks the gate, re-reads the status),
// buddy-show-refuses-before-creating (refusal returned before buddyManager.show()),
// buddy-drag-reads-cached-helper-status (the per-frame question reads the cache),
// buddy-work-area-only-where-needed and buddy-work-area-reresolved-on-display-change.

describe('losing the helper under a live buddy', () => {
  let gate: Gate;
  beforeEach(async () => {
    helperStatusMock.mockReset();
    gate = await freshGate();   // the cache is module state; each case starts empty
  });

  it('puts the buddy away when the helper stops being live', async () => {
    // WHY this is not covered by the Remove button. buddy-window-manager.ts
    // records that the caption channel MUST NOT flip true→false while buddy
    // windows exist: after the flip, moves take the setPosition branch — a
    // silent no-op on Wayland — and rectOf returns getBounds(), frozen at the
    // constructor position, so the chat and bar open in the screen corner while
    // the mascot sits still and undraggable. Removal was claimed as the
    // guarantee, but design §4 added the on-show re-check precisely so that
    // switching the KWin script off in KDE's own System Settings mid-session is
    // NOTICED — and noticing without acting produced exactly that buddy.
    const hide = vi.fn();
    gate.setBuddyHelperLostHandler(hide);
    try {
      helperStatusMock.mockResolvedValueOnce({ needed: true, supported: true, installed: true });
      await gate.refreshBuddyHelperStatus();
      expect(hide).not.toHaveBeenCalled();

      helperStatusMock.mockResolvedValueOnce({ needed: true, supported: true, installed: false });
      await gate.refreshBuddyHelperStatus();
      expect(hide).toHaveBeenCalledTimes(1);
    } finally {
      gate.setBuddyHelperLostHandler(null);
    }
  });

  it('does not put the buddy away when the helper was never live', async () => {
    const hide = vi.fn();
    gate.setBuddyHelperLostHandler(hide);
    try {
      helperStatusMock.mockResolvedValueOnce({ needed: false, supported: false, installed: false });
      await gate.refreshBuddyHelperStatus();
      helperStatusMock.mockResolvedValueOnce({ needed: false, supported: false, installed: false });
      await gate.refreshBuddyHelperStatus();
      expect(hide).not.toHaveBeenCalled();
    } finally {
      gate.setBuddyHelperLostHandler(null);
    }
  });

  it('reacts to a mid-session KDE outage, which is the case that actually happens', async () => {
    // helperStatus() has no rejecting path: an unreachable KWin comes back as
    // supported:false, installed:false. That is the shape a real outage takes.
    const hide = vi.fn();
    gate.setBuddyHelperLostHandler(hide);
    try {
      helperStatusMock.mockResolvedValueOnce({ needed: true, supported: true, installed: true });
      await gate.refreshBuddyHelperStatus();
      helperStatusMock.mockResolvedValueOnce({ needed: true, supported: false, installed: false, reason: 'KWin is not reachable' });
      await gate.refreshBuddyHelperStatus();
      expect(hide).toHaveBeenCalledTimes(1);
    } finally {
      gate.setBuddyHelperLostHandler(null);
    }
  });
});
