import { useState, useEffect, useMemo } from 'react';
import type { SkillEntry } from '../../shared/types';
import { useSkills } from '../state/skill-context';
import { Button, Dialog, Select, TextInput } from './ui';
import { useEscClose } from '../hooks/use-esc-close';

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

  useEscClose(true, onClose);

  if (!skill) {
    return (
      // Overlay layer L2 — theme-driven via Scrim/OverlayPanel.
      <>
        <Dialog open onClose={onClose} size="prompt" aria-label="Skill not found" scrollBody={false} className="p-5" screen="chat/skills/edit-missing">
          <p className="text-sm text-fg-muted">Skill not found</p>
        </Dialog>
      </>
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
    // Overlay layer L2 — theme-driven via Scrim/OverlayPanel.
    <>
      <Dialog open onClose={onClose} size="prompt" title="Edit Skill" scrollBody={false} className="p-5" screen="chat/skills/edit">

        {/* Name */}
        <label className="block mb-3">
          <span className="text-3xs font-medium text-fg-muted tracking-wider">NAME</span>
          {/* Shared field surface (change 20) — the hand-rolled recipe here used
              bg-well + placeholder-fg-muted; FIELD is bg-inset + fg-faint. */}
          <TextInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full"
            placeholder="Skill name"
          />
        </label>

        {/* Description */}
        <label className="block mb-3">
          <span className="text-3xs font-medium text-fg-muted tracking-wider">DESCRIPTION</span>
          {/* Same migration as NAME above (change 20). Stays a single-line input —
              it was never a textarea. */}
          <TextInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full"
            placeholder="Short description"
          />
        </label>

        {/* Category */}
        {/* Was a native <select> (change 21): its option list is OS-drawn, so the
            open menu ignored the theme entirely. <Select> renders the list itself.
            The wrapper is a <div>, not a <label> — a <label> can't name a
            <button>, which is what the Select trigger is, so the accessible name
            moves to aria-label instead. */}
        <div className="block mb-5">
          <span className="text-3xs font-medium text-fg-muted tracking-wider">CATEGORY</span>
          <Select
            options={categories}
            value={category}
            onChange={(v) => setCategory(v as SkillEntry['category'])}
            aria-label="Category"
            className="mt-1"
          />
        </div>

        {/* Buttons */}
        <div className="flex gap-2">
          {/* Reset was the odd one out with text-fg-muted; secondary makes it a
              visual peer of Cancel, which is what it is (spec decision 60). */}
          <Button
            variant="secondary"
            onClick={handleReset}
            disabled={saving}
            className="py-2"
          >
            Reset to Default
          </Button>
          <div className="flex-1" />
          <Button
            variant="secondary"
            onClick={onClose}
            className="py-2"
          >
            Cancel
          </Button>
          <Button
            size="lg"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
