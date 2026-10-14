// Layer-3 nested overlay for viewing a plugin's SKILL.md / command / agent
// markdown file in-app. Opened from the "What's inside" peek in the unified
// MarketplaceDetailOverlay. Content source:
//   - local FS (installed plugins)
//   - raw GitHub URL (fallback for non-installed plugins)
// The main process handler decides; this component just awaits the result.

import { useEffect, useState } from "react";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import MarkdownContent from "../MarkdownContent";
import { useEscClose } from "../../hooks/use-esc-close";
import { useScrollFade } from "../../hooks/useScrollFade";
import './FileViewerOverlay.css';
import { Callout, CloseButton, ErrorState, LoadingState } from "../ui";

export type FileViewerTarget = {
  pluginId: string;
  pluginName: string;
  kind: "skill" | "command" | "agent";
  name: string;
};

interface Props {
  target: FileViewerTarget;
  onClose(): void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ok"; content: string; source: "local" | "remote" }
  | { status: "error"; error: string; retryable: boolean };

export default function FileViewerOverlay({ target, onClose }: Props) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // WHY a counter (guide "File viewers" known deviation, 2026-10-13): a failed load had nothing to
  // press. Try again bumps it, which re-runs exactly the load below for the same file.
  const [attempt, setAttempt] = useState(0);

  // Always mounted when open (parent conditionally renders) — so open=true is correct here.
  // Replaces the former raw keydown listener; useEscClose integrates with the LIFO stack
  // so Android back and desktop ESC both dismiss this layer before the parent overlay.
  useEscClose(true, onClose);

  useEffect(() => {
    let cancelled = false;
    const api = (window as any).claude?.marketplace;
    if (!api?.readComponent) {
      setState({ status: "error", error: "File viewer not available on this platform", retryable: false });
      return;
    }
    setState({ status: "loading" });
    api.readComponent({ pluginId: target.pluginId, kind: target.kind, name: target.name })
      .then((res: any) => {
        if (cancelled) return;
        if (res?.error) setState({ status: "error", error: res.error, retryable: true });
        else if (res?.content != null) setState({ status: "ok", content: res.content, source: res.source });
        else setState({ status: "error", error: "Empty response", retryable: true });
      })
      .catch((err: any) => {
        if (cancelled) return;
        setState({ status: "error", error: String(err?.message || err), retryable: true });
      });
    return () => { cancelled = true; };
  }, [target.pluginId, target.kind, target.name, attempt]);

  const title = fileLabel(target);
  // WHY: the document body scrolls under a fixed header; fade only edges with
  // more file text, and clear the bottom fade at the last readable line.
  const scrollRef = useScrollFade<HTMLDivElement>();

  return (
    <>
      <Scrim layer={3} onClick={onClose} />
      {/* Nearly the whole window, so a long file reads comfortably; full-bleed on
          phones. The detail popup it opened from stays mounted at layer 2 and
          re-appears when this layer-3 viewer closes (Esc / scrim click). */}
      <OverlayPanel
        layer={3}
        className="fixed inset-2 sm:inset-12 md:inset-24 flex flex-col overflow-hidden"
      >
        <header data-file-viewer-header className="flex items-center justify-between gap-2 p-3 sm:p-4">
          {/* WHY: Destin selected the single-line file identity. Semibold, not medium (guide "File
              viewers" known deviation, 2026-10-13): decisions "Popup and side-panel titles" made
              every popup title the shared 16px semibold one — Dialog.tsx's h2. */}
          <h2 className="text-base font-semibold text-fg truncate min-w-0">{title}</h2>
          {/* WHY the ✕ at every width (decisions B-1; guide "Popups": the close control is
              always the ✕ — never the words "Esc" or "Close"). Was the words Esc and Close on wide
              windows and a bordered ✕ only on narrow ones. */}
          <CloseButton onClick={onClose} label="Close file viewer" className="shrink-0" />
        </header>
        <div ref={scrollRef} data-file-viewer-scroll className="flex-1 overflow-y-auto p-3 sm:p-6">
          {state.status === "loading" && (
            <LoadingState what="file" />
          )}
          {state.status === "error" && (
            // WHY this shape (guide "File viewers" known deviation, 2026-10-13): it was a grey
            // sentence over the handler's raw words, with nothing to press. Now the approved
            // failure shape of a plugin's detail page (DetailPage.tsx InstallFailed, decisions
            // "Failed install on a detail page"): one plain sentence in the error box with Try
            // again, the raw reason one click away under Details. "Not available on this
            // platform" never changes on a second try, so it gets the box without the button.
            <div className="max-w-3xl mx-auto space-y-2">
              {state.retryable ? (
                // popup-cards-8#Q-1: Details sits inside the error box, everywhere.
                <ErrorState message="Couldn't load this file." onRetry={() => setAttempt((n) => n + 1)} details={state.error} />
              ) : (
                <Callout tone="danger" details={state.error}>Couldn't load this file.</Callout>
              )}
            </div>
          )}
          {state.status === "ok" && (
            <article className="max-w-3xl mx-auto">
              <MarkdownContent content={state.content} />
              <p className="text-xs text-fg-muted mt-6 pt-4 border-t border-edge-dim">
                {state.source === "local" ? "Loaded from local install" : "Loaded from source repo"}
              </p>
            </article>
          )}
        </div>
      </OverlayPanel>
    </>
  );
}

function fileLabel(t: FileViewerTarget): string {
  if (t.kind === "skill") return `${t.name}/SKILL.md`;
  return `${t.name}.md`;
}
