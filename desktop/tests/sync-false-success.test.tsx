// @vitest-environment jsdom
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
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SyncSection from '../src/renderer/components/SyncPanel';

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
