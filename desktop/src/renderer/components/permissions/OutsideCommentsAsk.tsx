import type { ReactNode, RefObject } from 'react';
import { BROAD_ALLOW_COLORS } from './FullAutoStops';

/** Card #207: a comment tool reaching a file outside the chat's project asks
 *  Yes / Allow for this chat / No. WHY this shape (Destin's deck note,
 *  2026-10-29: "these buttons dont seem to actually match how we'd style
 *  other/similar cards"): it is ToolCard's generic Yes / Always allow / No row
 *  with only the middle button renamed, and the scope note UNDER the buttons
 *  like that row's notes. ToolCard owns the answers and the arrow-key walk;
 *  this draws the row. */
export function OutsideCommentsAsk({ inset, responding, focusIdx, buttonsRef, pad, ring, unconfirmedNote, onChoose }: {
  inset: boolean;
  responding: boolean;
  focusIdx: number;
  buttonsRef: RefObject<(HTMLButtonElement | null)[]>;
  pad: string;
  ring: string;
  unconfirmedNote: ReactNode;
  /** 0 Yes, 1 Allow for this chat, 2 No — the same order as the keyboard walk. */
  onChoose: (index: number) => void;
}) {
  return (
    <div className={inset ? 'space-y-1.5' : 'px-3 py-2 border-t border-edge bg-inset/30 space-y-1.5'}>
      {/* WHY nowrap + flex-wrap: at phone width "Allow for this chat" broke
          mid-label into a two-line pill; a whole button dropping to the next
          row reads cleaner than a split one. */}
      <div className="flex flex-wrap items-center gap-2">
        {([
          ['Yes', 'bg-green-400/60 hover:bg-green-400/80 text-green-100'],
          ['Allow for this chat', BROAD_ALLOW_COLORS],
          ['No', 'bg-red-400/60 hover:bg-red-400/80 text-red-100'],
        ] as const).map(([label, colors], i) => (
          <button
            key={label}
            ref={el => { buttonsRef.current[i] = el; }}
            disabled={responding}
            onClick={() => onChoose(i)}
            className={`px-3 ${pad} text-xs font-medium rounded-lg whitespace-nowrap ${colors} transition-colors disabled:opacity-50 ${focusIdx === i ? ring : ''}`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-3xs text-fg-muted leading-relaxed">
        This file is outside this chat&apos;s project. Allow for this chat covers comments on any outside file until the chat ends, and never lets the assistant change the files.
      </p>
      {unconfirmedNote}
    </div>
  );
}
