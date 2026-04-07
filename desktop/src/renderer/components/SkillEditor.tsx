import React, { useState, useEffect, useMemo } from 'react';
import type { SkillEntry } from '../../shared/types';
import { useSkills } from '../state/skill-context';

interface SkillEditorProps {
  skillId: string;
  onClose: () => void;
}

const categories: { label: string; value: SkillEntry['category'] }[] = [
  { label: 'Personal', value: 'personal' },
  { label: 'Work', value: 'work' },
  { label: 'Development', value: 'development' },
  { label: 'Admin', value: 'admin' },
  { label: 'Other', value: 'other' },
];

export default function SkillEditor({ skillId, onClose }: SkillEditorProps) {
  const { installed, setOverride } = useSkills();

  const skill = useMemo(() => installed.find((s) => s.id === skillId), [installed, skillId]);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<SkillEntry['category']>('other');
  const [saving, setSaving] = useState(false);

  // Pre-fill from skill
  useEffect(() => {
    if (skill) {
      setName(skill.displayName);
      setDescription(skill.description);
      setCategory(skill.category);
    }
  }, [skill]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!skill) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
        <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
        <div className="relative bg-panel border border-edge-dim rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl">
          <p className="text-sm text-fg-muted">Skill not found</p>
        </div>
      </div>
    );
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      await setOverride(skillId, {
        displayName: name.trim() || undefined,
        description: description.trim() || undefined,
        category,
      });
      onClose();
    } catch (err) {
      console.error('[SkillEditor] Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      // Clear overrides by sending empty values
      await setOverride(skillId, {});
      onClose();
    } catch (err) {
      console.error('[SkillEditor] Reset failed:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative bg-panel border border-edge-dim rounded-xl p-5 max-w-sm w-full mx-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-bold text-fg mb-4">Edit Skill</h3>

        {/* Name */}
        <label className="block mb-3">
          <span className="text-[10px] font-medium text-fg-muted tracking-wider">NAME</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full bg-well border border-edge-dim rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-accent transition-colors"
            placeholder="Skill name"
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

        {/* Category */}
        <label className="block mb-5">
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

        {/* Buttons */}
        <div className="flex gap-2">
          <button
            onClick={handleReset}
            disabled={saving}
            className="text-xs font-medium px-3 py-2 rounded-lg border border-edge-dim text-fg-muted hover:text-fg hover:bg-inset transition-colors disabled:opacity-50"
          >
            Reset to Default
          </button>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="text-xs font-medium px-3 py-2 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-xs font-medium px-4 py-2 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
