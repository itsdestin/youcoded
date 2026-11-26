// ChatNoticeStrip — this chat's notice, in the strip above its message box.
//
// WHY the status strip (Destin, waiting-notice deck round 3, K-1 and K-3): the same thin band
// as "Connecting tools…" and the model download, so a notice about this chat sits where those
// already sit, never covers a message, and nothing new needs learning. Buttons follow his K-7
// note: Dismiss leftmost and outlined, the main action rightmost and filled.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { clearChatNotice, getChatNotice, recheckChatNotice, subscribeChatNotice, type ChatNotice } from '../state/chat-notice-store';
import { useOptionalChatStore } from '../state/chat-context';
import { subscribeScreenInputBlocks } from '../state/screen-input-store';
import { getCapabilities } from '../platform';
import { NoticeBand } from './NoticeBand';
import { ScreenMark } from '../shoot-mode';

/**
 * Takes the notice away the moment its reason is gone (`stillTrue`). It listens ONLY while a notice that has a
 * `stillTrue` is up — so an ordinary streamed reply with no notice showing costs this component nothing
 * (performance rules 2 and 3: no listener, no timer, and no re-render, since the check is a plain function
 * and never goes through render).
 */
function useNoticeRecheck(sessionId: string | null, notice: ChatNotice | undefined, chatVisible: boolean): void {
  const chatStore = useOptionalChatStore();
  const watching = !!notice?.stillTrue;
  const poll = !!notice?.recheckEverySecond;
  useEffect(() => {
    if (!sessionId || !watching) return;
    const check = () => { recheckChatNotice(sessionId); };
    check(); // the reason may already be gone (a chat opened after the pop-up closed)
    const offChat = chatStore?.subscribeSession(sessionId, check);
    const offScreen = subscribeScreenInputBlocks(check);
    // WHY the document.hidden skip: a window nobody can see has no one to show the change to (and the timer rule).
    // Only where the host reads terminal text itself, and only while this chat is the one on screen (review 2, S1).
    const timer = poll && chatVisible && !getCapabilities().sessionRecord ? setInterval(() => { if (!document.hidden) check(); }, 1000) : undefined;
    return () => { offChat?.(); offScreen(); if (timer) clearInterval(timer); };
  }, [sessionId, watching, poll, chatVisible, chatStore, notice?.key]);
}

// The visible body is its own component so the narrow-screen hook (inside NoticeBand) runs only while a notice is showing.
function NoticeBody({ sessionId, notice }: { sessionId: string; notice: ChatNotice }) {
  return (
    <NoticeBand
      className="px-2 sm:px-3 pb-1.5"
      mark={<ScreenMark name="chat/notice-strip" />}
      tone={notice.tone}
      text={notice.text}
      onDismiss={() => clearChatNotice(sessionId, notice.key)}
      actions={notice.actions}
    />
  );
}

export function ChatNoticeStrip({ sessionId, chatVisible = true }: { sessionId: string | null; chatVisible?: boolean }) {
  const subscribe = useCallback((listener: () => void) => subscribeChatNotice(sessionId, listener), [sessionId]);
  const snapshot = useCallback(() => getChatNotice(sessionId), [sessionId]);
  const notice = useSyncExternalStore(subscribe, snapshot, snapshot);
  useNoticeRecheck(sessionId, notice, chatVisible);
  if (!notice || !sessionId) return null;
  return <NoticeBody sessionId={sessionId} notice={notice} />;
}
