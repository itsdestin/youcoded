// desktop/src/renderer/components/development/ContributePopup.tsx
// Single-screen install flow for the "Contribute to YouCoded" option.
// Clones the youcoded-dev workspace scaffold via dev:install-workspace IPC,
// then offers an "Open in New Session" button that drops the user into it.
// Uses <Scrim> / <OverlayPanel> primitives — no hardcoded colors, blur, or z-indexes
// (PITFALLS overlay invariant).
import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ContributePopup({ open, onClose }: Props) {
  const [installing, setInstalling] = useState(false);
  const [installLines, setInstallLines] = useState<string[]>([]);
  const [done, setDone] = useState<{ path: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // WHY: Reset install state when the popup closes so the next open always
  // starts fresh showing the "Install Workspace" button (Fix 3).
  useEffect(() => {
    if (!open) {
      setInstalling(false);
      setInstallLines([]);
      setDone(null);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const onInstall = async () => {
    setInstalling(true);
    setInstallLines([]);
    setError(null);
    // WHY: subscribe before the call so we don't miss early progress lines.
    const off = window.claude.dev.onInstallProgress((line) =>
      setInstallLines((prev) => [...prev.slice(-9), line]),
    );
    try {
      const r = await window.claude.dev.installWorkspace();
      // WHY: discriminated-union narrowing instead of (r as any) casts (Fix 4).
      if ('error' in r) {
        setError(r.error);
      } else {
        setDone({ path: r.path });
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      off();
      setInstalling(false);
    }
  };

  const onOpenInNewSession = async () => {
    if (!done) return;
    await window.claude.dev.openSessionIn({ cwd: done.path });
    onClose();
  };

  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel layer={2} className="p-4 w-[400px] max-w-[92vw] mx-4">
        {!installing && !done && !error && (
          <>
            <h3 className="text-sm font-medium text-fg mb-2">Contribute to YouCoded</h3>
            <p className="text-xs text-fg-2 mb-2">
              <code className="text-[11px] bg-inset/60 px-1 rounded">youcoded-dev</code> is the workspace scaffold
              that clones all five YouCoded sub-repos side by side, with shared docs and the <code>/audit</code> command.
            </p>
            <p className="text-xs text-fg-2 mb-3">
              Open it as a project folder, ask Claude to make changes, and push PRs to the relevant
              <strong> sub-repo</strong> — never to <code>youcoded-dev</code> itself.
            </p>
            <button
              onClick={onInstall}
              className="w-full py-2.5 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110"
            >
              Install Workspace
            </button>
          </>
        )}
        {installing && (
          <div className="text-xs text-fg-muted mb-3 font-mono">
            {installLines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        )}
        {error && (
          <>
            <div className="text-xs text-fg mb-3">{error}</div>
            <button onClick={onClose} className="w-full py-2.5 text-xs font-medium rounded-lg bg-accent text-on-accent">Done</button>
          </>
        )}
        {done && (
          <>
            <div className="text-xs text-fg mb-3">
              Workspace installed at <code className="text-[11px]">{done.path}</code>. Added to your project folders.
            </div>
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 py-2.5 text-xs font-medium rounded-lg border border-edge-dim text-fg-2 hover:bg-inset">Done</button>
              <button onClick={onOpenInNewSession} className="flex-1 py-2.5 text-xs font-medium rounded-lg bg-accent text-on-accent">Open in New Session</button>
            </div>
          </>
        )}
      </OverlayPanel>
    </>,
    document.body,
  );
}
