// UpdatePanel.tsx — L2 overlay opened from the StatusBar version pill.
// Two modes driven by updateStatus.update_available:
//   - true  → "Update available" + Update Now button + changelog entries since current version
//   - false → "What's new" + full changelog, no button
// Cache lives main-side (see changelog-service.ts).

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import MarkdownContent from './MarkdownContent';

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

  if (!open) return null;

  const handleUpdate = async () => {
    if (updateStatus.download_url) {
      await window.claude.shell.openExternal(updateStatus.download_url);
    }
    onClose();
  };

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
    body = <div className="text-fg-dim text-sm py-8 text-center">Loading…</div>;
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
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        aria-labelledby="update-panel-title"
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[720px] max-w-[90vw] max-h-[80vh] flex flex-col"
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-edge-dim">
          <h1 id="update-panel-title" className="text-base font-medium">
            {updateStatus.update_available ? 'Update available' : "What's new"}
          </h1>
          <button onClick={onClose} aria-label="Close" className="text-fg-dim hover:text-fg">✕</button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{body}</div>
        {updateStatus.update_available && (
          <footer className="px-5 py-3 border-t border-edge-dim flex justify-end">
            <button
              onClick={handleUpdate}
              className="px-4 py-2 rounded-sm bg-accent text-on-accent font-medium hover:opacity-90"
            >
              Update Now: v{updateStatus.current} → v{updateStatus.latest}
            </button>
          </footer>
        )}
      </OverlayPanel>
    </>,
    document.body,
  );
}
