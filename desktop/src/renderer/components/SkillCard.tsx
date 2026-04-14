import React from 'react';
import type { SkillEntry } from '../../shared/types';
import { useMarketplaceStats } from '../state/marketplace-stats-context';
import StarRating from './marketplace/StarRating';

interface Props {
  skill: SkillEntry;
  onClick: (skill: SkillEntry) => void;
  variant?: 'drawer' | 'marketplace';
  installed?: boolean;
  // Phase 3b: show an amber badge when a newer version is available
  updateAvailable?: boolean;
  onInstall?: (skill: SkillEntry) => void;
  installing?: boolean;
}

const sourceBadgeStyles: Record<string, string> = {
  destinclaude: 'bg-[#4CAF50]/15 text-[#4CAF50] border border-[#4CAF50]/25',
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

export default function SkillCard({ skill, onClick, variant = 'drawer', installed, updateAvailable, onInstall, installing }: Props) {
  // Task 9: pull live install count + rating from the marketplace stats context.
  // Falls back gracefully when stats are loading or unavailable for this skill id.
  const { plugins } = useMarketplaceStats();
  const liveStats = plugins[skill.id];
  const liveInstalls = liveStats?.installs ?? skill.installs ?? null;
  const liveRating = liveStats?.rating ?? null;
  const liveReviewCount = liveStats?.review_count ?? 0;

  if (variant === 'marketplace') {
    return (
      <div
        onClick={() => onClick(skill)}
        className="bg-panel border border-edge-dim rounded-lg p-3 text-left hover:bg-inset hover:border-edge transition-colors flex flex-col cursor-pointer"
      >
        <div className="flex justify-between items-start">
          <span className="text-sm font-medium text-fg leading-tight">{skill.displayName}</span>
          <span className={`text-[9px] font-medium px-1 py-0.5 rounded-sm shrink-0 ml-1 ${
            skill.source === 'destinclaude' ? sourceBadgeStyles.destinclaude :
            typeBadgeStyles[skill.type] || sourceBadgeStyles.plugin
          }`}>
            {skill.source === 'destinclaude' ? 'DC' : typeLabels[skill.type] || 'Plugin'}
          </span>
        </div>
        <span className="text-[11px] text-fg-muted mt-1 leading-snug line-clamp-2 flex-1">
          {skill.description}
        </span>
        {/* Task 9: live star rating — only shown when the API has returned at least 1 review */}
        {liveRating != null && (
          <div className="mt-1">
            <StarRating value={liveRating} count={liveReviewCount} size="sm" />
          </div>
        )}
        <div className="flex justify-between items-center mt-1">
          <span className="text-[9px] text-fg-faint">
            {skill.author ? `${skill.author}` : ''}
            {/* Task 9: use live install count from /stats API, fall back to static field */}
            {liveInstalls != null ? ` \u00B7 ${liveInstalls >= 1000 ? `${(liveInstalls / 1000).toFixed(1)}k` : liveInstalls} \u2193` : ''}
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

  // Drawer variant (existing look)
  return (
    <button
      onClick={() => onClick(skill)}
      className="bg-panel border border-edge-dim rounded-lg p-3 text-left hover:bg-inset hover:border-edge transition-colors flex flex-col"
    >
      <span className="text-sm font-medium text-fg leading-tight">{skill.displayName}</span>
      <span className="text-[11px] text-fg-muted mt-1 leading-snug line-clamp-2 flex-1">{skill.description}</span>
      <span className={`text-[9px] font-medium px-1 py-0.5 rounded-sm mt-2 self-start ${
        skill.source === 'destinclaude' ? sourceBadgeStyles.destinclaude :
        typeBadgeStyles[skill.type] || sourceBadgeStyles.plugin
      }`}>
        {skill.source === 'destinclaude' ? 'DC' : typeLabels[skill.type] || 'Plugin'}
      </span>
    </button>
  );
}
