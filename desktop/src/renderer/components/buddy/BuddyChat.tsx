import { useEffect, useRef, useState } from 'react';
import type { AttentionSummary } from '../../../shared/types';
import InputBar from '../InputBar';
import { SessionPill } from './SessionPill';
import { BubbleFeed } from './BubbleFeed';
import { AttentionStrip } from './AttentionStrip';

/**
 * Compact chat surface rendered inside the buddy chat BrowserWindow.
 * Shell composition only — bubble feed, input, and attention strip are
 * placeholders replaced by E3–E5.
 *
 * Session management:
 * - Mount effect picks up the session main already selected (or falls back to
 *   the leader window's first session), subscribes, and requests replay.
 * - Churn effect unsubscribes the previous session when the user switches.
 * - Unmount cleanup in the mount effect handles the active session on close.
 * - attentionSummary is hoisted here so both SessionPill and (future)
 *   AttentionStrip consume the same subscription.
 */
export function BuddyChat() {
  const [viewedSession, setViewedSession] = useState<string | null>(null);
  const [attentionSummary, setAttentionSummary] = useState<AttentionSummary | null>(null);

  // Subscribe to the global attention summary pushed by main. The unsub
  // function returned by onAttentionSummary is used directly as the cleanup.
  useEffect(() => {
    const unsub = window.claude.buddy?.onAttentionSummary?.(setAttentionSummary);
    return unsub;
  }, []);

  // Mount effect: pick the session to view. Prefer whatever main already
  // recorded for this buddy window; fall back to the leader window's first
  // session, then any first session in the directory.
  useEffect(() => {
    let cancelled = false;
    let subscribedId: string | null = null;
    (async () => {
      let sid = await window.claude.buddy?.getViewedSession?.() ?? null;
      if (!sid) {
        const dir = await window.claude.detach.getDirectory();
        // Use leaderWindowId to find the leader's first session.
        // Fall back to whatever first session the directory has.
        const leaderEntry = dir?.windows?.find?.((entry: any) => entry.window?.id === dir.leaderWindowId);
        sid = leaderEntry?.sessions?.[0]?.id
          ?? dir?.windows?.[0]?.sessions?.[0]?.id
          ?? null;
        // Persist the choice so reopening the chat picks the same session.
        if (sid) await window.claude.buddy.setSession(sid);
      }
      if (cancelled) return;
      setViewedSession(sid);
      if (sid) {
        window.claude.buddy.subscribe(sid);
        window.claude.detach.requestTranscriptReplay(sid);
        subscribedId = sid;
      }
    })();
    return () => {
      cancelled = true;
      // Release main's subscription record when this component unmounts
      // (buddy window close, or React strict-mode double-mount). Without
      // this, session events would keep flowing to a destroyed webContents.
      if (subscribedId) window.claude.buddy?.unsubscribe?.(subscribedId);
    };
  }, []);

  // Churn effect: when the user switches sessions via SessionPill, unsubscribe
  // the previous one. Does NOT return a cleanup — the mount effect above owns
  // unmount cleanup for the active subscription, preventing double-unsubscribe.
  const prevSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionRef.current;
    if (prev && prev !== viewedSession) {
      window.claude.buddy?.unsubscribe?.(prev);
    }
    prevSessionRef.current = viewedSession;
  }, [viewedSession]);

  // Close the chat window on Escape.
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
      <SessionPill
        viewedSessionId={viewedSession}
        onChange={setViewedSession}
        attentionSummary={attentionSummary}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <BubbleFeed sessionId={viewedSession} />
      </div>
      {viewedSession ? (
        <InputBar sessionId={viewedSession} compact />
      ) : null}
      <AttentionStrip sessionId={viewedSession} summary={attentionSummary} />
    </div>
  );
}
