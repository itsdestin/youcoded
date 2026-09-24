// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SyncSection from '../src/renderer/components/SyncPanel';

// Every section renders the real Backup & Sync panel (SyncPanel's default export,
// SyncSection) against a hand-built `window.claude`; each section keeps its own fake
// inside its describe, because the fakes answer differently on purpose.

/**
 * Backup & Sync must never report a success the backend did not confirm.
 *
 * Error inventory 2026-09-10, the first two of the seventeen false messages
 * (youcoded-dev docs/active/investigations/2026-09-10-error-inventory/README.md):
 *
 *   1. A backup warning's Retry read "Uploaded!" after `sync.pushBackend` answered
 *      `{ success: false }` — the handler never looked at the answer. The "Upload now"
 *      menu item beside it always did.
 *   2. Adding a backup read "You're all set! Your first backup is syncing now.
 *      Backups happen automatically every 15 minutes." when the save had thrown
 *      (SyncPanel's `catch {}` swallowed it, so the wizard's own error box never ran),
 *      when the first backup failed, and even when auto-backup was OFF — in which case
 *      nothing was uploaded at all. The 15-minute timer was deleted long ago.
 *
 * Every test here drives the REAL SyncPanel: the wizard is reached through a warning's
 * "Fix it" button, which is SyncPanel's own route into it, so SyncPanel's `onComplete`
 * is what runs — not a stand-in written for the test.
 */

const DRIVE = { id: 'drive-1', type: 'drive', label: 'My Drive', syncEnabled: true, config: {}, connected: true, lastPushEpoch: null, lastError: null };
const ICLOUD = { id: 'icloud-1', type: 'icloud', label: 'My iCloud', syncEnabled: true, config: {}, connected: false, lastPushEpoch: null, lastError: null };

const RETRY_WARNING = {
  code: 'PUSH_FAILED', level: 'danger', backendId: 'drive-1',
  title: 'Backup failed', body: 'The last upload did not finish.',
  fixAction: { label: 'Retry', kind: 'retry', payload: { backendId: 'drive-1' } },
  dismissible: false, createdEpoch: 0,
};
// iCloud has no sign-in step, so "Fix it" lands on the prerequisite check and then
// straight on the settings step with its Start Backup button.
const SETUP_WARNING = {
  code: 'ICLOUD_MISSING', level: 'warn', backendId: 'icloud-1',
  title: 'iCloud needs attention', body: 'Set it up again.',
  fixAction: { label: 'Fix it', kind: 'open-sync-setup', payload: { backendId: 'icloud-1' } },
  dismissible: false, createdEpoch: 0,
};

function stub(sync: Record<string, unknown>, warnings: unknown[]) {
  const status = {
    backends: [DRIVE, ICLOUD], lastSyncEpoch: null, backupMeta: null, warnings,
    syncInProgress: false, syncingBackendId: null, syncedCategories: [], lastSyncByDevice: {},
  };
  const api = {
    getStatus: vi.fn(async () => status),
    getLog: vi.fn(async () => []),
    force: vi.fn(async () => ({ success: true, output: '', error: '' })),
    pushBackend: vi.fn(async () => ({ success: true, error: '' })),
    addBackend: vi.fn(async (instance: any) => ({ ...instance, id: 'icloud-new' })),
    dismissWarning: vi.fn(async () => {}),
    setup: { checkPrereqs: vi.fn(async () => ({ icloudPath: '/Users/me/iCloud Drive' })) },
    ...sync,
  };
  (window as any).claude = {
    sync: api,
    syncSpaces: { status: async () => null, onEvent: () => () => {}, listDevices: async () => [] },
    github: { status: async () => ({ installed: true, authed: true }) },
    session: { browse: async () => [] },
    on: { statusData: () => () => {} },
    off: () => {},
    shell: { openExternal: async () => {} },
  };
  return api;
}

async function openSetup(): Promise<HTMLElement> {
  render(<SyncSection autoOpen />);
  fireEvent.click(await screen.findByRole('button', { name: 'Fix it' }));
  return screen.findByRole('button', { name: 'Start Backup' });
}

