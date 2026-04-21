import React from 'react';
import type { SkillEntry } from '../../shared/types';
import { useMarketplaceStats } from '../state/marketplace-stats-context';
import StarRating from './marketplace/StarRating';
import FavoriteStar from './marketplace/FavoriteStar';

interface FavoriteProps {
  filled: boolean;
  onToggle: () => void;
}

interface ChipSkill {
  id: string;
  displayName: string;
}

interface Props {
  skill: SkillEntry;
  onClick: (skill: SkillEntry) => void;
  variant?: 'drawer' | 'marketplace';
  installed?: boolean;
  updateAvailable?: boolean;
  onInstall?: (skill: SkillEntry) => void;
  installing?: boolean;
  /** When provided, a corner favorite star overlays the card. */
  favorite?: FavoriteProps;
  /** When provided, a row of bundled-skill chips renders beneath the blurb.
   *  Clicking a chip invokes the callback with the chip id; card click still fires. */
  chipSkills?: ChipSkill[];
  onChipClick?: (chipId: string) => void;
}

const sourceBadgeStyles: Record<string, string> = {
  'youcoded-core': 'bg-[#4CAF50]/15 text-[#4CAF50] border border-[#4CAF50]/25',
  self: 'bg-[#66AAFF]/15 text-[#66AAFF] border border-[#66AAFF]/25',
  plugin: 'bg-inset/50 text-fg-dim border border-edge/25',
  marketplace: 'bg-inset/50 text-fg-dim border border-edge/25',
};

const typeBadgeStyles: Record<string, string> = {
  prompt: 'bg-[#f0ad4e]/15 text-[#f0ad4e] border border-[#f0ad4e]/25',
  plugin: 'bg-inset/50 text-fg-dim border border-edge/25',
};

const typeLabels: Record<string, string> = {
  prompt: 'Prompt',
  plugin: 'Plugin',
};

