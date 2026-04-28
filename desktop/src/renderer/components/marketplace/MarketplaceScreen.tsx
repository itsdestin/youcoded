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
import MarketplaceAuthChip from "./MarketplaceAuthChip";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { useEscClose } from "../../hooks/use-esc-close";
import { useCurrentPlatform } from "../../state/platform";
import { platformDisplayName, platformListDisplay } from "../../../shared/platform-display";
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
  const currentPlatform = useCurrentPlatform();
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
  // After an install/connect that returns a postInstallCommand, we show an
  // inline "run this command to finish setup" banner in the detail overlay
  // rather than auto-typing into a new session. Auto-typing raced the CLI's
  // boot time and often landed before Claude was ready, leaving a blank
  // setup session. Manual copy-and-paste is boring but always works.
  const [setupHint, setSetupHint] = useState<{ slug: string; displayName: string; command: string } | null>(null);

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
  const integrationStatusBadge = (item: IntegrationCardItem): { text: string; tone: 'ok' | 'warn' | 'err' | 'neutral' | 'locked' } => {
    // Platform lock overrides everything — if the user can't install, the
    // connected/needs-auth state is moot. When platform is still resolving
    // (null) treat as "not blocked" to avoid a transient grey badge flash.
    if (currentPlatform && item.platforms && item.platforms.length > 0 && !item.platforms.includes(currentPlatform as any)) {
      return { text: `${platformDisplayName(item.platforms[0])} Only`, tone: 'locked' };
    }
    if (item.status === 'planned') return { text: 'Coming soon', tone: 'neutral' };
    if (item.status === 'deprecated') return { text: 'Deprecated', tone: 'neutral' };
    const s = item.state;
    if (s.error) return { text: 'Error', tone: 'err' };
    if (s.connected) return { text: 'Connected', tone: 'ok' };
    if (s.installed) return { text: 'Needs auth', tone: 'warn' };
    return { text: 'Not installed', tone: 'neutral' };
  };

  // Create an empty Sonnet session named "Set up X" and land on it. User then
  // runs the setup command themselves. Intentionally NOT auto-typing the
  // command — that path was timing-fragile and frequently no-op'd against a
  // still-booting CLI.
  const openSetupSession = async (displayName: string) => {
    const info = await (window as any).claude.session.create({
      name: `Set up ${displayName}`,
      cwd: "",
      skipPermissions: false,
      model: "claude-sonnet-4-6",
    });
    if (info?.id) onExit();
  };

  const installIntegration = async (item: IntegrationCardItem) => {
    if (item.status !== "available") return;
    const result = await (window as any).claude.integrations.install(item.slug);
    await refreshIntegrations();
    if (result?.postInstallCommand) {
      setSetupHint({ slug: item.slug, displayName: item.displayName, command: result.postInstallCommand });
    }
  };

  const connectIntegration = async (item: IntegrationCardItem) => {
    const result = await (window as any).claude.integrations.connect(item.slug);
    await refreshIntegrations();
    if (result?.postInstallCommand) {
      setSetupHint({ slug: item.slug, displayName: item.displayName, command: result.postInstallCommand });
    }
  };

  const uninstallIntegration = async (item: IntegrationCardItem) => {
    await (window as any).claude.integrations.uninstall(item.slug);
    await refreshIntegrations();
    // Clear any setup hint for this slug — the command's moot now.
    setSetupHint((prev) => (prev?.slug === item.slug ? null : prev));
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
      {/* Top bar — stays visible on scroll; holds Auth, title, library, exit. */}
      <div className="flex items-center justify-between gap-2 p-3">
        {/* Auth chip sits flush-left before the title so the GitHub sign-in
            entry point is the first thing users see when entering the
            marketplace — fixes the "no obvious way to sign in" gap. */}
        <div className="flex items-center gap-2 pl-2 min-w-0">
          <MarketplaceAuthChip />
          <h1 className="text-xl font-semibold text-fg truncate">Marketplace</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenLibrary && (
            <button
              type="button"
              onClick={onOpenLibrary}
              className="text-fg-2 hover:text-fg text-sm px-3 py-1 rounded-md border border-edge-dim hover:border-edge"
              aria-label="Open Your Library"
            >
              {/* Full label at sm+, abbreviated below — keeps the row to one line on a 360-wide phone. */}
              <span className="hidden sm:inline">Your Library</span>
              <span className="sm:hidden">Lib</span>
            </button>
          )}
          {/* Wide: text "Esc · Back to chat" hint, no border (Esc key does the work). */}
          <button
            type="button"
            onClick={onExit}
            className="hidden sm:inline-block text-fg-dim hover:text-fg text-sm px-2 py-1"
            aria-label="Exit marketplace"
          >
            Esc · Back to chat
          </button>
          {/* Narrow: bordered close-X button — touch users have no Esc key, so we
              give them an obvious close affordance with a button-shaped container
              matching the Library button next to it. */}
          <button
            type="button"
            onClick={onExit}
            className="sm:hidden p-1.5 rounded-md border border-edge-dim hover:border-edge text-fg-dim hover:text-fg"
            aria-label="Exit marketplace"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
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

      {integrationDetail && (() => {
        // Platform-block detection is shared with the card; compute it inline
        // so the detail header's disabled button and its tooltip agree with
        // the card's "macOS Only" pill.
        const blocked = !!(currentPlatform && integrationDetail.platforms && integrationDetail.platforms.length > 0 && !integrationDetail.platforms.includes(currentPlatform as any));
        const blockedName = blocked && integrationDetail.platforms ? platformDisplayName(integrationDetail.platforms[0]) : null;
        return (
          <IntegrationDetailOverlay
            item={integrationDetail}
            onClose={() => { setSetupHint(null); setIntegrationDetail(null); }}
            onInstall={async () => {
              await installIntegration(integrationDetail);
              // Keep the overlay open so the setup-hint banner (set inside
              // installIntegration when postInstallCommand is present) can
              // surface the "run this command" instructions to the user.
            }}
            onConnect={async () => {
              await connectIntegration(integrationDetail);
            }}
            onUninstall={async () => {
              await uninstallIntegration(integrationDetail);
              setIntegrationDetail(null);
            }}
            statusBadge={integrationStatusBadge(integrationDetail)}
            iconUrl={integrationDetail.iconUrl ? `${INTEGRATION_ICON_BASE}/${integrationDetail.iconUrl}` : undefined}
            platformBlocked={blocked}
            platformBlockedName={blockedName}
            setupHint={setupHint?.slug === integrationDetail.slug ? setupHint : null}
            onDismissSetupHint={() => setSetupHint(null)}
            onOpenSetupSession={() => {
              setSetupHint(null);
              setIntegrationDetail(null);
              void openSetupSession(integrationDetail.displayName);
            }}
          />
        );
      })()}

      {/* Docked footer — outside the scroll container so it stays fixed at the
          bottom of the viewport regardless of scroll position. */}
      <InstallingFooterStrip />
    </div>
  );
}

