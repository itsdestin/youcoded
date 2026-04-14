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
}

export default function LibraryScreen({ onExit }: Props) {
  const mp = useMarketplace();
  const [detail, setDetail] = useState<DetailTarget | null>(null);

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
  const installedById = useMemo(() => {
    const m = new Map<string, SkillEntry>();
    for (const s of mp.installedSkills) m.set(s.id, s);
    return m;
  }, [mp.installedSkills]);

  const favorites = mp.installedSkills.filter((s) => favSet.has(s.id));
  const installedOnly = mp.installedSkills.filter((s) => !favSet.has(s.id));
  const installedThemes = mp.themeEntries.filter((t) => t.installed);
  const updatesAvailable = [
    ...mp.installedSkills.filter((s) => !!mp.updateAvailable[s.id]),
    // Themes with updates — merged by slug key in updateAvailable map.
    ...installedThemes.filter((t) => !!mp.updateAvailable[t.slug]),
  ];

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto flex flex-col">
      <div className="flex items-center justify-between p-3">
        <h1 className="text-xl font-semibold text-fg pl-2">Your Library</h1>
        <button
          type="button"
          onClick={onExit}
          className="text-fg-dim hover:text-fg text-sm px-2 py-1"
          aria-label="Exit library"
        >
          Esc · Back to chat
        </button>
      </div>

      <div className="px-4 flex flex-col gap-8 pb-12">
        <Section title="Updates available" empty="Nothing to update.">
          {updatesAvailable.length > 0 && (
            <MarketplaceGrid>
              {updatesAvailable.map((item) => {
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
              })}
            </MarketplaceGrid>
          )}
        </Section>

        <Section title="Favorites" empty="No favorites yet — tap the star on any installed skill.">
          {favorites.length > 0 && (
            <MarketplaceGrid>
              {favorites.map((s) => (
                <MarketplaceCard
                  key={s.id}
                  item={{ kind: "skill", entry: s }}
                  installed
                  onOpen={() => setDetail({ kind: "skill", id: s.id })}
                />
              ))}
            </MarketplaceGrid>
          )}
        </Section>

        <Section title="Installed skills" empty="Install something from the marketplace to see it here.">
          {installedOnly.length > 0 && (
            <MarketplaceGrid>
              {installedOnly.map((s) => (
                <MarketplaceCard
                  key={s.id}
                  item={{ kind: "skill", entry: s }}
                  installed
                  onOpen={() => setDetail({ kind: "skill", id: s.id })}
                />
              ))}
            </MarketplaceGrid>
          )}
        </Section>

        <Section title="Installed themes" empty="No themes installed.">
          {installedThemes.length > 0 && (
            <MarketplaceGrid>
              {installedThemes.map((t) => (
                <MarketplaceCard
                  key={`theme:${t.slug}`}
                  item={{ kind: "theme", entry: t }}
                  installed
                  onOpen={() => setDetail({ kind: "theme", slug: t.slug })}
                />
              ))}
            </MarketplaceGrid>
          )}
        </Section>
      </div>

      {detail && <MarketplaceDetailOverlay target={detail} onClose={() => setDetail(null)} />}
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
