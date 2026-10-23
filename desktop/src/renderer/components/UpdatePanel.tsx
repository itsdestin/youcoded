// UpdatePanel.tsx — L2 overlay opened from the StatusBar version pill.
// Two modes driven by updateStatus.update_available:
//   - true  → "Update available" + Update now button + changelog entries since current version
//   - false → "What's new" + full changelog, no button
// Cache lives main-side (see changelog-service.ts).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { UpdateInstallProgressEvent, UpdateLaunchResult } from '../../shared/update-install-types';
import { createPortal } from 'react-dom';
import MarkdownContent from './MarkdownContent';
import { Button, Callout, CARD_LEVEL_1, Dialog, ErrorState, FieldError, LoadingState, ProgressBar, SectionLabel } from './ui';
import BrailleSpinner from './BrailleSpinner';
import { BugReportPopup } from './development/BugReportPopup';
import { BetaChannelRow, useAutoInstall } from './BetaChannelToggle';
import { plainMessage, stripInvokeWrapper } from '../utils/ipc-error';

// Error codes where a fresh download might succeed (transient or file-level).
// The complement (dmg-corrupt, appimage-not-writable, unsupported-platform,
// remote-unsupported, url-rejected, spawn-failed, busy, signature-invalid) won't
// benefit from retry — the user's best move is the browser fallback link.
// 'verify-failed' IS retriable: a corrupted download can succeed next time (the
// main process deletes the bad file so Retry re-downloads it). 2026-09-10 #7.
// 'install-cancelled' is retriable because Retry raises the password dialog
// again — dismissing it is a choice, not a broken download (2026-09-20).
const RETRIABLE_ERROR_CODES = new Set(['network-failed', 'disk-full', 'file-missing', 'verify-failed', 'install-cancelled']);
function isRetriableErrorCode(code: string): boolean {
  return RETRIABLE_ERROR_CODES.has(code);
}

/**
 * The installer's code from a rejected download. Main throws UpdateInstallError, whose
 * message is `<code>: <detail>` (update-installer.ts).
 *
 * WHY strip the wrapper first (error inventory 2026-09-10, false message 17): on desktop
 * the rejection arrives as "Error invoking remote method 'update:download': <code>: …",
 * so the text before the first colon was "Error invoking remote method 'update". No code
 * matched, every download failure lost its Retry, and the button called it a launch
 * failure. Only the wrapper is removed — not plainMessage's full rewrite, which turns
 * "remote-unsupported: …" into a sentence and would hide that code.
 * Text with no code-shaped prefix (a remote timeout, say) keeps the old fallback of
 * network-failed: a fresh download is the one attempt that cannot hurt.
 */
function downloadErrorCode(e: unknown): string {
  const raw = (e as { message?: unknown } | null | undefined)?.message;
  const match = /^([a-z][a-z-]*)(?::|$)/.exec(stripInvokeWrapper(typeof raw === 'string' ? raw : ''));
  return match ? match[1] : 'network-failed';
}

// Codes with their own message. Everything else falls back to 'Launch failed'.
// 2026-09-10 security review #7: verification failures get honest, specific copy
// instead of the generic launch error.
function updateErrorMessage(code: string): string {
  if (code === 'signature-invalid') return "This update couldn't be verified, so it wasn't installed. Your current version still works.";
  // WHY a plain sentence (Destin, small-fixes-1#SF-1, 2026-10-12): "Download failed — Try again"
  // put the failure inside the button's own label. The reason is a sentence in the notice box;
  // the button beside it reads only "Try again".
  if (code === 'verify-failed') return "The download was damaged, so it wasn't installed.";
  if (code === 'disk-full') return "There isn't enough free space on this computer for the update.";
  // Installing a Linux system package needs an administrator password (2026-09-20).
  if (code === 'install-cancelled') return 'The password prompt was closed, so nothing was installed.';
  if (code === 'install-failed') return "Your package manager wouldn't install the update.";
  return 'Launch failed';
}

/** The one sentence a failed update shows in its notice: the code's own words when it has
 *  some, else which step stopped — never a guessed cause. */
