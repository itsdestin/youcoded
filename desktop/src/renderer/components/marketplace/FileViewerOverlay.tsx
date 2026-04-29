// Layer-3 nested overlay for viewing a plugin's SKILL.md / command / agent
// markdown file in-app. Opened from the "What's inside" peek in the unified
// MarketplaceDetailOverlay. Content source:
//   - local FS (installed plugins)
//   - raw GitHub URL (fallback for non-installed plugins)
// The main process handler decides; this component just awaits the result.

import React, { useEffect, useState } from "react";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import MarkdownContent from "../MarkdownContent";
import { useEscClose } from "../../hooks/use-esc-close";

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
  | { status: "error"; error: string };

export default function FileViewerOverlay({ target, onClose }: Props) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  // Always mounted when open (parent conditionally renders) — so open=true is correct here.
  // Replaces the former raw keydown listener; useEscClose integrates with the LIFO stack
  // so Android back and desktop ESC both dismiss this layer before the parent overlay.
  useEscClose(true, onClose);

  useEffect(() => {
    let cancelled = false;
    const api = (window as any).claude?.marketplace;
    if (!api?.readComponent) {
      setState({ status: "error", error: "File viewer not available on this platform" });
      return;
    }
    setState({ status: "loading" });
    api.readComponent({ pluginId: target.pluginId, kind: target.kind, name: target.name })
      .then((res: any) => {
        if (cancelled) return;
        if (res?.error) setState({ status: "error", error: res.error });
        else if (res?.content != null) setState({ status: "ok", content: res.content, source: res.source });
        else setState({ status: "error", error: "Empty response" });
      })
      .catch((err: any) => {
        if (cancelled) return;
        setState({ status: "error", error: String(err?.message || err) });
      });
    return () => { cancelled = true; };
  }, [target.pluginId, target.kind, target.name]);

  const title = fileLabel(target);

  return (
    <>
      <Scrim layer={3} onClick={onClose} />
      {/* Inset matches MarketplaceDetailOverlay/IntegrationDetailOverlay so the
          file viewer reads as a same-size full-bleed popup on phones — the
          underlying parent popup stays mounted at layer 2 and re-appears when
          this layer-3 viewer closes (Esc / scrim click). */}
      <OverlayPanel
        layer={3}
        className="fixed inset-2 sm:inset-12 md:inset-24 flex flex-col overflow-hidden"
      >
        <header className="flex items-center justify-between gap-2 p-3 sm:p-4 border-b border-edge-dim">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-fg-dim">
              {target.pluginName} · {kindLabel(target.kind)}
            </p>
            <h2 className="text-lg font-semibold text-fg truncate">{title}</h2>
          </div>
          {/* Wide: Esc-text. Narrow: bordered close-X — matches the marketplace top bar. */}
          <button
            type="button"
            onClick={onClose}
            className="hidden sm:inline-block text-fg-dim hover:text-fg text-sm px-2 py-1 shrink-0"
            aria-label="Close file viewer"
          >
            Esc · Close
          </button>
          <button
            type="button"
            onClick={onClose}
            className="sm:hidden shrink-0 p-1.5 rounded-md border border-edge-dim hover:border-edge text-fg-dim hover:text-fg"
            aria-label="Close file viewer"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-3 sm:p-6">
          {state.status === "loading" && (
            <p className="text-fg-dim text-center py-12">Loading…</p>
          )}
          {state.status === "error" && (
            <div className="text-center py-12">
              <p className="text-fg-dim">Couldn't load this file.</p>
              <p className="text-xs text-fg-muted mt-2">{state.error}</p>
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

function kindLabel(k: FileViewerTarget["kind"]): string {
  if (k === "skill") return "Skill";
  if (k === "command") return "Command";
  return "Agent";
}
