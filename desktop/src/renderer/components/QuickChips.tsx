import React from 'react';
import { isAndroid } from '../platform';
import { useSkills } from '../state/skill-context';

export interface QuickChip {
  label: string;
  prompt: string;
}

// Fallback defaults if no config exists yet
export const defaultChips: QuickChip[] = [
  { label: 'Journal', prompt: "let's journal" },
  { label: 'Inbox', prompt: 'check my inbox' },
  { label: 'Git Status', prompt: "run git status and summarize what's changed" },
  { label: 'Review PR', prompt: 'review the latest PR on this repo' },
  { label: 'Fix Tests', prompt: 'run the tests and fix any failures' },
  { label: 'Briefing', prompt: 'brief me on ' },
  { label: 'Draft Text', prompt: 'help me draft a text to ' },
];

interface Props {
  onChipTap: (chip: QuickChip) => void;
}

export default function QuickChips({ onChipTap }: Props) {
  const { chips } = useSkills();
  const displayChips: QuickChip[] = chips.length > 0
    ? chips.map(c => ({ label: c.label, prompt: c.prompt }))
    : defaultChips;

  return (
    <div className="flex gap-1 px-3 py-1 overflow-x-auto scrollbar-none">
      {displayChips.map((chip) => (
        <button
          key={chip.label}
          onClick={() => onChipTap(chip)}
          className={`shrink-0 ${isAndroid() ? 'h-8 px-3' : 'h-6 px-2.5'} rounded-md bg-panel border border-edge-dim text-[11px] text-fg-2 hover:bg-inset hover:text-fg transition-colors`}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
