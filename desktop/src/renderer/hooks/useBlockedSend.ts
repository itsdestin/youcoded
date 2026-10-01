// useBlockedSend — App's refusal of a send, and the toast that says why.
//
// WHY its own hook: every automated PTY writer in App (guardedPtySend, the
// permission chip's Shift+Tab, InputBar's refused sends) asks the same gate —
// pending cards first, then the live screen (pty-input-gate.ts sendBlock) —
// and shows the same toast (utils/blocked-send-toast.ts). Kept out of App.tsx,
// which is over its line budget.
import { useCallback, useRef } from 'react';
import type { SessionChatState } from '../state/chat-types';
import { sendBlock, pendingCardRef } from '../state/pty-input-gate';
import { blockedSendToast, type BlockedSendToast } from '../utils/blocked-send-toast';

export type SendBlock = NonNullable<ReturnType<typeof sendBlock>>;

interface Io {
  /** Shows the toast (null clears it). */
  showToast: (toast: BlockedSendToast | null) => void;
  /** Switches a session to terminal view. */
  openTerminal: (sessionId: string) => void;
  /** The current chat state, read at the moment of the send. */
  chatState: { current: Map<string, SessionChatState> };
}

export function useBlockedSend(io: Io) {
  // Latest callbacks without re-creating the returned functions every render.
  const ioRef = useRef(io);
  ioRef.current = io;

  /** The refusal toast for `block`; `retry` (InputBar's sends) adds Send anyway. */
  const showBlockedSend = useCallback((sid: string, block: SendBlock, retry?: () => void) => {
    const { showToast, openTerminal, chatState } = ioRef.current;
    showToast(blockedSendToast(block, pendingCardRef(chatState.current.get(sid)), {
      dismiss: () => ioRef.current.showToast(null), retry,
      openTerminal: () => openTerminal(sid),
    }));
  }, []);

  /** True (and the toast shown) when a send to `sid` must not happen now. */
  const notifyIfPtyBlocked = useCallback((sid: string): boolean => {
    const block = sendBlock(ioRef.current.chatState.current.get(sid), sid);
    if (block) showBlockedSend(sid, block);
    return !!block;
  }, [showBlockedSend]);

  return { showBlockedSend, notifyIfPtyBlocked };
}