function updateFailureSentence(code: string, stage: 'download' | 'launch' | 'restart'): string {
  const own = updateErrorMessage(code);
  if (own !== 'Launch failed') return own;
  if (stage === 'launch' && code === 'busy') return 'Another update installation is already running.';
  return stage === 'launch' ? "The installer didn't start." : "The update didn't download.";
}

interface UpdateStatus {
  current: string;
  latest: string;
  update_available: boolean;
  download_url: string | null;
  /** #183: already downloaded in the background; the button becomes Restart to update. */
  downloaded?: boolean;
  /** #183: installing asks for a password (Linux package, non-administrator Mac), so
   *  quitting does not install it — only Restart to update does. */
  needs_password?: boolean;
  /** #183 F5: a quit really would install it (staged, not refused, under the failure limit); the switch is separate. */
  installs_on_quit?: boolean;
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
  // #183: the line under the title follows the switch in the Updates card (UX review 1, U2).
  const [autoInstall] = useAutoInstall();

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
    // #183: Restart to update was pressed; waiting on the close-window prompt or the restart.
    | { kind: 'restarting' }
    | { kind: 'downloading'; jobId: string | null; percent: number }
    | { kind: 'ready'; jobId: string; filePath: string }
    | { kind: 'launching'; jobId: string; phase: 'preparing' | 'handoff' | Exclude<UpdateInstallProgressEvent['phase'], 'failed'>; output: string }
    // `stage` is which step failed. WHY (error inventory 2026-09-10, false message 17):
    // the label used to be chosen by retriability alone, so every failure retry could
    // not fix — including a refused or busy DOWNLOAD — read "Launch failed".
    // Linux system package with no way to ask for a password: the download is
    // on disk and `command` finishes it (2026-09-20).
    | { kind: 'manual'; command: string; filePath: string }
    | { kind: 'error'; code: string; stage: 'download' | 'launch' | 'restart'; command?: string; output?: string };

  const [installState, setInstallState] = useState<InstallState>({ kind: 'idle' });
  const [reportMode, setReportMode] = useState<'report' | 'diagnose' | null>(null);
  const launchJobRef = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const lastInstallProgress = useRef<UpdateInstallProgressEvent | null>(null);
  const unknownOutcome = installState.kind === 'error'
    && (installState.code === 'install-timeout' || installState.code === 'launch-unknown');
  // WHY retain only this job's bounded snapshot while closed: closing a view cannot
  // cancel the system package manager, nor should hidden output redraw the popup.
  const watchInstall = open || launchJobRef.current !== null;
  useEffect(() => {
    if (!watchInstall) return;
    return window.claude.update.onInstallProgress((event) => {
      if (event.jobId !== launchJobRef.current) return;
      lastInstallProgress.current = event;
      if (!openRef.current) return;
      if (event.phase === 'failed') {
        launchJobRef.current = null;
        setInstallState({ kind: 'error', stage: 'launch', code: event.error, command: event.command, output: event.output });
        return;
      }
      setInstallState(prev => prev.kind === 'launching'
        || (prev.kind === 'error' && event.phase === 'restarting'
          && (prev.code === 'install-timeout' || prev.code === 'launch-unknown'))
        ? { kind: 'launching', ...event }
        : prev);
    });
  }, [watchInstall]);
  useEffect(() => {
    if (!open || !lastInstallProgress.current) return;
    const event = lastInstallProgress.current;
    if (event.phase === 'failed') {
      launchJobRef.current = null;
      setInstallState({ kind: 'error', stage: 'launch', code: event.error, command: event.command, output: event.output });
      return;
    }
    setInstallState(prev => prev.kind === 'launching'
      || (prev.kind === 'error' && event.phase === 'restarting'
        && (prev.code === 'install-timeout' || prev.code === 'launch-unknown'))
      ? { kind: 'launching', ...event }
      : prev);
  }, [open]);
  // The one command that finishes a Linux package update by hand — shown when
  // there is no password dialog to raise, or when the install was refused.
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [runningCommand, setRunningCommand] = useState(false);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const finishCommand = installState.kind === 'manual' ? installState.command
    : installState.kind === 'error' && !unknownOutcome ? installState.command
    : undefined;

