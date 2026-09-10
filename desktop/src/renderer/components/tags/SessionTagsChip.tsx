// src/renderer/components/tags/SessionTagsChip.tsx
// The fixed in-session StatusBar element: colored tag dots + a notebook icon,
// or an "Add tags" button when the session has none. Opens a popup with the
// shared TagPicker + NoteEditor.
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel, CONTENT_Z } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import { useTagRegistry } from '../../hooks/useTagRegistry';
import { useSessionMeta } from '../../hooks/useSessionMeta';
import type { TagRecord } from '../../../shared/tags';
import { TagNoteEditor } from './TagNoteEditor';
import { PRIORITY_TAG, PRIORITY_HINT } from './built-in-tags';
import { TagManagerPopup } from './TagManagerPopup';
import { Tooltip } from '../ui';

export function SessionTagsChip({ sessionId }: { sessionId: string | null }) {
  const [open, setOpen] = useState(false);
  // Tag registry editing moved out of TagPicker into its own surface; this is
  // the route to it from the in-session chip. Layer 3 because this popup is
  // itself layer 2.
  const [manageOpen, setManageOpen] = useState(false);
  const registry = useTagRegistry();
  const meta = useSessionMeta(sessionId);
  useEscClose(open, () => setOpen(false));

  const appliedTags = [...meta.tags]
    .map((id) => registry.byId.get(id))
    .filter((t): t is TagRecord => !!t);
  // Priority reads as an ordinary tag everywhere else (built-in-tags.ts), so it
  // leads the chip's dots and its label the same way it leads the picker list.
  // It is stored as a reserved FLAG, which is why it rides meta.flags rather
  // than meta.tags.
  const priority = !!meta.flags.priority;
  const dotColors = [...(priority ? [PRIORITY_TAG.color] : []), ...appliedTags.map((t) => t.color)];
  const leadLabel = priority ? PRIORITY_TAG.label : appliedTags[0]?.label;
  const labelCount = dotColors.length;
  const hasContent = labelCount > 0 || meta.note.length > 0;

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
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim enabled:hover:bg-inset transition-colors max-w-[220px] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {hasContent ? (
          <span className="flex items-center gap-1 overflow-hidden">
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
      {open && createPortal(
        <>
          <Scrim layer={2} onClick={() => setOpen(false)} />
          <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: CONTENT_Z[2] }}>
            <OverlayPanel
              layer={2}
              className="w-full max-w-[360px] max-h-[80vh] flex flex-col pointer-events-auto"
              style={{ position: 'relative', zIndex: 'auto' }}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
                <h2 className="text-sm font-bold text-fg">Tags &amp; note</h2>
                <button onClick={() => setOpen(false)}
                  className="text-fg-muted hover:text-fg-2 text-lg leading-none w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset">×</button>
              </div>
              <div className="px-4 py-3 overflow-y-auto">
                {/* The SAME editor the close prompt uses, not a copy of its
                    styling — see TagNoteEditor's header for why that
                    distinction earned its own component on this branch.
                    Priority rides along as a built-in tag; Complete is
                    deliberately NOT offered here, because a session you are
                    sitting in is not finished and the close prompt owns that
                    decision.
                    Footer says "Done", not "Save": this surface persists every
                    keystroke as you make it, so claiming there is something
                    left to save would be a lie. The close prompt says "Save"
                    because there, the writes really are still pending. */}
                <TagNoteEditor
                  appliedIds={meta.tags}
                  onToggleTag={meta.setTag}
                  registry={registry}
                  onManageTags={() => setManageOpen(true)}
                  note={meta.note}
                  onNote={meta.setNote}
                  footer={{ label: 'Done', onClick: () => setOpen(false) }}
                  builtIns={[{
                    tag: PRIORITY_TAG,
                    hint: PRIORITY_HINT,
                    applied: priority,
                    onToggle: (next) => meta.setFlag('priority', next),
                  }]}
                />
              </div>
            </OverlayPanel>
          </div>
          <TagManagerPopup open={manageOpen} onClose={() => setManageOpen(false)} registry={registry} layer={3} />
        </>,
        document.body,
      )}
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
