// ConnectionStrip — where a phone's copy of the conversation stands: reconnecting, catching up, waiting for a slow computer,
// possibly out of date (with Refresh), and a short "Up to date." after a refresh.
//
// WHY here, in the input bar's band above the message box (Destin, 2026-10-22: "sit above the input bar in the frame like some
// of our other notices and the voice typing input thing"): it was a row under the header, at the far end of the screen from
// where a phone's thumb and eyes are. It now sits where the voice "Listening" band and the model-download band do, the same
// StatusStrip. Wording, buttons and timing are unchanged from that row (remote access batch 2, deck 2026-09-10 Q-3).
// Only a phone sets these props; the computer's own window never shows it.
import { useEffect, useRef, useState } from 'react';
import { StatusStrip, Button } from './ui';
import { isAndroid } from '../platform';
import { useSessionIsEmpty } from '../state/chat-context';

export type ConversationStatus = 'reconnecting' | 'restoring' | 'incomplete' | 'complete';

export interface ConnectionStripProps {
  sessionId: string;
  /** Where this phone's copy stands. Undefined / `complete` shows nothing (after a transition out of catching up, "Up to date."). */
  conversationStatus?: ConversationStatus;
  /** The connection is up but the computer is slow to answer. */
  waitingForComputer?: boolean;
  /** The conversation is being filled right now (switched to, not watched yet): while it has no content, say "catching up". */
  filling?: boolean;
  /** Asks the computer for a fresh copy — the out-of-date strip's Refresh. */
  onRefresh?: () => void;
  /** The Android app leaves its unreachable computer for the phone's own runtime. */
  onUsePhoneOnly?: () => void;
}

export function ConnectionStrip({ sessionId, conversationStatus, waitingForComputer, filling, onRefresh, onUsePhoneOnly }: ConnectionStripProps) {
  // The live status, plus a 2.5 s "Up to date" after a refresh so the person can see it worked (tester U9). An initial
  // `complete` — a phone that connected cleanly — shows nothing; only a transition OUT of restoring/incomplete earns the beat.
  const [status, setStatus] = useState<'reconnecting' | 'restoring' | 'incomplete' | 'up-to-date' | null>(null);
  const prevRef = useRef<ConversationStatus | undefined>(undefined);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = conversationStatus;
    if (conversationStatus === 'complete') {
      if (prev === 'restoring' || prev === 'incomplete') {
        setStatus('up-to-date');
        const t = window.setTimeout(() => setStatus(null), 2500);
        return () => window.clearTimeout(t);
      }
      setStatus(null);
      return;
    }
    setStatus(conversationStatus ?? null);
  }, [conversationStatus]);
  // A conversation switched to but not filled yet shows the SAME "Catching up" a reconnect shows (one-core R5-3).
  const empty = useSessionIsEmpty(sessionId);
  // The computer slow to answer: said quietly, and only when nothing more specific is showing.
  const shown = status ?? (filling && empty ? 'restoring' : waitingForComputer ? 'slow' : null);
  if (!shown) return null;

  return (
    <div className="px-2 sm:px-3 pb-1.5" data-conversation-status={shown}>
      {shown === 'incomplete' ? (
        // Wording per the first phone tester (U11, 2026-09-10): "behind your computer" read as a place, not a time.
        <StatusStrip
          tone="warn"
          detail="The last refresh didn’t finish, so newer messages may be missing."
          action={<Button size="sm" onClick={onRefresh}>Refresh</Button>}
        >
          This conversation may be out of date.
        </StatusStrip>
      ) : shown === 'reconnecting' ? (
        // WHY the wording (2026-10-22): nothing sends on its own after a drop (contract row R2).
        <StatusStrip
          tone="busy"
          detail="Your draft is kept. Press Send again once you’re reconnected."
          // WHY outlined and on its own line (review P-1): beside the words it squeezed them onto two lines at phone width.
          actionBelow
          action={onUsePhoneOnly && isAndroid() ? <Button size="sm" variant="secondary" className="w-full justify-center" onClick={onUsePhoneOnly}>Use this phone only</Button> : undefined}
        >
          Reconnecting to your computer…
        </StatusStrip>
      ) : shown === 'slow' ? (
        <StatusStrip tone="busy" detail="It's taking longer than usual to answer. Anything you send will arrive once it does.">
          Waiting for your computer…
        </StatusStrip>
      ) : shown === 'restoring' ? (
        // No draft line here: the connection IS back (tester U8).
        <StatusStrip tone="busy" detail="Loading the newest messages…">
          Catching up with your computer…
        </StatusStrip>
      ) : (
        <StatusStrip tone="ok">Up to date.</StatusStrip>
      )}
    </div>
  );
}
