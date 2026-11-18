// @vitest-environment jsdom
// Backup fixes 2026-11-18, the screens' half:
//   item 1  GitHub backup is never offered on a phone; an existing entry reads "No longer supported" with Remove.
//   item 2  Google Drive backup is hidden on a phone running its own backend (but kept on a phone paired to a
//           computer, which drives the computer's backup); iCloud is not offered where it cannot work.
//   item 4  "Sign in again" repairs the SAME Drive entry instead of making a second one.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import SyncSection from '../src/renderer/components/SyncPanel';
import SyncSetupWizard from '../src/renderer/components/SyncSetupWizard';
import { setConnectionMode } from '../src/renderer/platform';
import { backupTypeOffered, backupEntryNotice } from '../src/renderer/components/backup-availability';

const asPhone = () => { (window as any).__PLATFORM__ = 'android'; setConnectionMode('local'); };
const asPairedPhone = () => { (window as any).__PLATFORM__ = 'android'; setConnectionMode('remote'); };
function asDesktop(os: 'Linux' | 'MacIntel' | 'Win32' = 'MacIntel') {
  delete (window as any).__PLATFORM__; setConnectionMode('local');
  Object.defineProperty(navigator, 'platform', { value: os, configurable: true });
  Object.defineProperty(navigator, 'userAgent', { value: os === 'Linux' ? 'X11; Linux x86_64' : os === 'Win32' ? 'Windows NT 10' : 'Macintosh; Mac OS X', configurable: true });
}

afterEach(() => { cleanup(); delete (window as any).claude; delete (window as any).__PLATFORM__; setConnectionMode('local'); });

const DRIVE = { id: 'drive-1', type: 'drive', label: 'My Drive', syncEnabled: true, config: { rcloneRemote: 'gdrive', DRIVE_ROOT: 'Claude' }, connected: true, lastPushEpoch: 1, lastError: null };
const GITHUB = { id: 'github-1', type: 'github', label: 'GitHub', syncEnabled: true, config: { PERSONAL_SYNC_REPO: 'https://github.com/me/x' }, connected: true, lastPushEpoch: 1, lastError: null };

function stub(backends: any[], warnings: any[] = [], over: Record<string, unknown> = {}) {
  const status = { backends, lastSyncEpoch: null, backupMeta: null, warnings, syncInProgress: false, syncingBackendId: null, syncedCategories: [], lastSyncByDevice: {} };
  const api: any = {
    getStatus: vi.fn(async () => status), getLog: vi.fn(async () => []),
    force: vi.fn(async () => ({ success: true, output: '', error: '' })),
    pushBackend: vi.fn(async () => ({ success: true, error: '' })),
    addBackend: vi.fn(async (i: any) => ({ ...i, id: 'new-1' })),
    updateBackend: vi.fn(async () => ({})), removeBackend: vi.fn(async () => {}), dismissWarning: vi.fn(async () => {}),
    setup: { checkPrereqs: vi.fn(async () => ({})), authGdrive: vi.fn(async (r?: string) => ({ success: true, remoteName: r ?? 'gdrive2' })) },
    ...over,
  };
  (window as any).claude = {
    sync: api, syncSpaces: { status: async () => null, onEvent: () => () => {}, listDevices: async () => [] },
    github: { status: async () => ({ installed: true, authed: true }) }, session: { browse: async () => [] },
    on: { statusData: () => () => {} }, off: () => {}, shell: { openExternal: async () => {} },
  };
  return api;
}

