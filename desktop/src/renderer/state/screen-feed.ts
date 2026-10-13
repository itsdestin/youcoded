// The two live listeners every chat screen runs, written ONCE: the transcript stream and the computer's `session:live` pushes.
//
// WHY one module (sync-fix6, Destin 2026-10-04: the floating buddy's chat must show the same lines as the main window): the main window
// (App.tsx) and the buddy (BubbleFeed.tsx) each wired their own `transcript:event` and `session:live` listeners, and the buddy added a typed
// ledger (`BUDDY_LIVE`) of event types it skipped. Three of them (a /clear, an interrupt, the skill card) were gaps nobody had decided on, and
// any wiring written twice can drift again. Both screens now attach through these two functions, so the translation (`eventToAction`), the
// routing and batching (`routeTranscriptEvent`) and the host's lines (`applySessionLive`) are literally the same code. What is genuinely a
// screen's own (the main window's statusline reading, the buddy's one-session filter) arrives as a dependency with its own WHY at the call site.
import type { TranscriptEvent } from '../../shared/types';
import { routeTranscriptEvent, type TranscriptRouteDeps } from './transcript-batch';
import { applySessionLive, type SessionLiveDeps } from './apply-session-live';

export interface TranscriptFeedDeps extends TranscriptRouteDeps {
  /** Only this session's events (the buddy watches one conversation). Omitted = every session (the main window). */
  only?: string | null;
  /** A live event for a session proves main can read its transcript: re-ask a first page that failed (first-page-loader.ts). */
  onLiveActivity(sessionId: string): void;
}

/** Listen to the transcript stream; returns the unsubscribe (a no-op where the host has no such channel). */
export function attachTranscriptFeed(deps: TranscriptFeedDeps): () => void {
  const handler = window.claude.on.transcriptEvent?.((event: TranscriptEvent) => {
    if (!event?.type || !event?.sessionId) return;
    if (deps.only && event.sessionId !== deps.only) return;
    deps.onLiveActivity(event.sessionId);
    routeTranscriptEvent(event, deps);
  });
  return () => { if (handler) window.claude.off('transcript:event', handler); };
}

/** Listen to the computer's shared lines and live facts (`session:live`); returns the unsubscribe. */
export function attachSessionLiveFeed(deps: SessionLiveDeps & { only?: string | null }): () => void {
  const off = window.claude.on.sessionLive?.((live) => {
    if (deps.only && live?.sessionId !== deps.only) return;
    applySessionLive(live, deps);
  });
  return () => { if (typeof off === 'function') off(); };
}