describe('Backup & Sync reports only what the backend confirmed', () => {
  afterEach(() => { cleanup(); delete (window as any).claude; });

  it('explains handoff limits without promising exclusive offline use or lossless merging', async () => {
    stub({}, []);
    render(<SyncSection autoOpen />);
    fireEvent.click(await screen.findByRole('button', { name: 'What is this?' }));
    expect(await screen.findByText(/conflicting updates may be kept as separate copies/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing is lost|runs on one device at a time/)).toBeNull();
    expect(screen.getByText(/not in the phone app/)).toBeInTheDocument();
    expect(screen.getByText(/Recent messages may still be syncing/)).toBeInTheDocument();
  });

  it('a warning Retry whose upload failed does not say "Uploaded!"', async () => {
    const api = stub(
      { pushBackend: vi.fn(async () => ({ success: false, error: "Some files didn't upload." })) },
      [RETRY_WARNING],
    );
    render(<SyncSection autoOpen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(api.pushBackend).toHaveBeenCalledWith('drive-1'));
    await waitFor(() => expect(screen.getByText("Upload failed: Some files didn't upload.")).toBeInTheDocument());
    expect(screen.queryByText('Uploaded!')).toBeNull();
  });

  // Destin, batch 1 deck (E-1, then E-1b): a bare "Error" is unhelpful, and every error state
  // offers an action — a failed upload is a full error block with Retry, plus Report bug
  // wherever the cause is not known. It stays until the next upload.
  async function retryAndFindAlert(pushBackend: ReturnType<typeof vi.fn>, text: RegExp) {
    const api = stub({ pushBackend }, [RETRY_WARNING]);
    render(<SyncSection autoOpen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    const alert = await waitFor(() => {
      const hit = screen.getAllByRole('alert').find((a) => text.test(a.textContent ?? ''));
      if (!hit) throw new Error('no alert matching ' + text);
      return hit;
    });
    return { api, alert };
  }

  it('a failed upload is an error block with its reason, Retry and Report bug, and it stays', async () => {
    const { api, alert } = await retryAndFindAlert(
      vi.fn(async () => ({ success: false, error: "Some files didn't upload." })),
      /Upload failed: Some files didn.t upload\./,
    );
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 2300));
    expect(alert).toBeInTheDocument();
    expect(screen.queryByText('Error')).toBeNull();

    // Retry in the block runs the upload again.
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.pushBackend).toHaveBeenCalledTimes(2));
  });

  it('an upload that was skipped offers Retry only — nothing to report', async () => {
    const { alert } = await retryAndFindAlert(vi.fn(async () => ({ success: false, error: '' })), /upload hasn.t run yet/i);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(alert).queryByRole('button', { name: 'Report bug' })).toBeNull();
  });

  it('an upload with no answer says it could not confirm, with Retry and Report bug', async () => {
    const { alert } = await retryAndFindAlert(
      vi.fn(async () => { throw new Error('Request sync:push-backend timed out'); }),
      /couldn.t confirm the upload finished/i,
    );
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
  });

  it('a backup that could not be saved keeps the wizard open and says why', async () => {
    stub({
      addBackend: vi.fn(async () => {
        throw new Error("Error invoking remote method 'sync:add-backend': Error: EACCES: permission denied, open '/home/me/.claude/toolkit-state/config.json'");
      }),
    }, [SETUP_WARNING]);
    fireEvent.click(await openSetup());

    expect(await screen.findByText(/EACCES: permission denied/)).toBeInTheDocument();
    // The transport wrapper is machinery, not part of the reason.
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    expect(screen.queryByText("You're all set!")).toBeNull();
    expect(screen.getByRole('button', { name: 'Start Backup' })).toBeInTheDocument();
  });

  it('a first backup that failed is reported as failed, for the new destination only', async () => {
    const api = stub({
      pushBackend: vi.fn(async () => ({ success: false, error: "Some files didn't upload." })),
      // A failure in some OTHER destination must not be blamed on the new one.
      force: vi.fn(async () => ({ success: false, output: '', error: "Some backups didn't finish." })),
    }, [SETUP_WARNING]);
    fireEvent.click(await openSetup());

    expect(await screen.findByText(/first backup didn.t finish/i)).toBeInTheDocument();
    expect(screen.getByText(/Some files didn.t upload/)).toBeInTheDocument();
    expect(api.pushBackend).toHaveBeenCalledWith('icloud-new');
    expect(api.force).not.toHaveBeenCalled();
    expect(screen.queryByText("You're all set!")).toBeNull();
  });

  it('a first backup that was skipped (another backup was running) says it has not run yet (code review F7)', async () => {
    // pushBackend answers { success: false, error: '' } when a push is already in flight
    // or the lock is held — nothing was attempted, so "didn't finish" would be false.
    stub({ pushBackend: vi.fn(async () => ({ success: false, error: '' })) }, [SETUP_WARNING]);
    fireEvent.click(await openSetup());

    expect(await screen.findByText(/first backup hasn.t run yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/didn.t finish/i)).toBeNull();
  });

  it('a first backup whose outcome never came back says it could not confirm', async () => {
    stub({
      pushBackend: vi.fn(async () => { throw new Error('Request sync:push-backend timed out'); }),
    }, [SETUP_WARNING]);
    fireEvent.click(await openSetup());

    expect(await screen.findByText(/couldn.t confirm/i)).toBeInTheDocument();
    expect(screen.queryByText("You're all set!")).toBeNull();
  });

  it('with auto-backup off, nothing is uploaded and the screen does not say it was', async () => {
    const api = stub({}, [SETUP_WARNING]);
    const start = await openSetup();
    fireEvent.click(screen.getByRole('switch', { name: 'Back up automatically after changes' }));
    fireEvent.click(start);

    expect(await screen.findByText(/automatic backup is off/i)).toBeInTheDocument();
    expect(api.pushBackend).not.toHaveBeenCalled();
    expect(api.force).not.toHaveBeenCalled();
    expect(screen.queryByText(/syncing now/i)).toBeNull();
  });

  it('a first backup that finished says so, without the deleted 15-minute schedule', async () => {
    const api = stub({}, [SETUP_WARNING]);
    fireEvent.click(await openSetup());

    expect(await screen.findByText(/first backup finished/i)).toBeInTheDocument();
    expect(api.pushBackend).toHaveBeenCalledWith('icloud-new');
    expect(screen.queryByText(/15 minutes/)).toBeNull();
  });
});

