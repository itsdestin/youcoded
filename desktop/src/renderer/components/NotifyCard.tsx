// The assistant's "Notify user" call in the chat (shared/notify-user.ts).
//
// Round 2 (Destin, 2026-10-26, deck notify-user-review N-1): the highlight goes
// around the WHOLE reply, not a box of its own — NotifyBubble is that reply's
// shell. It is "new" only while its call is the session's latest notification
// and unseen; it stops being new when the person
//   - sends a message (the call stops being latest — notify-seen.ts),
//   - rests the pointer on the reply for a moment, or
//   - clicks or taps the reply.
// NotifyCard is the notification itself inside the reply: the label over the
// message, set off by a divider, never a box.
//
// The status hue sits only in the outline, glow, tint and dot, never in the
// words (design guide, Principles 2).
import { memo, useEffect, useRef, type ReactNode } from 'react';
import type { ToolCallState } from '../../shared/types';
import { notifyFieldsOf } from '../../shared/notify-user';
import { markNotifySeen, setNotifyOnScreen, useNotifyActive } from '../state/notify-seen';
import { NOTIFY_STYLE } from './notify-style';

/** How long the pointer rests on a reply before it counts as seen — long enough
 *  that sweeping the mouse across the chat does not clear it. */
const HOVER_SEEN_MS = 600;

export function NotifyBubble({ sessionId, notifies, className, children }: {
  sessionId: string;
  notifies: readonly ToolCallState[];
  className: string;
  children: ReactNode;
}) {
  const ids = notifies.map((t) => t.toolUseId);
  const active = useNotifyActive(sessionId, ids);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seeAll = () => { for (const id of ids) markNotifySeen(id); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // Every reply uses this shell, notification or not: swapping a plain div for
  // it when a call lands mid-reply would remount the whole reply's contents.
  if (ids.length === 0) return <div className={className}>{children}</div>;
  return (
    <div
      className={`${className} notify-bubble`}
      data-notify={active ? 'new' : 'seen'}
      data-notify-style={NOTIFY_STYLE}
      onPointerEnter={active ? (e) => {
        // A finger has no hover; a tap arrives as the click below.
        if (e.pointerType !== 'mouse') return;
        timer.current = setTimeout(seeAll, HOVER_SEEN_MS);
      } : undefined}
      onPointerLeave={() => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }}
      onClick={active ? seeAll : undefined}
    >
      {children}
    </div>
  );
}

function NotifyCardImpl({ tool }: { tool: ToolCallState }) {
  const { label, message } = notifyFieldsOf(tool.input);
  const ref = useRef<HTMLDivElement>(null);

  // Report whether this notification is on screen, for ChatView's jump button.
  // The observer's root is the viewport, which still honours the chat
  // scroller's clipping, so one scrolled out of the chat reads as off screen.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setNotifyOnScreen(tool.toolUseId, !!entry?.isIntersecting), { threshold: 0.5 });
    io.observe(el);
    return () => { io.disconnect(); setNotifyOnScreen(tool.toolUseId, false); };
  }, [tool.toolUseId]);

  return (
    <div ref={ref} data-notify-id={tool.toolUseId} className="notify-line mt-3 pt-2.5 border-t border-edge-dim">
      <div className="notify-label flex items-center gap-1.5 text-xs font-medium text-fg-2">
        <span data-status="blue" className="notify-dot w-2 h-2 rounded-full bg-blue-400 shrink-0" aria-hidden="true" />
        {label}
      </div>
      {message && <div className="mt-1 text-sm text-fg whitespace-pre-wrap break-words">{message}</div>}
    </div>
  );
}

export const NotifyCard = memo(NotifyCardImpl);
