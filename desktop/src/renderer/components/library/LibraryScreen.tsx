// Your Library — management destination. Favorites + Installed + Updates.
// Shares MarketplaceProvider with MarketplaceScreen (per design doc — do
// not fork the context; install/uninstall must mutate one source of truth).

import React, { useMemo, useState, useEffect } from "react";
import { useMarketplace } from "../../state/marketplace-context";
import MarketplaceCard from "../marketplace/MarketplaceCard";
import MarketplaceGrid from "../marketplace/MarketplaceGrid";
import MarketplaceDetailOverlay, {
  type DetailTarget,
} from "../marketplace/MarketplaceDetailOverlay";
import type { SkillEntry } from "../../../shared/types";

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
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  // Tab state — defaults to 'skills' if no initialTab provided.
  const [tab, setTab] = useState<'skills' | 'themes' | 'updates'>(initialTab ?? 'skills');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || detail) return;
      e.stopPropagation();
      onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, onExit]);

  const favSet = useMemo(() => new Set(mp.favorites), [mp.favorites]);
  const themeFavSet = useMemo(() => new Set(mp.themeFavorites), [mp.themeFavorites]);

  // Count items that have updates available (skills + themes combined).
  const updateCount = useMemo(
    () => Object.values(mp.updateAvailable).filter(Boolean).length,
    [mp.updateAvailable],
  );

  // If the user is on the updates tab and updates drop to zero, fall back to skills.
  useEffect(() => {
    if (tab === 'updates' && updateCount === 0) setTab('skills');
  }, [tab, updateCount]);

  // ── per-item render helpers ────────────────────────────────────────────────

  function renderSkillCard(s: SkillEntry) {
    return (
      <MarketplaceCard
        key={s.id}
        item={{ kind: "skill", entry: s }}
        installed
        updateAvailable={!!mp.updateAvailable[s.id]}
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
    <div className="fixed inset-0 z-40 overflow-y-auto flex flex-col">
      <div className="flex items-center justify-between p-3">
        <h1 className="text-xl font-semibold text-fg pl-2">Your Library</h1>
        <div className="flex items-center gap-2">
          {onOpenMarketplace && (
            <button
              type="button"
              onClick={onOpenMarketplace}
              className="text-fg-2 hover:text-fg text-sm px-3 py-1 rounded-md border border-edge-dim hover:border-edge"
              aria-label="Open marketplace"
            >
              Marketplace
            </button>
          )}
          <button
            type="button"
            onClick={onExit}
            className="text-fg-dim hover:text-fg text-sm px-2 py-1"
            aria-label="Exit library"
          >
            Esc · Back to chat
          </button>
        </div>
      </div>

      {/* Tab chip row — sticky so it stays visible while scrolling content. */}
      <div className="sticky top-0 z-10 bg-canvas px-4 py-2 border-b border-edge-dim flex gap-2">
        {(['skills', 'themes'] as const).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-md text-sm ${
              tab === t ? 'bg-accent text-on-accent' : 'bg-inset text-fg-2 hover:text-fg'
            }`}
          >
            {t === 'skills' ? 'Skills' : 'Themes'}
          </button>
        ))}
        {/* Updates tab only shown when there are updates to act on. */}
        {updateCount > 0 && (
          <button
            type="button"
            onClick={() => setTab('updates')}
            className={`px-3 py-1.5 rounded-md text-sm ${
              tab === 'updates' ? 'bg-accent text-on-accent' : 'bg-inset text-fg-2 hover:text-fg'
            }`}
          >
            Updates · {updateCount}
          </button>
        )}
      </div>

      <div className="px-4 flex flex-col gap-8 pb-12 pt-4">

        {/* Skills tab — one card per plugin. Multi-skill plugins collapse to
             a single tile; the "What's inside" detail overlay lists bundled
             skills. Updates tab still uses installedSkills since update
             detection is per-skill. */}
        {tab === 'skills' && (
          <>
            <Section title="Favorites" empty="No favorites yet — tap the star on any installed skill.">
              {mp.installedPlugins.filter(p => favSet.has(p.id)).length > 0 && (
                <MarketplaceGrid>
                  {mp.installedPlugins.filter(p => favSet.has(p.id)).map(renderSkillCard)}
                </MarketplaceGrid>
              )}
            </Section>
            <Section title="Installed" empty="Install something from the marketplace to see it here.">
              {mp.installedPlugins.filter(p => !favSet.has(p.id)).length > 0 && (
                <MarketplaceGrid>
                  {mp.installedPlugins.filter(p => !favSet.has(p.id)).map(renderSkillCard)}
                </MarketplaceGrid>
              )}
            </Section>
          </>
        )}

        {/* Themes tab — starred theme favorites first, then the rest. */}
        {tab === 'themes' && (
          <>
            <Section title="Favorite themes" empty="No favorite themes yet — tap the star on any installed theme.">
              {mp.themeEntries.filter(t => t.installed && themeFavSet.has(t.slug)).length > 0 && (
                <MarketplaceGrid>
                  {mp.themeEntries.filter(t => t.installed && themeFavSet.has(t.slug)).map(renderThemeCard)}
                </MarketplaceGrid>
              )}
            </Section>
            <Section title="Installed themes" empty="No themes installed.">
              {mp.themeEntries.filter(t => t.installed && !themeFavSet.has(t.slug)).length > 0 && (
                <MarketplaceGrid>
                  {mp.themeEntries.filter(t => t.installed && !themeFavSet.has(t.slug)).map(renderThemeCard)}
                </MarketplaceGrid>
              )}
            </Section>
          </>
        )}

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
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children?: React.ReactNode }) {
  const hasContent = React.Children.count(children) > 0;
  return (
    <section>
      <h2 className="text-lg font-medium text-fg px-1 mb-2">{title}</h2>
      {hasContent ? children : <p className="text-fg-dim px-1 text-sm">{empty}</p>}
    </section>
  );
}
