// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import UpdatePanel from '../src/renderer/components/UpdatePanel';

// The StatusBar version pill popup.
//
// Covers the two display modes (update available vs up-to-date), the forceRefresh
// flag passed to the changelog IPC, the filter-with-fallback logic when the
// changelog lags a release, error fallback to Open on GitHub, and close behavior.
describe('UpdatePanel — the version pill popup', () => {
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
      update: {
        changelog: vi.fn().mockResolvedValue(CHANGELOG_OK),
        // New methods — no-op defaults so UpdatePanel's useEffects don't crash in tests.
        onProgress: vi.fn().mockReturnValue(() => {}),
        onInstallProgress: vi.fn().mockReturnValue(() => {}),
        getCachedDownload: vi.fn().mockResolvedValue(null),
        download: vi.fn().mockResolvedValue({ jobId: 'test-job', filePath: '/tmp/YouCoded-setup.exe', bytesTotal: 0 }),
        cancel: vi.fn().mockResolvedValue({ success: true }),
        launch: vi.fn().mockResolvedValue({ success: true, quitPending: true }),
      },
      shell: {
        openExternal: vi.fn().mockResolvedValue(undefined),
        openChangelog: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  describe('UpdatePanel — update available', () => {
    it('renders "Update available" header and Update now button', async () => {
      render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_AVAILABLE} />);
      await waitFor(() => expect(screen.getByText(/update available/i)).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /update now.*1\.1\.1.*1\.1\.2/i })).toBeInTheDocument();
    });

    it('calls changelog with forceRefresh=true when update is available', async () => {
      render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_AVAILABLE} />);
      await waitFor(() => expect((window as any).claude.update.changelog).toHaveBeenCalledWith({ forceRefresh: true }));
    });

    it('Update now button kicks off download then shows Launch installer', async () => {
      // Behavior changed from Task 11: clicking no longer opens the browser directly —
      // it starts the download flow. After download() resolves the button shows "Launch installer".
      const onClose = vi.fn();
      render(<UpdatePanel open={true} onClose={onClose} updateStatus={UPDATE_STATUS_AVAILABLE} />);
      const btn = await screen.findByRole('button', { name: /update now/i });
      fireEvent.click(btn);
      expect((window as any).claude.update.download).toHaveBeenCalled();
      await waitFor(() => expect(screen.getByRole('button', { name: /launch installer/i })).toBeInTheDocument());
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
    it('renders "What\'s new" header and no Update now button', async () => {
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

    it('Update now button stays visible even when changelog failed to load', async () => {
      (window as any).claude.update.changelog.mockResolvedValue(CHANGELOG_ERROR);
      render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_AVAILABLE} />);
      expect(await screen.findByRole('button', { name: /update now/i })).toBeInTheDocument();
    });

    it('signature-invalid: blocks the update, explains, and offers NO browser fallback', async () => {
      (window as any).claude.update.launch.mockResolvedValue({ success: false, error: 'signature-invalid' });
      render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_AVAILABLE} />);
      fireEvent.click(await screen.findByRole('button', { name: /update now/i }));
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));
      await waitFor(() => expect(screen.getByRole('button', { name: /update blocked/i })).toBeInTheDocument());
      // The disabled button can't be retried, the honest sentence is shown, and the
      // "Open in browser instead" workaround is deliberately absent.
      expect(screen.getByRole('button', { name: /update blocked/i })).toBeDisabled();
      expect(screen.getByText(/couldn't be verified/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /open in browser instead/i })).not.toBeInTheDocument();
    });

    it('verify-failed: offers a retry but NOT the raw-binary browser fallback', async () => {
      (window as any).claude.update.launch.mockResolvedValue({ success: false, error: 'verify-failed' });
      render(<UpdatePanel open={true} onClose={() => {}} updateStatus={UPDATE_STATUS_AVAILABLE} />);
      fireEvent.click(await screen.findByRole('button', { name: /update now/i }));
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));
      // small-fixes-1#SF-1: the reason is a sentence; the button reads exactly "Try again".
      expect(await screen.findByText("The download was damaged, so it wasn't installed.")).toBeInTheDocument();
      const retry = screen.getByRole('button', { name: 'Try again' });
      expect(retry).toBeEnabled();
      // The "Open in browser instead" link opens the raw installer — the very file
      // that failed verification — so it must be absent here.
      expect(screen.queryByRole('button', { name: /open in browser instead/i })).not.toBeInTheDocument();
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
});

