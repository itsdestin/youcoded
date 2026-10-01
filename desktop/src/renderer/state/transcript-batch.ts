// The transcript batcher, as a module with an on-demand flush.
//
// WHY this is a module and not a closure inside App's effect (remote access batch 2, design §1): the window batches transcript actions
// into animation frames (a 16 ms timer when hidden), and something outside App's effect has to apply the pending batch on demand. Today
// that is a fill (state/session-fill.ts): the events it plays as `before` must LAND before the page does, so it flushes between them
// (one-core R5-2). A closure inside App cannot be reached from there; a module can. (The remote snapshot exporter, the other caller this
// existed for, is gone with the snapshot.)
import type { ChatAction } from './chat-types';
import { eventToAction } from './transcript-event-actions';
import type { TranscriptEvent } from '../../shared/types';
import type { SessionLive } from '../../shared/session-live-types';

// The whole frame's actions in one call, in arrival order. WHY an array
// (2026-09-16 A4): the store applies them one by one but notifies its
// subscribers once for the batch — see ChatStore.dispatchMany.
type DispatchBatch = (actions: ChatAction[]) => void;

/** What the main window's transcript listener needs from the outside. */
export interface TranscriptRouteDeps {
  /** The frame batcher every transcript action goes through. */
  batcher: Pick<TranscriptBatcher, 'push'>;
  /** Did THIS window just run /compact? Read only when a compaction arrives. */
  compactionPending(sessionId: string): boolean;
  /** Claude Code's statusline reading of the context window, or null. Same laziness. */
  fallbackContextTokens(sessionId: string): number | null;
}

/**
 * The backup compaction signal: Claude Code rewrote or shortened the transcript file.
 * Only a window waiting on /compact acts on it.
 *
 * WHY it goes through the batcher too (R4-3 review): a `compact-summary` event still
 * waiting in the frame batch carries the marker's summary and freed-token figure. A
 * shrink that dispatched straight to the store landed FIRST, cleared `compactionPending`,
 * and the queued summary was then dropped as stale: a marker with no summary. In the
 * batch the reducer sees both in arrival order and keeps the first, the real one.
 */
export function routeTranscriptShrink(payload: { sessionId?: string } | null | undefined, deps: TranscriptRouteDeps): void {
  const sessionId = payload?.sessionId;
  if (!sessionId) return;
  if (!deps.compactionPending(sessionId)) return; // /clear or unrelated shrink — ignore
  deps.batcher.push({
    type: 'COMPACTION_COMPLETE',
    sessionId,
    markerId: `compact-done-${Date.now()}`,
    afterContextTokens: deps.fallbackContextTokens(sessionId),
  });
}

/**
 * One live transcript event, from the wire to the frame batch, in arrival order.
 *
 * WHY every action goes through the batcher (R4-3, Destin 2026-10-01): four types
 * (skill card, /clear, history rewrite, compaction marker) used to be dispatched
 * straight to the store while everything else waited for the next frame, so a
 * message and a /clear that arrived in the same frame were applied clear-first:
 * the message then drew BELOW the "Conversation cleared" line, as if sent after
 * it. Nothing recorded a reason for the split; those cases were simply written
 * as plain dispatches next to the batched ones. Read-after-write was checked: the
 * only state the listener reads is `compactionPending`, via a render-lagged ref
 * that a direct dispatch did not refresh any sooner than a batched one does.
 *
 * Extracted from App's listener so a test can pin it: App cannot be mounted in a
 * test, and a loop left inline had nothing that would fail if the routing changed.
 */
export function routeTranscriptEvent(event: TranscriptEvent, deps: TranscriptRouteDeps): void {
  // Only a compaction reads window state, so only it pays for the lookups.
  const compacting = event.type === 'compact-summary';
  const actions = eventToAction(event, {
    live: true,
    compactionPending: compacting ? deps.compactionPending(event.sessionId) : undefined,
    fallbackContextTokens: compacting ? deps.fallbackContextTokens(event.sessionId) : undefined,
  });
  for (const action of actions) deps.batcher.push(action);
}

/**
 * One shared line or live fact from the computer's record (`session:live`), turned into reducer actions and sent through the SAME frame batcher
 * as transcript events (one-core R5-4a).
 *
 * WHY the batcher and not a plain dispatch: a divider or a queue change is numbered AFTER the transcript events before it, and a plain dispatch
 * would land ahead of those still waiting for their frame, drawing "Conversation cleared" above the message sent just before it. This is
 * the same ordering rule `routeTranscriptEvent` keeps (R4-3).
 *
 * WHY every screen runs this and none infers the same thing itself: see shared/session-live-types.ts. The compaction spinner takes the context
 * size from THIS screen's own status reading, the figure the typing screen used to capture, so the finished note can say what was freed.
 */