describe('what each kind of device is offered', () => {
  it('GitHub is offered nowhere; Drive everywhere except a phone running its own backend', () => {
    asDesktop('MacIntel');
    expect(backupTypeOffered('github')).toBe(false);
    expect(backupTypeOffered('drive')).toBe(true);
    expect(backupTypeOffered('icloud')).toBe(true);
    asDesktop('Windows' as any); asDesktop('Win32'); expect(backupTypeOffered('icloud')).toBe(true);
    asDesktop('Linux'); expect(backupTypeOffered('icloud')).toBe(false);
    asPhone();
    expect(backupTypeOffered('github')).toBe(false);
    expect(backupTypeOffered('drive')).toBe(false);
    expect(backupTypeOffered('icloud')).toBe(false);
    asPairedPhone(); // drives the computer's backup
    expect(backupTypeOffered('drive')).toBe(true);
    expect(backupTypeOffered('github')).toBe(false);
  });

  it('an entry is "unsupported" only when it can never copy anything on this device', () => {
    asDesktop('MacIntel');
    expect(backupEntryNotice('github')).toBe('github-gone');
    expect(backupEntryNotice('drive')).toBeNull();
    asPhone();
    expect(backupEntryNotice('drive')).toBe('drive-phone');
    asPairedPhone();
    expect(backupEntryNotice('drive')).toBeNull();
  });
});

describe('the setup wizard\'s picker', () => {
  const picker = () => render(<SyncSetupWizard existingBackends={[]} onComplete={vi.fn()} onClose={vi.fn()} />);
  it('offers nothing on a phone running its own backend', () => {
    asPhone(); stub([]); picker();
    expect(screen.queryByText('Google Drive')).toBeNull();
    expect(screen.queryByText('GitHub')).toBeNull();
    expect(screen.queryByText('iCloud')).toBeNull();
  });
  it('still offers Google Drive (only) on a phone paired to a computer', () => {
    asPairedPhone(); stub([]); picker();
    expect(screen.getByText('Google Drive')).toBeInTheDocument();
    expect(screen.queryByText('GitHub')).toBeNull();
  });
});

