import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSkills } from '../state/skill-context';
import SkillCard from './SkillCard';
import SkillDetail from './SkillDetail';
import type { SkillEntry, SkillFilters } from '../../shared/types';

interface MarketplaceProps {
  onClose: () => void;
}

type TypeFilter = 'all' | 'prompt' | 'plugin';
type CategoryFilter = SkillEntry['category'] | 'all';
type SortOption = 'popular' | 'newest' | 'rating' | 'name';

const TYPE_PILLS: { label: string; value: TypeFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Prompts', value: 'prompt' },
  { label: 'Plugins', value: 'plugin' },
];

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

export default function Marketplace({ onClose }: MarketplaceProps) {
  const { listMarketplace, install, installed } = useSkills();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [sort, setSort] = useState<SortOption>('popular');
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const installedIds = new Set(installed.map(s => s.id));

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    try {
      const filters: SkillFilters = { sort };
      if (typeFilter !== 'all') filters.type = typeFilter;
      if (categoryFilter !== 'all') filters.category = categoryFilter;
      if (query.trim()) filters.query = query.trim();
      const results = await listMarketplace(filters);
      setSkills(results);
    } catch (err) {
      console.error('[Marketplace] Failed to fetch skills:', err);
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, [listMarketplace, typeFilter, categoryFilter, sort, query]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const handleInstall = useCallback(async (skill: SkillEntry) => {
    try {
      await install(skill.id);
      // Re-fetch to update any server-side state
      await fetchSkills();
    } catch (err) {
      console.error('[Marketplace] Install failed:', err);
    }
  }, [install, fetchSkills]);

  const handleCardClick = useCallback((skill: SkillEntry) => {
    setSelectedSkillId(skill.id);
  }, []);

  // If a skill detail is selected, show that instead of the grid
  if (selectedSkillId) {
    return (
      <div className="fixed inset-0 z-50 bg-canvas flex flex-col">
        <SkillDetail
          skillId={selectedSkillId}
          onBack={() => setSelectedSkillId(null)}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-canvas flex flex-col">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-edge">
        <button
          onClick={onClose}
          className="text-fg-muted hover:text-fg mr-3 text-lg"
        >
          &larr;
        </button>
        <h2 className="text-sm font-bold text-fg">Marketplace</h2>
      </div>

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
          {/* Type pills */}
          {TYPE_PILLS.map(pill => (
            <button
              key={pill.value}
              onClick={() => setTypeFilter(pill.value)}
              className={`px-2.5 py-1 text-[11px] font-medium rounded-full border whitespace-nowrap transition-colors ${
                typeFilter === pill.value
                  ? 'bg-accent text-on-accent border-accent'
                  : 'bg-panel text-fg-muted border-edge-dim hover:border-edge'
              }`}
            >
              {pill.label}
            </button>
          ))}

          {/* Divider */}
          <div className="w-px h-4 bg-edge-dim shrink-0" />

          {/* Category pills */}
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
          <div className="flex items-center justify-center py-12">
            <p className="text-fg-muted text-sm">Loading skills...</p>
          </div>
        ) : skills.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-fg-muted text-sm">No skills found</p>
            <p className="text-fg-faint text-xs mt-1">Try adjusting your filters or search query</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {skills.map(skill => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onClick={handleCardClick}
                variant="marketplace"
                installed={installedIds.has(skill.id)}
                onInstall={!installedIds.has(skill.id) ? handleInstall : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
