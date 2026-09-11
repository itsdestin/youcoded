// Your Library — management destination. Favorites + Installed + Updates.
// Shares MarketplaceProvider with MarketplaceScreen (per design doc — do
// not fork the context; install/uninstall must mutate one source of truth).

import React, { useMemo, useState, useEffect } from "react";
import { useMarketplace } from "../../state/marketplace-context";
import { useEscClose } from "../../hooks/use-esc-close";
import { Button, CloseButton, EmptyState, ErrorState, LoadingState, SegmentedTabs, SegmentedTabLabel, PluginIcon, PaletteIcon } from "../ui";
import MarketplaceCard from "../marketplace/MarketplaceCard";
import WallpaperBackdrop from "../WallpaperBackdrop";
import MarketplaceGrid from "../marketplace/MarketplaceGrid";
import MarketplaceDetailOverlay, {
  type DetailTarget,
} from "../marketplace/MarketplaceDetailOverlay";
import type { SkillEntry } from "../../../shared/types";
import { plainMessage } from "../../utils/ipc-error";

interface Props {
  onExit(): void;
  // Jump to the marketplace destination. Matches MarketplaceScreen's
  // onOpenLibrary — symmetric navigation between the two top-level views.
  onOpenMarketplace?(): void;
  // Threaded through to the detail overlay so users can share/QR from Library.
  onOpenShareSheet?(skillId: string): void;
  onOpenThemeShare?(themeSlug: string): void;
  // Context-aware default tab — set by youcoded:open-library event (Task 5.1).
  initialTab?: 'skills' | 'themes' | 'updates';
}

