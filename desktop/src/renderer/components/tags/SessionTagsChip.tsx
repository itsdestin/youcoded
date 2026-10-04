// src/renderer/components/tags/SessionTagsChip.tsx
// The fixed in-session StatusBar element and its Tags & note popup.
//
// The element shows, each only when it applies (pick-menus-6#PM6-2: "pin icon, tag icon,
// note icon, if applicable. tags should look like stacked tags of the relevant colors"):
// the pin, the session's tags as stacked coloured tag icons, and the note's page icon —
// or "Add tags" when the session has none.
import { useState } from 'react';
import { useTagRegistry } from '../../hooks/useTagRegistry';
import { useSessionMeta } from '../../hooks/useSessionMeta';
import type { TagRecord } from '../../../shared/tags';
import { SessionDetails } from './SessionDetails';
import SessionRenameDialog from '../SessionRenameDialog';
import { TagIconStack } from './TagChip';
import { PinIcon } from './PinIcon';
import { NotePageGlyph } from './glyphs';
import { Dialog, Tooltip } from '../ui';
import { useScreenOpen } from '../../shoot-mode';

export function SessionTagsChip({ sessionId, sessionName }: { sessionId: string | null; sessionName?: string }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  useScreenOpen('chat/tags', () => setOpen(true)); // photo-only build: `shoot` opens it by name
  const registry = useTagRegistry();
  const meta = useSessionMeta(sessionId);

  const appliedTags = [...meta.tags]
    .map((id) => registry.byId.get(id))
    .filter((t): t is TagRecord => !!t);
  // Pinned is the stored `priority` flag (it drives the sort); it shows as a pin.
  const pinned = !!meta.flags.priority;
  const hasContent = appliedTags.length > 0 || meta.note.length > 0 || pinned;

  return (
    <>
      <Tooltip text={meta.supported ? 'Tags & note for this session' : meta.unsupportedReason}>
      <button
        onClick={() => setOpen(true)}
        // Disabled for sessions the backend can't store meta for (Android, as
        // of Task 5 — desktop native sessions are real store records now), so
        // the popup never accepts an edit that would be refused. See
        // META_UNSUPPORTED_FALLBACK.
        disabled={!sessionId || !meta.supported}
        aria-label={hasContent ? `Tags & note: ${[pinned ? 'pinned' : '', ...appliedTags.map((t) => t.label), meta.note ? 'a note' : ''].filter(Boolean).join(', ')}` : undefined}
        // `status-chip`: float chrome styles every status chip alike; this one
        // is nested, so `.status-bar > button` alone never reached it.
        className="status-chip flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim enabled:hover:bg-inset transition-colors max-w-[220px] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {hasContent ? (
          <span className="flex items-center gap-1.5">
            {pinned && <PinIcon className="w-3 h-3 text-fg-2 shrink-0" />}
            {appliedTags.length > 0 && <TagIconStack tags={appliedTags} />}
            {meta.note && <NotePageGlyph className="w-3 h-3 text-fg-muted shrink-0" />}
          </span>
        ) : (
          <span className="text-fg-muted">Add tags</span>
        )}
      </button>
      </Tooltip>
      {/* The shared popup (Dialog): standard header, ✕ and scrolling body. No Done
          button — every change saves as you make it (pick-menus-11#PM11-1). Complete is
          deliberately NOT offered here: a session you are sitting in is not finished,
          and the close prompt owns that decision. */}
      <Dialog screen="chat/tags" open={open} onClose={() => setOpen(false)} title="Session details" size="panel">
        <SessionDetails
          name={sessionName || 'Untitled session'}
          onRename={sessionId ? () => setRenaming(true) : undefined}
          appliedIds={meta.tags}
          onToggleTag={meta.setTag}
          registry={registry}
          note={meta.note}
          onNote={meta.setNote}
          pin={{ pinned, onPin: (next) => meta.setFlag('priority', next) }}
        />
      </Dialog>
      {renaming && sessionId && <SessionRenameDialog id={sessionId} name={sessionName || 'Untitled session'} onClose={() => setRenaming(false)} />}
    </>
  );
}