// Regression test for "YouCoded failed to start" when opening Backup & Sync
// (reported by Destin 2026-09-04, seen on the PUBLIC landing page's live demo).
//
// WHAT HAPPENED: the workbench mock shim answers an unimplemented channel with
// `[]`. `[]` is TRUTHY, so `sync.getStatus()` handed SyncPopup an ARRAY where it
// expected a status OBJECT. The popup guarded that field with `status &&` only —
// `status.syncedCategories.length` threw TypeError on the undefined field, and
// because SyncSection renders inside the always-mounted settings drawer the
// RootErrorBoundary took the WHOLE APP down rather than just this panel.
//
// Two independent fixes, both pinned here:
//   1. the mock shim now hand-writes the `sync` namespace (mock-shim.ts);
//   2. the popup optional-chains every field the other side might omit, so a
//      partial status can never again escalate into an app-wide crash.
//
// Test 2 is the load-bearing one: the real main process could ship a status
// shape this renderer version doesn't know about (an older remote host over the
// remote shim, a partial reply mid-migration), and "the panel renders without
// that section" must always beat "the app dies".
describe('Backup & Sync — a partial status must not crash the app', () => {
  function spacesStatus() {
    return {
      enabled: true,
      syncHub: 'connected',
      spaces: [{
        id: 'personal', root: '/home/u/YouCoded/Personal', kind: 'personal',
        state: 'active', remote: 'https://github.com/u/personal.git',
        lastSyncAt: Date.now(),
      }],
      recentEvents: [],
    };
  }

  /** `status` is whatever the other side answered — deliberately untyped, because
   *  the whole point is that it may not be a SyncStatus at all. */
  function installClaudeMock(status: unknown) {
    (window as any).claude = {
      sync: {
        getStatus: vi.fn().mockResolvedValue(status),
        getLog: vi.fn().mockResolvedValue([]),
      },
      syncSpaces: {
        status: vi.fn().mockResolvedValue(spacesStatus()),
        onEvent: vi.fn().mockReturnValue(() => {}),
        listDevices: vi.fn().mockResolvedValue([]),
      },
      session: { browse: vi.fn().mockResolvedValue([]) },
      on: { statusData: vi.fn(() => () => {}) },
      off: vi.fn(),
    };
  }

  /** Renders the section with the popup already open — `autoOpen` is the same
   *  path Settings uses to deep-link into it. The popup is a Dialog PORTAL, so
   *  every assertion reads document.body, never the render container. */
  async function renderOpen() {
    render(<SyncSection autoOpen />);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Additional backups');
    }, { timeout: 3000 });
  }

  afterEach(() => { cleanup(); delete (window as any).claude; });

  // The exact payload the workbench catch-all used to return.
  it('survives getStatus() answering [] (the workbench catch-all default)', async () => {
    installClaudeMock([]);
    await renderOpen();
    // Reaching this line is the assertion — before the fix SyncPopup threw
    // during render, so 'Additional backups' never appeared at all.
    expect(document.body.textContent).toContain('Backup & Sync');
  });

  // The general case: a well-formed object that is simply missing fields this
  // renderer knows about.
  it('survives a status object with no syncedCategories and no backends', async () => {
    installClaudeMock({
      lastSyncEpoch: null,
      backupMeta: null,
      warnings: [],
      syncInProgress: false,
      syncingBackendId: null,
    });
    await renderOpen();
    // The "Includes …" category strip is the section that used to throw — it
    // must be absent, not fatal.
    expect(document.body.textContent).not.toContain('Includes');
  });

  it('still renders the category strip when the field IS present', async () => {
    installClaudeMock({
      backends: [],
      lastSyncEpoch: null,
      backupMeta: null,
      warnings: [],
      syncInProgress: false,
      syncingBackendId: null,
      syncedCategories: ['memory', 'conversations'],
    });
    await renderOpen();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Memory');
    }, { timeout: 3000 });
    expect(document.body.textContent).toContain('Conversations');
  });
});

