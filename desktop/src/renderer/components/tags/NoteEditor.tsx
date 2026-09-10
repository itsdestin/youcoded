// src/renderer/components/tags/NoteEditor.tsx
import { useEffect, useRef, useState } from 'react';
import { Textarea } from '../ui';

const NOTE_MAX = 8000;

// Freeform per-session note. maxLength hard-caps at 8000 chars (design); a
// remaining-count appears near the limit. Saves on blur (only when changed),
// and also on unmount so a note typed then ESC-closed (which fires no blur)
// isn't lost.
// Default placeholder (first-run guide, empty screens): says what a note is FOR
// and where it turns up again, instead of the bare "Add a note…" — a new user
// had no way to know the note surfaces in Resume. Callers may still override.
export function NoteEditor({ value, onSave, placeholder = 'A note to your future self — it shows in Resume', fieldClassName = '' }: {
  value: string;
  onSave: (text: string) => void;
  placeholder?: string;
  /** Extra classes for the textarea's surface — same reason as TagPicker's:
   *  a host that is itself `bg-inset` needs the field one step deeper. */
  fieldClassName?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  // Refs so the unmount-commit reads the newest draft/value/onSave without
  // re-subscribing every render (onSave is often a fresh closure each render).
  const latest = useRef({ draft, value, onSave });
  latest.current = { draft, value, onSave };
  useEffect(() => () => {
    const { draft: d, value: v, onSave: save } = latest.current;
    if (d !== v) save(d);
  }, []);
  const remaining = NOTE_MAX - draft.length;
  const commit = () => { if (draft !== value) onSave(draft); };
  return (
    <div className="flex flex-col gap-1">
      {/* Change 42: onto the shared FIELD surface. `resizable` is passed on purpose —
          this note box genuinely IS drag-resizable today (it was `resize-y`), and
          the explicit resize-y className keeps it vertical-only; the primitive's
          `resizable` escape hatch otherwise falls back to the browser default of
          resizing in both axes, which would let it overflow its container. */}
      <Textarea
        size="sm"
        resizable
        className={`w-full resize-y ${fieldClassName}`.trim()}
        aria-label={placeholder}
        value={draft}
        maxLength={NOTE_MAX}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={placeholder}
        rows={3}
      />
      {remaining < 500 && (
        <span className="text-4xs self-end text-fg-muted">{remaining} left</span>
      )}
    </div>
  );
}