export default function SkillCard({
  skill, onClick, variant = 'drawer', installed, updateAvailable,
  onInstall, installing, favorite, chipSkills, onChipClick,
}: Props) {
  const { plugins } = useMarketplaceStats();
  const liveStats = plugins[skill.id];
  const liveInstalls = liveStats?.installs ?? skill.installs ?? null;
  const liveRating = liveStats?.rating ?? null;
  const liveReviewCount = liveStats?.review_count ?? 0;

  // Chip row — renders for multi-skill plugin cards. Height-clipped to one
  // row so cards stay uniform in the grid; chips beyond the visible line are
  // simply hidden (users can open the plugin's detail overlay to see all of
  // them). stopPropagation on each chip prevents chip clicks from firing the
  // card's onClick.
  const chipRow = chipSkills && chipSkills.length > 0 && (
    <div className="flex flex-nowrap gap-1 mt-2 overflow-hidden shrink-0">
      {chipSkills.map(c => (
        <button
          key={c.id}
          type="button"
          onClick={(e) => { e.stopPropagation(); onChipClick?.(c.id); }}
          className="text-[10px] px-1.5 py-0.5 rounded-sm bg-inset/60 text-fg-dim border border-edge/25 hover:bg-inset hover:text-fg transition-colors shrink-0 truncate max-w-[80px]"
        >
          {c.displayName}
        </button>
      ))}
    </div>
  );

  if (variant === 'marketplace') {
    return (
      // Root is a div role=button so FavoriteStar (itself a button) can nest
      // without invalid HTML. Matches the pattern used in MarketplaceCard.
      <div
        role="button"
        tabIndex={0}
        onClick={() => onClick(skill)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(skill); } }}
        className="relative bg-panel border border-edge-dim rounded-lg p-3 text-left hover:bg-inset hover:border-edge transition-colors flex flex-col cursor-pointer"
      >
        {favorite && (
          <FavoriteStar corner size="sm" filled={favorite.filled} onToggle={favorite.onToggle} />
        )}
        <div className="flex justify-between items-start">
          <span className="text-sm font-medium text-fg leading-tight">{skill.displayName}</span>
          <span className={`text-[9px] font-medium px-1 py-0.5 rounded-sm shrink-0 ml-1 ${
            skill.source === 'youcoded-core' ? sourceBadgeStyles['youcoded-core'] :
            typeBadgeStyles[skill.type] || sourceBadgeStyles.plugin
          }`}>
            {skill.source === 'youcoded-core' ? 'YC' : typeLabels[skill.type] || 'Plugin'}
          </span>
        </div>
        <span className="text-[11px] text-fg-muted mt-1 leading-snug line-clamp-2 flex-1">
          {skill.description}
        </span>
        {chipRow}
        {liveRating != null && (
          <div className="mt-1">
            <StarRating value={liveRating} count={liveReviewCount} size="sm" />
          </div>
        )}
        <div className="flex justify-between items-center mt-1">
          <span className="text-[9px] text-fg-faint">
            {skill.author ? `${skill.author}` : ''}
            {liveInstalls != null ? ` · ${liveInstalls >= 1000 ? `${(liveInstalls / 1000).toFixed(1)}k` : liveInstalls} ↓` : ''}
          </span>
        </div>
        {installed ? (
          <div className={`text-center text-[11px] py-1 mt-2 border rounded-sm ${
            updateAvailable
              ? 'text-[#f0ad4e] border-[#f0ad4e]/40'
              : skill.source === 'self' || skill.visibility === 'private'
                ? 'text-[#66AAFF] border-[#66AAFF]/40'
                : 'text-[#4CAF50] border-[#4CAF50]/40'
          }`}>
            {/* User-authored skills read "User Skill"; updates still win so */}
            {/* bumping versions isn't blocked by the user-skill label. */}
            {updateAvailable
              ? 'Update Available'
              : skill.source === 'self' || skill.visibility === 'private'
                ? 'User Skill'
                : 'Installed'}
          </div>
        ) : installing ? (
          <div className="text-center text-[11px] py-1 mt-2 border rounded-sm text-fg-muted border-edge-dim opacity-60">
            Installing...
          </div>
        ) : onInstall ? (
          <button
            onClick={(e) => { e.stopPropagation(); onInstall(skill); }}
            className="w-full bg-accent text-on-accent text-[11px] font-medium py-1 mt-2 rounded-sm hover:brightness-110 transition-colors"
          >
            Get
          </button>
        ) : null}
      </div>
    );
  }

  // Drawer variant — Fix: root is `<div role="button">` with `relative` so
  // the FavoriteStar overlays inside the card. Fixed height (`h-28`) +
  // `overflow-hidden` keep every tile the same shape/size in the grid
  // regardless of description length or whether the plugin has a chip row;
  // content that would exceed the height is clipped cleanly rather than
  // pushing the row taller than its neighbors.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick(skill)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(skill); } }}
      className="relative bg-panel border border-edge-dim rounded-lg p-3 text-left hover:bg-inset hover:border-edge transition-colors flex flex-col cursor-pointer h-32 overflow-hidden"
    >
      {favorite && (
        <FavoriteStar corner size="sm" filled={favorite.filled} onToggle={favorite.onToggle} />
      )}
      <span className="text-sm font-medium text-fg leading-tight">{skill.displayName}</span>
      <span className="text-[11px] text-fg-muted mt-1 leading-snug line-clamp-2 flex-1">{skill.description}</span>
      {chipRow}
      <span className={`text-[9px] font-medium px-1 py-0.5 rounded-sm mt-2 self-start ${
        skill.source === 'youcoded-core' ? sourceBadgeStyles['youcoded-core'] :
        typeBadgeStyles[skill.type] || sourceBadgeStyles.plugin
      }`}>
        {skill.source === 'youcoded-core' ? 'YC' : typeLabels[skill.type] || 'Plugin'}
      </span>
    </div>
  );
}
