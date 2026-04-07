import React, { useState, useEffect } from 'react';
import type { SkillEntry } from '../../shared/types';
import { useSkills } from '../state/skill-context';

interface CreatePromptSheetProps {
  onClose: () => void;
}

const categories: { label: string; value: SkillEntry['category'] }[] = [
  { label: 'Personal', value: 'personal' },
  { label: 'Work', value: 'work' },
  { label: 'Development', value: 'development' },
  { label: 'Admin', value: 'admin' },
  { label: 'Other', value: 'other' },
];

const visibilityOptions: { label: string; value: SkillEntry['visibility'] }[] = [
  { label: 'Private', value: 'private' },
  { label: 'Shared', value: 'shared' },
];

export default function CreatePromptSheet({ onClose }: CreatePromptSheetProps) {
  const { createPrompt } = useSkills();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [category, setCategory] = useState<SkillEntry['category']>('personal');
  const [visibility, setVisibility] = useState<SkillEntry['visibility']>('private');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = name.trim().length > 0 && prompt.trim().length > 0 && !creating;

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      await createPrompt({
        displayName: name.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        category,
        visibility,
        source: 'self',
        type: 'prompt',
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to create prompt');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative bg-panel border border-edge-dim rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-fg">Create Prompt</h3>
          <button onClick={onClose} className="text-fg-muted hover:text-fg text-lg leading-none">
            &times;
          </button>
        </div>

        {/* Name */}
        <label className="block mb-3">
          <span className="text-[10px] font-medium text-fg-muted tracking-wider">
            NAME <span className="text-red-400">*</span>
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full bg-well border border-edge-dim rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-accent transition-colors"
            placeholder="e.g. Summarize Page"
          />
        </label>

        {/* Description */}
        <label className="block mb-3">
          <span className="text-[10px] font-medium text-fg-muted tracking-wider">DESCRIPTION</span>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full bg-well border border-edge-dim rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-accent transition-colors"
            placeholder="Short description"
          />
        </label>

        {/* Prompt */}
        <label className="block mb-3">
          <span className="text-[10px] font-medium text-fg-muted tracking-wider">
            PROMPT <span className="text-red-400">*</span>
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="mt-1 w-full bg-well border border-edge-dim rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-accent transition-colors resize-none"
            placeholder="The text that will be sent to Claude..."
          />
        </label>

        {/* Category */}
        <label className="block mb-3">
          <span className="text-[10px] font-medium text-fg-muted tracking-wider">CATEGORY</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as SkillEntry['category'])}
            className="mt-1 w-full bg-well border border-edge-dim rounded-lg px-3 py-2 text-sm text-fg outline-none focus:border-accent transition-colors"
          >
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        {/* Visibility */}
        <label className="block mb-5">
          <span className="text-[10px] font-medium text-fg-muted tracking-wider">VISIBILITY</span>
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as SkillEntry['visibility'])}
            className="mt-1 w-full bg-well border border-edge-dim rounded-lg px-3 py-2 text-sm text-fg outline-none focus:border-accent transition-colors"
          >
            {visibilityOptions.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </label>

        {/* Error */}
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

        {/* Buttons */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 text-xs font-medium py-2 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            className="flex-1 text-xs font-medium py-2 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
