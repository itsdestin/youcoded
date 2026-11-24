// @vitest-environment jsdom
// The optional status-bar "Backing up…" chip (backup fixes 2026-11-18, B-1). Whether it ships is Destin's pick after
// comparing pictures; these tests pin that it is OFF by default, and that when switched on it appears only while a
// copy is really running and rides the existing sync switch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render as rtlRender, screen, cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';
import { makeStoreWrapper } from './helpers/chat-store-harness';

// Switch the shipping constant on for the render tests below; the pure function and the default are tested separately.
vi.mock('../src/renderer/state/backup-progress', async (orig) => ({ ...(await orig<typeof import('../src/renderer/state/backup-progress')>()), BACKUP_PROGRESS_CHIP_ENABLED: true }));

import StatusBar from '../src/renderer/components/StatusBar';
import { showBackupProgressChip } from '../src/renderer/state/backup-progress';

function render(ui: ReactElement) { return rtlRender(ui, { wrapper: makeStoreWrapper(['s1']).wrapper }); }
afterEach(cleanup);
beforeEach(() => {
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; }, setItem(k: string, v: string) { this._s[k] = v; }, removeItem(k: string) { delete this._s[k]; },
  };
  (window as any).claude = { tags: { list: async () => [] }, session: { getMeta: async () => ({}) }, on: { tagsChanged: () => () => {}, sessionMetaChanged: () => () => {} } };
});

const base = { usage: null, updateStatus: null, announcement: null, contextPercent: null, gitBranch: null, sessionStats: null, syncWarnings: [] } as any;
const bar = (data: any, onOpenSync?: () => void) => render(<StatusBar statusData={data} provider="claude" sessionId="s1" nativeTotals={null} onOpenSync={onOpenSync} />);

describe('the "Backing up…" chip (switched on)', () => {
  it('shows while a backup copy is running, and a click opens Backup & sync', () => {
    const open = vi.fn();
    bar({ ...base, copyingBackendIds: ['drive-1'] }, open);
    screen.getByRole('button', { name: 'Backing up…' }).click();
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('is not drawn when nothing is copying', () => {
    bar({ ...base, copyingBackendIds: [] });
    expect(screen.queryByText('Backing up…')).toBeNull();
    cleanup();
    bar(base); // an older backend that never sends the field
    expect(screen.queryByText('Backing up…')).toBeNull();
  });
  it('sits beside, not instead of, a sync failure pill', () => {
    bar({ ...base, copyingBackendIds: ['drive-1'], syncWarnings: [{ code: 'X', level: 'danger', title: 't', body: 'b', dismissible: false, createdEpoch: 1 }] });
    expect(screen.getByText('Backing up…')).toBeTruthy();
    expect(screen.getByText('Sync failing')).toBeTruthy();
  });
});

describe('what ships', () => {
  it('the chip is OFF by default until Destin picks it (flip BACKUP_PROGRESS_CHIP_ENABLED to ship it)', async () => {
    const real = await vi.importActual<typeof import('../src/renderer/state/backup-progress')>('../src/renderer/state/backup-progress');
    expect(real.BACKUP_PROGRESS_CHIP_ENABLED).toBe(false);
  });
  it('is drawn only when enabled AND something is copying', () => {
    expect(showBackupProgressChip(['a'], false)).toBe(false);
    expect(showBackupProgressChip([], true)).toBe(false);
    expect(showBackupProgressChip(undefined, true)).toBe(false);
    expect(showBackupProgressChip(['a'], true)).toBe(true);
  });
});
