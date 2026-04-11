import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { isAndroid } from '../platform';
import { useSkills } from '../state/skill-context';
import type { ChipConfig } from '../../shared/types';

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
  const { chips, setChips, installed } = useSkills();
  const [editorOpen, setEditorOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const pencilRef = useRef<HTMLButtonElement>(null);

  const displayChips: QuickChip[] = chips.length > 0
    ? chips.map(c => ({ label: c.label, prompt: c.prompt }))
    : defaultChips;

  // Close popup on click outside
  useEffect(() => {
    if (!editorOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        popupRef.current && !popupRef.current.contains(e.target as Node) &&
        pencilRef.current && !pencilRef.current.contains(e.target as Node)
      ) {
        setEditorOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [editorOpen]);

  // Close on Escape
  useEffect(() => {
    if (!editorOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setEditorOpen(false); e.stopPropagation(); }
    };
    window.addEventListener('keydown', handler, true); // capture to beat other Escape handlers
    return () => window.removeEventListener('keydown', handler, true);
  }, [editorOpen]);

  const android = isAndroid();
  const chipHeight = android ? 'h-8' : 'h-6';
  const pencilSize = android ? 'w-8 h-8' : 'w-6 h-6';

  return (
    <div className="relative">
      <div className="flex gap-1 px-3 py-1 overflow-x-auto scrollbar-none items-center">
        {displayChips.map((chip) => (
          <button
            key={chip.label}
            onClick={() => onChipTap(chip)}
            className={`shrink-0 ${chipHeight} px-2.5 rounded-md bg-panel border border-edge-dim text-[11px] text-fg-2 hover:bg-inset hover:text-fg transition-colors`}
          >
            {chip.label}
          </button>
        ))}

        {/* Pencil button — opens chip editor */}
        <button
          ref={pencilRef}
          onClick={() => setEditorOpen(!editorOpen)}
          className={`shrink-0 ${pencilSize} rounded-md bg-well border border-edge-dim text-[11px] text-fg-muted hover:bg-inset hover:text-fg transition-colors flex items-center justify-center`}
          title="Edit quick chips"
        >
          &#9998;
        </button>
      </div>

      {/* Chip editor popup */}
      {editorOpen && (
        <ChipEditorPopup
          ref={popupRef}
          chips={chips}
          setChips={setChips}
          installed={installed}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}

// ── Chip Editor Popup ──────────────────────────────────────────────────────

interface ChipEditorProps {
  chips: ChipConfig[];
  setChips: (chips: ChipConfig[]) => Promise<void>;
  installed: import('../../shared/types').SkillEntry[];
  onClose: () => void;
}

const ChipEditorPopup = React.forwardRef<HTMLDivElement, ChipEditorProps>(
  ({ chips, setChips, installed, onClose }, ref) => {
    const [showAddForm, setShowAddForm] = useState(false);
    const [customLabel, setCustomLabel] = useState('');
    const [customPrompt, setCustomPrompt] = useState('');

    // Skills not already assigned to a chip
    const chipSkillIds = useMemo(() => new Set(chips.map(c => c.skillId).filter(Boolean)), [chips]);
    const availableSkills = useMemo(
      () => installed.filter(s => !chipSkillIds.has(s.id)),
      [installed, chipSkillIds]
    );

    const move = useCallback((index: number, dir: -1 | 1) => {
      const target = index + dir;
      if (target < 0 || target >= chips.length) return;
      const next = [...chips];
      [next[index], next[target]] = [next[target], next[index]];
      setChips(next);
    }, [chips, setChips]);

    const remove = useCallback((index: number) => {
      setChips(chips.filter((_, i) => i !== index));
    }, [chips, setChips]);

    const addFromSkill = useCallback((skill: import('../../shared/types').SkillEntry) => {
      if (chips.length >= 10) return;
      setChips([...chips, {
        skillId: skill.id,
        label: skill.displayName || skill.id,
        prompt: skill.prompt || `/${skill.id}`,
      }]);
      setShowAddForm(false);
    }, [chips, setChips]);

    const addCustom = useCallback(() => {
      if (chips.length >= 10 || !customLabel.trim() || !customPrompt.trim()) return;
      setChips([...chips, { label: customLabel.trim(), prompt: customPrompt.trim() }]);
      setCustomLabel('');
      setCustomPrompt('');
      setShowAddForm(false);
    }, [chips, setChips, customLabel, customPrompt]);

    return (
      <div
        ref={ref}
        className="absolute bottom-full right-0 mb-1 w-80 max-h-[400px] overflow-y-auto bg-panel border border-edge rounded-xl shadow-xl p-3 z-50"
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-[12px] font-semibold text-fg">Edit Quick Chips</span>
          <button
            onClick={onClose}
            className="text-fg-muted hover:text-fg text-sm leading-none"
          >
            &times;
          </button>
        </div>

        {/* Chip list */}
        <div className="space-y-1">
          {chips.map((chip, i) => (
            <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-well border border-edge-dim text-[11px]">
              <span className="font-medium text-fg truncate flex-1">{chip.label}</span>
              <span className="text-fg-faint truncate max-w-[100px]">{chip.prompt}</span>
              <div className="flex gap-0.5 shrink-0">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="px-1 text-fg-muted disabled:opacity-30">&uarr;</button>
                <button onClick={() => move(i, 1)} disabled={i === chips.length - 1} className="px-1 text-fg-muted disabled:opacity-30">&darr;</button>
                <button onClick={() => remove(i)} className="px-1 text-fg-muted hover:text-red-400">&times;</button>
              </div>
            </div>
          ))}
        </div>

        {/* Add chip button / form */}
        {chips.length < 10 && !showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="w-full mt-2 py-1.5 text-[11px] text-fg-muted border border-dashed border-edge-dim rounded-md hover:border-edge hover:text-fg transition-colors"
          >
            + Add Chip
          </button>
        )}

        {showAddForm && (
          <div className="mt-2 bg-inset border border-edge-dim rounded-lg p-2.5 space-y-2">
            {/* Custom chip form */}
            <div className="space-y-1.5">
              <input
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value.slice(0, 20))}
                placeholder="Label (max 20 chars)"
                className="w-full px-2 py-1 text-[11px] bg-well border border-edge-dim rounded-md text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent"
              />
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value.slice(0, 500))}
                placeholder="Prompt text"
                rows={2}
                className="w-full px-2 py-1 text-[11px] bg-well border border-edge-dim rounded-md text-fg placeholder:text-fg-faint focus:outline-none focus:border-accent resize-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={addCustom}
                  disabled={!customLabel.trim() || !customPrompt.trim()}
                  className="px-2 py-1 text-[10px] bg-accent text-on-accent rounded-md disabled:opacity-40"
                >
                  Add Custom
                </button>
                <button onClick={() => setShowAddForm(false)} className="px-2 py-1 text-[10px] text-fg-muted hover:text-fg">Cancel</button>
              </div>
            </div>

            {/* Divider */}
            {availableSkills.length > 0 && (
              <>
                <div className="border-t border-edge-dim" />
                <p className="text-[10px] text-fg-faint font-medium">Or pick from installed skills:</p>
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {availableSkills.map(skill => (
                    <button
                      key={skill.id}
                      onClick={() => addFromSkill(skill)}
                      className="w-full text-left px-2 py-1 text-[11px] text-fg-muted hover:text-fg hover:bg-well rounded-sm transition-colors"
                    >
                      {skill.displayName || skill.id}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {chips.length >= 10 && (
          <p className="mt-2 text-[10px] text-fg-faint text-center">Maximum 10 chips reached</p>
        )}
      </div>
    );
  }
);
