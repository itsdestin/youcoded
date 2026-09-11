// @vitest-environment jsdom
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
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import UpdatePanel from '../src/renderer/components/UpdatePanel';

const STATUS = { current: '1.1.1', latest: '1.1.2', update_available: true, download_url: 'https://example.com/YouCoded-1.1.2-setup.exe' };

// The exact shape Electron gives a handler's thrown UpdateInstallError
// (update-installer.ts: `super(detail ? \`${code}: ${detail}\` : code)`).
const wrapped = (code: string, detail: string) =>
  new Error(`Error invoking remote method 'update:download': ${code}: ${detail}`);

beforeEach(() => {
  (window as any).claude = {
    update: {
      changelog: vi.fn().mockResolvedValue({ markdown: null, entries: [], fromCache: false }),
      onProgress: vi.fn().mockReturnValue(() => {}),
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

    const button = await screen.findByRole('button', { name: /download failed/i });
    expect(button).toBeEnabled();
    expect(screen.queryByText(/launch failed/i)).toBeNull();
  });

  it('a download refused for a reason retry cannot fix still does not claim a launch', async () => {
    (window as any).claude.update.download = vi.fn().mockRejectedValue(wrapped('busy', 'another download is already active'));
    await clickUpdate();

    await waitFor(() => expect(screen.getByRole('button', { name: /download failed/i })).toBeInTheDocument());
    expect(screen.queryByText(/launch failed/i)).toBeNull();
  });

  it('a launch that failed is still called a launch failure', async () => {
    (window as any).claude.update.launch = vi.fn().mockResolvedValue({ success: false, error: 'dmg-corrupt' });
    await clickUpdate();
    fireEvent.click(await screen.findByRole('button', { name: /launch installer/i }));

    expect(await screen.findByRole('button', { name: /launch failed/i })).toBeInTheDocument();
  });
});