// Detail overlay for integrations. Mirrors MarketplaceDetailOverlay's section
// structure (header → metadata chips → About → Setup) but stays a separate
// component because integration actions (Install / Connect / Settings /
// Uninstall) diverge from plugin actions (Install / Favorite / Share / Review).
function IntegrationDetailOverlay({
  item, onClose, onInstall, onConnect, onUninstall,
  statusBadge, iconUrl, platformBlocked, platformBlockedName,
  setupHint, onDismissSetupHint, onOpenSetupSession,
}: {
  item: IntegrationCardItem;
  onClose(): void;
  onInstall(): void | Promise<void>;
  onConnect(): void | Promise<void>;
  onUninstall(): void | Promise<void>;
  statusBadge: { text: string; tone: 'ok' | 'warn' | 'err' | 'neutral' | 'locked' };
  iconUrl?: string;
  platformBlocked: boolean;
  platformBlockedName: string | null;  // e.g. "macOS" when blocked, else null
  // Shown as a banner after install/connect when the integration has a
  // postInstallCommand. Replaces the old auto-type-into-new-session flow.
  setupHint: { displayName: string; command: string } | null;
  onDismissSetupHint(): void;
  onOpenSetupSession(): void;
}) {
  useEscClose(true, onClose);

  const toneClass: Record<string, string> = {
    ok: 'bg-green-500/15 text-green-400 border-green-500/30',
    warn: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    err: 'bg-red-500/15 text-red-400 border-red-500/30',
    neutral: 'bg-inset text-fg-2 border-edge',
    locked: 'bg-slate-500/10 text-fg-dim border-slate-500/30',
  };

  // Derive the action-button state. Precedence: platform-blocked > planned >
  // deprecated > install-error > install-state. The spec table in
  // docs/superpowers/specs/2026-04-22-marketplace-integration-polish-design.md §6
  // is the source of truth.
  type ActionState =
    | { kind: 'blocked'; label: string; tooltip: string }
    | { kind: 'planned' }
    | { kind: 'deprecated' }
    | { kind: 'install-error' }
    | { kind: 'not-installed' }
    | { kind: 'needs-auth' }
    | { kind: 'connected' };

  const actionState: ActionState = (() => {
    if (platformBlocked && platformBlockedName) {
      return {
        kind: 'blocked',
        label: `${platformBlockedName} Only`,
        tooltip: `Only available on ${platformBlockedName}`,
      };
    }
    if (item.status === 'planned') return { kind: 'planned' };
    if (item.status === 'deprecated') return { kind: 'deprecated' };
    if (!item.state.installed && item.state.error) return { kind: 'install-error' };
    if (!item.state.installed) return { kind: 'not-installed' };
    if (item.state.installed && !item.state.connected) return { kind: 'needs-auth' };
    return { kind: 'connected' };
  })();

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      {/* Inset shrinks at narrow so the popup fills the phone screen — see
          MarketplaceDetailOverlay for the same treatment. */}
      <OverlayPanel
        layer={2}
        className="fixed inset-2 sm:inset-8 md:inset-16 flex flex-col overflow-hidden"
        style={item.accentColor ? { borderColor: item.accentColor } : undefined}
      >
        <header className="flex items-center justify-between p-3 sm:p-4 border-b border-edge-dim">
          <h2 className="text-lg font-semibold text-fg">Integration</h2>
          {/* Wide: Esc-text. Narrow: bordered close-X. */}
          <button
            type="button"
            onClick={onClose}
            className="hidden sm:inline-block text-fg-dim hover:text-fg text-sm px-2 py-1"
            aria-label="Close"
          >
            Esc · Close
          </button>
          <button
            type="button"
            onClick={onClose}
            className="sm:hidden p-1.5 rounded-md border border-edge-dim hover:border-edge text-fg-dim hover:text-fg"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-3 sm:p-6">
          <article className="flex flex-col gap-4 max-w-3xl mx-auto">
            {/* Header stacks at narrow so the icon+title+tagline get full row
                width and the action button cluster drops below. */}
            <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
              <div className="flex items-start gap-3 sm:gap-4 min-w-0 flex-1">
                {/* Custom integration icon, falls back to the displayName letter. */}
                <div
                  className="w-12 h-12 sm:w-16 sm:h-16 rounded-lg shrink-0 overflow-hidden bg-inset flex items-center justify-center text-on-accent text-xl sm:text-2xl font-semibold"
                  style={iconUrl ? undefined : { background: item.accentColor || 'var(--accent)' }}
                >
                  {iconUrl ? (
                    <img src={iconUrl} alt="" className="w-full h-full object-contain" />
                  ) : (
                    item.displayName.slice(0, 1)
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h1 className="text-xl sm:text-2xl font-semibold text-fg">{item.displayName}</h1>
                  {item.tagline && <p className="mt-1 text-sm sm:text-base text-fg-2">{item.tagline}</p>}
                  <div className="mt-3 flex items-center gap-2 flex-wrap">
                    <span className={`text-[10px] uppercase tracking-wide rounded-full px-2 py-0.5 border ${toneClass[statusBadge.tone]}`}>
                      {statusBadge.text}
                    </span>
                    {item.state.error && (
                      <span className="text-xs text-red-400 truncate max-w-[40ch]" title={item.state.error}>{item.state.error}</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="shrink-0 flex items-center gap-2 flex-wrap">
                <IntegrationActions
                  state={actionState}
                  onInstall={onInstall}
                  onConnect={onConnect}
                  onUninstall={onUninstall}
                />
              </div>
            </header>

            {setupHint && (
              <SetupHintBanner
                command={setupHint.command}
                onDismiss={onDismissSetupHint}
                onOpenSetupSession={onOpenSetupSession}
              />
            )}

            <IntegrationMetadataChips entry={item} />

            {item.longDescription ? (
              <section>
                <h2 className="text-sm uppercase tracking-wide text-fg-dim mb-2">About</h2>
                <div className="prose prose-sm max-w-none text-fg-2 whitespace-pre-wrap">
                  {item.longDescription}
                </div>
              </section>
            ) : null}

            <IntegrationSetupDetails entry={item} />
          </article>
        </div>
      </OverlayPanel>
    </>
  );
}

// Renders the contextual action buttons in the detail header. One branch per
// ActionState case keeps the overlay JSX clean.
function IntegrationActions({
  state, onInstall, onConnect, onUninstall,
}: {
  state:
    | { kind: 'blocked'; label: string; tooltip: string }
    | { kind: 'planned' }
    | { kind: 'deprecated' }
    | { kind: 'install-error' }
    | { kind: 'not-installed' }
    | { kind: 'needs-auth' }
    | { kind: 'connected' };
  onInstall(): void | Promise<void>;
  onConnect(): void | Promise<void>;
  onUninstall(): void | Promise<void>;
}) {
  // Shared styles — mirrors MarketplaceDetailOverlay's primary + uninstall classes.
  const primaryCls = 'px-4 py-2 rounded-md bg-accent text-on-accent hover:opacity-90';
  const uninstallCls = 'px-4 py-2 rounded-md bg-inset text-fg border border-edge hover:border-edge-dim';
  const disabledCls = 'px-4 py-2 rounded-md bg-inset text-fg-dim border border-edge-dim cursor-not-allowed opacity-60';

  if (state.kind === 'blocked') {
    return (
      <button type="button" disabled title={state.tooltip} className={disabledCls}>
        {state.label}
      </button>
    );
  }
  if (state.kind === 'planned') {
    return <button type="button" disabled className={disabledCls}>Coming soon</button>;
  }
  if (state.kind === 'deprecated') {
    return <button type="button" disabled className={disabledCls}>Deprecated</button>;
  }
  if (state.kind === 'install-error') {
    return (
      <button type="button" onClick={() => { void onInstall(); }} className={primaryCls}>
        Retry Install
      </button>
    );
  }
  if (state.kind === 'not-installed') {
    return (
      <button type="button" onClick={() => { void onInstall(); }} className={primaryCls}>
        Install
      </button>
    );
  }
  if (state.kind === 'needs-auth') {
    return (
      <>
        <button type="button" onClick={() => { void onConnect(); }} className={primaryCls}>
          Connect
        </button>
        <button type="button" disabled title="Coming soon" className={disabledCls}>
          Settings (Coming soon…)
        </button>
        <button type="button" onClick={() => { void onUninstall(); }} className={uninstallCls}>
          Uninstall
        </button>
      </>
    );
  }
  // connected
  return (
    <>
      <button type="button" disabled title="Coming soon" className={disabledCls}>
        Settings (Coming soon…)
      </button>
      <button type="button" onClick={() => { void onUninstall(); }} className={uninstallCls}>
        Uninstall
      </button>
    </>
  );
}

// Mirror of MarketplaceDetailOverlay's MetadataChips — pulls the tags +
// lifeArea from the IntegrationEntry. Intentionally duplicated (not imported)
// because the plugin MetadataChips takes a SkillEntry shape.
function IntegrationMetadataChips({ entry }: { entry: IntegrationCardItem }) {
  const tags = entry.tags || [];
  const lifeAreas = entry.lifeArea || [];
  if (!tags.length && !lifeAreas.length) return null;

  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {tags.map((t) => (
        <span key={`tag-${t}`} className="text-xs px-2 py-0.5 rounded-full bg-inset text-fg-2 border border-edge-dim">
          #{t}
        </span>
      ))}
      {lifeAreas.map((a) => (
        <span key={`area-${a}`} className="text-xs px-2 py-0.5 rounded-full bg-accent/10 text-fg border border-accent/30 capitalize">
          {a}
        </span>
      ))}
    </div>
  );
}

// Post-install / post-connect banner. Shows the slash command the user must
// run to finish setup, with a Copy button and a shortcut that creates a
// dedicated empty "Set up <X>" session (user still runs the command there
// themselves — we stopped auto-typing it because the timing against CLI
// boot was unreliable).
function SetupHintBanner({
  command, onDismiss, onOpenSetupSession,
}: {
  command: string;
  onDismiss(): void;
  onOpenSetupSession(): void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    // navigator.clipboard exists in Electron renderer; fall through silently
    // if the API is missing so the user can still read + retype the command.
    try {
      if (navigator?.clipboard?.writeText) {
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }
    } catch { /* ignore — user can still read the command */ }
  };

  return (
    <section className="rounded-md border border-accent/40 bg-accent/5 p-3 flex flex-col gap-2">
      <div className="text-sm text-fg">
        <span className="font-medium">Installed.</span> To finish setup, run this
        command in any chat:
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <code className="flex-1 min-w-0 truncate px-2 py-1.5 rounded bg-inset text-fg text-sm font-mono border border-edge-dim">
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 text-sm px-3 py-1.5 rounded-md border border-edge-dim hover:border-edge text-fg-2 hover:text-fg"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onOpenSetupSession}
          className="shrink-0 text-sm px-3 py-1.5 rounded-md bg-accent text-on-accent hover:opacity-90"
        >
          Open new setup session
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-sm px-2 py-1.5 text-fg-dim hover:text-fg"
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}

// Small bulleted block describing setup — derived from setup.type /
// requiresOAuth / postInstallCommand / platforms. No new registry fields.
function IntegrationSetupDetails({ entry }: { entry: IntegrationCardItem }) {
  const bullets: string[] = [];
  if (entry.setup.type === 'api-key' && entry.setup.keyName) {
    bullets.push(`Requires a \`${entry.setup.keyName}\` API key`);
  }
  if (entry.setup.requiresOAuth) {
    const provider = entry.setup.oauthProvider ? entry.setup.oauthProvider : 'OAuth';
    bullets.push(`Signs in via ${provider}`);
  }
  if (entry.platforms && entry.platforms.length > 0) {
    bullets.push(`Available on ${platformListDisplay(entry.platforms)}`);
  }
  if (entry.setup.postInstallCommand) {
    bullets.push(`After install, runs \`${entry.setup.postInstallCommand}\``);
  }

  if (bullets.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm uppercase tracking-wide text-fg-dim mb-2">Setup</h2>
      <ul className="list-disc pl-5 text-sm text-fg-2 space-y-1">
        {bullets.map((b) => (
          <li key={b}>
            {/* Render inline-code segments inside backticks as <code>. */}
            {b.split(/(`[^`]+`)/g).map((chunk, i) =>
              chunk.startsWith('`') && chunk.endsWith('`')
                ? <code key={i} className="px-1 py-0.5 rounded bg-inset text-fg-2 text-xs">{chunk.slice(1, -1)}</code>
                : <span key={i}>{chunk}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
