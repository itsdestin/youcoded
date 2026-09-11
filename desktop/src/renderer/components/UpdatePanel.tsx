// UpdatePanel.tsx — L2 overlay opened from the StatusBar version pill.
// Two modes driven by updateStatus.update_available:
//   - true  → "Update available" + Update Now button + changelog entries since current version
//   - false → "What's new" + full changelog, no button
// Cache lives main-side (see changelog-service.ts).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateLaunchResult } from '../../shared/update-install-types';
import { createPortal } from 'react-dom';
import MarkdownContent from './MarkdownContent';
import { Button, Dialog, LoadingState, ProgressBar } from './ui';

// Error codes where a fresh download might succeed (transient or file-level).
// The complement (dmg-corrupt, appimage-not-writable, unsupported-platform,
// remote-unsupported, url-rejected, spawn-failed, busy, signature-invalid) won't
// benefit from retry — the user's best move is the browser fallback link.
// 'verify-failed' IS retriable: a corrupted download can succeed next time (the
// main process deletes the bad file so Retry re-downloads it). 2026-09-10 #7.
const RETRIABLE_ERROR_CODES = new Set(['network-failed', 'disk-full', 'file-missing', 'verify-failed']);
function isRetriableErrorCode(code: string): boolean {
  return RETRIABLE_ERROR_CODES.has(code);
}

// Codes with their own message. Everything else falls back to 'Launch failed'.
// 2026-09-10 security review #7: verification failures get honest, specific copy
// instead of the generic launch error.
function updateErrorMessage(code: string): string {
  if (code === 'signature-invalid') return "This update couldn't be verified, so it wasn't installed. Your current version still works.";
  if (code === 'verify-failed') return 'The download looked corrupted — Retry';
  return 'Launch failed';
}

interface UpdateStatus {
  current: string;
  latest: string;
  update_available: boolean;
  download_url: string | null;
}

// Mirrors ChangelogIpcResult in preload.ts (which mirrors ChangelogResult in
// main/changelog-service.ts). Four-way mirror — when you edit one, edit all four.
// Not covered by the IPC-parity test; drift is silent until runtime shape mismatch.
interface ChangelogEntry { version: string; date?: string; body: string; }

interface ChangelogData {
  markdown: string | null;
  entries: ChangelogEntry[];
  fromCache: boolean;
  error?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  updateStatus: UpdateStatus;
}

