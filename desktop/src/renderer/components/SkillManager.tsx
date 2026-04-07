import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { SkillEntry, ChipConfig } from '../../shared/types';
import { useSkills } from '../state/skill-context';

interface SkillManagerProps {
  onClose: () => void;
  onOpenMarketplace: () => void;
  onOpenShareSheet: (skillId: string) => void;
  onOpenEditor: (skillId: string) => void;
  onOpenCreatePrompt: () => void;
}

type Tab = 'my-skills' | 'quick-chips';
type Filter = 'all' | 'favorites' | 'private';

const typeBadgeStyles: Record<string, string> = {
  prompt: 'bg-[#f0ad4e]/15 text-[#f0ad4e] border border-[#f0ad4e]/25',
  plugin: 'bg-inset/50 text-fg-dim border border-edge/25',
};

export default function SkillManager({
  onClose,
  onOpenMarketplace,
  onOpenShareSheet,
  onOpenEditor,
  onOpenCreatePrompt,
}: SkillManagerProps) {
  const { installed, favorites, chips, setChips, setFavorite, deletePrompt } = useSkills();

  const [activeTab, setActiveTab] = useState<Tab>('my-skills');
  const [filter, setFilter] = useState<Filter>('all');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // --- My Skills tab ---
  const favSet = useMemo(() => new Set(favorites), [favorites]);

  const filteredSkills = useMemo(() => {
    switch (filter) {
      case 'favorites':
        return installed.filter((s) => favSet.has(s.id));
      case 'private':
        return installed.filter((s) => s.visibility === 'private');
      default:
        return installed;
    }
  }, [installed, filter, favSet]);

  const handleToggleFavorite = useCallback(
    (id: string) => {
      setFavorite(id, !favSet.has(id));
    },
    [setFavorite, favSet],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deletePrompt(id);
      setConfirmDelete(null);
    },
    [deletePrompt],
  );

  // --- Quick Chips tab ---
  const [chipList, setChipList] = useState<ChipConfig[]>(chips);
  const [showChipPicker, setShowChipPicker] = useState(false);

  // Sync local state when context chips change
  useEffect(() => {
    setChipList(chips);
  }, [chips]);

  const moveChip = useCallback(
    (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (target < 0 || target >= chipList.length) return;
      const next = [...chipList];
      [next[index], next[target]] = [next[target], next[index]];
      setChipList(next);
      setChips(next);
    },
    [chipList, setChips],
  );

  const removeChip = useCallback(
    (index: number) => {
      const next = chipList.filter((_, i) => i !== index);
      setChipList(next);
      setChips(next);
    },
    [chipList, setChips],
  );

  const addChip = useCallback(
    (skill: SkillEntry) => {
      if (chipList.length >= 10) return;
      const next = [...chipList, { skillId: skill.id, label: skill.displayName, prompt: skill.prompt }];
      setChipList(next);
      setChips(next);
      setShowChipPicker(false);
    },
    [chipList, setChips],
  );

  return (
    <div className="fixed inset-0 z-50 bg-canvas flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
        <button onClick={onClose} className="text-fg-muted hover:text-fg transition-colors text-sm">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h2 className="text-sm font-bold text-fg">Skill Manager</h2>
        <div className="w-5" />
      </div>

      {/* Segmented control */}
      <div className="flex mx-4 mt-3 bg-well rounded-lg p-0.5 border border-edge-dim">
        <button
          onClick={() => setActiveTab('my-skills')}
          className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${
            activeTab === 'my-skills' ? 'bg-panel text-fg shadow-sm' : 'text-fg-muted hover:text-fg-2'
          }`}
        >
          My Skills
        </button>
        <button
          onClick={() => setActiveTab('quick-chips')}
          className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${
            activeTab === 'quick-chips' ? 'bg-panel text-fg shadow-sm' : 'text-fg-muted hover:text-fg-2'
          }`}
        >
          Quick Chips
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4">
        {activeTab === 'my-skills' ? (
          <MySkillsContent
            skills={filteredSkills}
            filter={filter}
            onSetFilter={setFilter}
            favSet={favSet}
            onToggleFavorite={handleToggleFavorite}
            onEdit={onOpenEditor}
            onShare={onOpenShareSheet}
            onDelete={(id) => setConfirmDelete(id)}
            onOpenMarketplace={onOpenMarketplace}
            onOpenCreatePrompt={onOpenCreatePrompt}
          />
        ) : (
          <QuickChipsContent
            chipList={chipList}
            installed={installed}
            showPicker={showChipPicker}
            onTogglePicker={() => setShowChipPicker((p) => !p)}
            onMove={moveChip}
            onRemove={removeChip}
            onAddChip={addChip}
          />
        )}
      </div>

      {/* Delete confirmation dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={() => setConfirmDelete(null)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <div
            className="relative bg-panel border border-edge-dim rounded-xl p-5 max-w-xs w-full mx-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-bold text-fg mb-2">Delete Prompt</h3>
            <p className="text-xs text-fg-muted mb-4">
              Are you sure? This cannot be undone.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 text-xs font-medium py-2 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                className="flex-1 text-xs font-medium py-2 rounded-lg bg-red-600/80 text-white hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- My Skills sub-component ---

function MySkillsContent({
  skills,
  filter,
  onSetFilter,
  favSet,
  onToggleFavorite,
  onEdit,
  onShare,
  onDelete,
  onOpenMarketplace,
  onOpenCreatePrompt,
}: {
  skills: SkillEntry[];
  filter: Filter;
  onSetFilter: (f: Filter) => void;
  favSet: Set<string>;
  onToggleFavorite: (id: string) => void;
  onEdit: (id: string) => void;
  onShare: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenMarketplace: () => void;
  onOpenCreatePrompt: () => void;
}) {
  const filters: { label: string; value: Filter }[] = [
    { label: 'All', value: 'all' },
    { label: 'Favorites', value: 'favorites' },
    { label: 'Private', value: 'private' },
  ];

  return (
    <>
      {/* Actions row */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={onOpenCreatePrompt}
          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors"
        >
          + Create Prompt
        </button>
        <button
          onClick={onOpenMarketplace}
          className="text-xs font-medium text-accent hover:underline ml-auto"
        >
          Browse Marketplace
        </button>
      </div>

      {/* Filter pills */}
      <div className="flex gap-1.5 mb-3">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => onSetFilter(f.value)}
            className={`text-[11px] font-medium px-2.5 py-1 rounded-full transition-colors ${
              filter === f.value
                ? 'bg-accent text-on-accent'
                : 'bg-well text-fg-muted hover:text-fg-2 border border-edge-dim'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Skill list */}
      {skills.length === 0 ? (
        <div className="text-center py-10">
          <p className="text-sm text-fg-muted">No skills match this filter</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-inset transition-colors group"
            >
              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg truncate">{skill.displayName}</span>
                  <span className={`text-[9px] font-medium px-1 py-0.5 rounded-sm shrink-0 ${typeBadgeStyles[skill.type] || typeBadgeStyles.plugin}`}>
                    {skill.type === 'prompt' ? 'Prompt' : 'Plugin'}
                  </span>
                </div>
                <p className="text-[11px] text-fg-muted truncate mt-0.5">{skill.description}</p>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                {/* Star */}
                <button
                  onClick={() => onToggleFavorite(skill.id)}
                  className="p-1.5 rounded-sm hover:bg-well transition-colors"
                  title={favSet.has(skill.id) ? 'Remove from favorites' : 'Add to favorites'}
                >
                  <svg className={`w-4 h-4 ${favSet.has(skill.id) ? 'text-[#f0ad4e] fill-current' : 'text-fg-muted'}`} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} fill={favSet.has(skill.id) ? 'currentColor' : 'none'}>
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {/* Edit */}
                <button
                  onClick={() => onEdit(skill.id)}
                  className="p-1.5 rounded-sm hover:bg-well transition-colors text-fg-muted hover:text-fg"
                  title="Edit"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {/* Share */}
                <button
                  onClick={() => onShare(skill.id)}
                  className="p-1.5 rounded-sm hover:bg-well transition-colors text-fg-muted hover:text-fg"
                  title="Share"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                {/* Delete (only user-created prompts) */}
                {skill.source === 'self' && skill.type === 'prompt' && (
                  <button
                    onClick={() => onDelete(skill.id)}
                    className="p-1.5 rounded-sm hover:bg-well transition-colors text-fg-muted hover:text-red-400"
                    title="Delete"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// --- Quick Chips sub-component ---

function QuickChipsContent({
  chipList,
  installed,
  showPicker,
  onTogglePicker,
  onMove,
  onRemove,
  onAddChip,
}: {
  chipList: ChipConfig[];
  installed: SkillEntry[];
  showPicker: boolean;
  onTogglePicker: () => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
  onAddChip: (skill: SkillEntry) => void;
}) {
  const chipSkillIds = useMemo(() => new Set(chipList.map((c) => c.skillId).filter(Boolean)), [chipList]);

  return (
    <>
      {/* Live preview */}
      <div className="mb-4">
        <p className="text-[10px] font-medium text-fg-muted tracking-wider mb-2">PREVIEW</p>
        <div className="flex gap-1 overflow-x-auto scrollbar-none py-1">
          {chipList.length > 0 ? (
            chipList.map((chip, i) => (
              <span
                key={i}
                className="shrink-0 h-6 px-2.5 rounded-sm bg-panel border border-edge-dim text-[11px] text-fg-2 flex items-center"
              >
                {chip.label}
              </span>
            ))
          ) : (
            <span className="text-xs text-fg-muted italic">No chips configured</span>
          )}
        </div>
      </div>

      {/* Chip list */}
      <p className="text-[10px] font-medium text-fg-muted tracking-wider mb-2">CHIPS ({chipList.length}/10)</p>
      <div className="flex flex-col gap-1 mb-3">
        {chipList.map((chip, index) => (
          <div
            key={index}
            className="flex items-center gap-2 py-2 px-3 rounded-lg bg-panel border border-edge-dim"
          >
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium text-fg block truncate">{chip.label}</span>
              <span className="text-[10px] text-fg-muted block truncate">{chip.prompt}</span>
            </div>

            {/* Move up */}
            <button
              onClick={() => onMove(index, -1)}
              disabled={index === 0}
              className="p-1 rounded-sm hover:bg-inset text-fg-muted hover:text-fg disabled:opacity-30 transition-colors"
              title="Move up"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path d="M5 15l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* Move down */}
            <button
              onClick={() => onMove(index, 1)}
              disabled={index === chipList.length - 1}
              className="p-1 rounded-sm hover:bg-inset text-fg-muted hover:text-fg disabled:opacity-30 transition-colors"
              title="Move down"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* Remove */}
            <button
              onClick={() => onRemove(index)}
              className="p-1 rounded-sm hover:bg-inset text-fg-muted hover:text-red-400 transition-colors"
              title="Remove"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {/* Add chip button */}
      {chipList.length < 10 && (
        <button
          onClick={onTogglePicker}
          className="w-full text-xs font-medium py-2 rounded-lg border border-dashed border-edge-dim text-fg-muted hover:text-fg hover:border-edge hover:bg-inset transition-colors"
        >
          + Add Chip
        </button>
      )}

      {/* Chip picker */}
      {showPicker && (
        <div className="mt-3 border border-edge-dim rounded-lg bg-well p-3">
          <p className="text-[10px] font-medium text-fg-muted tracking-wider mb-2">SELECT A SKILL</p>
          <div className="max-h-48 overflow-y-auto flex flex-col gap-1">
            {installed
              .filter((s) => !chipSkillIds.has(s.id))
              .map((skill) => (
                <button
                  key={skill.id}
                  onClick={() => onAddChip(skill)}
                  className="flex items-center gap-2 py-2 px-2 rounded-sm hover:bg-inset text-left transition-colors"
                >
                  <span className="text-xs font-medium text-fg truncate">{skill.displayName}</span>
                  <span className="text-[10px] text-fg-muted truncate">{skill.description}</span>
                </button>
              ))}
            {installed.filter((s) => !chipSkillIds.has(s.id)).length === 0 && (
              <p className="text-xs text-fg-muted text-center py-2">All skills are already added</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