  const copyFinishCommand = useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(true);
      setTimeout(() => setCopiedCommand(false), 1500);
    } catch { /* clipboard blocked — the command is on screen and selectable */ }
  }, []);

  const runFinishCommand = useCallback(async (command: string) => {
    // busy guard: a double-click would otherwise open two terminals, and the
    // second steals focus from the first (same reason as EngineCard's).
    setRunningCommand(true);
    setTerminalError(null);
    try { await window.claude.engine.runInTerminal(command); }
    catch (e: unknown) { setTerminalError(plainMessage(e)); }
    finally { setRunningCommand(false); }
  }, []);
  // Ref rather than state because the progress handler fires asynchronously and
  // we want the freshest jobId without re-subscribing.
  const activeJobIdRef = useRef<string | null>(null);
  // True while THIS view's own download() call is unanswered, so the reopen check does not mistake its job for a stale one.
  const downloadRequestPending = useRef(false);

  // Subscribe to download progress. Main broadcasts progress to every window;
  // we rely on the main-side single-job invariant (only one download in flight
  // at a time) so any progress event during `downloading` state is ours.
  // The jobId is captured lazily from the first progress event, since
  // `window.claude.update.download()` doesn't return its jobId until it resolves.
  // We preserve the raw `percent` (including the -1 sentinel for unknown
  // Content-Length) so the button can render an indeterminate "Downloading…"
  // label — don't clamp here.
  // WHY also while closed and downloading: a job that dies while the popup is closed (a background
  // run, or one started before closing) must still take this view out of "Downloading…" — nothing in
  // the popup cancels a job, so without this it would sit there forever. Closed, only that failure is
  // acted on; progress ticks are ignored (hidden means idle).
  const watchProgress = open || installState.kind === 'downloading';
  useEffect(() => {
    if (!watchProgress) return;
    const unsub = window.claude.update.onProgress((ev) => {
      if (ev.failed) {
        setInstallState(prev => prev.kind === 'downloading'
          ? { kind: 'error', code: ev.error ?? 'network-failed', stage: 'download' } : prev);
        return;
      }
      if (!openRef.current) return;
      setInstallState(prev => {
        if (prev.kind !== 'downloading') return prev;
        if (!activeJobIdRef.current) activeJobIdRef.current = ev.jobId;
        return { kind: 'downloading', jobId: ev.jobId, percent: ev.percent };
      });
    });
    return unsub;
  }, [watchProgress]);

  // When the popup opens and a completed download is already cached for this
  // version, jump straight to ready state (skip the re-download). If a job is still running (a
  // background download, or one started before the popup was closed), show its progress instead.
  // Guard: only overwrite state if we're still in `idle` — don't race against
  // a user-initiated download that already started.
  useEffect(() => {
    if (!open) return;
    if (!updateStatus.update_available) return;
    let cancelled = false;
    (async () => {
      const cached = await window.claude.update.getCachedDownload(updateStatus.latest);
      if (cancelled) return;
      if (!cached) {
        // Nothing running and nothing on disk: a "Downloading…" left over from before the popup was
        // closed is stale (its job ended), so show the normal Update now button again.
        setInstallState(prev => prev.kind === 'downloading' && !downloadRequestPending.current ? { kind: 'idle' } : prev);
        return;
      }
      if ('downloading' in cached) {
        // WHY: closing the popup no longer cancels, so a reopened popup finds the job still running.
        activeJobIdRef.current = cached.downloading.jobId;
        setInstallState(prev => prev.kind === 'idle'
          ? { kind: 'downloading', jobId: cached.downloading.jobId, percent: cached.downloading.percent }
          : prev);
        return;
      }
      setInstallState(prev => prev.kind === 'idle'
        ? { kind: 'ready', jobId: 'cached', filePath: cached.filePath }
        : prev);
    })();
    return () => { cancelled = true; };
  }, [open, updateStatus.update_available, updateStatus.latest]);

  // A download that finished while no click of ours was waiting on it (a background run, or one
  // this view lost track of when it was closed and reopened) arrives as `downloaded` in the status.
  useEffect(() => {
    if (updateStatus.downloaded) setInstallState(prev => prev.kind === 'downloading' ? { kind: 'idle' } : prev);
  }, [updateStatus.downloaded]);

  // WHY this effect no longer cancels or resets a download (Destin, 2026-10-22): closing the popup
  // after pressing Update used to cancel the download and fall back to "Update now". The job now
  // belongs to main and keeps running; this popup has no way to stop it, and a failure reaches it
  // as a failed progress event (above). Launch outcomes are kept too — an error can
  // arrive while closed, and reopening must not offer a second install over an uncertain first one.
  useEffect(() => {
    if (open) return;
    setInstallState(prev => prev.kind === 'launching' || prev.kind === 'manual' || prev.kind === 'downloading'
      || (prev.kind === 'error' && prev.stage === 'launch') ? prev : { kind: 'idle' });
  }, [open]);

  const runLaunch = useCallback(async (jobId: string, filePath: string) => {
    if (launchJobRef.current) return;
    launchJobRef.current = jobId;
    lastInstallProgress.current = null;
    setInstallState({ kind: 'launching', jobId, phase: 'preparing', output: '' });
    let result: UpdateLaunchResult;
    try {
      result = await window.claude.update.launch(jobId, filePath);
    } catch (error) {
      // A broken transport is NOT evidence that the package manager stopped.
      setInstallState({ kind: 'error', code: 'launch-unknown', stage: 'launch', output: plainMessage(error) });
      return;
    }
    if (!result.success) {
      // A Linux package install hands back the command that would finish the
      // job by hand, so a refusal is not a dead end (2026-09-20).
      if (result.error !== 'install-timeout') launchJobRef.current = null;
      setInstallState({ kind: 'error', code: result.error, stage: 'launch', command: result.command, output: result.output });
      return;
    }
    if ('fallback' in result && result.fallback === 'manual') {
      launchJobRef.current = null;
      setInstallState({ kind: 'manual', command: result.command, filePath: result.filePath });
      return;
    }
    if ('fallback' in result && result.fallback === 'browser') {
      // Missing APPIMAGE — browser opened; no process remains to track on reopening.
      launchJobRef.current = null;
      lastInstallProgress.current = null;
      setInstallState({ kind: 'idle' });
      onClose();
      return;
    }
    // WHY distinguish success: “Launching” hid the completed installation during
    // the quit grace period. The backend schedules quit only after a real success.
    // Windows/macOS only handed off to an external installer; they did not
    // report a finished installation. Only Linux's confirmed restart says so.
    const progress = lastInstallProgress.current as UpdateInstallProgressEvent | null;
    setInstallState({ kind: 'launching', jobId,
      phase: progress?.phase === 'restarting' ? 'restarting' : 'handoff', output: progress?.output ?? '' });
  }, [onClose]);

  // #183 Restart to update. Main asks through the close-window prompt when chats are open
  // (Q-busy: "just show the standard closeout prompt"); closing that prompt resolves
  // `restarting: false` and the button comes back, so nothing restarts behind the user's back.
  const handleRestart = useCallback(async () => {
    setInstallState({ kind: 'restarting' });
    try {
      const api = window.claude.update as unknown as { restartToUpdate: () => Promise<{ restarting: boolean; fallback?: { kind: 'browser' } | { kind: 'manual'; command: string; filePath: string } }> };
      const result = await api.restartToUpdate();
      // WHY (T3): when today's interactive installer could not simply run, main hands back what it always
      // showed here: a command to run by hand, or the browser.
      if (result.fallback?.kind === 'manual') { setInstallState({ kind: 'manual', command: result.fallback.command, filePath: result.fallback.filePath }); return; }
      if (result.fallback?.kind === 'browser') { setInstallState({ kind: 'idle' }); onClose(); return; }
      if (!result.restarting) setInstallState({ kind: 'idle' });
    } catch (e: unknown) {
      // WHY not "The installer didn't start." (code review F7, error-message-standards): Restart can fail before
      // any installer exists (the release could not be confirmed, a helper failed to start). A code that has
      // its own sentence keeps it; anything else is the general error with the real text in Details.
      const code = downloadErrorCode(e);
      const known = updateErrorMessage(code) !== 'Launch failed' || code === 'busy';
      setInstallState(known
        ? { kind: 'error', code, stage: 'launch' }
        : { kind: 'error', code: 'restart-failed', stage: 'restart', output: plainMessage(e) });
    }
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
      downloadRequestPending.current = true;
      const result = await window.claude.update.download().finally(() => { downloadRequestPending.current = false; });
      // WHY no closed-popup guard any more: closing keeps the download running, so finishing while
      // closed should leave the popup Ready for the next open, not idle.
      activeJobIdRef.current = result.jobId;
      setInstallState({ kind: 'ready', jobId: result.jobId, filePath: result.filePath });
      // WHY (#183 T3): "Update now" is still ONE press. With the popup open, the finished download goes
      // straight into Restart to update. Closed meanwhile, nothing restarts behind the person's back: the
      // popup is simply Ready (Restart to update) the next time they open it.
      // (Design note from the code review: also not where a password box would come next. Contract R8: on a
      // password computer the person presses Restart to update themselves.)
      if (openRef.current && !updateStatus.needs_password) await handleRestart();
    } catch (e: unknown) {
      setInstallState({ kind: 'error', code: downloadErrorCode(e), stage: 'download' });
    }
  }, [installState, runLaunch, handleRestart, updateStatus.needs_password]);

  const readyToRestart = !!updateStatus.downloaded && (installState.kind === 'idle' || installState.kind === 'ready');

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
    // WHY the notice box (guide: a problem is the one tinted box, its button inside at the
    // right; never underlined text as a button): was a centred grey line with an underlined link.
    body = (
      <Callout tone="danger" actions={<Button size="sm" variant="secondary" onClick={handleOpenOnGithub}>Open on GitHub</Button>}>
        Couldn't load the release notes.
      </Callout>
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
    // WHY a labelled card per version (Destin, close-session-4#CS4-1; guide: nothing bare on
    // the popup — a group is a small label and a card): the notes sat bare on the popup under
    // an 18px heading the guide's three levels don't have. The version and date are the label;
    // the notes are reading text in a first-level card (About's Disclaimer / Privacy cards).
    body = (
      <>
        {shown.map(e => (
          <section key={e.version}>
            <SectionLabel className="mb-2">v{e.version}{e.date ? ` · ${e.date}` : ''}</SectionLabel>
            {/* text-fg text-sm: the notes set no colour of their own (in chat they inherit
                the bubble's); here they inherited the page default, near-invisible on dark
                themes like Halftone Dimension (seen on close-session-5's preview). */}
            <div className={`${CARD_LEVEL_1} p-3 text-fg text-sm`}><MarkdownContent content={e.body} /></div>
          </section>
        ))}
      </>
    );
  } else if (data.markdown) {
    // The whole changelog (no update waiting): one card under one label, the same recipe.
    body = (
      <section>
        <SectionLabel className="mb-2">Release notes</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3 text-fg text-sm`}><MarkdownContent content={data.markdown} /></div>
      </section>
    );
  }

  return createPortal(
    <>
      <Dialog
        screen="chat/update"
        open
        onClose={onClose}
        size="document"
        title={updateStatus.update_available ? (updateStatus.downloaded ? 'Update ready' : 'Update available') : "What's new"}
        // #183: one line on when it installs — by itself on quit, except where installing
        // needs a password (Q-linux / Q-mac: only when you press the button).
        subtitle={updateStatus.update_available && updateStatus.downloaded
          ? (updateStatus.needs_password
            ? 'Downloaded. Restarting asks for your password, then installs it.'
            // WHY all three (code review F5): "installs by itself" is only true when the switch is ON (and known),
            // the copy is staged, the install is not refused here and it has not failed twice. Otherwise the
            // approved "Restart when you are ready." line, never a promise a quit will not keep.
            : autoInstall === true && updateStatus.installs_on_quit === true
              ? 'Downloaded. Installs by itself the next time you quit YouCoded.'
              : 'Downloaded. Restart when you are ready.')
          : undefined}
        // WHY the shared body + footer (close-session-friction proposal 1): it scrolled its own
        // notes with no fade and drew a full-width line above its footer (guide: no full-width
        // line in a popup; the content fades at the hidden edge). The footer slot keeps Update
        // in view and the notes fade see-through under it.
        footer={updateStatus.update_available ? (
          // WHY full width (Destin, close-session-4#CS4-1: "the button should be full width as
          // well"; guide: a lone button is full width): it hugged its label at the right.
          <div className="flex flex-col">
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
            {/* A failed update (all but a blocked one): the notice box in the button's place —
                its sentence, then "Open in browser instead" where that is safe, and "Try again"
                where a fresh attempt can help (guide "A failed action replaces the buttons it
                came from"; small-fixes-1#SF-1). No browser fallback for a damaged download:
                that file is the one the check refused (2026-09-10 #7 review). */}
            {installState.kind === 'launching' || installState.kind === 'restarting' ? (
              <div role="status" aria-live="polite">
                {/* WHY retain the button (LU-1/LU-2/LU-5 review): Destin rejected bare
                    status text. Keep the original full-width action shape as its label
                    names each confirmed step; disabled prevents a duplicate installer. */}
                <Button size="lg" className="w-full" disabled aria-busy="true">
                  <span aria-hidden="true"><BrailleSpinner size="sm" colorCycle={false} className="text-inherit" /></span>
                  {/* WHY only the last reported action: Destin asked for the button
                      itself to update, with no extra text or expandable log below it.
                      Main bounds/sanitizes output; cap the label too for noisy scripts. */}
                  <span className="min-w-0 truncate">
                    {installState.kind === 'restarting' ? 'Restarting YouCoded…'
                      : installState.phase === 'preparing' ? 'Preparing the installer…'
                      : installState.phase === 'authorizing' ? 'Waiting for administrator approval…'
                      : installState.phase === 'restarting' ? 'Restarting YouCoded…'
                      : installState.phase === 'handoff' ? 'Opening the installer…'
                      : installState.output.trim().split(/[\r\n]+/).at(-1)?.trim().slice(0, 160) || 'Running the installer…'}
                  </span>
                </Button>
              </div>
            ) : installState.kind === 'error' && installState.stage === 'restart' ? (
              <ErrorState
                title="Couldn't restart to update."
                explainer="Your current version is still running."
                onDiagnose={() => setReportMode('diagnose')}
                onReportBug={() => setReportMode('report')}
                onRetry={handleRestart}
                details={installState.output}
              />
            ) : installState.kind === 'error' && installState.code !== 'signature-invalid' ? (
              <ErrorState
                {...(unknownOutcome ? {
                  title: "Couldn't confirm the installation result.",
                  explainer: 'The installer may still be running. Check your system’s package manager before trying another installation.',
                  onDiagnose: () => setReportMode('diagnose'),
                } : { message: updateFailureSentence(installState.code, installState.stage) })}
                onReportBug={() => setReportMode('report')}
                onRetry={isRetriableErrorCode(installState.code) ? handleUpdate : undefined}
                details={installState.output}
                moreActions={!unknownOutcome && installState.code !== 'verify-failed'
                  && !(installState.stage === 'launch' && installState.code === 'busy') ? [
                  { label: 'Open in browser instead', onClick: handleFallbackBrowser },
                ] : undefined}
              />
            ) : (
            <Button
              size="lg"
              className="w-full"
              onClick={readyToRestart ? handleRestart : handleUpdate}
              disabled={
                installState.kind === 'downloading' ||
                // The download is done and waiting on a terminal — the block
                // below is the next step, not this button.
                installState.kind === 'manual' ||
                // Disable "retry" for errors where a fresh download won't help.
                (installState.kind === 'error' && !isRetriableErrorCode(installState.code))
              }
            >
              {/* #183: replaces Update now once the background download is done. */}
              {readyToRestart && `Restart to update: v${updateStatus.current} → v${updateStatus.latest}`}
              {!readyToRestart && installState.kind === 'idle' && `Update now: v${updateStatus.current} → v${updateStatus.latest}`}
              {installState.kind === 'downloading' && (
                installState.percent >= 0 ? `Downloading ${installState.percent}%…` : 'Downloading…'
              )}
              {!readyToRestart && installState.kind === 'ready' && 'Launch installer'}
              {installState.kind === 'manual' && 'Downloaded — one step left'}
              {/* Only a blocked update still reaches here in the error state; every other failure
                  is the notice above. WHY the stage picks the sentence there (error inventory
                  2026-09-10, false message 17): a download that retry could not fix (busy,
                  url-rejected) was once reported as a launch that never happened. */}
              {installState.kind === 'error' && 'Update blocked'}
            </Button>
            )}
            {/* No browser fallback for a VERIFICATION failure: handleFallbackBrowser
                opens download_url — the raw installer binary — which for a
                verify-failed (sha256/size mismatch, i.e. the installer was swapped
                after signing) is the very tampered file the gate just refused.
                Offering it there would reopen the attack outside the app. Retry
                (which re-downloads and re-verifies) is the only safe move; a
                signature-invalid shows an explanation instead. 2026-09-10 #7 review. */}
            {/* The update is downloaded and verified; installing a system
                package is the one step that needs an administrator password.
                Same shape the engine prerequisites use: the command in full,
                Copy, and Run in terminal. */}
            {finishCommand && (
              <div className="w-full mt-2 text-left">
                <p className="text-xs text-fg-dim mb-1">
                  {installState.kind === 'manual'
                    ? 'The update is downloaded. Finish it with this command — it asks for your password:'
                    : 'You can finish the update yourself with this command:'}
                </p>
                <div className="flex items-start gap-1.5 rounded-md bg-inset px-2 py-1.5">
                  {/* WHY explicit ink: the system command inherited black on dark themes. */}
                  <pre className="flex-1 min-w-0 text-3xs text-fg-2 font-mono whitespace-pre-wrap break-words select-all">{finishCommand}</pre>
                  <Button size="sm" variant="ghost" onClick={() => void copyFinishCommand(finishCommand)} className="shrink-0 -my-1">
                    {copiedCommand ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <div className="flex justify-end gap-1.5 mt-1.5">
                  <Button size="sm" variant="secondary" onClick={() => void runFinishCommand(finishCommand)} disabled={runningCommand}>
                    Run in terminal
                  </Button>
                </div>
                {/* WHY FieldError (guide: no red/coloured body text for messages) */}
                {terminalError && <FieldError as="p" size="2xs" className="mt-1">{terminalError}</FieldError>}
              </div>
            )}
            {installState.kind === 'error' && installState.code === 'signature-invalid' && (
              <div className="text-xs mt-2">
                {/* WHY FieldError (guide: no red/coloured body text for messages —
                    amber sentences are in scope too). Other failures carry "Open in browser
                    instead" inside their notice above. */}
                <FieldError as="p" size="2xs">{updateErrorMessage('signature-invalid')}</FieldError>
              </div>
            )}
          </div>
        ) : undefined}
      >
        {/* The beta switch rides at the END of the scrolling body, so it appears
            in BOTH modes — under "what's new" when you are current, and under the
            release notes when an update is waiting (Destin, 2026-09-13 deck, S-1:
            "should also appear somewhere on the version chip popup modal with the
            changelog"). It renders nothing where the channel is unavailable —
            Android and a remote browser refuse the call — so no gate is needed
            here. Inside the scroll rather than the footer: the footer only exists
            in the update-available mode, and it belongs to the Update button. */}
        {body}
        <BetaChannelRow card />
      </Dialog>
      <BugReportPopup open={reportMode !== null} onClose={() => setReportMode(null)} context={{
        surface: 'App update', diagnose: reportMode === 'diagnose',
        error: installState.kind === 'error' ? installState.output ?? installState.code : undefined,
      }} />
    </>,
    document.body,
  );
}
