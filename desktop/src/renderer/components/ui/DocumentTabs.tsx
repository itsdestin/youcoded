// DocumentTabs — a strip of open documents, each closable, like browser tabs.
//
// WHY a new primitive (guide G-1): SegmentedTabs is for 2–5 short exclusive
// options and has no close control; Office needs any number of open files
// (office-questions#Q-tabs: "tabs in one page"). Rows are the same rounded
// pills as the page panel's rows, so the strip reads as part of that family:
// current = inset fill, rest = fg-2 with the one-step hover (guide §2.4).
//
// A tab can be ASLEEP (office-questions#Q-sleep): its editor was closed to save
// memory and comes back where it was when chosen. It stays in the strip, dimmer,
// with a moon, and says so on hover — the tab never disappears on its own.
import React from 'react';
import { Tooltip } from './Tooltip';

export interface DocumentTab {
  id: string;
  label: string;
  /** 16px glyph before the label (the file type). */
  icon?: React.ReactNode;
  asleep?: boolean;
  /** false for a tab that cannot be closed (Office's Home). Default true. */
  closable?: boolean;
  /** Set while the tab cannot close for a moment (Office: a copy is being written). The ✕ is
   *  shown disabled with this as its tooltip, so pressing it is never a silent no-op. */
  closeNote?: string;
}

export interface DocumentTabsProps {
  tabs: readonly DocumentTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Accessible name of the strip. */
  label: string;
  className?: string;
}

export function DocumentTabs({ tabs, activeId, onSelect, onClose, label, className = '' }: DocumentTabsProps) {
  return (
    <div role="tablist" aria-label={label} className={`flex items-center gap-1 min-w-0 overflow-x-auto select-none ${className}`}>
      {tabs.map((t) => {
        const current = t.id === activeId;
        const closable = t.closable !== false;
        const tab = (
          <div
            key={t.id}
            className={`group shrink-0 flex items-center h-8 max-w-56 rounded-md transition-colors ${
              current ? 'bg-inset text-fg' : 'text-fg-2 hover:bg-inset hover:text-fg active:bg-edge'
            }`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={current}
              data-document-tab={t.id}
              onClick={() => onSelect(t.id)}
              className={`flex items-center gap-2 min-w-0 h-full text-sm ${closable ? 'pl-2.5 pr-1' : 'px-2.5'} rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
            >
              {t.icon && <span className={`shrink-0 ${t.asleep ? 'text-fg-muted' : ''}`}>{t.icon}</span>}
              <span className={`truncate ${t.asleep ? 'text-fg-muted' : ''}`}>{t.label}</span>
              {t.asleep && <MoonGlyph />}
            </button>
            {closable && withNote(t.closeNote,
              <button
                type="button"
                aria-label={t.closeNote ? `Close ${t.label}: ${t.closeNote}` : `Close ${t.label}`}
                aria-disabled={t.closeNote ? true : undefined}
                onClick={() => { if (!t.closeNote) onClose(t.id); }}
                // Visible on the current tab; on the others it appears with
                // hover or focus, and always on touch (.touch-reveal).
                className={`coarse-hit mr-1 w-5 h-5 shrink-0 flex items-center justify-center rounded text-fg-muted hover:text-fg hover:bg-edge focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  current ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 touch-reveal'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeWidth={2.5} d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>,
            )}
          </div>
        );
        return t.asleep
          ? <Tooltip key={t.id} text="Asleep to save memory. Opens where you left off." placement="bottom">{tab}</Tooltip>
          : tab;
      })}
    </div>
  );
}

/** The ✕ with its tooltip while it cannot close (an aria-disabled button still takes hover). */
function withNote(note: string | undefined, button: React.ReactElement<Record<string, unknown>>): React.ReactNode {
  return note ? <Tooltip text={note} placement="bottom">{button}</Tooltip> : button;
}

function MoonGlyph() {
  return (
    <svg className="w-3.5 h-3.5 shrink-0 text-fg-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-label="Asleep">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" />
    </svg>
  );
}