// Regression test for the Settings → "Backup & Sync" row freezing on the
// warnings it read at APP LAUNCH (reported by Destin 2026-07-26).
//
// The row lives in SyncSection, which mounts with the app — DesktopSettings
// renders unconditionally inside the always-mounted, translate-hidden settings
// drawer — and fetches getSyncStatus() exactly once, 350ms in. That fetch lands
// ~35s BEFORE SyncService.runHealthCheck() finishes rewriting
// ~/.claude/.sync-warnings.json, so the row captures the PREVIOUS session's
// warnings and then never refetches: its status:data handler patched only the
// recency fields, and the popup's refreshStatus only auto-fires when the LEGACY
// .sync-marker epoch advances (a file that doesn't exist on a spaces-only
// install). Result: red "Sync Failing · 2" for the whole app run while the
// popup two clicks away reads green "All synced" off a fresh fetch.
//
// The fix takes warnings from the same authoritative 10s status:data push that
// App.tsx's gear danger-dot already uses (buildStatusData reads the warnings
// file every cycle). These tests pin BOTH directions — a push must be able to
// clear a stale warning AND raise a fresh one.
describe('Settings row — Backup & Sync warnings freshness', () => {
  // Two danger warnings — the pair runHealthCheck leaves behind when a launch
  // finds no network and no legacy backend (OFFLINE + PERSONAL_NOT_CONFIGURED),
  // which is exactly what the reported row was showing.
  const STALE_WARNINGS = [
    {
      code: 'OFFLINE', level: 'danger', title: 'No internet',
      body: "Can't reach the network.", dismissible: true, createdEpoch: 1,
    },
    {
      code: 'PERSONAL_NOT_CONFIGURED', level: 'danger', title: 'No sync configured',
      body: "Your backups aren't set up.", dismissible: false, createdEpoch: 1,
    },
  ];

  function syncStatus(warnings: any[]) {
    return {
      backends: [],
      lastSyncEpoch: null,
      backupMeta: null,
      warnings,
      syncInProgress: false,
      syncingBackendId: null,
      syncedCategories: [],
      lastSyncByDevice: {},
    };
  }

  // A healthy spaces-only install: sync on, Personal provisioned and synced —
  // the state that makes the popup's box read green "All synced".
  function spacesStatus() {
    return {
      enabled: true,
      syncHub: 'connected',
      spaces: [{
        id: 'personal', root: '/home/u/YouCoded/Personal', kind: 'personal',
        state: 'active', remote: 'https://github.com/u/personal.git',
        lastSyncAt: Date.now(),
      }],
      recentEvents: [],
    };
  }

  // Captures the status:data subscriber so a test can push a cycle by hand.
  let pushStatusData: ((data: any) => void) | null = null;

  function installClaudeMock(warnings: any[]) {
    pushStatusData = null;
    (window as any).claude = {
      sync: { getStatus: vi.fn().mockResolvedValue(syncStatus(warnings)) },
      syncSpaces: {
        status: vi.fn().mockResolvedValue(spacesStatus()),
        onEvent: vi.fn().mockReturnValue(() => {}),
      },
      on: {
        statusData: vi.fn((cb: (d: any) => void) => { pushStatusData = cb; return cb; }),
      },
      off: vi.fn(),
    };
  }

  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { cleanup(); delete (window as any).claude; });

  it('shows the launch-time warnings before any push arrives', async () => {
    installClaudeMock(STALE_WARNINGS);
    const { container } = render(<SyncSection />);

    // The mount fetches are deferred 350ms past the settings slide-in.
    await waitFor(() => {
      expect(container.textContent).toContain('Sync Failing');
    }, { timeout: 3000 });
    expect(container.textContent).toContain('2');
  });

  it('clears the row when a status:data push reports the warnings are gone', async () => {
    installClaudeMock(STALE_WARNINGS);
    const { container } = render(<SyncSection />);

    await waitFor(() => {
      expect(container.textContent).toContain('Sync Failing');
    }, { timeout: 3000 });

    // runHealthCheck has since swept both codes and unlinked the file, so the
    // next 10s push carries an empty array — the row must follow it down.
    await act(async () => {
      pushStatusData!({ syncWarnings: [], lastSyncEpoch: null, syncInProgress: false });
    });

    expect(container.textContent).not.toContain('Sync Failing');
    expect(container.textContent).toContain('Last synced');
  });

  it('raises the row when a status:data push reports a NEW danger warning', async () => {
    installClaudeMock([]);
    const { container } = render(<SyncSection />);

    await waitFor(() => {
      expect(container.textContent).toContain('Last synced');
    }, { timeout: 3000 });

    await act(async () => {
      pushStatusData!({ syncWarnings: [STALE_WARNINGS[0]], lastSyncEpoch: null, syncInProgress: false });
    });

    expect(container.textContent).toContain('Sync Failing');
  });

  it('keeps the last-known warnings when a push omits the field entirely', async () => {
    // An older host (remote shim to a pre-fix desktop) sends no syncWarnings.
    // Absent must mean "no news", not "all clear" — same convention as the
    // other fields this handler patches.
    installClaudeMock(STALE_WARNINGS);
    const { container } = render(<SyncSection />);

    await waitFor(() => {
      expect(container.textContent).toContain('Sync Failing');
    }, { timeout: 3000 });

    await act(async () => {
      pushStatusData!({ lastSyncEpoch: null, syncInProgress: false });
    });

    expect(container.textContent).toContain('Sync Failing');
  });
});
