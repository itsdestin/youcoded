// src/renderer/components/guide/GuideBubble.tsx
//
// The buddy, in the bottom-right corner of the main window, with a speech
// bubble. The tour and every tip speak through this one component, so a person
// learns once where to look. The bubble's shape and colours are the coach mark
// that already points at the chat/terminal switch (ViewToggleHint): accent
// fill, an accent-derived outline, a tail — the shape Destin picked from three
// on 2026-09-04. Here the tail points RIGHT, at the buddy, instead of up at a
// control; a ringed control (GuideRing) does the pointing at the screen.
//
// Design: docs/active/specs/2026-09-10-first-run-guide-design.md §3.
import React from 'react';
import { createPortal } from 'react-dom';
import { OverlayPanel, CONTENT_Z } from '../overlays/Overlay';
import { Button } from '../ui';
import { ThemeMascot, WelcomeAppIcon } from '../Icons';
import { HINT_FILL, HINT_EDGE } from '../ViewToggleHint';

const TAIL_PX = 12;

export interface GuideBubbleButton {
  label: string;
  onClick: () => void;
  /** `next` is the one filled button; the rest are quiet. */
  role?: 'next' | 'quiet';
}

interface Props {
  /** "2 of 8", or "Tip" — text-2xs, uppercase, above the sentence. */
  eyebrow: string;
  children: React.ReactNode;
  buttons: GuideBubbleButton[];
  pose: 'welcome' | 'inquisitive';
  /** Names the dialog for assistive tech: "Tour" / "Tip". */
  label: string;
}

export default function GuideBubble({ eyebrow, children, buttons, pose, label }: Props) {
  return createPortal(
    <div
      role="dialog"
      aria-label={label}
      data-guide-bubble=""
      className="fixed flex items-end gap-1 pointer-events-none"
      style={{
        right: 16,
        // Above whichever bottom chrome is there: the input bar in a session,
        // the bare frame's strip on the welcome screen (which is the header's
        // height, not --bottom-chrome-height — globals.css .chrome-glass--bare).
        bottom: 'calc(max(var(--bottom-chrome-height, 0px), var(--top-chrome-height, 2.5rem)) + 20px)',
        zIndex: CONTENT_Z[4],
        maxWidth: 'calc(100vw - 2rem)',
      }}
    >
      <div className="relative pointer-events-auto mb-6">
        <OverlayPanel
          layer={4}
          className="relative flex flex-col gap-2 px-4 py-3 text-on-accent w-[22rem] max-w-[calc(100vw-8.5rem)]"
          // Inline, not utilities: .layer-surface paints in unlayered CSS and
          // beats any Tailwind class (globals.css cascade note). Same override
          // ViewToggleHint makes, for the same reason.
          style={{
            zIndex: 'auto',
            background: HINT_FILL,
            borderColor: HINT_EDGE,
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <span className="text-2xs font-medium uppercase tracking-wider text-on-accent/70">{eyebrow}</span>
          <p className="text-sm leading-snug">{children}</p>
          <div className="flex items-center gap-1 pt-1 flex-wrap">
            {buttons.map((b) => (
              <Button
                key={b.label}
                size="sm"
                variant="on-accent"
                onClick={b.onClick}
                className={b.role === 'next' ? 'font-medium' : undefined}
                // The one filled button on the bubble: on-accent ink, accent
                // text — the bubble's own colours swapped. Inline, because the
                // variant's `text-on-accent/80` is an opacity-suffixed token
                // that mergeClasses does not treat as the same group as
                // `text-accent`, so a utility override left both in place and
                // the label vanished (measured 2026-09-10).
                style={b.role === 'next' ? { background: 'var(--on-accent)', color: 'var(--accent)' } : undefined}
              >
                {b.label}
              </Button>
            ))}
          </div>
        </OverlayPanel>
        {/* The tail, AFTER the bubble so its fill hides the bubble's right
            border where they meet — the same paint-order trick as
            ViewToggleHint's arrow, rotated to point at the buddy. */}
        <div
          aria-hidden="true"
          className="absolute rotate-45"
          style={{
            width: TAIL_PX,
            height: TAIL_PX,
            right: -TAIL_PX / 2,
            bottom: 18,
            background: HINT_FILL,
            borderTop: `1px solid ${HINT_EDGE}`,
            borderRight: `1px solid ${HINT_EDGE}`,
          }}
        />
      </div>
      {/* The active theme's own mascot gives the tour. Not `scene`: the
          companions need a big canvas, and this is a corner. */}
      <div className="pointer-events-none shrink-0" data-guide-buddy="">
        <ThemeMascot small={false} variant={pose} fallback={WelcomeAppIcon} className="w-24 h-24 text-fg-dim" />
      </div>
    </div>,
    document.body,
  );
}
