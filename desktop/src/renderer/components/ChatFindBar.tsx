import React from 'react';
import type { SessionChatState } from '../state/chat-types';
import { useChatMessageFind } from '../hooks/use-chat-message-find';
import { ContentFindBar } from './ContentFindBar';

interface Props {
  state: SessionChatState;
  sessionId: string;
  contentRef: React.RefObject<HTMLElement | null>;
  scrollRef: React.RefObject<HTMLElement | null>;
  getEntryEl: (key: string) => HTMLElement | undefined;
  revealAndPin: (key: string) => () => void;
  unfoldNearViewport: () => void;
  releaseStick: () => void;
  onClose: () => void;
}

/** WHY: closed Find must have no controller, effects, index or subscriptions.
 * Keeping its hook in ChatView ran it on every streamed word even while closed.
 * The conditional parent mounts this lifecycle only when the bar is requested. */
export function ChatFindBar({ state, sessionId, contentRef, scrollRef, getEntryEl,
  revealAndPin, unfoldNearViewport, releaseStick, onClose }: Props) {
  const chatFind = useChatMessageFind(
    state, true, contentRef, getEntryEl, revealAndPin, unfoldNearViewport, releaseStick,
  );
  return (
    <ContentFindBar
      layout="row"
      containerRef={contentRef}
      scrollRef={scrollRef}
      highlightName="chat-find"
      chatFind={chatFind}
      placeholder="Find in chat"
      resetKey={sessionId}
      onClose={onClose}
    />
  );
}
