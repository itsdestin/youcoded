// Unified detail overlay — replaces SkillDetail + ThemeDetail. Opens inside
// the marketplace/library screen as a layer-2 popup. Renders skill OR theme
// content from the same shell; the "What's inside" section only shows for
// skills with extracted `components` data.

import React, { useEffect } from "react";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { useMarketplace } from "../../state/marketplace-context";
import type { SkillEntry, SkillComponents } from "../../../shared/types";
import type { ThemeRegistryEntryWithStatus } from "../../../shared/theme-marketplace-types";

export type DetailTarget =
  | { kind: "skill"; id: string }
  | { kind: "theme"; slug: string };

interface Props {
  target: DetailTarget;
  onClose(): void;
}

export default function MarketplaceDetailOverlay({ target, onClose }: Props) {
  const mp = useMarketplace();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lookup the target in the already-fetched context. No per-overlay fetch —
  // keeps the overlay snappy and avoids cache-invalidation questions.
  let content: React.ReactNode;
  if (target.kind === "skill") {
    const entry = mp.skillEntries.find((e) => e.id === target.id)
      || mp.installedSkills.find((e) => e.id === target.id);
    if (!entry) {
      content = <NotFound label="Skill" onClose={onClose} />;
    } else {
      const installed = mp.installedSkills.some((e) => e.id === target.id);
      content = (
        <SkillBody
          entry={entry}
          installed={installed}
          installing={false}
          onInstall={() => mp.installSkill(entry.id).catch(() => undefined)}
          onUninstall={() => mp.uninstallSkill(entry.id).catch(() => undefined)}
        />
      );
    }
  } else {
    const entry = mp.themeEntries.find((e) => e.slug === target.slug);
    if (!entry) {
      content = <NotFound label="Theme" onClose={onClose} />;
    } else {
      content = (
        <ThemeBody
          entry={entry}
          onInstall={() => mp.installTheme(entry.slug).catch(() => undefined)}
          onUninstall={() => mp.uninstallTheme(entry.slug).catch(() => undefined)}
        />
      );
    }
  }

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        className="fixed inset-8 md:inset-16 flex flex-col overflow-hidden"
      >
        <header className="flex items-center justify-between p-4 border-b border-edge-dim">
          <h2 className="text-lg font-semibold text-fg">Details</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-sm px-2 py-1"
            aria-label="Close"
          >
            Esc · Close
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-6">{content}</div>
      </OverlayPanel>
    </>
  );
}

function NotFound({ label, onClose }: { label: string; onClose(): void }) {
  return (
    <div className="text-center py-12 text-fg-dim">
      <p>{label} not found in the current registry.</p>
      <button type="button" onClick={onClose} className="mt-4 underline text-fg-2">Close</button>
    </div>
  );
}

// ── Skill body ──────────────────────────────────────────────────────────────

function SkillBody({
  entry, installed, installing, onInstall, onUninstall,
}: {
  entry: SkillEntry;
  installed: boolean;
  installing: boolean;
  onInstall(): void;
  onUninstall(): void;
}) {
  return (
    <article className="flex flex-col gap-4 max-w-3xl mx-auto">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-fg">{entry.displayName}</h1>
          {entry.author && <p className="text-sm text-fg-dim">{entry.author}</p>}
          {entry.tagline && <p className="mt-2 text-base text-fg-2">{entry.tagline}</p>}
        </div>
        <div className="shrink-0">
          {installed ? (
            <button type="button" onClick={onUninstall} className="px-4 py-2 rounded-md bg-inset text-fg border border-edge hover:border-edge-dim">
              Uninstall
            </button>
          ) : (
            <button
              type="button"
              onClick={onInstall}
              disabled={installing}
              className="px-4 py-2 rounded-md bg-accent text-on-accent disabled:opacity-50 hover:opacity-90"
            >
              {installing ? "Installing…" : "Install"}
            </button>
          )}
        </div>
      </header>

      {entry.longDescription ? (
        <section>
          <h2 className="text-sm uppercase tracking-wide text-fg-dim mb-2">About</h2>
          <div className="prose prose-sm max-w-none text-fg-2 whitespace-pre-wrap">
            {entry.longDescription}
          </div>
        </section>
      ) : (
        <p className="text-fg-2">{entry.description}</p>
      )}

      <ComponentsPeek components={entry.components} />

      {entry.repoUrl && (
        <footer className="text-xs text-fg-dim">
          Source: <a className="underline" href={entry.repoUrl} target="_blank" rel="noreferrer">{entry.repoUrl}</a>
        </footer>
      )}
    </article>
  );
}

