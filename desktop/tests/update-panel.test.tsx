// @vitest-environment jsdom
// update-panel.test.tsx — tests for the StatusBar version pill popup.
//
// Covers the two display modes (update available vs up-to-date), the forceRefresh
// flag passed to the changelog IPC, the filter-with-fallback logic when the
// changelog lags a release, error fallback to Open on GitHub, and close behavior.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import UpdatePanel from '../src/renderer/components/UpdatePanel';

// WHY: createPortal renders into document.body — cleanup after each test prevents
// DOM accumulation that causes "multiple elements found" errors in subsequent tests.
afterEach(cleanup);

type Status = {
  current: string;
  latest: string;
  update_available: boolean;
  download_url: string | null;
};

const UPDATE_STATUS_AVAILABLE: Status = {
  current: '1.1.1',
  latest: '1.1.2',
  update_available: true,
  download_url: 'https://example.com/YouCoded-1.1.2-setup.exe',
};

const UPDATE_STATUS_OK: Status = {
  current: '1.1.2',
  latest: '1.1.2',
  update_available: false,
  download_url: null,
};

const CHANGELOG_OK = {
  markdown: `# Changelog

## [1.1.2] — 2026-04-21
### Added
- Thing B

## [1.1.1] — 2026-04-18
### Fixed
- Thing A
`,
  entries: [
    { version: '1.1.2', date: '2026-04-21', body: '### Added\n- Thing B' },
    { version: '1.1.1', date: '2026-04-18', body: '### Fixed\n- Thing A' },
  ],
  fromCache: false,
};

const CHANGELOG_ERROR = { markdown: null, entries: [], fromCache: false, error: true };

beforeEach(() => {
  (window as any).claude = {
    update: { changelog: vi.fn().mockResolvedValue(CHANGELOG_OK) },
    shell: {
      openExternal: vi.fn().mockResolvedValue(undefined),
      openChangelog: vi.fn().mockResolvedValue(undefined),
    },
  };
});

describe('UpdatePanel — update available', () => {
  it('renders "Update available" header and Update Now button', async () => {
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_AVAILABLE} />);
    await waitFor(() => expect(screen.getByText(/update available/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /update now.*1\.1\.1.*1\.1\.2/i })).toBeInTheDocument();
  });

  it('calls changelog with forceRefresh=true when update is available', async () => {
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_AVAILABLE} />);
    await waitFor(() => expect((window as any).claude.update.changelog).toHaveBeenCalledWith({ forceRefresh: true }));
  });

  it('Update Now button calls shell.openExternal and closes', async () => {
    const onClose = vi.fn();
    render(<UpdatePanel open={true} onClose={onClose} updateStatus={UPDATE_STATUS_AVAILABLE} />);
    const btn = await screen.findByRole('button', { name: /update now/i });
    fireEvent.click(btn);
    expect((window as any).claude.shell.openExternal).toHaveBeenCalledWith(UPDATE_STATUS_AVAILABLE.download_url);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('filters entries to those newer than current version', async () => {
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_AVAILABLE} />);
    // Current is 1.1.1 → only 1.1.2 should be rendered.
    await waitFor(() => expect(screen.getByText(/Thing B/)).toBeInTheDocument());
    expect(screen.queryByText(/Thing A/)).not.toBeInTheDocument();
  });

  it('falls back to rendering the newest entry when filter returns empty (changelog lags release)', async () => {
    // Current is already 1.1.2, but update_available is true — filter returns [] → fallback.
    const offStatus = { ...UPDATE_STATUS_AVAILABLE, current: '1.1.2', latest: '1.1.3' };
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={offStatus} />);
    await waitFor(() => expect(screen.getByText(/Thing B/)).toBeInTheDocument());
  });

  it('handles version resets by using CHANGELOG position rather than semver math', async () => {
    // YouCoded-style reset: 2.4.0 pre-reset is chronologically OLDER than current 1.1.2
    // even though semver says 2.4.0 > 1.1.2. Filter must use position, not semver.
    const resetChangelog = {
      markdown: '# Changelog',
      entries: [
        { version: '1.1.2', date: '2026-04-21', body: 'current' },
        { version: '1.1.1', date: '2026-04-20', body: 'pre-current 1.1.1' },
        { version: '1.0.0', date: '2026-04-15', body: 'renumbered to 1.0.0' },
        { version: '2.4.0', date: '2026-04-10', body: 'pre-reset 2.4.0 — MUST NOT APPEAR' },
        { version: '2.3.0', date: '2026-04-05', body: 'pre-reset 2.3.0 — MUST NOT APPEAR' },
      ],
      fromCache: false,
    };
    (window as any).claude.update.changelog.mockResolvedValue(resetChangelog);
    const status = { current: '1.1.1', latest: '1.1.2', update_available: true, download_url: 'http://x' };
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={status} />);
    // User is on 1.1.1 (index 1). Entries above it: [1.1.2]. Pre-reset entries MUST NOT be shown.
    await waitFor(() => expect(screen.getByText(/current/)).toBeInTheDocument());
    expect(screen.queryByText(/pre-reset 2\.4\.0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pre-reset 2\.3\.0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/pre-current 1\.1\.1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/renumbered to 1\.0\.0/)).not.toBeInTheDocument();
  });
});

describe('UpdatePanel — up to date', () => {
  it('renders "What\'s new" header and no Update Now button', async () => {
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_OK} />);
    await waitFor(() => expect(screen.getByText(/what'?s new/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /update now/i })).not.toBeInTheDocument();
  });

  it('calls changelog with forceRefresh=false when up to date', async () => {
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_OK} />);
    await waitFor(() => expect((window as any).claude.update.changelog).toHaveBeenCalledWith({ forceRefresh: false }));
  });

  it('renders full changelog markdown (both entries visible)', async () => {
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_OK} />);
    await waitFor(() => expect(screen.getByText(/Thing B/)).toBeInTheDocument());
    expect(screen.getByText(/Thing A/)).toBeInTheDocument();
  });
});

describe('UpdatePanel — error states', () => {
  it('shows Open on GitHub fallback link when IPC returns error=true', async () => {
    (window as any).claude.update.changelog.mockResolvedValue(CHANGELOG_ERROR);
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_OK} />);
    const link = await screen.findByRole('button', { name: /open on github/i });
    fireEvent.click(link);
    expect((window as any).claude.shell.openChangelog).toHaveBeenCalled();
  });

  it('Update Now button stays visible even when changelog failed to load', async () => {
    (window as any).claude.update.changelog.mockResolvedValue(CHANGELOG_ERROR);
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_AVAILABLE} />);
    expect(await screen.findByRole('button', { name: /update now/i })).toBeInTheDocument();
  });
});

describe('UpdatePanel — close behavior', () => {
  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();
    render(<UpdatePanel open={true} onClose={onClose} updateStatus={UPDATE_STATUS_OK} />);
    await screen.findByText(/what'?s new/i);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not fetch when open=false', () => {
    render(<UpdatePanel open={false} onClose={() => {}} updateStatus={UPDATE_STATUS_OK} />);
    expect((window as any).claude.update.changelog).not.toHaveBeenCalled();
  });
});
