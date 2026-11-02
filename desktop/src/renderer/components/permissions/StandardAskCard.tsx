import type { ReactNode } from 'react';
import { QuestionIcon } from '../Icons';
import { isAndroid } from '../../platform';
import { BROAD_ALLOW_COLORS } from './FullAutoStops';

/** The chat's standard permission card, drawn for an ask that is NOT a tool call.
 *  WHY (Destin's deck note on the browser form ask, 2026-11-01: "make this a more
 *  standard permission card. idk why this has unique styling"): ToolCard draws every
 *  other ask as an outlined card, a one-line header (question icon, divider, label,
 *  detail), then a band holding the question, the green Yes / blue Always allow /
 *  red No row and a small note. The browser's form ask had its own boxed style, so
 *  it looked like a different product. This reproduces that exact shell (same
 *  borders, band, status colours, pill radius, padding, note size) so the two cannot
 *  drift apart. bg-inset because ToolCard's own card sits inside an assistant bubble or a tool group, which supply the backing; this one is drawn directly on the chat, where text would otherwise sit on the wallpaper (what the old browser card's bg-inset was for). A new ask of this kind uses this, not a fresh box. Click-only: the
 *  browser's asks have never taken Enter/arrow keys, and the window-wide key
 *  listener ToolCard installs would fight the one already on the page. */
export function StandardAskCard({ label, detail, question, note, responding, onYes, onAlways, alwaysLabel = 'Always allow', onNo, ariaLabel }: {
  /** Header label, ToolCard's `display.label` ("Sending a form"). */
  label: string;
  /** Header detail, ToolCard's `display.detail` (the site). */
  detail?: string;
  /** The question the buttons answer, same slot as "Visit python.org?". */
  question: string;
  /** Small note under the buttons saying what each answer covers. */
  note?: ReactNode;
  responding: boolean;
  onYes: () => void;
  /** Omit when the ask can never be remembered (the person's own Chrome). */
  onAlways?: () => void;
  alwaysLabel?: string;
  onNo: () => void;
  ariaLabel: string;
}) {
  const pad = isAndroid() ? 'py-2' : 'py-1';
  return (
    <div className="mx-4 my-2 border border-edge rounded-lg overflow-hidden bg-inset in-view" role="group" aria-label={ariaLabel}>
      <div className="w-full flex items-center gap-1.5 px-3 py-1.5 select-none">
        <QuestionIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        <span aria-hidden="true" className="w-px h-3.5 bg-edge shrink-0" />
        <span className="text-xs font-medium text-fg-2">{label}</span>
        {detail && <span className="text-xs text-fg-muted truncate flex-1 min-w-0">{detail}</span>}
      </div>
      <div className="px-3 py-2 border-t border-edge bg-inset/30 space-y-1.5">
        <p className="text-xs font-medium text-fg-2 break-words">{question}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={responding} onClick={onYes}
            className={`px-3 ${pad} text-xs font-medium rounded-lg whitespace-nowrap bg-green-400/60 hover:bg-green-400/80 text-green-100 transition-colors disabled:opacity-50`}>Yes</button>
          {onAlways && (
            <button disabled={responding} onClick={onAlways}
              className={`px-3 ${pad} text-xs font-medium rounded-lg whitespace-nowrap ${BROAD_ALLOW_COLORS} transition-colors disabled:opacity-50`}>{alwaysLabel}</button>
          )}
          <button disabled={responding} onClick={onNo}
            className={`px-3 ${pad} text-xs font-medium rounded-lg whitespace-nowrap bg-red-400/60 hover:bg-red-400/80 text-red-100 transition-colors disabled:opacity-50`}>No</button>
        </div>
        {note && <p className="text-3xs text-fg-muted leading-relaxed">{note}</p>}
      </div>
    </div>
  );
}
