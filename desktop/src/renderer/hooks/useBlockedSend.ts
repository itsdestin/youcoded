// useBlockedSend — App's refusal of a send, and the notice that says why.
//
// WHY its own hook: every automated PTY writer in App (guardedPtySend, the
// permission chip's Shift+Tab, InputBar's refused sends) asks the same gate —
// pending cards first, then the live screen (pty-input-gate.ts sendBlock) —
// and shows the same notice (utils/blocked-send-toast.ts). Kept out of App.tsx,
// which is over its line budget.
import { useCallback, useRef } from 'react';
import type { SessionChatState } from '../state/chat-types';
import { useChatStore } from '../state/chat-context';
import { sendBlock, pendingCardRef } from '../state/pty-input-gate';
import { clearChatNotice, showChatNotice } from '../state/chat-notice-store';
import { blockedSendNotice, blockedSendFloating, type BlockedSendToast } from '../utils/blocked-send-toast';

export type SendBlock = NonNullable<ReturnType<typeof sendBlock>>;

interface Io {
  /** Shows the short floating notice for a chat that is not on screen (null clears it). */
  showToast: (toast: BlockedSendToast | null) => void;
  /** Switches a session to terminal view. */
  openTerminal: (sessionId: string) => void;
  /** The current chat state, read at the moment of the send. */
  chatState: { current: Map<string, SessionChatState> };
  /** Is this chat the one whose message box is on screen right now? Default: yes. */
  isChatVisible?: (sessionId: string) => boolean;
  /** The chat's name, for the floating notice about a chat you are not in. */
  chatName?: (sessionId: string) => string | undefined;
}

export function useBlockedSend(io: Io) {
  // Latest callbacks without re-creating the returned functions every render.
  const ioRef = useRef(io);
  ioRef.current = io;
  const store = useChatStore();

  /** The refusal notice for `block` in that chat's strip; `retry` (InputBar's sends) adds Send anyway. */
  const showBlockedSend = useCallback((sid: string, block: SendBlock, retry?: () => void) => {
    const { showToast, openTerminal, chatState, isChatVisible, chatName } = ioRef.current;
    const notice = blockedSendNotice(block, pendingCardRef(chatState.current.get(sid)), {
      dismiss: () => clearChatNotice(sid, 'held'), retry,
      openTerminal: () => openTerminal(sid),
    });
    showChatNotice(sid, {
      ...notice,
      // WHY derived (review B3): it leaves by itself the moment the card is answered / the pop-up is gone, with
      // no send and no Dismiss. Read from the chat store (never a stale copy) so it is right at the instant asked.
      stillTrue: () => !!sendBlock(store.getSession(sid), sid),
      // Only a host that reads terminal text itself needs the 1 s re-check (see ChatNotice.recheckEverySecond).
      recheckEverySecond: true,
    });
    // WHY also a floating notice when that chat is not on screen (review 1, S3): its strip is invisible until
    // he switches there, and a refused background write must never be silent.
    if (isChatVisible && !isChatVisible(sid)) showToast(blockedSendFloating(chatName?.(sid)));
  }, [store]);

  /** True (and the notice shown) when a send to `sid` must not happen now. */
  const notifyIfPtyBlocked = useCallback((sid: string): boolean => {
    const block = sendBlock(ioRef.current.chatState.current.get(sid), sid);
    if (block) showBlockedSend(sid, block);
    return !!block;
  }, [showBlockedSend]);

  return { showBlockedSend, notifyIfPtyBlocked };
}