export function routeSessionLive(live: SessionLive, deps: { batcher: Pick<TranscriptBatcher, 'push'>; contextTokens(sessionId: string): number | null; now?: () => number }): void {
  const { sessionId } = live;
  const now = deps.now ?? Date.now;
  switch (live.kind) {
    case 'queue':
      deps.batcher.push({ type: 'QUEUE_SYNCED', sessionId, queue: live.queue });
      return;
    case 'model':
      deps.batcher.push({ type: 'MODEL_ANNOUNCED', sessionId, model: live.model });
      return;
    case 'model-switch':
      deps.batcher.push({ type: 'MODEL_SWITCH_MARKER', sessionId, markerId: live.id, timestamp: now(), label: live.label });
      return;
    case 'clear':
      deps.batcher.push({ type: 'CLEAR_TIMELINE', sessionId, markerId: live.id, timestamp: now() });
      return;
    case 'compact-start':
      deps.batcher.push({ type: 'COMPACTION_PENDING', sessionId, cardId: live.id, beforeContextTokens: deps.contextTokens(sessionId) });
      return;
    case 'compact-end':
      // A stop drops the spinner quietly ("Compaction may have failed" would be false after a Stop); anything else leaves the failed note.
      deps.batcher.push(live.outcome === 'cancelled'
        ? { type: 'COMPACTION_CANCELLED', sessionId }
        : { type: 'COMPACTION_COMPLETE', sessionId, markerId: `compact-end-${live.id}`, afterContextTokens: null, aborted: true });
      return;
    case 'prompt-show':
      deps.batcher.push({
        type: 'SHOW_PROMPT', sessionId, promptId: live.promptId, title: live.title, description: live.description,
        buttons: live.buttons as never, defaultIndex: live.defaultIndex,
      });
      return;
    case 'prompt-dismiss':
      deps.batcher.push({ type: 'DISMISS_PROMPT', sessionId, promptId: live.promptId });
      return;
  }
}

export interface TranscriptBatcher {
  /** Queue an action for the next frame (or the next 16 ms while hidden). */
  push(action: ChatAction): void;
  /** Apply everything queued, now, synchronously. Safe to call at any time. */
  flush(): void;
  /** Stop scheduling; anything still queued is dropped (the effect is gone). */
  dispose(): void;
}

// The one live batcher. App installs it in its transcript effect and disposes
// it on cleanup; a StrictMode double mount installs, disposes, installs again,
// so the module always points at the batcher whose dispatch is current.
let active: TranscriptBatcher | null = null;

export function installTranscriptBatcher(dispatch: DispatchBatch): TranscriptBatcher {
  const pending: ChatAction[] = [];
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearScheduled() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    if (timerId !== null) { clearTimeout(timerId); timerId = null; }
  }

  function flush() {
    clearScheduled();
    if (disposed) return;
    const batch = pending.splice(0);
    // One call for the frame: the store applies every action in order and
    // notifies subscribers once (React already coalesced the render).
    if (batch.length > 0) dispatch(batch);
  }

  function push(action: ChatAction) {
    // A push after dispose (a transcript event racing the effect's cleanup) must not
    // arm a frame whose flush would only no-op — the batch is gone with the effect.
    if (disposed) return;
    pending.push(action);
    if (rafId !== null || timerId !== null) return;
    // Hidden-window caveat: Electron suspends requestAnimationFrame while the
    // window is minimized/occluded, which used to FREEZE chat state (queued
    // actions never flushed) while wall-clock timers kept firing — the 8s
    // submit-retry then evaluated its idle gate against stale state and could
    // send a stray \r into the PTY. While hidden we batch on a 16ms timeout
    // instead: same batching cost, but state keeps advancing.
    if (document.visibilityState === 'hidden') {
      timerId = setTimeout(flush, 16);
    } else {
      rafId = requestAnimationFrame(flush);
    }
  }

  // If the window hides while an rAF flush is pending, that rAF may never
  // fire — hand the pending batch to a timeout so it can't strand.
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden' && rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      if (timerId === null) timerId = setTimeout(flush, 16);
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange);

  const batcher: TranscriptBatcher = {
    push,
    flush,
    dispose() {
      disposed = true;
      clearScheduled();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (active === batcher) active = null;
    },
  };
  active = batcher;
  return batcher;
}

/** Apply every transcript action still waiting for its frame. No-op when no
 *  batcher is installed (a test, or a window whose App has not mounted). */
export function flushTranscriptActions(): void {
  active?.flush();
}