function ComponentsPeek({ components }: { components?: SkillComponents | null }) {
  // `null` = extraction failed — hide the peek entirely (don't alarm the user
  // with a scary error message). `undefined` = pre-Phase-1 cached entry;
  // same hide behavior. Empty object = plugin genuinely has nothing.
  if (!components) return null;
  const sections: Array<[string, string[]]> = [
    ["Skills", components.skills],
    ["Commands", components.commands],
    ["Hooks", components.hooks],
    ["Agents", components.agents],
    ["MCP servers", components.mcpServers],
  ];
  const nonEmpty = sections.filter(([, arr]) => arr.length > 0);
  if (!nonEmpty.length && !components.hasHooksManifest && !components.hasMcpConfig) return null;
  return (
    <section>
      <h2 className="text-sm uppercase tracking-wide text-fg-dim mb-2">What's inside</h2>
      <div className="layer-surface p-3 flex flex-col gap-2 text-sm">
        {nonEmpty.map(([label, items]) => (
          <div key={label}>
            <span className="text-fg-dim">{label}:</span>{" "}
            <span className="text-fg-2">{items.join(", ")}</span>
          </div>
        ))}
        {components.hasHooksManifest && !components.hooks.length && (
          <div className="text-fg-dim">Hooks configured via hooks-manifest.json</div>
        )}
        {components.hasMcpConfig && !components.mcpServers.length && (
          <div className="text-fg-dim">MCP servers via .mcp.json</div>
        )}
      </div>
    </section>
  );
}

// ── Theme body ──────────────────────────────────────────────────────────────

function ThemeBody({
  entry, onInstall, onUninstall,
}: {
  entry: ThemeRegistryEntryWithStatus;
  onInstall(): void;
  onUninstall(): void;
}) {
  const installed = entry.installed;
  return (
    <article className="flex flex-col gap-4 max-w-3xl mx-auto">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-fg">{entry.name}</h1>
          {entry.author && <p className="text-sm text-fg-dim">{entry.author}</p>}
          {entry.description && <p className="mt-2 text-fg-2">{entry.description}</p>}
        </div>
        <div className="shrink-0">
          {installed ? (
            <button type="button" onClick={onUninstall} className="px-4 py-2 rounded-md bg-inset text-fg border border-edge hover:border-edge-dim">
              Uninstall
            </button>
          ) : (
            <button type="button" onClick={onInstall} className="px-4 py-2 rounded-md bg-accent text-on-accent hover:opacity-90">
              Install
            </button>
          )}
        </div>
      </header>
      {/* PNG preview — uploaded on publish. Shown first when present so the
          user sees the real rendered screen. Token swatches follow as a
          fallback/supplement for themes whose PNG hasn't regenerated. */}
      {entry.preview && (
        <section>
          <img
            src={entry.preview}
            alt={`${entry.name} preview`}
            loading="lazy"
            className="w-full rounded-md border border-edge-dim"
          />
        </section>
      )}
      {entry.previewTokens && (
        <section className="flex gap-2 flex-wrap">
          {Object.entries(entry.previewTokens).map(([name, color]) => (
            <span
              key={name}
              title={name}
              className="inline-block w-8 h-8 rounded border border-edge-dim"
              style={{ background: color as string }}
            />
          ))}
        </section>
      )}
    </article>
  );
}
