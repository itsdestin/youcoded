import React from 'react';
import type { SkillEntry } from '../../shared/types';

interface Props {
  skill: SkillEntry;
  onClick: (skill: SkillEntry) => void;
  variant?: 'drawer' | 'marketplace';
  installed?: boolean;
  onInstall?: (skill: SkillEntry) => void;
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

function StarRating({ rating }: { rating?: number }) {
  if (rating == null) return null;
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  const stars = '\u2605'.repeat(full) + (half ? '\u00BD' : '') + '\u2606'.repeat(5 - full - (half ? 1 : 0));
  return <span className="text-[7px] text-[#f0ad4e]">{stars}</span>;
}

export default function SkillCard({ skill, onClick, variant = 'drawer', installed, onInstall }: Props) {
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
        <StarRating rating={skill.rating} />
        <div className="flex justify-between items-center mt-1">
          <span className="text-[9px] text-fg-faint">
            {skill.author ? `${skill.author}` : ''}
            {skill.installs != null ? ` \u00B7 ${skill.installs >= 1000 ? `${(skill.installs / 1000).toFixed(1)}k` : skill.installs} \u2193` : ''}
          </span>
        </div>
        {installed ? (
          <div className="text-center text-[#4CAF50] text-[11px] py-1 mt-2 border border-[#4CAF50]/40 rounded-sm">
            Installed
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