export default function LibraryScreen({
  onExit, onOpenMarketplace, onOpenShareSheet, onOpenThemeShare, initialTab,
}: Props) {
  const mp = useMarketplace();

  // What a tab shows INSTEAD of its sections while it has nothing real to show.
  // WHY (error inventory 2026-09-10, false message 15): installedSkills and themeEntries
  // are [] both before marketplace-context's fetchAll finishes and after it fails, and the
  // sections' empty state cannot tell either from a real "nothing installed" — so a failed
  // or unfinished load told someone with plugins "Nothing installed yet." A running load
  // now says so; a failed one names the reason and offers Retry. Once a tab HAS rows, a
  // later failed refresh leaves them on screen: stale rows are still real rows, and
  // swapping them for an error would hide things the user can see are installed.
  const loadGate = (hasRows: boolean, what: 'plugins' | 'themes'): React.ReactNode | null => {
    if (hasRows) return null;
    // The theme list can fail on its own without failing the whole load (code review F4).
    const failure = what === 'themes' ? (mp.error ?? mp.themesError) : mp.error;
    if (failure) {
      return (
        <ErrorState
          message={`Couldn't load your installed ${what}: ${plainMessage(failure)}`}
          onRetry={() => { void mp.refresh(); }}
        />
      );
    }
    if (mp.loading) return <LoadingState what={`your ${what}`} />;
    return null;
  };
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  // Tab state — defaults to 'skills' if no initialTab provided.
  const [tab, setTab] = useState<'skills' | 'themes' | 'updates'>(initialTab ?? 'skills');

  // Register with the dismissal stack — ESC (desktop) and hardware back
  // (Android) both call onExit. LIFO with any nested overlay so the overlay
  // closes first (detail popup), then the screen.
  useEscClose(true, onExit);

  const favSet = useMemo(() => new Set(mp.favorites), [mp.favorites]);
  const themeFavSet = useMemo(() => new Set(mp.themeFavorites), [mp.themeFavorites]);

  // Count items that have updates available (skills + themes combined).
  const updateCount = useMemo(
    () => Object.values(mp.updateAvailable).filter(Boolean).length,
    [mp.updateAvailable],
  );

  // Installed-theme count for the Themes segment — themeEntries holds the whole
  // registry, so filter to what is actually installed (mirrors the Installed
  // themes section below).
  const installedThemeCount = useMemo(
    () => mp.themeEntries.filter(t => t.installed).length,
    [mp.themeEntries],
  );

  // Empty-state CTA for the Installed sections. undefined when the screen was
  // mounted without a marketplace destination, so EmptyState renders no button.
  const browseAction = onOpenMarketplace
    ? { label: 'Browse the Marketplace', onClick: onOpenMarketplace }
    : undefined;

  // If the user is on the updates tab and updates drop to zero, fall back to skills.
  useEffect(() => {
    if (tab === 'updates' && updateCount === 0) setTab('skills');
  }, [tab, updateCount]);

  // ── per-item render helpers ────────────────────────────────────────────────

  // Plugin-name lookup for the skill-card badge. Skills whose pluginName
  // resolves to a marketplace entry get a clickable pill that jumps to
  // that plugin's detail overlay. Skills without a matching registry
  // entry fall back to MarketplaceCard's generic source tag.
  const pluginDisplayNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const entry of mp.skillEntries) {
      m.set(entry.id, entry.displayName);
    }
    return m;
  }, [mp.skillEntries]);

  function renderSkillCard(s: SkillEntry) {
    const pluginId = s.pluginName;
    const pluginName = pluginId ? pluginDisplayNames.get(pluginId) : undefined;
    const pluginBadge = pluginId && pluginName
      ? { name: pluginName, onClick: () => setDetail({ kind: "skill", id: pluginId }) }
      : undefined;
    return (
      <MarketplaceCard
        key={s.id}
        item={{ kind: "skill", entry: s }}
        installed
        updateAvailable={!!mp.updateAvailable[s.id]}
        pluginBadge={pluginBadge}
        onOpen={() => setDetail({ kind: "skill", id: s.id })}
      />
    );
  }

  function renderThemeCard(t: (typeof mp.themeEntries)[number]) {
    return (
      <MarketplaceCard
        key={`theme:${t.slug}`}
        item={{ kind: "theme", entry: t }}
        installed
        updateAvailable={!!mp.updateAvailable[t.slug]}
        onOpen={() => setDetail({ kind: "theme", slug: t.slug })}
      />
    );
  }

  // Unified card for the Updates tab — handles both skills and themes.
  function renderMixedCard(item: SkillEntry | (typeof mp.themeEntries)[number]) {
    const isTheme = "slug" in item && !("id" in item);
    const kind = isTheme ? "theme" : "skill";
    return (
      <MarketplaceCard
        key={kind === "theme" ? `theme:${(item as any).slug}` : (item as SkillEntry).id}
        item={
          kind === "theme"
            ? { kind: "theme", entry: item as any }
            : { kind: "skill", entry: item as SkillEntry }
        }
        installed
        updateAvailable
        onOpen={() =>
          setDetail(
            kind === "theme"
              ? { kind: "theme", slug: (item as any).slug }
              : { kind: "skill", id: (item as SkillEntry).id },
          )
        }
      />
    );
  }

  return (
    <div className="fixed inset-0 z-40">
      {/* Pre-blurred wallpaper as a non-scrolling backdrop — pinned to the
          fixed outer wrapper so it stays put as content scrolls. */}
      <WallpaperBackdrop />
      <div className="absolute inset-0 overflow-y-auto overflow-x-hidden flex flex-col [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex items-center justify-between gap-2 p-3">
        <h1 className="text-xl font-semibold text-fg pl-2 truncate min-w-0">Your Library</h1>
        <div className="flex items-center gap-2 shrink-0">
          {/* panel-glass and the tighter py-1 stay as className overrides (spec
              decision 69) — glass re-tiers translucency on wallpaper themes, so a
              naive migration would leave this chip opaque over the wallpaper. */}
          {onOpenMarketplace && (
            <Button
              variant="secondary"
              size="lg"
              type="button"
              onClick={onOpenMarketplace}
              className="panel-glass py-1"
              aria-label="Open marketplace"
              title="Marketplace"
            >
              {/* Wide: text. Narrow: storefront icon — symmetric with MarketplaceScreen's library bookmark. */}
              <span className="hidden sm:inline">Marketplace</span>
              <span className="sm:hidden inline-flex p-0.5" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 9l1-5h16l1 5" />
                  <path d="M5 9v11h14V9" />
                  <path d="M9 13h6" />
                </svg>
              </span>
            </Button>
          )}
          {/* Wide: Esc text. Narrow: bordered close-X — matches the marketplace top bar. */}
          <Button
            variant="ghost"
            onClick={onExit}
            className="hidden sm:inline-flex text-sm px-2.5 py-1"
            aria-label="Exit library"
          >
            Esc · Back to chat
          </Button>
          {/* Was a hand-rolled button + inline ✕ SVG while Marketplace next door
              already used the primitive — change 27 is "one exit per surface
              type", so the two narrow exits must be the same component. */}
          <CloseButton
            onClick={onExit}
            label="Exit library"
            className="sm:hidden panel-glass bg-inset rounded-md border border-edge-dim hover:border-edge"
          />
        </div>
      </div>

      {/* Tab row — sticky so it stays visible while scrolling content.
          UI review P-2 #2: the Library adopts the Projects header switcher —
          one rounded-full pill of icon + label + count segments — so the two
          top-level browsing screens share a single switcher shape. The pill
          look itself lives in SegmentedTabs (variant="pill"); this file only
          supplies the segment contents. The Updates tab is conditional, so it
          is appended to the array rather than rendered as a sibling — otherwise
          it would sit outside the tablist and drop out of arrow-key navigation. */}
      <div className="sticky top-0 z-10 bg-canvas px-4 py-2 border-b border-edge-dim">
        <SegmentedTabs
          aria-label="Library sections"
          variant="pill"
          value={tab}
          onChange={(id) => setTab(id as typeof tab)}
          tabs={[
            {
              id: 'skills',
              // "Plugins", not "Skills" — Destin unified the word across both switchers (2026-08-27).
              label: <SegmentedTabLabel icon={<PluginIcon />} text="Plugins" count={mp.installedSkills.length} active={tab === 'skills'} />,
            },
            {
              id: 'themes',
              label: <SegmentedTabLabel icon={<PaletteIcon />} text="Themes" count={installedThemeCount} active={tab === 'themes'} />,
            },
            ...(updateCount > 0 ? [{ id: 'updates', label: `Updates · ${updateCount}` }] : []),
          ]}
        />
      </div>

      <div className="px-4 flex flex-col gap-8 pb-12 pt-4">

        {/* Skills tab — starred favorites first, then the rest. Each skill
             card carries a plugin-name badge that jumps to the parent
             plugin's marketplace detail overlay. */}
        {tab === 'skills' && (loadGate(mp.installedSkills.length > 0, 'plugins') ?? (
          <>
            <Section title="Favorites" empty="Star an installed plugin and it appears here.">
              {mp.installedSkills.filter(s => favSet.has(s.id)).length > 0 && (
                <MarketplaceGrid>
                  {mp.installedSkills.filter(s => favSet.has(s.id)).map(renderSkillCard)}
                </MarketplaceGrid>
              )}
            </Section>
            <Section title="Installed" empty="Nothing installed yet." action={browseAction}>
              {mp.installedSkills.filter(s => !favSet.has(s.id)).length > 0 && (
                <MarketplaceGrid>
                  {mp.installedSkills.filter(s => !favSet.has(s.id)).map(renderSkillCard)}
                </MarketplaceGrid>
              )}
            </Section>
          </>
        ))}

        {/* Themes tab — starred theme favorites first, then the rest. */}
        {tab === 'themes' && (loadGate(installedThemeCount > 0, 'themes') ?? (
          <>
            <Section title="Favorite themes" empty="Star an installed theme and it appears here.">
              {mp.themeEntries.filter(t => t.installed && themeFavSet.has(t.slug)).length > 0 && (
                <MarketplaceGrid>
                  {mp.themeEntries.filter(t => t.installed && themeFavSet.has(t.slug)).map(renderThemeCard)}
                </MarketplaceGrid>
              )}
            </Section>
            <Section title="Installed themes" empty="No themes installed yet." action={browseAction}>
              {mp.themeEntries.filter(t => t.installed && !themeFavSet.has(t.slug)).length > 0 && (
                <MarketplaceGrid>
                  {mp.themeEntries.filter(t => t.installed && !themeFavSet.has(t.slug)).map(renderThemeCard)}
                </MarketplaceGrid>
              )}
            </Section>
          </>
        ))}

        {/* Updates tab — all update-available items (skills + themes) in one list. */}
        {tab === 'updates' && (
          <Section title="Updates available" empty="Nothing to update.">
            {[
              ...mp.installedSkills.filter(s => !!mp.updateAvailable[s.id]),
              ...mp.themeEntries.filter(t => !!mp.updateAvailable[t.slug]),
            ].length > 0 && (
              <MarketplaceGrid>
                {[
                  ...mp.installedSkills.filter(s => !!mp.updateAvailable[s.id]),
                  ...mp.themeEntries.filter(t => !!mp.updateAvailable[t.slug]),
                ].map(renderMixedCard)}
              </MarketplaceGrid>
            )}
          </Section>
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
      </div>
    </div>
  );
}

function Section({ title, empty, action, children }: {
  title: string;
  empty: string;
  // Optional button under the empty message (Installed sections offer "Browse
  // the Marketplace"; Favorites sections have nothing to offer, so none).
  action?: { label: string; onClick: () => void };
  children?: React.ReactNode;
}) {
  // Bug fix (UI review P-2 #1): every call site passes `{cond && <Grid/>}`,
  // and when `cond` is false that child is the literal `false` — which
  // React.Children.count STILL counts as 1. So `hasContent` was always true
  // and the empty state had never rendered on any theme since this file was
  // written. toArray() drops null/undefined/boolean children, so filtering it
  // counts only real elements.
  const hasContent = React.Children.toArray(children).filter(Boolean).length > 0;
  return (
    <section>
      <h2 className="text-lg font-medium text-fg px-1 mb-2">{title}</h2>
      {hasContent ? children : <EmptyState message={empty} action={action} />}
    </section>
  );
}
