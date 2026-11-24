// ChatNoticeStrip — this chat's notice, in the strip above its message box.
//
// WHY the status strip (Destin, waiting-notice deck round 3, K-1 and K-3): the same thin band
// as "Connecting tools…" and the model download, so a notice about this chat sits where those
// already sit, never covers a message, and nothing new needs learning. Buttons follow his K-7
// note: Dismiss leftmost and outlined, the main action rightmost and filled.
import { useCallback, useSyncExternalStore } from 'react';
import { clearChatNotice, getChatNotice, subscribeChatNotice } from '../state/chat-notice-store';
import { StatusStrip } from './ui/StatusStrip';
import { Button } from './ui/Button';
import { ScreenMark } from '../shoot-mode';

export function ChatNoticeStrip({ sessionId }: { sessionId: string | null }) {
  const subscribe = useCallback((listener: () => void) => subscribeChatNotice(sessionId, listener), [sessionId]);
  const snapshot = useCallback(() => getChatNotice(sessionId), [sessionId]);
  const notice = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!notice || !sessionId) return null;
  const others = notice.actions ?? [];
  return (
    <div className="px-2 sm:px-3 pb-1.5" role="status" aria-live="polite">
      <ScreenMark name="chat/notice-strip" />
      <StatusStrip
        tone={notice.tone}
        action={
          <span className="flex items-center gap-1.5 shrink-0">
            <Button variant="secondary" size="sm" onClick={() => clearChatNotice(sessionId, notice.key)}>Dismiss</Button>
            {/* Outlined ones first, the filled main one last, whatever order the caller listed them in. */}
            {[...others.filter((a) => !a.primary), ...others.filter((a) => a.primary)].map((a) => (
              <Button key={a.label} variant={a.primary ? 'primary' : 'secondary'} size="sm" onClick={a.onClick}>{a.label}</Button>
            ))}
          </span>
        }
      >
        {notice.text}
      </StatusStrip>
    </div>
  );
}
