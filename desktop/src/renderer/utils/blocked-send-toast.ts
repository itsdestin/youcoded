// blocked-send-toast.ts — the notice a refused send shows, with a way to the
// thing in the way.
//
// WHY a button (Destin, 2026-09-30): "answer the card first" left the user
// hunting for a card that may be scrolled away, and a pop-up open only in the
// terminal was invisible from chat. "Show card" scrolls to the waiting card and
// lights it up; when only Claude Code's screen is in the way (no card), "Open
// terminal" switches the session there.
//
// WHY it now lives in the chat's own strip (Destin, waiting-notice deck, held-back rows): the floating toast
// followed him into other chats and sat over messages. Buttons follow his K-7 note: Dismiss leftmost (the strip
// draws it), "Send anyway" the filled one on the right where a retry exists, otherwise the way to the card is.
// Kept out of App.tsx, which is over its line budget.
import type { ToastAction } from '../components/ui/Toast';
import type { ChatNotice } from '../state/chat-notice-store';
import { pendingInteractionRefusalCopy, type SendBlockKind, type screenInputBlock } from '../state/pty-input-gate';
import { focusChatCard, type CardRef } from './focus-chat-card';

/** The short floating notice for a chat you are NOT looking at (its strip is not on screen). */
export interface BlockedSendToast { message: string; durationMs: number; actions: ToastAction[] }

/** The held-back sentence and buttons for the chat's strip. The caller adds `stillTrue`. */
export function blockedSendNotice(
  block: { kind: SendBlockKind; screen?: ReturnType<typeof screenInputBlock> },
  /** The waiting card (pendingCardRef), or null when only the screen blocks. */
  card: CardRef | null,
  io: { dismiss: () => void; openTerminal: () => void; retry?: () => void },
): Omit<ChatNotice, 'stillTrue'> {
  const retry = io.retry;
  const forward = card && block.kind !== 'screen'
    // Not in the visible chat (folded far up): the menu is live in the
    // terminal too, so go there instead of doing nothing.
    ? { label: 'Show card', onClick: () => { io.dismiss(); if (!focusChatCard(card)) io.openTerminal(); } }
    : { label: 'Open terminal', onClick: () => { io.dismiss(); io.openTerminal(); } };
  return {
    key: 'held',
    tone: 'warn',
    leave: 'resolved',
    text: pendingInteractionRefusalCopy(block.kind, block.screen),
    // With a retry, "Send anyway" is the one filled button; without one the way forward is.
    actions: retry
      ? [forward, { label: 'Send anyway', primary: true, onClick: () => { io.dismiss(); retry(); } }]
      : [{ ...forward, primary: true }],
  };
}

/** Held back in a chat that is not on screen: say which chat, so a background refusal is never invisible. */
export function blockedSendFloating(chatName: string | undefined): BlockedSendToast {
  return {
    message: chatName
      ? `Claude Code is waiting on something in "${chatName}" — answer it first.`
      : 'Claude Code is waiting on something in another chat — answer it first.',
    durationMs: 8000,
    actions: [],
  };
}