describe('Backup & sync on a phone running its own backend', () => {
  it('a GitHub entry says "No longer supported", gives Remove, and no menu — without saying "on computers"', async () => {
    asPhone(); stub([GITHUB]);
    render(<SyncSection autoOpen />);
    expect(await screen.findByText('No longer supported')).toBeInTheDocument();
    expect(screen.getByText(/GitHub backups are no longer supported, so nothing is copied here/)).toBeInTheDocument();
    expect(screen.queryByText(/on computers/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull();
  });

  it('a Drive entry says it is not available on this phone, gives Remove, and no "Upload now" menu', async () => {
    asPhone(); stub([DRIVE]);
    render(<SyncSection autoOpen />);
    expect(await screen.findByText('Not available on this phone')).toBeInTheDocument();
    expect(screen.getByText(/Google Drive backup needs a computer. Nothing is copied from this phone/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByText('Backed up')).toBeNull();
  });

  it('has no "Back up all now" when every saved backup is one that cannot run here', async () => {
    asPhone(); stub([DRIVE, GITHUB]);
    render(<SyncSection autoOpen />);
    await screen.findByText('Not available on this phone');
    expect(screen.queryByRole('button', { name: /Back up all now/ })).toBeNull();
  });

  it('offers no way to add a backup (no Add a backup button, no inline Drive / iCloud picker)', async () => {
    asPhone(); stub([GITHUB]);
    render(<SyncSection autoOpen />);
    await screen.findByText('No longer supported');
    expect(screen.queryByRole('button', { name: /Add a backup/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Google Drive/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /iCloud/ })).toBeNull();
  });

  it('with no entries at all, the optional second-copy card is not shown (nothing in it could be used)', async () => {
    asPhone(); stub([]);
    render(<SyncSection autoOpen />);
    await screen.findByText(/Backup/i);
    expect(screen.queryByText('Keep a second copy')).toBeNull();
  });
});

// The "Keep a second copy" card's own on/off switch: the nearest switch around its title.
async function secondCopySwitch(): Promise<HTMLElement> {
  let node: HTMLElement | null = await screen.findByText('Keep a second copy');
  while (node) {
    const sw = node.querySelector('[role="switch"]') as HTMLElement | null;
    if (sw) return sw;
    node = node.parentElement;
  }
  throw new Error('no switch found');
}

describe('Backup & sync elsewhere', () => {
  it('a phone paired to a computer keeps Google Drive in the inline picker and its Drive rows work', async () => {
    asPairedPhone(); stub([DRIVE]);
    render(<SyncSection autoOpen />);
    expect(await screen.findByText(/Backed up/)).toBeInTheDocument();
    expect(screen.queryByText('Not available on this phone')).toBeNull();
    expect(screen.getByRole('button', { name: /Add a backup/ })).toBeInTheDocument();
  });

  it('a computer\'s GitHub entry keeps the wording it already has ("on computers")', async () => {
    asDesktop('MacIntel'); stub([GITHUB]);
    render(<SyncSection autoOpen />);
    expect(await screen.findByText(/GitHub backups are no longer supported on computers/)).toBeInTheDocument();
  });

  it('the inline picker does not offer iCloud on Linux, where there is no iCloud', async () => {
    asDesktop('Linux');
    // masterOn with no destinations: turn the card on through its switch.
    stub([]);
    render(<SyncSection autoOpen />);
    fireEvent.click(await secondCopySwitch());
    expect(await screen.findByRole('button', { name: /Google Drive/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /iCloud/ })).toBeNull();
  });

  it('the inline picker still offers iCloud on a Mac', async () => {
    asDesktop('MacIntel'); stub([]);
    render(<SyncSection autoOpen />);
    fireEvent.click(await secondCopySwitch());
    expect(await screen.findByRole('button', { name: /iCloud/ })).toBeInTheDocument();
  });
});

describe('"Sign in again" repairs the same Drive backup', () => {
  const EXPIRED = {
    code: 'AUTH_EXPIRED', level: 'danger', backendId: 'drive-1', title: 'Google Drive sign-in expired', body: 'Sign in again.',
    fixAction: { label: 'Sign in again', kind: 'open-sync-setup', payload: { backendId: 'drive-1' } }, dismissible: false, createdEpoch: 0,
  };
  const failing = { ...DRIVE, lastError: 'Google Drive sign-in expired' };

  async function openReconnect(api: any) {
    asDesktop('MacIntel');
    render(<SyncSection autoOpen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect to Google' }));
    return api;
  }

  it('signs the existing connection in again, adds no second entry, skips the settings page, and re-uploads that backup', async () => {
    const api = stub([failing], [EXPIRED]);
    await openReconnect(api);
    await waitFor(() => expect(api.pushBackend).toHaveBeenCalledWith('drive-1'));
    expect(api.setup.authGdrive).toHaveBeenCalledWith('gdrive'); // the entry's own connection, by name
    expect(api.addBackend).not.toHaveBeenCalled();
    expect(api.updateBackend).not.toHaveBeenCalled(); // same name: nothing to change
    expect(screen.queryByRole('button', { name: 'Start backup' })).toBeNull(); // no Configure page
  });

  it('points the entry at the new connection name only if sign-in answered with a different one', async () => {
    const api = stub([failing], [EXPIRED], { setup: { checkPrereqs: vi.fn(), authGdrive: vi.fn(async () => ({ success: true, remoteName: 'gdrive3' })) } });
    await openReconnect(api);
    await waitFor(() => expect(api.updateBackend).toHaveBeenCalledWith('drive-1', { config: { rcloneRemote: 'gdrive3' } }));
    expect(api.addBackend).not.toHaveBeenCalled();
  });

  it('a sign-in that fails changes nothing and shows its reason', async () => {
    const api = stub([failing], [EXPIRED], { setup: { checkPrereqs: vi.fn(), authGdrive: vi.fn(async () => ({ success: false, error: 'Google sign-in was closed.' })) } });
    await openReconnect(api);
    expect(await screen.findByText(/Google sign-in was closed/)).toBeInTheDocument();
    expect(api.addBackend).not.toHaveBeenCalled();
    expect(api.updateBackend).not.toHaveBeenCalled();
    expect(api.pushBackend).not.toHaveBeenCalled();
  });
});
