// The assistant's "Notify user" call in the chat (shared/notify-user.ts).
//
// Round 2 (Destin, 2026-10-26, deck notify-user-review N-1): the highlight goes
// around the WHOLE reply, not a box of its own — NotifyBubble is that reply's
// shell. It is "new" only while its call is the session's latest notification
// and unseen; it stops being new when the person
//   - sends a message (the call stops being latest — notify-seen.ts),
//   - rests the pointer on the reply for a moment, or
//   - clicks or taps the reply.
// NotifyCard is the notification itself, the reply's FIRST child: one line —
// label · message — in a pill on the reply's top edge (round 2 R2-1 picked the
// tab; round 3: "single line"), or, when that line would not fit, a card nested
// at the top of the reply.
//
// The status hue sits only in the outline, glow, tint and dot, never in the
// words (design guide, Principles 2).
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ToolCallState } from '../../shared/types';
import { notifyFieldsOf } from '../../shared/notify-user';
import { markNotifySeen, setNotifyOnScreen, useNotifyActive } from '../state/notify-seen';

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

/** The pill's own look, shared by the visible pill and the hidden copy that
 *  measures how wide it would be on one line. */
const PILL = 'notify-tab inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-1 rounded-full text-xs';

function NotifyCardImpl({ tool }: { tool: ToolCallState }) {
  const { label, message } = notifyFieldsOf(tool.input);
  const ref = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  // One line when it fits, else a nested card (round 3, Destin: "single line";
  // "keep it as a separate nested card at the top if it reaches the point of
  // needing to wrap").
  const [fits, setFits] = useState(true);

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

  // Measure on resize only (the reply's width changes with the window), never
  // per frame: the hidden copy's natural width against the reply's text width.
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    const measure = measureRef.current;
    if (!host || !measure || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      const cs = getComputedStyle(host);
      const room = host.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setFits(measure.offsetWidth <= room);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(host);
    return () => ro.disconnect();
  }, [label, message]);

  const dot = <span data-status="blue" className="notify-dot w-2 h-2 rounded-full bg-blue-400 shrink-0" aria-hidden="true" />;
  const line = (
    <>
      {dot}
      <span className="font-medium text-fg">{label}</span>
      {message && <span className="text-fg">· {message}</span>}
    </>
  );
  return (
    <div ref={ref} data-notify-id={tool.toolUseId} data-shape={fits ? 'pill' : 'card'} className="notify-slot relative">
      <span ref={measureRef} aria-hidden="true" className={`${PILL} absolute invisible pointer-events-none left-0 top-0`}>{line}</span>
      {fits ? (
        <div className={PILL}>{line}</div>
      ) : (
        <div className="notify-tab mb-3 px-3 py-2 rounded-xl">
          <div className="flex items-center gap-1.5 text-xs font-medium text-fg-2">{dot}{label}</div>
          {message && <div className="mt-0.5 text-sm text-fg whitespace-pre-wrap break-words">{message}</div>}
        </div>
      )}
    </div>
  );
}

export const NotifyCard = memo(NotifyCardImpl);
