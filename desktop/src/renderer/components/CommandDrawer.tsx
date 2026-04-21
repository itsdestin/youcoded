import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { SkillEntry } from '../../shared/types';
import SkillCard from './SkillCard';
import FavoriteStar from './marketplace/FavoriteStar';
import { useSkills } from '../state/skill-context';
import { useScrollFade } from '../hooks/useScrollFade';

interface Props {
  open: boolean;
  searchMode: boolean;
  externalFilter?: string; // Filter driven by InputBar when slash-triggered
  onSelect: (skill: SkillEntry) => void;
  onClose: () => void;
  onOpenManager: () => void;
  onOpenMarketplace: () => void;
  // Marketplace redesign Phase 2 — optional Library entry; only rendered
  // when provided so pre-redesign code paths stay unchanged.
  onOpenLibrary?: () => void;
}

const categoryChips = ['personal', 'work', 'development', 'admin', 'other'] as const;
type CategoryChip = typeof categoryChips[number];

export default function CommandDrawer({ open, searchMode, externalFilter, onSelect, onClose, onOpenManager, onOpenMarketplace, onOpenLibrary }: Props) {
  const { drawerSkills, favorites, setFavorite } = useSkills();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryChip | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useScrollFade<HTMLDivElement>();

  // Derive favorite id set for O(1) lookups
  const skillFavSet = useMemo(() => new Set(favorites), [favorites]);

  // Effective query: in search mode (slash-triggered), the InputBar drives
  // the filter via externalFilter; in browse mode, the drawer's own input does
  const effectiveQuery = searchMode ? (externalFilter ?? '') : search;
  const isSearching = effectiveQuery.trim().length > 0;

  // Focus internal search on open — only in browse mode (compass button).
  // In search mode the InputBar keeps focus so the user sees the "/" prefix.
  useEffect(() => {
    if (open && !searchMode) {
      setSearch('');
      // Small delay to let the transition start before focusing
      const t = setTimeout(() => searchRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open, searchMode]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Search mode: flat list matching the query (preserves original behavior)
  const searchFiltered = useMemo(() => {
    if (!isSearching) return drawerSkills;
    const q = effectiveQuery.toLowerCase();
    return drawerSkills.filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    );
  }, [drawerSkills, effectiveQuery, isSearching]);

  // Browse mode: apply category chip filter, then split into favorites / others
  const categoryFiltered = useMemo(() => {
    if (isSearching) return drawerSkills;
    if (!categoryFilter) return drawerSkills;
    return drawerSkills.filter((s) => (s.category ?? 'other') === categoryFilter);
  }, [drawerSkills, categoryFilter, isSearching]);

  // Favorites section — skills whose id or pluginName is in the favorites set
  const favsSorted = useMemo(() =>
    categoryFiltered
      .filter((s) => skillFavSet.has(s.id) || (s.pluginName != null && skillFavSet.has(s.pluginName)))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [categoryFiltered, skillFavSet],
  );

  // All-installed section — skills not in favorites
  const othersSorted = useMemo(() =>
    categoryFiltered
      .filter((s) => !skillFavSet.has(s.id) && !(s.pluginName != null && skillFavSet.has(s.pluginName)))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [categoryFiltered, skillFavSet],
  );

  // Helper: render a single drawer card with a FavoriteStar corner overlay.
  // FavoriteStar is a <button>, so it cannot be placed inside SkillCard's
  // drawer <button>. Instead, a relative-positioned wrapper div sits around
  // SkillCard and the star is absolutely positioned over the card corner.
  // FavoriteStar already calls e.stopPropagation(), so clicks on the star
  // never bubble into the SkillCard click handler.
  const renderDrawerCard = (skill: SkillEntry) => {
    const isFav = skillFavSet.has(skill.id) || (skill.pluginName != null && skillFavSet.has(skill.pluginName));
    const favId = skill.pluginName && skillFavSet.has(skill.pluginName) ? skill.pluginName : skill.id;
    return (
      <div key={skill.id} className="relative">
        <SkillCard skill={skill} onClick={onSelect} />
        <FavoriteStar
          corner
          size="sm"
          filled={isFav}
          onToggle={() => setFavorite(favId, !isFav)}
        />
      </div>
    );
  };

  return (
    <>
      {/* Backdrop — L1 drawer scrim via layer-scrim class (theme-tinted). */}
      <div
        className={`layer-scrim transition-opacity duration-300 ${
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        data-layer={1}
        style={{ zIndex: 40 }}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-50 bg-panel border-t border-edge-dim rounded-t-xl transition-transform duration-300 ease-out ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ maxHeight: '45vh' }}
      >
        {/* Grab handle */}
        <div className="flex justify-center py-2">
          <div className="w-8 h-1 rounded-full bg-fg-faint" />
        </div>

        {/* Search bar — read-only mirror in search mode (InputBar drives the
             filter), interactive in browse mode (compass button) */}
        <div className="px-4 pb-3">
          <div
            className="flex items-center gap-2 bg-well rounded-lg px-3 py-2 border border-edge-dim"
            {...(searchMode ? { onClick: () => {/* no-op: keep focus in InputBar */} } : {})}
          >
            <svg className="w-4 h-4 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
            </svg>
            {searchMode ? (
              /* Read-only mirror showing what the user typed after "/" */
              <span className="flex-1 text-sm text-fg-dim truncate select-none">
                {externalFilter ? `/${externalFilter}` : '/'}
              </span>
            ) : (
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search skills and commands..."
                className="flex-1 bg-transparent text-sm text-fg placeholder-fg-muted outline-none"
              />
            )}
            {/* Pencil — opens Your Library (favorites/installed management).
                Falls back to the legacy Skill Manager when the redesign flag
                is off; onOpenLibrary is only supplied in that mode. */}
            <button
              onClick={() => { onClose(); (onOpenLibrary ?? onOpenManager)(); }}
              className="shrink-0 p-1 rounded-sm hover:bg-inset text-fg-muted hover:text-fg transition-colors"
              title={onOpenLibrary ? "Your Library — favorites & installed" : "Manage skills"}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {/* Market stall — jump straight to the marketplace discovery
                view. Heroicons "building-storefront" outline. */}
            <button
              onClick={() => { onClose(); onOpenMarketplace(); }}
              className="shrink-0 p-1 rounded-sm hover:bg-inset text-fg-muted hover:text-fg transition-colors"
              title="Open marketplace"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016c.896 0 1.7-.393 2.25-1.016a3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75Z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Scrollable content.
             "Add Skills +" is always the last box in the drawer so the marketplace
             is always one click away. When a search has zero matches, it stands
             alone as the empty-state affordance. */}
        <div ref={scrollRef} className="scroll-fade pb-4" style={{ maxHeight: 'calc(45vh - 80px)' }}>
          {isSearching ? (
            // Search mode: flat filtered list, no chip row (preserves original behavior)
            <div className="px-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {searchFiltered.map((skill) => renderDrawerCard(skill))}
              <AddSkillsCard onClick={() => { onClose(); onOpenMarketplace(); }} />
            </div>
          ) : (
            // Browse mode: sticky category chip row + two flat sections
            <>
              {/* Sticky filter chip row — category filters + favorites-only toggle */}
              <div className="sticky top-0 z-10 bg-panel px-2 py-1.5 border-b border-edge-dim flex flex-wrap gap-1.5">
                {categoryChips.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategoryFilter((prev) => prev === c ? null : c)}
                    className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                      categoryFilter === c
                        ? 'bg-accent text-on-accent border-accent'
                        : 'bg-inset text-fg-2 border-edge-dim hover:border-edge'
                    }`}
                  >
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setFavoritesOnly((v) => !v)}
                  className={`text-xs px-2 py-0.5 rounded-full border ml-auto transition-colors ${
                    favoritesOnly
                      ? 'bg-accent/20 text-accent border-accent/50'
                      : 'bg-inset text-fg-2 border-edge-dim hover:border-edge'
                  }`}
                >
                  ★ Favorites only
                </button>
              </div>

              {/* Favorites section */}
              {favsSorted.length > 0 && (
                <section className="px-2 pt-2">
                  <h3 className="text-[10px] uppercase tracking-wide text-fg-dim mb-1 px-1">Favorites</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {favsSorted.map((skill) => renderDrawerCard(skill))}
                  </div>
                </section>
              )}

              {/* All installed (non-favorites) — hidden when favoritesOnly toggle is on */}
              {!favoritesOnly && othersSorted.length > 0 && (
                <section className="px-2 pt-3">
                  <h3 className="text-[10px] uppercase tracking-wide text-fg-dim mb-1 px-1">All installed</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {othersSorted.map((skill) => renderDrawerCard(skill))}
                  </div>
                </section>
              )}

              {/* Add Skills + always trails at the end */}
              <div className="px-2 pt-3 grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                <AddSkillsCard onClick={() => { onClose(); onOpenMarketplace(); }} />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// Persistent "Add Skills +" tile — matches SkillCard's drawer dimensions so it
// sits naturally at the end of the grid. Uses dashed border + accent color to
// read as an action, not a skill.
function AddSkillsCard({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="bg-panel/40 border border-dashed border-edge rounded-lg p-3 text-left hover:bg-inset hover:border-accent transition-colors flex flex-col items-center justify-center text-accent"
    >
      <span className="text-lg font-medium leading-none">+</span>
      <span className="text-sm font-medium mt-1">Add Skills</span>
      <span className="text-[11px] text-fg-muted mt-1">Browse marketplace</span>
    </button>
  );
}
