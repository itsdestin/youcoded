import { useEffect, useState } from 'react';

/**
 * Compact chat surface rendered inside the buddy chat BrowserWindow.
 * Shell composition only — the four regions (session pill, bubble feed,
 * input, attention strip) are placeholders replaced by E2–E5.
 *
 * Behavior: Escape closes the chat via buddy.toggleChat. On mount,
 * subscribes to whichever session main already selected for this buddy
 * (viewedSessionId, persisted in BuddyWindowManager).
 */
export function BuddyChat() {
  const [viewedSession, setViewedSession] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let subscribedId: string | null = null;
    window.claude.buddy?.getViewedSession?.().then((sid) => {
      if (cancelled) return;
      setViewedSession(sid);
      if (sid) {
        window.claude.buddy.subscribe(sid);
        subscribedId = sid;
      }
    });
    return () => {
      cancelled = true;
      // Release main's subscription record when this component unmounts
      // (buddy window close, or React strict-mode double-mount). Without
      // this, session events would keep flowing to a destroyed webContents.
      if (subscribedId) window.claude.buddy?.unsubscribe?.(subscribedId);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.claude.buddy?.toggleChat?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        padding: '12px 10px',
        gap: 10,
      }}
    >
      <SessionPillPlaceholder sessionId={viewedSession} />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <BubbleFeedPlaceholder sessionId={viewedSession} />
      </div>
      <InputBarPlaceholder sessionId={viewedSession} />
      <AttentionStripPlaceholder sessionId={viewedSession} />
    </div>
  );
}

// Placeholders — E2–E5 replace each with the real component.
function SessionPillPlaceholder({ sessionId }: { sessionId: string | null }) {
  return (
    <div
      className="layer-surface"
      style={{ padding: '7px 14px', alignSelf: 'center', borderRadius: 999, fontSize: 12 }}
    >
      {sessionId ?? 'no session'}
    </div>
  );
}

function BubbleFeedPlaceholder({ sessionId }: { sessionId: string | null }) {
  return <div style={{ color: 'var(--fg)' }}>bubble feed for {sessionId ?? '(none)'}</div>;
}

function InputBarPlaceholder({ sessionId: _sessionId }: { sessionId: string | null }) {
  return (
    <div
      className="layer-surface"
      style={{ padding: 8, borderRadius: 14 }}
    >
      input placeholder
    </div>
  );
}

function AttentionStripPlaceholder({ sessionId: _sessionId }: { sessionId: string | null }) {
  return null;
}