/**
 * The update button names the step that actually failed.
 *
 * Error inventory 2026-09-10, false message 17: a failed DOWNLOAD read "Launch failed"
 * with the button disabled. The panel read the error code as the text before the first
 * colon — but on desktop a rejected invoke arrives as
 * "Error invoking remote method 'update:download': network-failed: …", so the "code"
 * was "Error invoking remote method 'update", matched nothing, and every download
 * failure fell into the can't-retry branch, labelled as a launch that never happened.
 * A plain network blip — the one failure a second try usually fixes — lost its Retry.
 */
describe('UpdatePanel — the update button after a failure', () => {
  const STATUS = { current: '1.1.1', latest: '1.1.2', update_available: true, download_url: 'https://example.com/YouCoded-1.1.2-setup.exe' };

  // The exact shape Electron gives a handler's thrown UpdateInstallError
  // (update-installer.ts: `super(detail ? \`${code}: ${detail}\` : code)`).
  // Electron replies with the thrown error's toString(), and UpdateInstallError sets `name`,
  // so the real text carries "UpdateInstallError: " after the wrapper. The first version of
  // this fixture left that out and passed a fix that never read a code (code review
  // 2026-09-11, F2/F3).
  const wrapped = (code: string, detail: string) =>
    new Error(`Error invoking remote method 'update:download': UpdateInstallError: ${code}: ${detail}`);

  beforeEach(() => {
    (window as any).claude = {
      update: {
        changelog: vi.fn().mockResolvedValue({ markdown: null, entries: [], fromCache: false }),
        onProgress: vi.fn().mockReturnValue(() => {}),
        onInstallProgress: vi.fn().mockReturnValue(() => {}),
        getCachedDownload: vi.fn().mockResolvedValue(null),
        download: vi.fn().mockResolvedValue({ jobId: 'job', filePath: '/tmp/YouCoded-setup.exe', bytesTotal: 0 }),
        cancel: vi.fn().mockResolvedValue({ success: true }),
        launch: vi.fn().mockResolvedValue({ success: true, quitPending: true }),
      },
      shell: { openExternal: vi.fn(), openChangelog: vi.fn() },
    };
  });
  afterEach(() => { cleanup(); delete (window as any).claude; });

  async function clickUpdate() {
    render(<UpdatePanel open={true} onClose={() => {}} updateStatus={STATUS} />);
    fireEvent.click(await screen.findByRole('button', { name: /update now/i }));
  }

  describe('UpdatePanel — the failure label names the failed step', () => {
    it('a network failure during download offers Retry, not "Launch failed"', async () => {
      (window as any).claude.update.download = vi.fn().mockRejectedValue(wrapped('network-failed', 'getaddrinfo ENOTFOUND github.com'));
      await clickUpdate();

      // small-fixes-1#SF-1: the failure is a sentence in the notice box, the button just "Try again".
      expect(await screen.findByText("The update didn't download.")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
      expect(screen.queryByText(/installer didn't start/i)).toBeNull();
    });

    it('a download refused for a reason retry cannot fix still does not claim a launch', async () => {
      (window as any).claude.update.download = vi.fn().mockRejectedValue(wrapped('busy', 'another download is already active'));
      await clickUpdate();

      // The sentence names the download; no Try again — a retry that cannot help (code review F3).
      expect(await screen.findByText("The update didn't download.")).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Open in browser instead' })).toBeInTheDocument();
      expect(screen.queryByText(/installer didn't start/i)).toBeNull();
    });

    it('a launch that failed is still called a launch failure', async () => {
      (window as any).claude.update.launch = vi.fn().mockResolvedValue({ success: false, error: 'dmg-corrupt' });
      await clickUpdate();
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));

      expect(await screen.findByText("The installer didn't start.")).toBeInTheDocument();
    });
  });

  // A Linux system package (pacman/deb/rpm) is installed with an administrator
  // password. When there is no dialog to ask with, or the install is refused,
  // the one command that finishes it is on screen rather than a dead end.
  describe('UpdatePanel — finishing a Linux package update by hand', () => {
    const COMMAND = 'sudo pacman -U /home/u/.config/youcoded/update-cache/youcoded-1.3.0.pacman';

    beforeEach(() => {
      (window as any).claude.engine = { runInTerminal: vi.fn().mockResolvedValue(undefined) };
    });

    async function launchWith(result: unknown) {
      (window as any).claude.update.launch = vi.fn().mockResolvedValue(result);
      await clickUpdate();
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));
    }

    it('shows the command, and runs it in the terminal on request', async () => {
      await launchWith({ success: true, quitPending: false, fallback: 'manual', command: COMMAND, filePath: '/tmp/x.pacman' });

      expect(await screen.findByText(COMMAND)).toBeInTheDocument();
      expect(screen.getByText(/asks for your password/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /run in terminal/i }));
      await waitFor(() => expect((window as any).claude.engine.runInTerminal).toHaveBeenCalledWith(COMMAND));
    });

    it('shows real installer activity and ignores another job’s output', async () => {
      let finish!: (result: unknown) => void;
      (window as any).claude.update.launch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
      await clickUpdate();
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));
      expect(await screen.findByRole('button', { name: 'Preparing the installer…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Preparing the installer…' })).toHaveClass('w-full');
      const progress = (window as any).claude.update.onInstallProgress.mock.calls[0][0];
      act(() => progress({ jobId: 'other', phase: 'installing', output: 'Unrelated output' }));
      expect(screen.queryByText('Unrelated output')).not.toBeInTheDocument();
      act(() => progress({ jobId: 'job', phase: 'authorizing', output: '' }));
      expect(screen.getByRole('button', { name: 'Waiting for administrator approval…' })).toBeDisabled();
      act(() => progress({ jobId: 'job', phase: 'installing', output: 'upgrading youcoded…' }));
      expect(screen.getByRole('button', { name: 'upgrading youcoded…' })).toBeDisabled();
      expect(screen.queryByText('Details')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Installer output')).not.toBeInTheDocument();
      expect(screen.queryByText(/restarts automatically when installation finishes/i)).not.toBeInTheDocument();
      act(() => progress({ jobId: 'job', phase: 'installing', output: 'upgrading youcoded…\nRunning post-install hooks…\n' }));
      expect(screen.getByRole('button', { name: 'Running post-install hooks…' })).toBeDisabled();
      expect(screen.queryByText('upgrading youcoded…')).not.toBeInTheDocument();
      act(() => progress({ jobId: 'job', phase: 'restarting', output: 'upgrading youcoded…' }));
      await act(async () => finish({ success: true, quitPending: true }));
      expect(screen.getByRole('button', { name: 'Restarting YouCoded…' })).toBeDisabled();
    });

    it('does not preserve a running install after the browser fallback completed', async () => {
      (window as any).claude.update.launch.mockResolvedValue({ success: true, quitPending: false, fallback: 'browser' });
      const onClose = vi.fn();
      const view = render(<UpdatePanel open onClose={onClose} updateStatus={STATUS} />);
      fireEvent.click(await screen.findByRole('button', { name: /update now/i }));
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      view.rerender(<UpdatePanel open={false} onClose={onClose} updateStatus={STATUS} />);
      view.rerender(<UpdatePanel open onClose={onClose} updateStatus={STATUS} />);
      expect(await screen.findByRole('button', { name: /update now/i })).toBeEnabled();
    });

    it('keeps an in-flight install when the popup closes and reopens', async () => {
      (window as any).claude.update.launch = vi.fn(() => new Promise(() => {}));
      const props = { onClose: () => {}, updateStatus: STATUS };
      const view = render(<UpdatePanel open {...props} />);
      fireEvent.click(await screen.findByRole('button', { name: /update now/i }));
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));
      view.rerender(<UpdatePanel open={false} {...props} />);
      view.rerender(<UpdatePanel open {...props} />);
      expect(await screen.findByText('Preparing the installer…')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /update now|launch installer/i })).not.toBeInTheDocument();
      expect((window as any).claude.update.launch).toHaveBeenCalledTimes(1);
    });

    it('restores progress received while the popup was hidden', async () => {
      (window as any).claude.update.launch = vi.fn(() => new Promise(() => {}));
      const props = { onClose: () => {}, updateStatus: STATUS };
      const view = render(<UpdatePanel open {...props} />);
      fireEvent.click(await screen.findByRole('button', { name: /update now/i }));
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));
      const progress = (window as any).claude.update.onInstallProgress.mock.calls[0][0];
      view.rerender(<UpdatePanel open={false} {...props} />);
      act(() => progress({ jobId: 'job', phase: 'installing', output: 'Running post-install hooks…' }));
      view.rerender(<UpdatePanel open {...props} />);
      expect(await screen.findByRole('button', { name: 'Running post-install hooks…' })).toBeDisabled();
      expect(screen.queryByText('Details')).not.toBeInTheDocument();
    });

    it.each(['install-failed', 'install-timeout'])('retains %s received while closed', async (error) => {
      let finish!: (result: unknown) => void;
      (window as any).claude.update.launch = vi.fn(() => new Promise(resolve => { finish = resolve; }));
      const props = { onClose: () => {}, updateStatus: STATUS };
      const view = render(<UpdatePanel open {...props} />);
      fireEvent.click(await screen.findByRole('button', { name: /update now/i }));
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));
      view.rerender(<UpdatePanel open={false} {...props} />);
      await act(async () => finish({ success: false, error, output: 'Last installer output', command: COMMAND }));
      view.rerender(<UpdatePanel open {...props} />);
      expect(await screen.findByText(error === 'install-timeout' ? "Couldn't confirm the installation result." : "Your package manager wouldn't install the update.")).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /launch installer|update now/i })).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Details'));
      expect(screen.getByText('Last installer output')).toBeInTheDocument();
      if (error === 'install-timeout') expect(screen.queryByRole('button', { name: /try again|run in terminal|open in browser/i })).not.toBeInTheDocument();
    });

    it('a rejected launch shows an unknown outcome with the real error, never a stuck button', async () => {
      (window as any).claude.update.launch = vi.fn().mockRejectedValue(new Error('connection closed'));
      await clickUpdate();
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));
      expect(await screen.findByText("Couldn't confirm the installation result.")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Report bug' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Diagnose with the assistant' })).toBeInTheDocument();
      fireEvent.click(screen.getByText('Details'));
      expect(screen.getByText('connection closed')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /open in browser/i })).not.toBeInTheDocument();
    });

    it('a launch refused because another installation is active offers no parallel installation', async () => {
      await launchWith({ success: false, error: 'busy' });
      expect(await screen.findByText('Another update installation is already running.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /try again|run in terminal|open in browser/i })).not.toBeInTheDocument();
    });

    it('an install timeout warns that it may still be running without offering another install', async () => {
      await launchWith({ success: false, error: 'install-timeout', command: COMMAND, output: 'Running post-install hooks…' });
      expect(await screen.findByText("Couldn't confirm the installation result.")).toBeInTheDocument();
      expect(screen.getByText(/may still be running/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /run in terminal|open in browser/i })).not.toBeInTheDocument();
    });

    it('replaces a timed-out outcome with a confirmed late cancellation, even while hidden', async () => {
      (window as any).claude.update.launch.mockResolvedValue({ success: false, error: 'install-timeout' });
      const props = { onClose: () => {}, updateStatus: STATUS };
      const view = render(<UpdatePanel open {...props} />);
      fireEvent.click(await screen.findByRole('button', { name: /update now/i }));
      fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));
      expect(await screen.findByText("Couldn't confirm the installation result.")).toBeInTheDocument();
      const progress = (window as any).claude.update.onInstallProgress.mock.calls[0][0];
      view.rerender(<UpdatePanel open={false} {...props} />);
      act(() => progress({ jobId: 'job', phase: 'failed', error: 'install-cancelled', output: 'Authentication cancelled', command: COMMAND }));
      view.rerender(<UpdatePanel open {...props} />);
      expect(await screen.findByText('The password prompt was closed, so nothing was installed.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
      expect(screen.getByText(COMMAND)).toBeInTheDocument();
      fireEvent.click(screen.getByText('Details'));
      expect(screen.getByText('Authentication cancelled')).toBeInTheDocument();
    });

    it('keeps a failed package manager’s output inside the error’s Details', async () => {
      await launchWith({ success: false, error: 'install-failed', command: COMMAND, output: 'error: failed to lock database' });
      expect(await screen.findByText("Your package manager wouldn't install the update.")).toBeInTheDocument();
      fireEvent.click(screen.getByText('Details'));
      expect(screen.getByText('error: failed to lock database')).toBeInTheDocument();
    });

    it('a dismissed password prompt offers Retry and the command, not a dead end', async () => {
      await launchWith({ success: false, error: 'install-cancelled', command: COMMAND });

      // Retry raises the password dialog again — dismissing it was a choice.
      expect(await screen.findByRole('button', { name: /try again/i })).toBeEnabled();
      expect(screen.getByText(COMMAND)).toBeInTheDocument();
    });

    it('a refused package install says so and still offers the command', async () => {
      await launchWith({ success: false, error: 'install-failed', command: COMMAND });

      expect(await screen.findByText("Your package manager wouldn't install the update.")).toBeInTheDocument();
      expect(screen.getByText(COMMAND)).toBeInTheDocument();
    });

    it('shows no command block on platforms that never send one', async () => {
      await launchWith({ success: false, error: 'dmg-corrupt' });

      expect(await screen.findByText("The installer didn't start.")).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /run in terminal/i })).toBeNull();
    });
  });
});