export default function UpdatePanel({ open, onClose, updateStatus }: Props) {
  const [data, setData] = useState<ChangelogData | null>(null);
  const [loading, setLoading] = useState(false);

  // Escape-to-close, matching AboutPopup/PreferencesPopup convention.
  // When the planned useEscClose stack lands, migrate alongside those popups.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Fetch changelog when popup opens. forceRefresh only when an update is available —
  // the up-to-date path uses cache unless the app version changed (cache invalidates itself).
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    window.claude.update
      .changelog({ forceRefresh: updateStatus.update_available })
      .then((res: ChangelogData) => setData(res))
      .catch(() => setData({ markdown: null, entries: [], fromCache: false, error: true }))
      .finally(() => setLoading(false));
  }, [open, updateStatus.update_available]);

  // ── Install state machine ────────────────────────────────────────────────
  type InstallState =
    | { kind: 'idle' }
    | { kind: 'downloading'; jobId: string | null; percent: number }
    | { kind: 'ready'; jobId: string; filePath: string }
    | { kind: 'launching' }
    | { kind: 'error'; code: string };

  const [installState, setInstallState] = useState<InstallState>({ kind: 'idle' });
  // Ref rather than state because the progress handler fires asynchronously and
  // we want the freshest jobId without re-subscribing.
  const activeJobIdRef = useRef<string | null>(null);
  // Aborted-close guard: if the user closes the popup mid-download and the
  // download() promise still resolves afterwards (cancel didn't race in time),
  // we must NOT setInstallState(ready) — that would leave stale "Launch Installer"
  // state showing on next open.
  const abortedRef = useRef(false);

  // Subscribe to download progress. Main broadcasts progress to every window;
  // we rely on the main-side single-job invariant (only one download in flight
  // at a time) so any progress event during `downloading` state is ours.
  // The jobId is captured lazily from the first progress event, since
  // `window.claude.update.download()` doesn't return its jobId until it resolves.
  // We preserve the raw `percent` (including the -1 sentinel for unknown
  // Content-Length) so the button can render an indeterminate "Downloading…"
  // label — don't clamp here.
  useEffect(() => {
    const unsub = window.claude.update.onProgress((ev) => {
      setInstallState(prev => {
        if (prev.kind !== 'downloading') return prev;
        if (!activeJobIdRef.current) activeJobIdRef.current = ev.jobId;
        return { kind: 'downloading', jobId: ev.jobId, percent: ev.percent };
      });
    });
    return unsub;
  }, []);

  // When the popup opens and a completed download is already cached for this
  // version, jump straight to ready state (skip the re-download).
  // Guard: only overwrite state if we're still in `idle` — don't race against
  // a user-initiated download that already started.
  useEffect(() => {
    if (!open) return;
    if (!updateStatus.update_available) return;
    let cancelled = false;
    (async () => {
      const cached = await window.claude.update.getCachedDownload(updateStatus.latest);
      if (cancelled || !cached) return;
      setInstallState(prev => prev.kind === 'idle'
        ? { kind: 'ready', jobId: 'cached', filePath: cached.filePath }
        : prev);
    })();
    return () => { cancelled = true; };
  }, [open, updateStatus.update_available, updateStatus.latest]);

  // When the popup opens/closes, manage the abortedRef + cancel any in-flight
  // download. Main's cancelDownload is a no-op if the job isn't active, so we
  // don't need to check installState — keeping this effect's deps to [open] only.
  useEffect(() => {
    if (open) {
      // Fresh open — clear the abort flag so a new download can resolve.
      abortedRef.current = false;
      return;
    }
    // Close — signal abort, cancel any in-flight download, reset to idle.
    abortedRef.current = true;
    if (activeJobIdRef.current) {
      window.claude.update.cancel(activeJobIdRef.current);
      activeJobIdRef.current = null;
    }
    setInstallState({ kind: 'idle' });
  }, [open]);

  const runLaunch = useCallback(async (jobId: string, filePath: string) => {
    setInstallState({ kind: 'launching' });
    const result: UpdateLaunchResult = await window.claude.update.launch(jobId, filePath);
    if (!result.success) {
      setInstallState({ kind: 'error', code: result.error });
      return;
    }
    if ('fallback' in result && result.fallback === 'browser') {
      // .deb or missing-APPIMAGE — browser opened; close the popup.
      onClose();
      return;
    }
    // Happy path: main process will app.quit() in ~500ms. Leave the button in
    // "launching" state — the app is about to disappear.
  }, [onClose]);

  const handleUpdate = useCallback(async () => {
    // If we already have a ready job, skip straight to launch.
    if (installState.kind === 'ready') {
      await runLaunch(installState.jobId, installState.filePath);
      return;
    }
    // Otherwise kick off a download. Preserve raw percent sentinel (-1 means
    // Content-Length unknown) so the label shows the indeterminate branch.
    try {
      setInstallState({ kind: 'downloading', jobId: null, percent: -1 });
      const result = await window.claude.update.download();
      // Guard: if the popup closed during the download, don't leave stale
      // "Launch Installer" state showing on next open.
      if (abortedRef.current) return;
      activeJobIdRef.current = result.jobId;
      setInstallState({ kind: 'ready', jobId: result.jobId, filePath: result.filePath });
    } catch (e: any) {
      if (abortedRef.current) return;
      const code = typeof e?.message === 'string' ? (e.message.split(':')[0] || 'network-failed') : 'network-failed';
      setInstallState({ kind: 'error', code });
    }
  }, [installState, runLaunch]);

  const handleFallbackBrowser = useCallback(async () => {
    if (updateStatus.download_url) {
      await window.claude.shell.openExternal(updateStatus.download_url);
    }
    onClose();
  }, [onClose, updateStatus.download_url]);
  // ────────────────────────────────────────────────────────────────────────

  if (!open) return null;

  const handleOpenOnGithub = async () => {
    await window.claude.shell.openChangelog();
  };

  // Body selection:
  //   update_available → entries newer than current; if filter is empty (changelog lags release), fall back to the newest entry
  //   otherwise       → full markdown, rendered as one block
  let body: React.ReactNode;
  if (data?.error || (!loading && data !== null && !data.markdown && !data.entries?.length)) {
    body = (
      <div className="text-fg-dim text-sm py-8 text-center">
        Couldn't load changelog.{' '}
        <button onClick={handleOpenOnGithub} className="underline hover:text-fg">Open on GitHub</button>
      </div>
    );
  } else if (loading || !data) {
    body = <LoadingState what="changelog" />;
  } else if (updateStatus.update_available) {
    // Filter by CHRONOLOGICAL position, not semver. CHANGELOG.md is authored
    // top-newest-bottom-oldest, so source order is release order. Semver math breaks
    // when a project resets its version numbers (e.g. YouCoded went 2.4.0 → 1.0.0);
    // "older" entries can semver-compare as "newer." Position-based filter handles
    // resets correctly.
    const currentIdx = data.entries.findIndex(e => e.version === updateStatus.current);
    let shown: ChangelogEntry[];
    if (currentIdx === -1) {
      // User's current version isn't in the changelog (never-released local build,
      // stale file, etc.) — fall back to newest entry only.
      shown = data.entries.length > 0 ? [data.entries[0]] : [];
    } else if (currentIdx === 0) {
      // User is already at the top of the file — no newer entries. Fall back to the
      // newest so the popup isn't empty when `update_available` is true (e.g. the
      // CHANGELOG lags a fresh release).
      shown = [data.entries[0]];
    } else {
      shown = data.entries.slice(0, currentIdx);
    }
    body = (
      <div className="space-y-6">
        {shown.map(e => (
          <section key={e.version}>
            <h2 className="text-lg font-semibold mb-2">
              v{e.version}
              {e.date && <span className="text-fg-dim font-normal ml-2">{e.date}</span>}
            </h2>
            <MarkdownContent content={e.body} />
          </section>
        ))}
      </div>
    );
  } else if (data.markdown) {
    body = <MarkdownContent content={data.markdown} />;
  }

  return createPortal(
    <>
      <Dialog
        open
        onClose={onClose}
        size="document"
        title={updateStatus.update_available ? 'Update available' : "What's new"}
        scrollBody={false}
      >
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">{body}</div>
        {updateStatus.update_available && (
          <footer className="px-5 py-3 border-t border-edge-dim flex flex-col items-end">
            {/* Change 46: download progress gets a real bar. It used to live only
                as a percentage inside the (disabled, therefore dimmed) button
                label, which is the one place a user is least likely to watch.
                The -1 sentinel means the server sent no Content-Length, so there
                is genuinely nothing to plot — the button's "Downloading…" text
                covers that case and no bar is rendered. */}
            {installState.kind === 'downloading' && installState.percent >= 0 && (
              <ProgressBar
                percent={installState.percent}
                showLabel
                aria-label="Download progress"
                className="w-full mb-2"
              />
            )}
            <Button
              size="lg"
              onClick={handleUpdate}
              disabled={
                installState.kind === 'downloading' ||
                installState.kind === 'launching' ||
                // Disable "retry" for errors where a fresh download won't help.
                (installState.kind === 'error' && !isRetriableErrorCode(installState.code))
              }
            >
              {installState.kind === 'idle' && `Update Now: v${updateStatus.current} → v${updateStatus.latest}`}
              {installState.kind === 'downloading' && (
                installState.percent >= 0 ? `Downloading ${installState.percent}%…` : 'Downloading…'
              )}
              {installState.kind === 'ready' && 'Launch Installer'}
              {installState.kind === 'launching' && 'Launching…'}
              {installState.kind === 'error' && (
                // A blocked/unverifiable update, a corrupt download that a retry
                // may fix, and a launch failure each read differently.
                installState.code === 'signature-invalid' ? 'Update blocked'
                  : installState.code === 'verify-failed' ? 'Retry download'
                  : isRetriableErrorCode(installState.code) ? 'Download failed — Retry'
                  : 'Launch failed'
              )}
            </Button>
            {/* No browser fallback for a VERIFICATION failure: handleFallbackBrowser
                opens download_url — the raw installer binary — which for a
                verify-failed (sha256/size mismatch, i.e. the installer was swapped
                after signing) is the very tampered file the gate just refused.
                Offering it there would reopen the attack outside the app. Retry
                (which re-downloads and re-verifies) is the only safe move; a
                signature-invalid shows an explanation instead. 2026-09-10 #7 review. */}
            {installState.kind === 'error' && installState.code !== 'verify-failed' && (
              <div className="text-xs mt-2">
                {installState.code === 'signature-invalid' ? (
                  <p className="text-amber-400">{updateErrorMessage('signature-invalid')}</p>
                ) : (
                  <button
                    onClick={handleFallbackBrowser}
                    className="text-fg-dim underline hover:text-fg"
                  >
                    Open in browser instead
                  </button>
                )}
              </div>
            )}
          </footer>
        )}
      </Dialog>
    </>,
    document.body,
  );
}
