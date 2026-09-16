// src/renderer/components/tags/TagNoteEditor.tsx
//
// The tag + note editor, shared by every surface that offers one. Extracted
// 2026-07-31 from the close prompt, whose arrangement won ten workbench
// comparison rounds, so the StatusBar chip could use the same thing rather than
// a copy of its styling.
//
// WHY SHARED RATHER THAN COPIED: this branch fixed the same field-on-a-
// same-coloured-card bug three separate times (model picker trigger, close
// prompt, resume sheet) because three call sites each assembled their own
// version. A component that carries the card, the surfaces, the divider and
// the field overrides together can only be wrong in one place.
//
// The card is `bg-inset`; the fields inside are lifted to `bg-well`. That is
// the documented surface ladder, and it is load-bearing: the shared FIELD
// surface IS `bg-inset`, so without the lift a field sitting on this card is
// exactly the colour of its own background.
import { TagPicker, type BuiltInTag } from './TagPicker';
import { NoteEditor } from './NoteEditor';
import type { TagRegistryApi } from '../../hooks/useTagRegistry';

const FIELD_LIFT = 'bg-well border-edge';

export function TagNoteEditor({
  appliedIds, onToggleTag, registry, onManageTags, builtIns,
  note, onNote, footer,
}: {
  appliedIds: Set<string>;
  onToggleTag: (tagId: string, next: boolean) => void;
  registry: TagRegistryApi;
  onManageTags?: () => void;
  builtIns?: BuiltInTag[];
  note: string;
  onNote: (text: string) => void;
  /** Optional closing action. The close prompt collapses back to its summary
   *  ("Save"); the StatusBar chip dismisses its popup ("Done"). Neither writes —
   *  the label differs because what the click MEANS differs, and a surface that
   *  has already persisted every keystroke must not claim there is something
   *  left to save. Omit for a surface with nothing to close. */
  footer?: { label: string; onClick: () => void };
}) {
  return (
    <div className="rounded-lg border border-edge-dim bg-inset px-3 py-2.5 flex flex-col gap-2">
      {/* No "TAGS" / "NOTE" headers — the two placeholders already say what
          each field is, and the labels cost a third of the height on the
          smallest host. */}
      <TagPicker
        appliedIds={appliedIds}
        onToggle={onToggleTag}
        registry={registry}
        onManageTags={onManageTags}
        builtIns={builtIns}
        fieldClassName={FIELD_LIFT}
      />
      <div className="border-t border-edge-dim pt-2">
        {/* NoteEditor commits on blur AND on unmount, so a note typed and then
            dismissed without blurring still lands. */}
        {/* No placeholder override: NoteEditor's default says what a note is
            for (first-run guide, S-3), and every host should read the same. */}
        <NoteEditor value={note} onSave={onNote} fieldClassName={FIELD_LIFT} />
      </div>
      {footer && (
        // Filled NEUTRAL pill, deliberately not `primary`: on the close prompt
        // the accent belongs to "Close session", and two accent buttons in one
        // dialog is two primary actions. Chosen in the workbench, round 7/8.
        <button
          type="button"
          onClick={footer.onClick}
          className="w-full rounded-full bg-well border border-edge-dim px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-edge hover:border-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {footer.label}
        </button>
      )}
    </div>
  );
}
