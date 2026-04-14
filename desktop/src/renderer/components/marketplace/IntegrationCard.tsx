// Integrations card — purpose-built variant. Wider, logo-forward, status pill
// on the right. Never mixed into a skill/theme grid (per design doc): only
// rendered inside the dedicated integrations rail.

import React from "react";
import type { IntegrationEntry, IntegrationState } from "../../../shared/types";

export type IntegrationCardItem = IntegrationEntry & { state: IntegrationState };

interface Props {
  item: IntegrationCardItem;
  onPrimary(): void; // install / connect / open settings
  busy?: boolean;
}

function statusLabel(item: IntegrationCardItem): { text: string; tone: "neutral" | "ok" | "warn" | "err" } {
  if (item.status === "planned") return { text: "Coming soon", tone: "neutral" };
  if (item.status === "deprecated") return { text: "Deprecated", tone: "neutral" };
  const s = item.state;
  if (s.error) return { text: "Error", tone: "err" };
  if (s.connected) return { text: "Connected", tone: "ok" };
  if (s.installed) return { text: "Needs auth", tone: "warn" };
  return { text: "Not installed", tone: "neutral" };
}

const TONE_CLASS: Record<string, string> = {
  ok: "bg-green-500/15 text-green-400 border border-green-500/30",
  warn: "bg-amber-500/15 text-amber-400 border border-amber-500/30",
  err: "bg-red-500/15 text-red-400 border border-red-500/30",
  neutral: "bg-inset text-fg-2 border border-edge",
};

export default function IntegrationCard({ item, onPrimary, busy }: Props) {
  const status = statusLabel(item);
  const planned = item.status === "planned";
  return (
    <div
      className="layer-surface flex items-start gap-4 p-4 min-w-[320px]"
      style={item.accentColor ? { borderColor: item.accentColor } : undefined}
    >
      <div
        className="w-10 h-10 rounded-md shrink-0 flex items-center justify-center text-on-accent text-sm font-semibold"
        style={{ background: item.accentColor || "var(--accent)" }}
        aria-hidden
      >
        {item.displayName.slice(0, 1)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-medium text-fg truncate">{item.displayName}</h3>
            <p className="text-xs text-fg-dim">{item.tagline}</p>
          </div>
          <span className={`text-[10px] uppercase tracking-wide rounded px-2 py-0.5 shrink-0 ${TONE_CLASS[status.tone]}`}>
            {status.text}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={onPrimary}
            disabled={planned || busy}
            className="px-3 py-1 rounded-md bg-accent text-on-accent text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {planned ? "Coming soon" : item.state.installed ? "Open settings" : "Install"}
          </button>
          {item.state.error && (
            <span className="text-xs text-red-400 truncate" title={item.state.error}>{item.state.error}</span>
          )}
        </div>
      </div>
    </div>
  );
}
