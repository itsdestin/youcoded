// NotifyCard — the in-chat card for the assistant's "Notify user" call
// (shared/notify-user.ts): its short label over its message, in the blue the
// session list uses for "Response ready". It glows until the person clicks it
// (Destin, 2026-10-26: "its own clickable element that like glows or something
// until clicked"). ChatView's "Jump to notification" button scrolls here.
//
// Built from the notice box's shape (Callout: tinted box, matching border) and
// the status pill's colour (SessionStrip STATUS_PILL blue) — the status hue sits
// only in the tint, border, dot and glow, never in the words (design guide,
// Principles 2).
import { memo, useEffect, useRef } from 'react';
import type { ToolCallState } from '../../shared/types';
import { notifyFieldsOf } from '../../shared/notify-user';
import { markNotifySeen, setNotifyOnScreen, useNotifySeen } from '../state/notify-seen';

/** The glow while unclicked: the status dot's own blue glow (SessionStrip
 *  GLOW_SHADOW.blue), widened to a card. Static — no animation runs while a
 *  card waits, however long (performance.md rule 6). */
const UNSEEN_GLOW = '0 0 0 1px rgba(96,165,250,0.45), 0 0 16px rgba(96,165,250,0.35)';

function NotifyCardImpl({ tool }: { tool: ToolCallState }) {
  const { label, message } = notifyFieldsOf(tool.input);
  const seen = useNotifySeen(tool.toolUseId);
  const ref = useRef<HTMLButtonElement>(null);

  // Report whether this card is on screen, for ChatView's jump button. The
  // observer's root is the viewport, which still honours the chat scroller's
  // clipping, so a card scrolled out of the chat reads as off screen.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setNotifyOnScreen(tool.toolUseId, !!entry?.isIntersecting), { threshold: 0.5 });
    io.observe(el);
    return () => { io.disconnect(); setNotifyOnScreen(tool.toolUseId, false); };
  }, [tool.toolUseId]);

  return (
    <button
      ref={ref}
      type="button"
      data-notify-id={tool.toolUseId}
      data-seen={seen ? 'true' : 'false'}
      onClick={() => markNotifySeen(tool.toolUseId)}
      aria-label={seen ? `Notification: ${label}` : `New notification: ${label}`}
      className={`notify-card w-full text-left select-text rounded-lg border px-3 py-2 mt-1.5 transition-shadow ${
        seen ? 'bg-inset border-edge-dim cursor-default' : 'bg-blue-400/10 border-blue-400/40 cursor-pointer'
      }`}
      style={seen ? undefined : { boxShadow: UNSEEN_GLOW }}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-fg-2">
        <span
          data-status="blue"
          className="w-2 h-2 rounded-full bg-blue-400 shrink-0"
          // The status dot's own breathing (SessionStrip SessionDot): steps(8), never smooth.
          style={seen ? { opacity: 0.5 } : { animation: 'breathe 2s steps(8) infinite' }}
        />
        {label}
      </span>
      {message && <span className="block mt-1 text-sm text-fg whitespace-pre-wrap break-words">{message}</span>}
    </button>
  );
}

export const NotifyCard = memo(NotifyCardImpl);
