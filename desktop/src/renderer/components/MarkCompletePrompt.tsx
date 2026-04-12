import React, { useEffect, useState } from 'react';
import { Scrim, OverlayPanel } from './overlays/Overlay';

interface Props {
  open: boolean;
  sessionName?: string;
  onCancel: () => void;
  // markComplete=true means the caller should call session.setComplete(sid, true)
  // before destroying. Caller controls both, so the modal stays pure.
  onConfirm: (markComplete: boolean) => void;
}

// Shown when the user closes an active session, so they can mark it complete
// in one step. Defaults to "mark complete" = true since that's the usual intent
// when closing a session you're done with.
export default function MarkCompletePrompt({ open, sessionName, onCancel, onConfirm }: Props) {
  const [markComplete, setMarkComplete] = useState(true);

  useEffect(() => {
    if (open) setMarkComplete(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onConfirm(markComplete);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, markComplete, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <>
      <Scrim layer={2} onClick={onCancel} />
      <div className="fixed inset-0 z-[61] flex items-center justify-center p-4 pointer-events-none">
        <OverlayPanel
          layer={2}
          className="w-full max-w-sm pointer-events-auto"
          style={{ position: 'relative', zIndex: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-4 pt-4 pb-3 border-b border-edge">
            <h2 className="text-sm font-bold text-fg">Close session</h2>
            {sessionName && (
              <p className="text-[11px] text-fg-muted mt-1 truncate">{sessionName}</p>
            )}
          </div>
          <div className="px-4 py-4 flex flex-col gap-3">
            <button
              onClick={() => setMarkComplete(!markComplete)}
              className="flex items-center justify-between w-full"
              aria-pressed={markComplete}
            >
              <span className="text-[10px] uppercase tracking-wider text-fg-muted">Mark complete</span>
              <span
                className={`w-8 h-4.5 rounded-full relative transition-colors ${markComplete ? 'bg-accent' : 'bg-inset'}`}
              >
                <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${markComplete ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
              </span>
            </button>
            <p className="text-[10px] text-fg-faint">
              {markComplete
                ? 'Hidden from the resume menu by default. Toggle Show Complete to unmark.'
                : 'Will appear in the resume menu next time you open it.'}
            </p>
          </div>
          <div className="px-4 pb-4 flex items-center gap-2 justify-end">
            <button
              onClick={onCancel}
              className="text-[11px] text-fg-dim hover:text-fg px-3 py-1.5 rounded-md hover:bg-inset transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(markComplete)}
              className="text-[11px] font-medium bg-accent text-on-accent px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
            >
              Close session
            </button>
          </div>
        </OverlayPanel>
      </div>
    </>
  );
}
