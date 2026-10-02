// src/renderer/components/tags/SessionTagsChip.tsx
// The fixed in-session StatusBar element: colored tag dots + a notebook icon,
// or an "Add tags" button when the session has none. Opens a popup with the
// shared TagPicker + NoteEditor.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import './SessionTagsChip.css';
import { useTagRegistry } from '../../hooks/useTagRegistry';
import { useSessionMeta } from '../../hooks/useSessionMeta';
import type { TagRecord } from '../../../shared/tags';
import { TagNoteEditor } from './TagNoteEditor';
import { PinIcon } from './PinIcon';
import { TagChip, MoreTagsChip } from './TagChip';
import { TagGlyph } from './glyphs';

// TRIAL: the status bar element's look for the pick-menus-6 deck.
const SB_TAG = 'pills' as 'dots' | 'pills' | 'icon-count';
import { TagManagerPopup } from './TagManagerPopup';
import { Dialog, Tooltip } from '../ui';
import { useScreenOpen } from '../../shoot-mode';

export function SessionTagsChip({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(false);
  useScreenOpen('chat/tags', () => setOpen(true)); // photo-only build: `shoot` opens it by name
  // Tag registry editing moved out of TagPicker into its own surface; this is
  // the route to it from the in-session chip. Layer 3 because this popup is
  // itself layer 2.
  const [manageOpen, setManageOpen] = useState(false);
  useScreenOpen('chat/tags/manage', () => setManageOpen(true)); // photo-only build
  const registry = useTagRegistry();
  const meta = useSessionMeta(sessionId);

  const appliedTags = [...meta.tags]
    .map((id) => registry.byId.get(id))
    .filter((t): t is TagRecord => !!t);
  // Priority reads as an ordinary tag everywhere else (built-in-tags.ts), so it
  // leads the chip's dots and its label the same way it leads the picker list.
  // It is stored as a reserved FLAG, which is why it rides meta.flags rather
  // than meta.tags.
  const priority = !!meta.flags.priority;
  // Pinned shows as a pin glyph, not an amber "Priority" dot (pick-menus-2#PM2-3).
  const dotColors = appliedTags.map((t) => t.color);
  const leadLabel = appliedTags[0]?.label;
  const labelCount = dotColors.length;
  const hasContent = labelCount > 0 || meta.note.length > 0 || priority;

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
        // `status-chip`: float chrome styles every status chip alike; this one
        // is nested, so `.status-bar > button` alone never reached it.
        className="status-chip flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim enabled:hover:bg-inset transition-colors max-w-[220px] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {hasContent && SB_TAG !== 'dots' ? (
          // TRIAL pick-menus-6: the status bar element in the new tag look.
          <span className="flex items-center gap-1 overflow-hidden">
            {priority && <PinIcon className="w-3 h-3 text-fg-2 shrink-0" />}
            {SB_TAG === 'pills' ? (
              <>
                {appliedTags.slice(0, 1).map((t) => <TagChip key={t.id} tag={t} />)}
                <MoreTagsChip names={appliedTags.slice(1).map((t) => t.label)} />
              </>
            ) : appliedTags.length > 0 && (
              <span className="flex items-center gap-1 text-fg-2">
                <TagGlyph className="w-3 h-3 text-fg-muted" />
                {appliedTags.length === 1 ? appliedTags[0].label : `${appliedTags.length} tags`}
              </span>
            )}
            {meta.note && <NotebookIcon className="w-3 h-3 text-fg-muted shrink-0" />}
          </span>
        ) : hasContent ? (
          <span className="flex items-center gap-1 overflow-hidden">
            {priority && <PinIcon className="w-3 h-3 text-fg-2 shrink-0" />}
            {dotColors.slice(0, 3).map((c, i) => (
              <span key={`${c}-${i}`} className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: `var(--${c})` }} />
            ))}
            {meta.note && <NotebookIcon className="w-3 h-3 text-fg-muted shrink-0" />}
            {leadLabel && (
              <span className="truncate text-fg-2">
                {leadLabel}{labelCount > 1 ? ` +${labelCount - 1}` : ''}
              </span>
            )}
          </span>
        ) : (
          <span className="text-fg-muted">Add tags</span>
        )}
      </button>
      </Tooltip>
      {/* WHY the shared Dialog (pick-menus#PM-4): the popup hand-built its own header and
          ×, so it matched no other popup; the Dialog brings the standard header, close
          button and scrolling body. */}
      <Dialog screen="chat/tags" open={open} onClose={() => setOpen(false)} title="Tags & note" size="panel">
        {/* Footer says "Done", not "Save": this surface persists every keystroke as you
            make it. Priority rides along as a built-in tag; Complete is deliberately NOT
            offered here — the close prompt owns that decision. */}
        <TagNoteEditor
          split
          appliedIds={meta.tags}
          onToggleTag={meta.setTag}
          registry={registry}
          note={meta.note}
          onNote={meta.setNote}
          footer={{ label: 'Done', onClick: () => setOpen(false) }}
          pin={{ pinned: priority, onPin: (next) => meta.setFlag('priority', next) }}
        />
      </Dialog>
      {manageOpen && createPortal(<TagManagerPopup open onClose={() => setManageOpen(false)} registry={registry} layer={3} />, document.body)}
    </>
  );
}

function NotebookIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}
