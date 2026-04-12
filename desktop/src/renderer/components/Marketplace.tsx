/**
 * Unified Marketplace — three-tab modal replacing Marketplace, ThemeMarketplace,
 * and SkillManager. Tabs: Installed / Skills / Themes.
 *
 * Wraps itself in MarketplaceProvider so the context is only live while the
 * modal is open. Keeps SkillCard, ThemeCard, SkillDetail, ThemeDetail as-is.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';

import { MarketplaceProvider, useMarketplace, type MarketplaceTab } from '../state/marketplace-context';
import SkillCard from './SkillCard';
import SkillDetail from './SkillDetail';
import ThemeCard from './ThemeCard';
import ThemeDetail from './ThemeDetail';
import type { SkillEntry, SkillFilters } from '../../shared/types';
import type { ThemeRegistryEntryWithStatus } from '../../shared/theme-marketplace-types';

// ── Props ────────────────────────────────────────────────────────────────────

interface MarketplaceProps {
  onClose: () => void;
  initialTab?: MarketplaceTab;
  // Callbacks for actions that need parent handling (editors, share sheets)
  onOpenShareSheet?: (skillId: string) => void;
  onOpenEditor?: (skillId: string) => void;
}

// Re-export MarketplaceTab for App.tsx
export type { MarketplaceTab };

// ── Wrapper: mounts provider around inner component ──────────────────────────

export default function Marketplace(props: MarketplaceProps) {
  return (
    <MarketplaceProvider>
      <MarketplaceInner {...props} />
    </MarketplaceProvider>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

function MarketplaceInner({ onClose, initialTab = 'skills', onOpenShareSheet, onOpenEditor }: MarketplaceProps) {
  const [activeTab, setActiveTab] = useState<MarketplaceTab>(initialTab);

  // Detail view state — when set, detail replaces the tab content
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [selectedTheme, setSelectedTheme] = useState<ThemeRegistryEntryWithStatus | null>(null);

  // Escape to close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Close detail first, then modal
        if (selectedSkillId) { setSelectedSkillId(null); e.stopPropagation(); }
        else if (selectedTheme) { setSelectedTheme(null); e.stopPropagation(); }
        else onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, selectedSkillId, selectedTheme]);

  // If detail view is active, render it full-screen
  if (selectedSkillId) {
    return (
      <div className="fixed inset-0 z-50 bg-canvas flex flex-col">
        <SkillDetail skillId={selectedSkillId} onBack={() => setSelectedSkillId(null)} />
      </div>
    );
  }
  if (selectedTheme) {
    return (
      <div className="fixed inset-0 z-50 bg-canvas flex flex-col">
        <ThemeDetail
          entry={selectedTheme}
          onBack={() => setSelectedTheme(null)}
          onInstallComplete={() => setSelectedTheme(null)}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-canvas flex flex-col">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-edge">
        <button onClick={onClose} className="text-fg-muted hover:text-fg mr-3 text-lg">&larr;</button>
        <h2 className="text-sm font-bold text-fg">Marketplace</h2>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-edge-dim">
        {(['installed', 'skills', 'themes'] as MarketplaceTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2.5 text-[11px] font-medium transition-colors ${
              activeTab === tab
                ? 'text-accent border-b-2 border-accent'
                : 'text-fg-muted hover:text-fg'
            }`}
          >
            {tab === 'installed' ? 'Installed' : tab === 'skills' ? 'Skills' : 'Themes'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'installed' && (
          <InstalledTab
            onSelectSkill={setSelectedSkillId}
            onSelectTheme={setSelectedTheme}
            onOpenShareSheet={onOpenShareSheet}
            onOpenEditor={onOpenEditor}
          />
        )}
        {activeTab === 'skills' && (
          <SkillsTab onSelectSkill={setSelectedSkillId} />
        )}
        {activeTab === 'themes' && (
          <ThemesTab onSelectTheme={setSelectedTheme} />
        )}
      </div>
    </div>
  );
}

// ── Installed Tab ────────────────────────────────────────────────────────────

function InstalledTab({
  onSelectSkill,
  onSelectTheme,
  onOpenShareSheet,
  onOpenEditor,
}: {
  onSelectSkill: (id: string) => void;
  onSelectTheme: (theme: ThemeRegistryEntryWithStatus) => void;
  onOpenShareSheet?: (id: string) => void;
  onOpenEditor?: (id: string) => void;
}) {
  const { installedSkills, favorites, loading, setFavorite, updateAvailable, update, uninstallSkill, packages, publishSkill } = useMarketplace();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  // Phase 4a: track publish-in-progress state per skill id
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<{ id: string; prUrl?: string; error?: string } | null>(null);
  const [filter, setFilter] = useState<'all' | 'favorites'>('all');

  const favSet = useMemo(() => new Set(favorites), [favorites]);

  const filtered = useMemo(() => {
    switch (filter) {
      case 'favorites': return installedSkills.filter(s => favSet.has(s.id));
      default: return installedSkills;
    }
  }, [installedSkills, filter, favSet]);

  if (loading) {
    return <div className="flex items-center justify-center py-12"><p className="text-fg-muted text-sm">Loading...</p></div>;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Filter pills */}
      <div className="px-4 pt-3 pb-2 flex gap-1.5">
        {(['all', 'favorites'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-full border whitespace-nowrap transition-colors ${
              filter === f
                ? 'bg-accent text-on-accent border-accent'
                : 'bg-panel text-fg-muted border-edge-dim hover:border-edge'
            }`}
          >
            {f === 'all' ? `All (${installedSkills.length})` : 'Favorites'}
          </button>
        ))}
      </div>

      {/* Installed skills list */}
      <div className="px-4 space-y-1">
        {filtered.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-fg-muted text-sm">{filter === 'all' ? 'No skills installed' : 'No matching skills'}</p>
          </div>
        ) : filtered.map(skill => (
          <div
            key={skill.id}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-panel border border-edge-dim hover:border-edge cursor-pointer transition-colors"
            onClick={() => onSelectSkill(skill.id)}
          >
            {/* Favorite star */}
            <button
              onClick={(e) => { e.stopPropagation(); setFavorite(skill.id, !favSet.has(skill.id)); }}
              className={`text-sm shrink-0 ${favSet.has(skill.id) ? 'text-[#f0ad4e]' : 'text-fg-faint hover:text-fg-muted'}`}
            >
              {favSet.has(skill.id) ? '★' : '☆'}
            </button>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-fg truncate">{skill.displayName || skill.id}</span>
                {/* Type badge */}
                <span className="px-1.5 py-0.5 text-[8px] font-medium rounded-sm bg-inset/50 text-fg-dim border border-edge/25">
                  Plugin
                </span>
              </div>
              <p className="text-[11px] text-fg-muted truncate">{skill.description}</p>
            </div>

            {/* Phase 3b: update-available badge */}
            {updateAvailable[skill.id] && (
              <span className="text-[8px] font-medium px-1.5 py-0.5 rounded-full bg-[#f0ad4e]/15 text-[#f0ad4e] border border-[#f0ad4e]/25 shrink-0">
                Update
              </span>
            )}

            {/* Actions */}
            <div className="flex items-center gap-1 shrink-0 opacity-60 hover:opacity-100 transition-opacity">
              {/* Phase 3b: update button, visible only when an update is available */}
              {updateAvailable[skill.id] && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    setUpdatingId(skill.id);
                    try { await update(skill.id, 'skill'); } catch {} finally { setUpdatingId(null); }
                  }}
                  disabled={updatingId === skill.id}
                  className="p-1 text-[#f0ad4e] hover:text-[#e09d3e] text-[10px] font-medium"
                  title="Update to latest version"
                >
                  {updatingId === skill.id ? '...' : '\u2191'}
                </button>
              )}
              {/* Phase 3b: uninstall button for marketplace packages */}
              {packages[skill.id]?.removable && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    try { await uninstallSkill(skill.id); } catch {}
                  }}
                  className="p-1 text-fg-muted hover:text-red-400 text-xs"
                  title="Uninstall"
                >
                  &#10005;
                </button>
              )}
              {onOpenShareSheet && (
                <button onClick={(e) => { e.stopPropagation(); onOpenShareSheet(skill.id); }} className="p-1 text-fg-muted hover:text-fg text-xs" title="Share">&#8599;</button>
              )}
              {/* Phase 4a: Publish button — only for user-created plugins */}
              {(skill.source === 'self' || skill.visibility === 'private') && skill.type === 'plugin' && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    setPublishingId(skill.id);
                    setPublishResult(null);
                    try {
                      const result = await publishSkill(skill.id);
                      setPublishResult({ id: skill.id, prUrl: result.prUrl });
                    } catch (err: any) {
                      setPublishResult({ id: skill.id, error: err?.message || 'Publish failed' });
                    } finally {
                      setPublishingId(null);
                    }
                  }}
                  disabled={publishingId === skill.id}
                  className="p-1 text-fg-muted hover:text-accent text-[10px] font-medium"
                  title="Publish to marketplace"
                >
                  {publishingId === skill.id ? '...' : '\u2191 Publish'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Phase 4a: Publish result banner — shows PR URL on success or error message */}
      {publishResult && (
        <div className="fixed bottom-4 left-4 right-4 z-[60]">
          <div className={`mx-auto max-w-sm px-4 py-3 rounded-lg border text-sm ${
            publishResult.prUrl
              ? 'bg-green-500/10 border-green-500/30 text-green-400'
              : 'bg-red-500/10 border-red-500/30 text-red-400'
          }`}>
            {publishResult.prUrl ? (
              <div>
                <p className="font-medium">Published successfully!</p>
                <a
                  href={publishResult.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] underline break-all"
                >
                  {publishResult.prUrl}
                </a>
              </div>
            ) : (
              <p>{publishResult.error}</p>
            )}
            <button
              onClick={() => setPublishResult(null)}
              className="absolute top-1 right-2 text-fg-muted hover:text-fg text-xs"
            >
              &times;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Quick Chips (sub-section of Installed tab) ───────────────────────────────

// ── Skills Tab ───────────────────────────────────────────────────────────────

type CategoryFilter = SkillEntry['category'] | 'all';
type SortOption = 'popular' | 'newest' | 'rating' | 'name';

const CATEGORY_PILLS: { label: string; value: CategoryFilter }[] = [
  { label: 'Personal', value: 'personal' },
  { label: 'Work', value: 'work' },
  { label: 'Development', value: 'development' },
  { label: 'Admin', value: 'admin' },
  { label: 'Other', value: 'other' },
];

const SORT_OPTIONS: { label: string; value: SortOption }[] = [
  { label: 'Popular', value: 'popular' },
  { label: 'Newest', value: 'newest' },
  { label: 'Rating', value: 'rating' },
  { label: 'Name', value: 'name' },
];

function SkillsTab({ onSelectSkill }: { onSelectSkill: (id: string) => void }) {
  const { skillEntries, installedSkills, installSkill, loading, updateAvailable } = useMarketplace();
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [sort, setSort] = useState<SortOption>('popular');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const installedIds = useMemo(() => new Set(installedSkills.map(s => s.id)), [installedSkills]);

  // Use the marketplace index directly with client-side filtering
  const filtered = useMemo(() => {
    let result = skillEntries;
    if (categoryFilter !== 'all') result = result.filter(s => s.category === categoryFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      result = result.filter(s =>
        (s.displayName || '').toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q)
      );
    }
    // Sort
    switch (sort) {
      case 'name': return [...result].sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
      case 'newest': return [...result].sort((a, b) => (b.updatedAt || b.installedAt || '').localeCompare(a.updatedAt || a.installedAt || ''));
      default: return result; // Server-side default ordering (popular/rating)
    }
  }, [skillEntries, categoryFilter, query, sort]);

  // Focus search on mount
  useEffect(() => { searchRef.current?.focus(); }, []);

  const handleInstall = useCallback(async (skill: SkillEntry) => {
    setInstallingId(skill.id);
    try { await installSkill(skill.id); } catch (err) { console.error('[Marketplace] Install failed:', err); }
    finally { setInstallingId(null); }
  }, [installSkill]);

  return (
    <>
      {/* Search bar */}
      <div className="px-4 pt-3 pb-2">
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search skills..."
          className="w-full px-3 py-2 text-sm rounded-lg bg-well border border-edge-dim text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent"
        />
      </div>

      {/* Filter pills */}
      <div className="px-4 pb-2 overflow-x-auto">
        <div className="flex gap-1.5 items-center flex-nowrap">
          {CATEGORY_PILLS.map(pill => (
            <button
              key={pill.value}
              onClick={() => setCategoryFilter(prev => prev === pill.value ? 'all' : pill.value)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-full border whitespace-nowrap transition-colors ${
                categoryFilter === pill.value
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-panel text-fg-muted border-edge-dim hover:border-edge'
              }`}
            >
              {pill.label}
            </button>
          ))}
        </div>
      </div>

      {/* Sort dropdown */}
      <div className="px-4 pb-2 flex justify-end">
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortOption)}
          className="text-[11px] bg-well border border-edge-dim rounded-sm px-2 py-1 text-fg-muted focus:outline-none focus:border-accent"
        >
          {SORT_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <div className="flex items-center justify-center py-12"><p className="text-fg-muted text-sm">Loading skills...</p></div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-fg-muted text-sm">No skills found</p>
            <p className="text-fg-faint text-xs mt-1">Try adjusting your filters or search query</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {filtered.map(skill => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onClick={(s) => onSelectSkill(s.id)}
                variant="marketplace"
                installed={installedIds.has(skill.id)}
                updateAvailable={updateAvailable[skill.id]}
                installing={installingId === skill.id}
                onInstall={!installedIds.has(skill.id) && installingId !== skill.id ? handleInstall : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Themes Tab ───────────────────────────────────────────────────────────────

type ThemeSortOption = 'newest' | 'name';

const FEATURE_PILLS = ['wallpaper', 'particles', 'glassmorphism', 'custom-font', 'custom-icons', 'mascot', 'custom-css'];

function ThemesTab({ onSelectTheme }: { onSelectTheme: (theme: ThemeRegistryEntryWithStatus) => void }) {
  const { themeEntries, loading, updateAvailable } = useMarketplace();
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'destinclaude' | 'community'>('all');
  const [modeFilter, setModeFilter] = useState<'all' | 'dark' | 'light'>('all');
  const [activeFeatures, setActiveFeatures] = useState<string[]>([]);
  const [sort, setSort] = useState<ThemeSortOption>('newest');
  const searchRef = useRef<HTMLInputElement>(null);

  const toggleFeature = (f: string) => {
    setActiveFeatures(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f]);
  };

  // Client-side filtering on theme entries from context
  const filtered = useMemo(() => {
    let result = themeEntries;
    if (sourceFilter !== 'all') result = result.filter(t => t.source === sourceFilter);
    if (modeFilter !== 'all') result = result.filter(t => modeFilter === 'dark' ? t.dark : !t.dark);
    if (activeFeatures.length > 0) {
      result = result.filter(t => activeFeatures.every(f => (t.features || []).includes(f)));
    }
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      result = result.filter(t =>
        t.name.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q)
      );
    }
    switch (sort) {
      case 'name': return [...result].sort((a, b) => a.name.localeCompare(b.name));
      default: return [...result].sort((a, b) => (b.updated || b.created || '').localeCompare(a.updated || a.created || ''));
    }
  }, [themeEntries, sourceFilter, modeFilter, activeFeatures, query, sort]);

  useEffect(() => { searchRef.current?.focus(); }, []);

  return (
    <>
      {/* Search bar */}
      <div className="px-4 pt-3 pb-2">
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search themes..."
          className="w-full px-3 py-2 text-sm rounded-lg bg-well border border-edge-dim text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent"
        />
      </div>

      {/* Filter pills */}
      <div className="px-4 pb-2 overflow-x-auto">
        <div className="flex gap-1.5 items-center flex-nowrap">
          {/* Source pills */}
          {(['all', 'destinclaude', 'community'] as const).map(src => (
            <button
              key={src}
              onClick={() => setSourceFilter(src)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-full border whitespace-nowrap transition-colors ${
                sourceFilter === src
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-panel text-fg-muted border-edge-dim hover:border-edge'
              }`}
            >
              {src === 'all' ? 'All' : src === 'destinclaude' ? 'Official' : 'Community'}
            </button>
          ))}
          <div className="w-px h-4 bg-edge-dim shrink-0" />
          {/* Mode pills */}
          {(['dark', 'light'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setModeFilter(prev => prev === mode ? 'all' : mode)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-full border whitespace-nowrap transition-colors ${
                modeFilter === mode
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-panel text-fg-muted border-edge-dim hover:border-edge'
              }`}
            >
              {mode === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
      </div>

      {/* Feature pills */}
      <div className="px-4 pb-2 overflow-x-auto">
        <div className="flex gap-1 items-center flex-nowrap">
          {FEATURE_PILLS.map(f => (
            <button
              key={f}
              onClick={() => toggleFeature(f)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded-full border whitespace-nowrap transition-colors ${
                activeFeatures.includes(f)
                  ? 'bg-accent/20 text-accent border-accent/40'
                  : 'bg-well text-fg-faint border-edge-dim hover:border-edge hover:text-fg-muted'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Sort */}
      <div className="px-4 pb-2 flex justify-end">
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as ThemeSortOption)}
          className="text-[11px] bg-well border border-edge-dim rounded-sm px-2 py-1 text-fg-muted focus:outline-none focus:border-accent"
        >
          <option value="newest">Newest</option>
          <option value="name">Name</option>
        </select>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <div className="flex items-center justify-center py-12"><p className="text-fg-muted text-sm animate-pulse">Loading themes...</p></div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-fg-muted text-sm">No themes found</p>
            <p className="text-fg-faint text-xs mt-1">Try adjusting your filters</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filtered.map(theme => (
              <ThemeCard
                key={theme.slug}
                entry={theme}
                onClick={() => onSelectTheme(theme)}
                updateAvailable={updateAvailable[theme.slug]}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
