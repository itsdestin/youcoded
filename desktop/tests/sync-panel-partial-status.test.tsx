// @vitest-environment jsdom
// sync-panel-partial-status.test.tsx
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

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import SyncSection from '../src/renderer/components/SyncPanel';

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
      syncNow: vi.fn().mockResolvedValue({ ok: true }),
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

describe('Backup & Sync — a partial status must not crash the app', () => {
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

  it('acknowledges Try again until the engine reports its eventual result', async () => {
    installClaudeMock({
      backends: [], lastSyncEpoch: null, backupMeta: null, warnings: [],
      syncInProgress: false, syncingBackendId: null, syncedCategories: [],
    });
    const errorStatus: any = spacesStatus();
    errorStatus.recentEvents = [{ type: 'error', spaceId: 'personal', message: 'network failed' }];
    (window as any).claude.syncSpaces.status.mockResolvedValue(errorStatus);
    const listeners: Array<(event: any) => void> = [];
    (window as any).claude.syncSpaces.onEvent.mockImplementation((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    });
    await renderOpen();

    await waitFor(() => expect(screen.getByText('Try again')).toBeTruthy());
    fireEvent.click(screen.getByText('Try again'));

    expect((window as any).claude.syncSpaces.syncNow).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByText('Trying again…')).toBeTruthy());

    listeners.forEach((listener) => listener({ type: 'error', spaceId: 'personal', message: 'network failed' }));
    await waitFor(() => expect(screen.getByText('Try again')).toBeTruthy());
  });
});
