import React, { useEffect, useState } from 'react';
import { Scrim, OverlayPanel } from './overlays/Overlay';

// Flag order must match ResumeBrowser's pill order so the UI is consistent.
type FlagName = 'priority' | 'helpful' | 'complete';
const FLAG_ORDER: FlagName[] = ['priority', 'helpful', 'complete'];
const FLAG_LABEL: Record<FlagName, string> = {
  priority: 'Priority',
  helpful: 'Helpful',
  complete: 'Complete',
};

interface Props {
  open: boolean;
  sessionName?: string;
  onCancel: () => void;
  // onConfirm receives the set of flags the user wants set to `true`. Callers
  // fire one setFlag(flag, true) per entry, then destroy the session. Unmarking
  // is handled in the resume menu, not here — this prompt only sets flags.
  onConfirm: (flagsToSet: FlagName[]) => void;
}

// Shown when the user closes an active session. Lets them tag the session with
// any combination of Priority, Helpful, Complete in one step. Complete defaults
// to `true` because that's the usual "I'm done with this" close intent, which
// Destin already validated on the prior Complete-only prompt.
export default function CloseSessionPrompt({ open, sessionName, onCancel, onConfirm }: Props) {
  const [sel, setSel] = useState<Record<FlagName, boolean>>({
    priority: false,
    helpful: false,
    complete: true,
  });

  useEffect(() => {
    if (open) setSel({ priority: false, helpful: false, complete: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') {
        onConfirm(FLAG_ORDER.filter((f) => sel[f]));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, sel, onCancel, onConfirm]);

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
            <label className="text-[10px] uppercase tracking-wider text-fg-muted">Tag before closing</label>
            <div className="flex gap-1">
              {FLAG_ORDER.map((flag) => {
                const active = sel[flag];
                return (
                  <button
                    key={flag}
                    onClick={() => setSel((prev) => ({ ...prev, [flag]: !prev[flag] }))}
                    className={`flex-1 px-1 py-1.5 rounded-sm text-[11px] transition-colors ${
                      active
                        ? 'bg-accent text-on-accent font-medium'
                        : 'bg-inset text-fg-dim hover:bg-edge'
                    }`}
                    aria-pressed={active}
                  >
                    {FLAG_LABEL[flag]}
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-fg-faint">
              {sel.complete
                ? 'Marking Complete hides this from the resume menu by default.'
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
              onClick={() => onConfirm(FLAG_ORDER.filter((f) => sel[f]))}
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
