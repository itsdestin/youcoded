import { useEffect } from 'react';
import { useChatDispatch, useChatStore } from '../../state/chat-context';
import { applyHookEvent } from '../../state/hook-dispatcher';
import { createFirstPageLoader } from '../../state/first-page-loader';
import { attachTranscriptFeed, attachSessionLiveFeed } from '../../state/screen-feed';
import { installTranscriptBatcher, flushTranscriptActions } from '../../state/transcript-batch';

/**
 * Feeds the buddy window's own chat store for the ONE conversation it shows: the fill, the live transcript and
 * session-live feeds, asks, helper and background-command records. Moved unchanged out of the old BubbleFeed when the
 * buddy started drawing the main window's ChatView (buddy rebuild, 2026-10-25): in the main window App does this
 * wiring and ChatView only draws, so the buddy needs the same split. Drawing lives in ChatView; this only feeds.
 */
export function useBuddyFeed(sessionId: string | null): void {
  const dispatch = useChatDispatch();
  const store = useChatStore();

  // ── Transcript event subscription ─────────────────────────────────────────
  // The buddy window receives transcript:event IPC for the subscribed session
  // (WindowRegistry routes to owner + all subscribers). Wire them into the
  // shared reducer exactly as App.tsx does, but filtered to sessionId.
  useEffect(() => {
    if (!sessionId) return;

    // Bootstrap the reducer's per-session state entry. Every chat-reducer
    // handler that touches session state bails with `if (!session) return
    // state` when state.get(sessionId) is undefined — so without SESSION_INIT,
    // USER_PROMPT and every TRANSCRIPT_* event is silently dropped and the
    // bubble feed never populates. Main's App.tsx dispatches SESSION_INIT via
    // the sessionCreated listener and the session-list load; buddy has
    // neither, so we initialize on-demand here for the session being viewed.
    // SESSION_INIT is idempotent (no-op if already initialized).
    dispatch({ type: 'SESSION_INIT', sessionId });

    // The SAME frame batcher the main window uses (state/transcript-batch.ts), applied through the store's one-notification-per-frame path.
    // WHY not a local copy (sync-fix6): this file kept its own rAF queue, which had no hidden-window timer fallback and no way to flush from a
    // fill; the main window's batcher has both, and a second batcher is a second place for the ordering rule to rot.
    const batcher = installTranscriptBatcher(store.dispatchMany);
    let cancelled = false;

    // The fill: the SAME `session:open` the main window uses, asked for as this window (sync-fix3). WHY not a page request: a page holds only
    // what is on disk, so this feed missed everything the computer keeps in memory about the conversation: an ask raised before it looked
    // (the question never appeared here), the compaction spinner, a usage-limit or trust card, the queued-messages strip, the model and
    // "Conversation cleared" lines. The answer carries all of them, and is played back through the listeners below.
    const loader = createFirstPageLoader({
      open: async (req) => (window as any).claude.session.open(req),
      requestPage: async (req) => (window as any).claude?.detach?.requestTranscriptPage?.(req),
      dispatch: (action) => { if (!cancelled) dispatch(action); },
      flush: () => batcher.flush(),
      play: (pushes) => { if (!cancelled) (window as any).claude?.session?.play?.(pushes); },
    });

    // The same listener, translation and batching as the main window (state/screen-feed.ts); the buddy skips NO event type, so it draws the lines
    // the main window does for every chat (/clear, an interrupt, the skill card; Destin 2026-10-04). Its genuine differences, each its own reason:
    //  - `only`: this window watches ONE conversation;
    //  - no statusline fallback (`fallbackContextTokens: null`): a compaction marker's "after" figure comes from the event or is left out, because
    //    the buddy has no Claude Code statusline to read;
    //  - `compactionPending` reads this feed's own state (the ref), the same fact the main window reads from its chat map.
    const unsubTranscript = attachTranscriptFeed({
      batcher,
      only: sessionId,
      compactionPending: () => !!store.getSession(sessionId).compactionPending,
      fallbackContextTokens: () => null,
      onLiveActivity: (sid) => loader.noteLiveActivity(sid),
    });

    // The shared lines and live facts (compaction spinner, prompt cards, queue, model and clear dividers) through the SAME `session:live` feed as the
    // main window, with the pieces that only exist there (the status bar's context reading, the model chip, the send gates) left out.
    const unsubLive = attachSessionLiveFeed({
      only: sessionId,
      batcher,
      contextTokens: () => null,
      isNative: () => false,
      setChipModel: () => {},
      setSessionModel: () => {},
    });
    // The end of a fill lists the asks still open: any card not named was answered while this feed could not see it.
    const unsubReplayComplete = (window.claude.on as any).hookReplayComplete?.((p: { sessionId: string; pendingRequestIds: string[] }) => {
      if (p?.sessionId !== sessionId) return;
      dispatch({ type: 'PERMISSION_REPLAY_COMPLETE', sessionId, pendingRequestIds: Array.isArray(p.pendingRequestIds) ? p.pendingRequestIds : [] });
    });

    // Fill AFTER every listener is wired, so no live event can race past us (the answer is played through them). Perf cycle 2: this used
    // to be requestTranscriptReplay, which streamed the WHOLE transcript into the buddy's own reducer. The loader retries a page the
    // computer could not resolve yet (a just-resumed session) on the same terms as the main window (first-page-loader.ts).
    //
    // The buddy has no scroll-up sentinel this cycle: it is a glanceable recent
    // view, not a place to read back through a conversation.
    void loader.load(sessionId);
    // The computer says this window's fill never completed (its 30 s hold expired and the held pushes were dropped): fill again from a fresh page.
    const unsubRefill = (window as any).claude?.session?.onRefill?.((sid: string) => { if (sid === sessionId) void loader.refill(sessionId, { fresh: true }); });

    return () => {
      cancelled = true;
      batcher.dispose();
      unsubTranscript();
      unsubLive();
      if (typeof unsubReplayComplete === 'function') unsubReplayComplete();
      if (typeof unsubRefill === 'function') unsubRefill();
      // A fill still in flight is for a feed that is gone: forget it, so its answer is applied to nothing.
      loader.retainOnly(new Set());
    };
  }, [sessionId, dispatch, store]);

  // ── Hook event subscription (permissions only) ────────────────────────────
  // Permission requests from hook:event transition tool cards to approval
  // state via applyHookEvent (state/hook-dispatcher.ts, shared with App.tsx),
  // which maps PermissionRequest → PERMISSION_REQUEST and PermissionExpired →
  // PERMISSION_EXPIRED (all other hook types return null) and flushes this
  // window's transcript batch first — see that function's WHY.
  useEffect(() => {
    if (!sessionId) return;

    const unsubHook = window.claude.on.hookEvent((event: any) => {
      if (event?.sessionId !== sessionId) return;
      applyHookEvent(event, dispatch);
    });
    // Specialists 1c: delegation feed — MUST mirror App.tsx. Task 10: typed
    // bridge — on.specialistEvent returns the unsubscribe function directly,
    // and there is no separate 'note' event kind (a note rides on the run
    // record; SPECIALIST_RUN_CHANGED's reducer case derives the Activity row).
    const unsubSpecialist = window.claude.on.specialistEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.kind === 'run') {
        dispatch({ type: 'SPECIALIST_RUN_CHANGED', sessionId, run: event.run });
      }
    });

    // G-1: background command records — MUST mirror App.tsx, including the flush
    // (same drop class as the hook handler above: this dispatches immediately,
    // its card's own tool-use may still be queued in the batcher above).
    const unsubShell = window.claude.on.shellEvent((event) => {
      if (event.sessionId !== sessionId) return;
      flushTranscriptActions();
      dispatch({ type: 'SHELL_RUN_CHANGED', sessionId, run: event.run });
    });

    return () => {
      window.claude.off('hook:event', unsubHook);
      // Task 10 fix: unsubSpecialist IS the unsubscribe function, not a
      // listener for `.off()` — see the matching fix in App.tsx.
      unsubSpecialist();
      unsubShell();
    };
  }, [sessionId, dispatch]);
}
