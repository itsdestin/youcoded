import React, { useState, useEffect, useCallback, useRef } from 'react';
import ThemeCard from './ThemeCard';
import ThemeDetail from './ThemeDetail';
import type { ThemeRegistryEntryWithStatus, ThemeMarketplaceFilters } from '../../shared/theme-marketplace-types';

interface ThemeMarketplaceProps {
  onClose: () => void;
}

type SourceFilter = 'all' | 'destinclaude' | 'community';
type ModeFilter = 'all' | 'dark' | 'light';
type SortOption = 'newest' | 'name';

const SOURCE_PILLS: { label: string; value: SourceFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Official', value: 'destinclaude' },
  { label: 'Community', value: 'community' },
];

const MODE_PILLS: { label: string; value: ModeFilter }[] = [
  { label: 'Dark', value: 'dark' },
  { label: 'Light', value: 'light' },
];

const SORT_OPTIONS: { label: string; value: SortOption }[] = [
  { label: 'Newest', value: 'newest' },
  { label: 'Name', value: 'name' },
];

const FEATURE_PILLS = ['wallpaper', 'particles', 'glassmorphism', 'custom-font', 'custom-icons', 'mascot', 'custom-css'];

export default function ThemeMarketplace({ onClose }: ThemeMarketplaceProps) {
  const [themes, setThemes] = useState<ThemeRegistryEntryWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [activeFeatures, setActiveFeatures] = useState<string[]>([]);
  const [sort, setSort] = useState<SortOption>('newest');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchThemes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const claude = (window as any).claude;
      if (!claude?.theme?.marketplace?.list) {
        setError('Theme marketplace not available');
        setLoading(false);
        return;
      }
      const filters: ThemeMarketplaceFilters = { sort };
      if (sourceFilter !== 'all') filters.source = sourceFilter;
      if (modeFilter !== 'all') filters.mode = modeFilter;
      if (activeFeatures.length > 0) filters.features = activeFeatures;
      if (query.trim()) filters.query = query.trim();
      const results = await claude.theme.marketplace.list(filters);
      setThemes(results);
    } catch (err: any) {
      console.error('[ThemeMarketplace] Failed to fetch themes:', err);
      setError(err?.message || 'Failed to load themes');
      setThemes([]);
    } finally {
      setLoading(false);
    }
  }, [sourceFilter, modeFilter, activeFeatures, sort, query]);

  useEffect(() => { fetchThemes(); }, [fetchThemes]);
  useEffect(() => { searchRef.current?.focus(); }, []);

  const toggleFeature = (feature: string) => {
    setActiveFeatures(prev =>
      prev.includes(feature) ? prev.filter(f => f !== feature) : [...prev, feature],
    );
  };

  const handleInstallComplete = useCallback(() => {
    // Refresh the list to update installed status
    fetchThemes();
  }, [fetchThemes]);

  // Detail view
  if (selectedSlug) {
    const entry = themes.find(t => t.slug === selectedSlug);
    if (entry) {
      return (
        <div className="fixed inset-0 z-50 bg-canvas flex flex-col">
          <ThemeDetail
            entry={entry}
            onBack={() => setSelectedSlug(null)}
            onInstallComplete={handleInstallComplete}
          />
        </div>
      );
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-canvas flex flex-col">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-edge shrink-0">
        <button onClick={onClose} className="text-fg-muted hover:text-fg mr-3 text-lg">&larr;</button>
        <h2 className="text-sm font-bold text-fg">Theme Marketplace</h2>
      </div>

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
          {SOURCE_PILLS.map(pill => (
            <button
              key={pill.value}
              onClick={() => setSourceFilter(pill.value)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-full border whitespace-nowrap transition-colors ${
                sourceFilter === pill.value
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-panel text-fg-muted border-edge-dim hover:border-edge'
              }`}
            >
              {pill.label}
            </button>
          ))}

          {/* Divider */}
          <div className="w-px h-4 bg-edge-dim shrink-0" />

          {/* Mode pills */}
          {MODE_PILLS.map(pill => (
            <button
              key={pill.value}
              onClick={() => setModeFilter(prev => prev === pill.value ? 'all' : pill.value)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-full border whitespace-nowrap transition-colors ${
                modeFilter === pill.value
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-panel text-fg-muted border-edge-dim hover:border-edge'
              }`}
            >
              {pill.label}
            </button>
          ))}

          {/* Divider */}
          <div className="w-px h-4 bg-edge-dim shrink-0" />

          {/* Feature pills */}
          {FEATURE_PILLS.map(feature => (
            <button
              key={feature}
              onClick={() => toggleFeature(feature)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-full border whitespace-nowrap transition-colors ${
                activeFeatures.includes(feature)
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-panel text-fg-muted border-edge-dim hover:border-edge'
              }`}
            >
              {feature}
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
          <div className="flex items-center justify-center py-12">
            <span className="text-xs text-fg-muted animate-pulse">Loading themes...</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <p className="text-xs text-fg-muted text-center">{error}</p>
            <button
              onClick={fetchThemes}
              className="text-xs text-accent hover:underline"
            >
              Retry
            </button>
          </div>
        ) : themes.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-xs text-fg-muted">
              {query || sourceFilter !== 'all' || modeFilter !== 'all' || activeFeatures.length > 0
                ? 'No themes match your filters'
                : 'No themes available yet'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {themes.map(theme => (
              <ThemeCard
                key={theme.slug}
                entry={theme}
                onClick={() => setSelectedSlug(theme.slug)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
