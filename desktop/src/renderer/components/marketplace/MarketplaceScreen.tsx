// Full-screen marketplace destination. Wallpaper reads through; chrome,
// hero, rails, and grid compose on top with theme-driven glass tokens.
//
// Mode switch:
//   discovery — no chips/search active → hero + rails + bottom grid
//   search    — any chip or search active → filtered grid only

import React, { useMemo, useState, useEffect } from "react";
import { useMarketplace } from "../../state/marketplace-context";
import MarketplaceHero from "./MarketplaceHero";
import MarketplaceFilterBar, {
  type FilterState, emptyFilter, isActive,
} from "./MarketplaceFilterBar";
import MarketplaceRail from "./MarketplaceRail";
import MarketplaceCard from "./MarketplaceCard";
import MarketplaceGrid from "./MarketplaceGrid";
import MarketplaceDetailOverlay, { type DetailTarget } from "./MarketplaceDetailOverlay";
import InstallingFooterStrip from "./InstallingFooterStrip";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { useEscClose } from "../../hooks/use-esc-close";
import type { SkillEntry, IntegrationEntry, IntegrationState } from "../../../shared/types";
import type { ThemeRegistryEntryWithStatus } from "../../../shared/theme-marketplace-types";

// Integrations carry their catalog metadata plus live installed/connected state.
// Previously lived in IntegrationCard.tsx; moved inline when the dedicated
// component was retired in favor of rendering through MarketplaceCard.
type IntegrationCardItem = IntegrationEntry & { state: IntegrationState };

// Integration icons live in the marketplace repo at integrations/icons/,
// referenced via raw.githubusercontent.com. Pre-built once at module scope
// rather than per-render inside the map callback.
const INTEGRATION_MARKETPLACE_BRANCH = 'master';
const INTEGRATION_ICON_BASE = `https://raw.githubusercontent.com/itsdestin/wecoded-marketplace/${INTEGRATION_MARKETPLACE_BRANCH}/integrations`;

interface Props {
  onExit(): void;
  // Phase 2 redesign — jump to Your Library without round-tripping through
  // the command drawer. Optional so the screen still renders standalone.
  onOpenLibrary?(): void;
  // ShareSheet (link/QR) is owned by App.tsx so it layers above this screen.
  // Threaded down to the detail overlay via these callbacks.
  onOpenShareSheet?(skillId: string): void;
  onOpenThemeShare?(themeSlug: string): void;
  initialTypeChip?: "skill" | "theme";
  // When set, open the given plugin's detail overlay on mount. Set by
  // App.tsx's openMarketplaceDetail; cleared via onDetailConsumed after
  // consumption so re-entering the marketplace doesn't re-trigger the overlay.
  initialDetailId?: string;
  onDetailConsumed?: () => void;
}

