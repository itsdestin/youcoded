// blocked-send-toast.ts — the toast a refused send shows, with a way to the
// thing in the way.
//
// WHY a button (Destin, 2026-09-30): "answer the card first" left the user
// hunting for a card that may be scrolled away, and a pop-up open only in the
// terminal was invisible from chat. "Show card" scrolls to the waiting card and
// lights it up; when only Claude Code's screen is in the way (no card), "Open
// terminal" switches the session there. Order and weight per his review deck
// (S-1/S-2): the way forward is the dark button on the right; "Send anyway"
// keeps its original style, directly to its left. Kept out of App.tsx, which
// is over its line budget.
import type { ToastAction } from '../components/ui/Toast';
import { pendingInteractionRefusalCopy, type SendBlockKind, type screenInputBlock } from '../state/pty-input-gate';
import { focusChatCard, type CardRef } from './focus-chat-card';

export interface BlockedSendToast { message: string; durationMs: number; actions: ToastAction[] }

export function blockedSendToast(
  block: { kind: SendBlockKind; screen?: ReturnType<typeof screenInputBlock> },
  /** The waiting card (pendingCardRef), or null when only the screen blocks. */
  card: CardRef | null,
  io: { dismiss: () => void; openTerminal: () => void; retry?: () => void },
): BlockedSendToast {
  const forward: ToastAction = card && block.kind !== 'screen'
    // Not in the visible chat (folded far up): the menu is live in the
    // terminal too, so go there instead of doing nothing.
    ? { label: 'Show card', primary: true, onClick: () => { io.dismiss(); if (!focusChatCard(card)) io.openTerminal(); } }
    : { label: 'Open terminal', primary: true, onClick: () => { io.dismiss(); io.openTerminal(); } };
  const retry = io.retry;
  return {
    message: pendingInteractionRefusalCopy(block.kind, block.screen),
    durationMs: 8000,
    actions: retry ? [{ label: 'Send anyway', onClick: () => { io.dismiss(); retry(); } }, forward] : [forward],
  };
}
