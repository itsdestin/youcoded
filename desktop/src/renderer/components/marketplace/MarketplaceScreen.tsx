// Full-screen marketplace destination. Wallpaper reads through; chrome,
// hero, rails, and grid compose on top with theme-driven glass tokens.
//
// Mode switch:
//   discovery — no chips/search active → hero + rails + bottom grid
//   search    — any chip or search active → filtered grid only

import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { useChunkedReveal } from "../../hooks/use-chunked-reveal";
import { useMarketplace } from "../../state/marketplace-context";
import MarketplaceHero from "./MarketplaceHero";
import MarketplaceFilterBar, {
  type FilterState, type TypeChip, emptyFilter, isActive,
} from "./MarketplaceFilterBar";
import { catalogType } from "../../../shared/catalog-types";
import MarketplaceRail from "./MarketplaceRail";
import MarketplaceCard, { STATUS_TONE_CLASS } from "./MarketplaceCard";
import MarketplaceGrid from "./MarketplaceGrid";
import MarketplaceDetailOverlay, { type DetailTarget } from "./MarketplaceDetailOverlay";
import WallpaperBackdrop from "../WallpaperBackdrop";
import InstallingFooterStrip from "./InstallingFooterStrip";
import MarketplaceAuthChip from "./MarketplaceAuthChip";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { Button, CloseButton, EmptyState, ErrorState, LoadingState } from "../ui";
import { useEscClose } from "../../hooks/use-esc-close";
import { useNarrowViewport } from "../../hooks/use-narrow-viewport";
import { useCurrentPlatform } from "../../state/platform";
import { platformDisplayName, platformListDisplay } from "../../../shared/platform-display";
import type { SkillEntry, IntegrationEntry, IntegrationState } from "../../../shared/types";
import type { ThemeRegistryEntryWithStatus } from "../../../shared/theme-marketplace-types";
import { useScreenOpen, ScreenMark } from '../../shoot-mode';

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
  initialTypeChip?: TypeChip;
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
  // Photo-only build: `shoot` opens a tab, a search, or a detail by name. Fixture ids from the
  // practice marketplace: the civic-report skill and the meadow-mist theme.
  useScreenOpen('marketplace/skills', () => setFilter({ ...emptyFilter(), type: 'plugin' }));
  useScreenOpen('marketplace/themes', () => setFilter({ ...emptyFilter(), type: 'theme' }));
  useScreenOpen('marketplace/search', () => setFilter({ ...emptyFilter(), query: 'civic' }));
  useScreenOpen('marketplace/detail', () => setDetail({ kind: 'skill', id: 'civic-report' }));
  useScreenOpen('marketplace/theme-detail', () => setDetail({ kind: 'theme', slug: 'meadow-mist' }));
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

  // Register with the dismissal stack. ESC (desktop) and hardware back
  // (Android) both call onExit — same path as the on-screen close button.
  // LIFO with MarketplaceDetailOverlay: when an overlay is open over the
  // grid, its useEscClose entry sits above this one and gets dismissed first.
  useEscClose(true, onExit);

  const mode: "discovery" | "search" = isActive(filter) ? "search" : "discovery";
  // Marketplace cards match by the marketplace entry id (always the bare
  // plugin id, e.g. "wecoded-themes-plugin"). Installed-skills entries
  // can be either:
  //   - bare plugin-level placeholders ({id: "wecoded-themes-plugin"})
  //   - namespaced individual skills ({id: "wecoded-themes-plugin:theme-builder",
  //     pluginName: "wecoded-themes-plugin"})
  // The provider's pluginsWithScannedSkills filter (skill-provider.ts +
  // LocalSkillProvider.kt) intentionally drops the bare placeholder when
  // any individual skill is scanned, to avoid a duplicate card in the
  // command drawer. So for ANY plugin that ships at least one skill, the
  // marketplace card would never see a matching id and would forever show
  // "Install" even after a successful install. Matching pluginName too
  // bridges the two id shapes.
  const installedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of mp.installedSkills) {
      if (s.id) ids.add(s.id);
      if (s.pluginName) ids.add(s.pluginName);
    }
    return ids;
  }, [mp.installedSkills]);

  // Overhaul: a row that lives inside a bundle is installed when its bundle
  // is — the installer still works in bundles until per-item install ships.
  const isInstalled = (s: SkillEntry): boolean =>
    installedIds.has(s.id) || (!!s.catalog?.partOf && installedIds.has(s.catalog.partOf.id));

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

  // Set of slugs that count as "Featured picks" — prefer the rail explicitly
  // titled "Destin's picks" in the registry for tight scoping; fall back to
  // the union of all rails so the chip still does something if the rail gets
  // renamed in the marketplace registry.
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
    const picksOnly = filter.view === "picks";

    const skillPass = (s: SkillEntry): boolean => {
      // Overhaul (decision #1): grouped when browsing, split when looking for
      // something specific. A type tab shows every row of that kind, members
      // of bundles included; a typed search shows members too (typing "pdf"
      // must find the pdf skill, not the 19-skill bundle around it); chips
      // alone (a vibe, "New") keep the grouped view — bundles, no members.
      if (filter.type !== null) {
        if (filter.type === "theme") return false;
        if (catalogType(s.catalog) !== filter.type) return false;
      } else if (s.catalog?.partOf && !q) {
        return false;
      }
      // "Featured picks" chip: hard filter against the curated slug set so the
      // chip actually narrows results instead of just reordering them.
      if (picksOnly && !pickSlugs.has(s.id)) return false;
      if (filter.vibe && !(s.lifeArea || []).includes(filter.vibe)) return false;
      if (q) {
        const hay = `${s.displayName} ${s.description} ${s.tagline || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };
    const themePass = (t: ThemeRegistryEntryWithStatus): boolean => {
      if (filter.type !== null && filter.type !== "theme") return false;
      if (picksOnly && !pickSlugs.has(t.slug)) return false;
      if (filter.vibe) return false; // themes have no lifeArea (yet)
      if (q) {
        const hay = `${t.name} ${t.description || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    };

    const skills = mp.skillEntries.filter(skillPass);
    const themes = mp.themeEntries.filter(themePass);

    const combined: Array<
      | { kind: "skill"; entry: SkillEntry; pluginBadge?: { name: string; onClick: () => void } }
      | { kind: "theme"; entry: ThemeRegistryEntryWithStatus }
    > = [
      ...skills.map((entry) => ({
        kind: "skill" as const,
        entry,
        // Fix round 1 (review finding #1): built ONCE per entry, here inside
        // this memo — the search grid used to build this object literal
        // inline in its .map() below, a fresh `pluginBadge` prop every render
        // (independent of the onOpen fix), so bundle-member rows never got
        // MarketplaceCard's memo benefit. `setDetail` (React's state setter)
        // is already stable, so this closure needs no dependency to stay put.
        pluginBadge: entry.catalog?.partOf ? {
          name: `Part of ${entry.catalog.partOf.displayName}`,
          onClick: () => setDetail({ kind: "skill", id: entry.catalog!.partOf!.id }),
        } : undefined,
      })),
      ...themes.map((entry) => ({ kind: "theme" as const, entry })),
    ];

    // Recency timestamp lives under different field names per entry type:
    // skills use `updatedAt`, themes use `updated`. Read both so the "New"
    // chip surfaces recent themes too instead of always sinking them.
    const recency = (item: typeof combined[number]): string =>
      item.kind === "skill" ? (item.entry.updatedAt || "") : (item.entry.updated || "");

    if (filter.view === "popular") {
      combined.sort((a, b) => (
        (b.kind === "skill" ? (b.entry.installs || 0) : 0) -
        (a.kind === "skill" ? (a.entry.installs || 0) : 0)
      ));
    } else if (filter.view === "new") {
      combined.sort((a, b) => recency(b).localeCompare(recency(a)));
    }
    return combined;
  }, [mode, filter, mp.skillEntries, mp.themeEntries, pickSlugs]);

  const open = (t: DetailTarget) => setDetail(t);

  // Task 8 (render-cost consolidation 2026-09-18): MarketplaceCard is memoized
  // now, so a chunked list must hand every row the SAME onOpen reference — a
  // fresh `() => open(...)` closure per row (the old shape) defeats the memo
  // on every render. The card reports its OWN id (its existing "theme:<slug>"
  // convention for themes, bare id for skills — see MarketplaceCard's `id`
  // local), so this one useCallback serves every row of both chunked grids.
  const openEntry = useCallback((id: string) => {
    setDetail(id.startsWith("theme:") ? { kind: "theme", slug: id.slice("theme:".length) } : { kind: "skill", id });
  }, []);

  // Fix round 1 (review finding #2, explicit instruction): the integrations
  // rail passed a fresh `() => setIntegrationDetail(item)` closure per row,
  // defeating MarketplaceCard's memo the same way an unstable onOpen did
  // everywhere else. MarketplaceCard reports its OWN id (skillLike.id below
  // is set to item.slug), so one id-taking handler that looks the integration
  // back up by slug covers every row. Depends on `integrations` (not `[]`)
  // because that's the only thing that legitimately changes this lookup —
  // an unrelated marketplace-context render (e.g. installingIds) does not.
  const openIntegration = useCallback((slug: string) => {
    const match = integrations.find((it) => it.slug === slug);
    if (match) setIntegrationDetail(match);
  }, [integrations]);

  // P-1 #5: see the header below — decides whether the "Esc · Back to chat"
  // button exists at all, not just whether it is displayed.
  const compact = useNarrowViewport();

  // Task 8: both chunked grids (bottom catalog + search results) scroll the
  // SAME outer container (ref'd below) — draw-more triggers off it either way.
  const scrollRef = useRef<HTMLDivElement>(null);
  // The grouped "Explore everything" list, pre-wrapped into MarketplaceCard's
  // `item` shape ONCE here rather than inline in the .map() below. Fix round 1
  // (review finding #1): `item={{ kind: "skill", entry: s }}` inline built a
  // fresh object every render, so MarketplaceCard's memo (Task 8) never held —
  // every visible card redrew on every MarketplaceScreen render (e.g. every
  // install click, since the marketplace context value changes with
  // installingIds). Memoized here, keyed on mp.skillEntries, so `item`'s
  // identity (and useChunkedReveal's window) is stable per entry across
  // unrelated re-renders and only changes when the underlying catalog does.
  const exploreItems = useMemo(
    () => mp.skillEntries
      .filter((s) => !s.catalog?.partOf)
      .map((entry) => ({ kind: "skill" as const, entry })),
    [mp.skillEntries],
  );
  // resetKey is the filter's VALUES: while in discovery mode filter is always
  // the empty shape (isActive() is what flips `mode` to "search"), so this
  // never resets the explore grid mid-browse; it resets the search grid to
  // the top on every new query/chip. Deliberately NOT keyed on install state
  // (filter carries none), so installing an entry mid-scroll can't collapse
  // the window back to one chunk under the user.
  const filterKey = JSON.stringify(filter);
  const explore = useChunkedReveal(exploreItems, {
    resetKey: filterKey,
    rootRef: scrollRef,
    active: mode === "discovery",
  });
  const searchReveal = useChunkedReveal(filtered, {
    resetKey: filterKey,
    rootRef: scrollRef,
    active: mode === "search",
  });

  // P-1 #4: "Explore everything" used to render its heading over nothing while
  // the registry loaded — and forever if it couldn't be reached. Only the
  // nothing-loaded-yet case shows a state: fetchAll() flips `loading` on every
  // refresh (after each install/uninstall too), and swapping a populated grid
  // for a spinner each time would be a visible flash. The error text is
  // mp.error verbatim — the real message, never a guessed cause
  // (docs/error-message-standards.md). Retry re-runs the same fetch.
  const registryEmpty = mp.skillEntries.length === 0 && mp.themeEntries.length === 0;
  const registryState = registryEmpty && mp.loading
    ? <LoadingState what="the marketplace" />
    : registryEmpty && mp.error
      ? <ErrorState mode="recoverable" message={mp.error} onRetry={() => { void mp.refresh(); }} />
      : null;

  return (
    <div className="fixed inset-0 z-40">
      {/* Marked once the catalog has loaded, so a picture never shows the spinner. */}
      {!mp.loading && <ScreenMark name="marketplace" />}
      {!mp.loading && !filter.query && filter.type === 'plugin' && <ScreenMark name="marketplace/skills" />}
      {!mp.loading && !filter.query && filter.type === 'theme' && <ScreenMark name="marketplace/themes" />}
      {!mp.loading && filter.query.trim() !== '' && <ScreenMark name="marketplace/search" />}
      {/* Pre-blurred wallpaper as a non-scrolling backdrop. Absolute-positioned
          inside the FIXED outer wrapper (not the inner scroll container) so it
          stays pinned to the viewport while content scrolls over it. */}
      <WallpaperBackdrop />
      {/* Scroll happens on the inner div. overflow-x-hidden suppresses any
          stray horizontal wiggle from rail cards / wallpaper transform. Ref'd
          for both chunked grids' useChunkedReveal (Task 8) — it's the one
          scrolling root either mode uses. */}
      <div ref={scrollRef} className="absolute inset-0 overflow-y-auto overflow-x-hidden flex flex-col [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
          {/* panel-glass and the tighter py-1 stay as className overrides (spec
              decision 69): glass re-tiers translucency on wallpaper themes, and
              dropping it in a naive migration would make this chip opaque. */}
          {onOpenLibrary && (
            <Button
              variant="secondary"
              size="lg"
              type="button"
              onClick={onOpenLibrary}
              className="panel-glass py-1"
              aria-label="Open Your Library"
              title="Your Library"
            >
              {/* Wide: text label. Narrow: bookmark icon — matches the close-X
                  treatment on the adjacent button. */}
              <span className="hidden sm:inline">Your Library</span>
              <span className="sm:hidden inline-flex p-0.5" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
              </span>
            </Button>
          )}
          {/* Wide: "Esc · Back to chat", no border (the Esc key does the work).
              Ghost Button rather than a bare <button> so it carries the hover
              pill + focus ring — matched across all three screens, change 27.
              P-1 #5: this was `className="hidden sm:inline-flex"`, which never
              hid it — Tailwind v4 emits `.hidden` BEFORE `.inline-flex`, so the
              Button's own base `inline-flex` won and the keyboard hint rendered
              at phone width, ~150px that truncated the title to "Ma…". Rendering
              it only when not compact (same 640px boundary) removes the thief;
              the CloseButton below is the narrow exit. */}
          {!compact && (
            <Button
              variant="ghost"
              onClick={onExit}
              className="text-sm px-2.5 py-1"
              aria-label="Exit marketplace"
            >
              Esc · Back to chat
            </Button>
          )}
          {/* Narrow: bordered close-X button — touch users have no Esc key, so we
              give them an obvious close affordance with a button-shaped container
              matching the Library button next to it. */}
          {/* panel-glass + the border survive as className overrides — the bordered
              container is what makes this match the Library button next to it. */}
          <CloseButton
            onClick={onExit}
            label="Exit marketplace"
            className="sm:hidden panel-glass bg-inset rounded-md border border-edge-dim hover:border-edge"
          />
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

      <div className="px-3 sm:px-4 mt-2">
        <MarketplaceFilterBar value={filter} onChange={setFilter} />
      </div>

      {/* Tightened section spacing: gap-2 between rails (was gap-6) lets the
          rail's pt-3/pb-6 shadow buffers carry the visual rhythm instead of
          stacking gap + buffer + buffer between every section. mt-2 above
          keeps the filter bar visually attached to the hero. */}
      <div className="px-3 sm:px-4 mt-2 flex flex-col gap-2 pb-12">
        {mode === "discovery" ? (
          <>
            {/* Integrations rail — purpose-built cards only. Never mixed with
                skill/theme cards. Rendered above the curated picks rail so
                users see OAuth-based connections (Gmail, Drive, etc.) before
                curated plugin rails — these are the highest-value setup step.
                Hidden when the catalog hasn't loaded. */}
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
                        onOpen={openIntegration}
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
                      // Fix round 1 (review finding #2): was a fresh
                      // `() => open(...)` closure per row — openEntry (Task 8's
                      // own stable handler) does the identical routing from the
                      // card's own id, so it's reused here instead of a new one.
                      onOpen={openEntry}
                    />
                  ))}
                </MarketplaceRail>
              );
            })}

            {/* Bottom catalog — denser surface; ALL skills in default sort,
                drawn 50 at a time as you scroll (Task 8, render-cost
                consolidation 2026-09-18). Previously slice(0, 48) capped this
                at 48 entries, which silently hid most of the marketplace as it
                grew; drawing every entry at once after that fix stalled at
                catalog-growth scale (~58,000 page elements at stress scale).
                content-visibility:auto (the alternative PITFALLS used to
                suggest here) is retired app-wide — its implicit contain:paint
                clips card box-shadow glows (globals.css, use-entry-folding.ts).
                The chunked window keeps every entry reachable by scrolling,
                same as the removed slice(0, 48) never did. */}
            <section className="flex flex-col gap-2">
              <h3 className="text-lg font-medium text-fg px-1">Explore everything</h3>
              {/* P-1 #4: loading / unreachable state under the heading. */}
              {registryState ?? (
                <MarketplaceGrid
                  dense
                  sentinel={explore.hasMore && (
                    <div ref={explore.sentinelRef} className="col-span-full h-px" aria-hidden />
                  )}
                >
                  {/* Overhaul: the grouped view — bundles and standalone items
                      only. Rows that live inside a bundle are reached through
                      the type tabs, search, or the bundle's own page. */}
                  {explore.visible.map((item) => (
                    <MarketplaceCard
                      key={item.entry.id}
                      item={item}
                      installed={isInstalled(item.entry)}
                      updateAvailable={!!mp.updateAvailable[item.entry.id]}
                      onOpen={openEntry}
                    />
                  ))}
                </MarketplaceGrid>
              )}
            </section>
          </>
        ) : (
          <section>
            {/* P-1 #4: while nothing has loaded yet, the filtered list is empty
                for the wrong reason — show the registry state, not "no match". */}
            {registryState ?? (filtered.length === 0 ? (
              /* P-1 #3: ONE empty state with a way out. Previously "0 results"
                 and "Nothing matches those filters." rendered together, and
                 there was no button to clear the chips. */
              <EmptyState
                message="Nothing matches those filters."
                action={{ label: "Clear filters", onClick: () => setFilter(emptyFilter()) }}
              />
            ) : (
              <>
                {/* filtered.length, not searchReveal.visible.length — the
                    header counts the whole match set, not just what's drawn
                    so far (Task 8). */}
                <h3 className="text-sm text-fg-dim px-1 mb-2">
                  {filtered.length} result{filtered.length === 1 ? "" : "s"}
                </h3>
                <MarketplaceGrid
                  dense
                  sentinel={searchReveal.hasMore && (
                    <div ref={searchReveal.sentinelRef} className="col-span-full h-px" aria-hidden />
                  )}
                >
                  {searchReveal.visible.map((item) => (
                    <MarketplaceCard
                      key={item.kind === "skill" ? item.entry.id : `theme:${item.entry.slug}`}
                      item={item}
                      installed={item.kind === "skill" && isInstalled(item.entry)}
                      // Overhaul: a member row says which bundle it came from;
                      // the tag jumps to the bundle's page. Fix round 1: the
                      // badge object itself now comes off `item` (built once
                      // in the `filtered` memo above) instead of being
                      // rebuilt inline here every render.
                      pluginBadge={item.kind === "skill" ? item.pluginBadge : undefined}
                      onOpen={openEntry}
                    />
                  ))}
                </MarketplaceGrid>
              </>
            ))}
          </section>
        )}
      </div>

      {detail && (
        <MarketplaceDetailOverlay
          target={detail}
          onClose={() => setDetail(null)}
          onNavigate={setDetail}
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

      {/* Docked footer — internally position:fixed, so its placement in the
          JSX tree doesn't affect viewport pinning. */}
      <InstallingFooterStrip />
      </div>
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

  // Change 24: this was a second, hand-copied tone map that had already drifted
  // from MarketplaceCard's (it omitted the `border` keyword, and its `locked`
  // kept the stock slate hue after the card's was tokenized). One map now —
  // the detail overlay and the card can't disagree about what a status looks
  // like. The `border` keyword comes from STATUS_TONE_CLASS, so the call site
  // below no longer adds its own.

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
          {/* panel-glass + the border survive as className overrides — deliberately a
              bordered container matching the marketplace top bar. */}
          <CloseButton
            onClick={onClose}
            className="sm:hidden panel-glass bg-inset rounded-md border border-edge-dim hover:border-edge"
          />
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
                    <span className={`text-3xs uppercase tracking-wide rounded-full px-2 py-0.5 ${STATUS_TONE_CLASS[statusBadge.tone]}`}>
                      {statusBadge.text}
                    </span>
                    {item.state.error && (
                      <span className="text-xs text-destructive-fg truncate max-w-[40ch]" title={item.state.error}>{item.state.error}</span>
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
        <Button
          variant="secondary"
          size="lg"
          type="button"
          onClick={copy}
          className="shrink-0"
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button
          size="lg"
          type="button"
          onClick={onOpenSetupSession}
          className="shrink-0"
        >
          Open new setup session
        </Button>
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