export default function MarketplaceScreen({
  onExit, onOpenLibrary, onOpenShareSheet, onOpenThemeShare, initialTypeChip, initialDetailId, onDetailConsumed,
}: Props) {
  const mp = useMarketplace();
  const [filter, setFilter] = useState<FilterState>(() => {
    const f = emptyFilter();
    if (initialTypeChip) f.type = initialTypeChip;
    return f;
  });
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationCardItem[]>([]);
  // Integration click-to-expand — mirrors the plugin detail-overlay pattern
  // but renders IntegrationDetailOverlay (below) because integrations aren't
  // in mp.skillEntries and need their own action wiring via handleIntegration.
  const [integrationDetail, setIntegrationDetail] = useState<IntegrationCardItem | null>(null);

  // Open a specific plugin's detail overlay when App.tsx navigates here via
  // openMarketplaceDetail (e.g. from a CommandDrawer plugin-name badge click).
  // Fires once, then signals back to clear the parent's state so re-entering
  // the marketplace manually doesn't re-open the overlay.
  useEffect(() => {
    if (initialDetailId) {
      setDetail({ kind: "skill", id: initialDetailId });
      onDetailConsumed?.();
    }
  }, [initialDetailId, onDetailConsumed]);

  // Fetch integrations on mount. Non-blocking — if the namespace is missing
  // (older app version) the catch keeps the rail empty without warning.
  useEffect(() => {
    const api = (window as any).claude.integrations;
    if (!api?.list) return;
    api.list().then((items: IntegrationCardItem[]) => setIntegrations(items || []))
       .catch(() => setIntegrations([]));
  }, []);

  const refreshIntegrations = async () => {
    try {
      const items = await (window as any).claude.integrations.list();
      setIntegrations(items || []);
    } catch { /* ignore */ }
  };

  // Compute the status-pill text/tone for an integration. Mirrors the
  // semantics the retired IntegrationCard.statusLabel() helper had — without
  // it, integrations would fall back to MarketplaceCard's generic "Installed"
  // badge and lose the connected/needs-auth/error/deprecated nuance.
  const integrationStatusBadge = (item: IntegrationCardItem): { text: string; tone: 'ok' | 'warn' | 'err' | 'neutral' } => {
    if (item.status === 'planned') return { text: 'Coming soon', tone: 'neutral' };
    if (item.status === 'deprecated') return { text: 'Deprecated', tone: 'neutral' };
    const s = item.state;
    if (s.error) return { text: 'Error', tone: 'err' };
    if (s.connected) return { text: 'Connected', tone: 'ok' };
    if (s.installed) return { text: 'Needs auth', tone: 'warn' };
    return { text: 'Not installed', tone: 'neutral' };
  };

  const handleIntegration = async (item: IntegrationCardItem) => {
    if (item.status !== "available") return;
    if (item.state.installed) {
      // Phase 3 scaffold — no real settings panel yet; uninstall as the
      // safe placeholder so users can recover from a stuck state.
      await (window as any).claude.integrations.uninstall(item.slug);
    } else {
      const result = await (window as any).claude.integrations.install(item.slug);
      // setup.type === 'plugin' entries can carry a post-install slash
      // command (e.g. /google-services-setup). Run it in a fresh Sonnet
      // session so the user's active chat isn't hijacked by a multi-step
      // OAuth walkthrough.
      if (result?.postInstallCommand) {
        const info = await (window as any).claude.session.create({
          name: `Set up ${item.displayName}`,
          cwd: "", // main falls back to home dir when blank
          skipPermissions: false,
          model: "claude-sonnet-4-6",
        });
        if (info?.id) {
          // Pragmatic fixed delay — the CLI takes ~1–2s to reach the
          // prompt. Claude Code buffers stdin until ready, so an early
          // send is tolerated; a late send is the common case.
          setTimeout(() => {
            try {
              (window as any).claude.session.sendInput(info.id, result.postInstallCommand + "\r");
            } catch { /* user can type the command themselves */ }
          }, 3000);
          onExit(); // land on the new session
        }
      }
    }
    await refreshIntegrations();
  };

  // Esc: close detail first, then exit screen. Matches App.tsx state-transition rules.
  // When a detail overlay (plugin or integration) is open, its own useEscClose
  // registration sits on top of the LIFO stack and captures ESC first; this
  // registration only fires when no nested overlay is active.
  useEscClose(!detail && !integrationDetail, onExit);

  const mode: "discovery" | "search" = isActive(filter) ? "search" : "discovery";
  const installedIds = useMemo(
    () => new Set(mp.installedSkills.map((s) => s.id)),
    [mp.installedSkills],
  );

  const skillById = useMemo(() => {
    const m = new Map<string, SkillEntry>();
    for (const s of mp.skillEntries) m.set(s.id, s);
    return m;
  }, [mp.skillEntries]);

  const themeBySlug = useMemo(() => {
    const m = new Map<string, ThemeRegistryEntryWithStatus>();
    for (const t of mp.themeEntries) m.set(t.slug, t);
    return m;
  }, [mp.themeEntries]);

  // Set of slugs that count as "Destin's picks" — prefer the rail explicitly
  // titled "Destin's picks" for tight scoping; fall back to the union of all
  // rails so the chip still does something if the rail gets renamed.
  const pickSlugs = useMemo(() => {
    const rails = mp.featured.rails || [];
    const named = rails.find((r) => r.title.toLowerCase() === "destin's picks");
    const source = named ? [named] : rails;
    return new Set(source.flatMap((r) => r.slugs));
  }, [mp.featured.rails]);

  // Search-mode filtered list — union of skills + themes that pass the chips.
  const filtered = useMemo(() => {
    if (mode !== "search") return [];
    const q = filter.query.trim().toLowerCase();
    const picksOnly = filter.meta.has("picks");

    const skillPass = (s: SkillEntry): boolean => {
      if (filter.type !== null && filter.type !== "skill") return false;
      // "Destin's picks" chip: hard filter against the curated slug set so the
      // chip actually narrows results instead of just reordering them.
      if (picksOnly && !pickSlugs.has(s.id)) return false;
      if (filter.vibes.size > 0) {
        const areas = s.lifeArea || [];
        if (!areas.some((a) => filter.vibes.has(a as any))) return false;
      }
      if (q) {
        const hay = `${s.displayName} ${s.description} ${s.tagline || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };
    const themePass = (t: ThemeRegistryEntryWithStatus): boolean => {
      if (filter.type !== null && filter.type !== "theme") return false;
      if (picksOnly && !pickSlugs.has(t.slug)) return false;
      if (filter.vibes.size > 0) return false; // themes have no lifeArea (yet)
      if (q) {
        const hay = `${t.name} ${t.description || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };

    const skills = mp.skillEntries.filter(skillPass);
    const themes = mp.themeEntries.filter(themePass);

    const combined: Array<{ kind: "skill"; entry: SkillEntry } | { kind: "theme"; entry: ThemeRegistryEntryWithStatus }> = [
      ...skills.map((entry) => ({ kind: "skill" as const, entry })),
      ...themes.map((entry) => ({ kind: "theme" as const, entry })),
    ];

    // Recency timestamp lives under different field names per entry type:
    // skills use `updatedAt`, themes use `updated`. Read both so the "New"
    // chip surfaces recent themes too instead of always sinking them.
    const recency = (item: typeof combined[number]): string =>
      item.kind === "skill" ? (item.entry.updatedAt || "") : (item.entry.updated || "");

    if (filter.meta.has("popular")) {
      combined.sort((a, b) => (
        (b.kind === "skill" ? (b.entry.installs || 0) : 0) -
        (a.kind === "skill" ? (a.entry.installs || 0) : 0)
      ));
    } else if (filter.meta.has("new")) {
      combined.sort((a, b) => recency(b).localeCompare(recency(a)));
    }
    return combined;
  }, [mode, filter, mp.skillEntries, mp.themeEntries, pickSlugs]);

  const open = (t: DetailTarget) => setDetail(t);

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto flex flex-col">
      {/* Top bar — stays visible on scroll; holds the Exit hint. */}
      <div className="flex items-center justify-between p-3">
        <h1 className="text-xl font-semibold text-fg pl-2">Marketplace</h1>
        <div className="flex items-center gap-2">
          {onOpenLibrary && (
            <button
              type="button"
              onClick={onOpenLibrary}
              className="text-fg-2 hover:text-fg text-sm px-3 py-1 rounded-md border border-edge-dim hover:border-edge"
              aria-label="Open Your Library"
            >
              Your Library
            </button>
          )}
          <button
            type="button"
            onClick={onExit}
            className="text-fg-dim hover:text-fg text-sm px-2 py-1"
            aria-label="Exit marketplace"
          >
            Esc · Back to chat
          </button>
        </div>
      </div>

      {mode === "discovery" && mp.featured.hero && mp.featured.hero.length > 0 && (
        <div className="px-3 sm:px-4">
          <MarketplaceHero
            slots={mp.featured.hero}
            lookup={(id) => skillById.get(id)}
            onOpen={(id) => open({ kind: "skill", id })}
          />
        </div>
      )}

      <div className="px-3 sm:px-4 mt-4">
        <MarketplaceFilterBar value={filter} onChange={setFilter} />
      </div>

      <div className="px-3 sm:px-4 mt-4 flex flex-col gap-6 pb-12">
        {mode === "discovery" ? (
          <>
            {/* Integrations rail — purpose-built cards only. Never mixed with
                skill/theme cards. Rendered above Destin's picks so users see
                OAuth-based connections (Gmail, Drive, etc.) before curated
                plugin rails — these are the highest-value setup step. Hidden
                when the catalog hasn't loaded. */}
            {integrations.length > 0 && (
              <MarketplaceRail title="Connect your stuff" description="Bring your data in.">
                {integrations.map((item) => {
                  // Previously IntegrationCard resolved the icon path internally;
                  // now we pass a fully-resolved URL to MarketplaceCard's iconUrl
                  // prop. The base URL is hoisted to module scope (see
                  // INTEGRATION_ICON_BASE above) so it's not rebuilt per render.
                  const resolvedIcon = item.iconUrl ? `${INTEGRATION_ICON_BASE}/${item.iconUrl}` : undefined;

                  // Shape a SkillEntry-compatible value so MarketplaceCard's
                  // discriminated union is satisfied. Integrations go through
                  // handleIntegration (via onOpen) for install/connect — the
                  // corner affordance is suppressed. handleIntegration still
                  // receives the raw `item` (with state/status/setup fields),
                  // never this synthetic shape.
                  // `category` is typed as a narrow union that doesn't include
                  // 'integrations' — the double cast through `unknown` is the
                  // documented escape hatch for this discriminated-union adapter.
                  // MarketplaceCard only reads displayName/description/id from
                  // this entry for display, so the fake category never reaches
                  // any category-sensitive code path.
                  const skillLike = {
                    id: item.slug,
                    displayName: item.displayName,
                    description: item.tagline || '',
                    category: 'integrations',
                    prompt: `/${item.slug}`,
                    source: 'marketplace',
                    type: 'plugin',
                    visibility: 'published',
                  } as unknown as SkillEntry;

                  // Width caps at 360px on desktop but shrinks to 90vw on
                  // narrow screens (splitscreen / mobile) so a single card
                  // doesn't overflow the viewport. `!` needed because the
                  // rail's `[&>*]:w-[...]` child selector outranks a plain
                  // w- class by specificity — integration cards are wider
                  // than plugin/theme cards by design.
                  return (
                    <div key={item.slug} className="shrink-0 !w-[min(360px,90vw)]">
                      <MarketplaceCard
                        item={{ kind: "skill", entry: skillLike }}
                        installed={!!item.state.installed}
                        iconUrl={resolvedIcon}
                        accentColor={item.accentColor}
                        suppressCorner
                        statusBadge={integrationStatusBadge(item)}
                        onOpen={() => setIntegrationDetail(item)}
                      />
                    </div>
                  );
                })}
              </MarketplaceRail>
            )}

            {(mp.featured.rails || []).map((rail) => {
              const items = rail.slugs
                .map((slug) => {
                  const skill = skillById.get(slug);
                  if (skill) return { kind: "skill" as const, entry: skill };
                  const theme = themeBySlug.get(slug);
                  if (theme) return { kind: "theme" as const, entry: theme };
                  return null;
                })
                .filter(Boolean) as Array<{ kind: "skill"; entry: SkillEntry } | { kind: "theme"; entry: ThemeRegistryEntryWithStatus }>;
              if (items.length === 0) return null;
              return (
                <MarketplaceRail key={rail.title} title={rail.title} description={rail.description}>
                  {items.map((item) => (
                    <MarketplaceCard
                      key={item.kind === "skill" ? item.entry.id : `theme:${item.entry.slug}`}
                      item={item}
                      installed={item.kind === "skill" && installedIds.has(item.entry.id)}
                      updateAvailable={
                        item.kind === "skill"
                          ? !!mp.updateAvailable[item.entry.id]
                          : !!mp.updateAvailable[item.entry.slug]
                      }
                      onOpen={() =>
                        open(item.kind === "skill"
                          ? { kind: "skill", id: item.entry.id }
                          : { kind: "theme", slug: item.entry.slug })
                      }
                    />
                  ))}
                </MarketplaceRail>
              );
            })}

            {/* Bottom catalog — denser surface; all skills + themes in default sort. */}
            <section className="flex flex-col gap-2 mt-4">
              <h3 className="text-lg font-medium text-fg px-1">Explore everything</h3>
              <MarketplaceGrid dense>
                {mp.skillEntries.slice(0, 48).map((s) => (
                  <MarketplaceCard
                    key={s.id}
                    item={{ kind: "skill", entry: s }}
                    installed={installedIds.has(s.id)}
                    updateAvailable={!!mp.updateAvailable[s.id]}
                    onOpen={() => open({ kind: "skill", id: s.id })}
                  />
                ))}
              </MarketplaceGrid>
            </section>
          </>
        ) : (
          <section>
            <h3 className="text-sm text-fg-dim px-1 mb-2">
              {filtered.length} result{filtered.length === 1 ? "" : "s"}
            </h3>
            <MarketplaceGrid dense>
              {filtered.map((item) => (
                <MarketplaceCard
                  key={item.kind === "skill" ? item.entry.id : `theme:${item.entry.slug}`}
                  item={item}
                  installed={item.kind === "skill" && installedIds.has(item.entry.id)}
                  onOpen={() =>
                    open(item.kind === "skill"
                      ? { kind: "skill", id: item.entry.id }
                      : { kind: "theme", slug: item.entry.slug })
                  }
                />
              ))}
            </MarketplaceGrid>
            {filtered.length === 0 && (
              <p className="text-center text-fg-dim py-12">Nothing matches those filters.</p>
            )}
          </section>
        )}
      </div>

      {detail && (
        <MarketplaceDetailOverlay
          target={detail}
          onClose={() => setDetail(null)}
          onOpenShareSheet={onOpenShareSheet}
          onOpenThemeShare={onOpenThemeShare}
        />
      )}

      {integrationDetail && (
        <IntegrationDetailOverlay
          item={integrationDetail}
          onClose={() => setIntegrationDetail(null)}
          onPrimary={async () => {
            await handleIntegration(integrationDetail);
            setIntegrationDetail(null);
          }}
          statusBadge={integrationStatusBadge(integrationDetail)}
          iconUrl={integrationDetail.iconUrl ? `${INTEGRATION_ICON_BASE}/${integrationDetail.iconUrl}` : undefined}
        />
      )}

      {/* Docked footer — outside the scroll container so it stays fixed at the
          bottom of the viewport regardless of scroll position. */}
      <InstallingFooterStrip />
    </div>
  );
}

// Lightweight detail overlay for integrations. Mirrors MarketplaceDetailOverlay's
// layer-2 pattern (scrim + panel) but stays self-contained because integrations
// aren't in mp.skillEntries and their Install button routes through
// handleIntegration, not the generic installSkill flow.
function IntegrationDetailOverlay({
  item, onClose, onPrimary, statusBadge, iconUrl,
}: {
  item: IntegrationCardItem;
  onClose(): void;
  onPrimary(): void | Promise<void>;
  statusBadge: { text: string; tone: 'ok' | 'warn' | 'err' | 'neutral' };
  iconUrl?: string;
}) {
  useEscClose(true, onClose);

  const toneClass: Record<string, string> = {
    ok: 'bg-green-500/15 text-green-400 border-green-500/30',
    warn: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    err: 'bg-red-500/15 text-red-400 border-red-500/30',
    neutral: 'bg-inset text-fg-2 border-edge',
  };

  const planned = item.status === 'planned';
  const deprecated = item.status === 'deprecated';
  const actionLabel = planned
    ? 'Coming soon'
    : deprecated
      ? 'Deprecated'
      : item.state.installed
        ? 'Open settings'
        : 'Install';
  const actionDisabled = planned || deprecated || item.status !== 'available';

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        className="fixed inset-8 md:inset-16 flex flex-col overflow-hidden"
        style={item.accentColor ? { borderColor: item.accentColor } : undefined}
      >
        <header className="flex items-center justify-between p-4 border-b border-edge-dim">
          <h2 className="text-lg font-semibold text-fg">Integration</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-dim hover:text-fg text-sm px-2 py-1"
            aria-label="Close"
          >
            Esc · Close
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-6">
          <article className="flex flex-col gap-4 max-w-3xl mx-auto">
            <header className="flex items-start gap-4">
              {/* Custom integration icon, falls back to the displayName letter. */}
              <div
                className="w-16 h-16 rounded-lg shrink-0 overflow-hidden bg-inset flex items-center justify-center text-on-accent text-2xl font-semibold"
                style={iconUrl ? undefined : { background: item.accentColor || 'var(--accent)' }}
              >
                {iconUrl ? (
                  <img src={iconUrl} alt="" className="w-full h-full object-contain" />
                ) : (
                  item.displayName.slice(0, 1)
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-semibold text-fg">{item.displayName}</h1>
                {item.tagline && <p className="mt-1 text-fg-2">{item.tagline}</p>}
                <div className="mt-3 flex items-center gap-2">
                  <span className={`text-[10px] uppercase tracking-wide rounded-full px-2 py-0.5 border ${toneClass[statusBadge.tone]}`}>
                    {statusBadge.text}
                  </span>
                  {item.state.error && (
                    <span className="text-xs text-red-400 truncate" title={item.state.error}>{item.state.error}</span>
                  )}
                </div>
              </div>
            </header>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { void onPrimary(); }}
                disabled={actionDisabled}
                className="px-4 py-2 rounded-md bg-accent text-on-accent hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {actionLabel}
              </button>
            </div>
          </article>
        </div>
      </OverlayPanel>
    </>
  );
}
