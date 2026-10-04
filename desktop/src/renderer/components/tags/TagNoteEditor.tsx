// src/renderer/components/tags/TagNoteEditor.tsx
//
// The tags-and-note editor, shared by every surface that offers one: the status bar's
// Tags & note popup, the close-session prompt, Resume's Organize sheet, the session
// drawer's sheet and a project's conversation preview.
//
// WHY SHARED RATHER THAN COPIED: the same field-on-a-same-coloured-card bug was fixed
// three separate times because three call sites each assembled their own version.
//
// Layout (pick-menus-2 … -15, 2026-10-02/04): a "Tags" card (TagCloud — the tags, their
// editing and "+ New tag", all on this card), a "Note" card (fixed size, no drag corner),
// then a "Pin to top" switch card — Priority's new face, the same stored flag, so a
// session marked Priority before comes up pinned. Every card has its small label first
// (guide: a label first, nothing bare).
import { TagCloud } from './TagCloud';
import { NoteEditor } from './NoteEditor';
import { PinIcon } from './PinIcon';
import type { TagRegistryApi } from '../../hooks/useTagRegistry';
import { Button, CARD_LEVEL_1, SectionLabel, SettingRow, Toggle } from '../ui';

export function TagNoteEditor({ appliedIds, onToggleTag, registry, note, onNote, pin, footer }: {
  appliedIds: Set<string>;
  onToggleTag: (tagId: string, next: boolean) => void;
  registry: TagRegistryApi;
  note: string;
  onNote: (text: string) => void;
  /** Pin to top. Omit where pinning doesn't apply. */
  pin?: { pinned: boolean; onPin: (next: boolean) => void };
  /** A closing action for a surface whose writes are still pending (the close prompt's
   *  "Save"). The status bar popup has none — it saves as you go and its ✕ closes
   *  (pick-menus-11#PM11-1: "drop the done button"). */
  footer?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col gap-4">
      <TagCloud registry={registry} appliedIds={appliedIds} onToggle={onToggleTag} />
      <section>
        <SectionLabel className="mb-2">Note</SectionLabel>
        <div className={`${CARD_LEVEL_1} p-3`}>
          {/* NoteEditor commits on blur AND on unmount, so a note typed and then
              dismissed without blurring still lands. */}
          <NoteEditor value={note} onSave={onNote} resizable={false} />
        </div>
      </section>
      {/* Pin sits last, under the note (pick-menus-9#PM9-1). */}
      {pin && (
        <div className={`${CARD_LEVEL_1} px-3 py-1`}>
          <SettingRow header variant="item" title="Pin to top" icon={<PinIcon className="w-3.5 h-3.5 text-fg-muted" />}
            description="Keeps this session first in your session lists"
            control={<Toggle checked={pin.pinned} onChange={pin.onPin} aria-label="Pin to top" />} />
        </div>
      )}
      {/* Outlined, not filled: on the close prompt the one filled button is "Close
          session" (guide: one filled button per view). */}
      {footer && <Button variant="secondary" className="w-full" onClick={footer.onClick}>{footer.label}</Button>}
    </div>
  );
}
