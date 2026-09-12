// The transcript batcher, as a module with an on-demand flush.
//
// WHY this is a module and not a closure inside App's effect (remote access
// batch 2, design §1 "the cut line"): main hands each transcript event to the
// owning window and broadcasts it to remote clients in the SAME synchronous
// handler, and a snapshot request travels the same ordered channel. So by the
// time `chat:export-snapshot` reaches the desktop renderer, every event the
// host queued for the phone below its `snapshotIndex` has already been
// DELIVERED to this window — but not necessarily APPLIED, because the window
// batches transcript actions into animation frames (a 16 ms timer when
// hidden). The exporter used to serialize a render-lagged ref, so a delta that
// arrived in the frame before the request was missing from the snapshot and
// then applied on top of it — a message shown twice, or a turn ended twice.
//
// The fix is ordering, not dedup: the exporter calls `flushTranscriptActions()`
// and serializes the store synchronously afterwards, and the phone's hydrate
// handler flushes ITS pending batch before replacing state. With that, every
// event below the cut line is in the snapshot by construction (IPC order plus
// synchronous apply) and nothing above it is. A closure inside App cannot be
// reached from either caller; a module can.
//
// Pinned by tests/remote-snapshot-cut-line.test.tsx, which drives THIS batcher
// and the real exporter under jsdom — a test that fakes either cannot see the
// ordering it exists to guarantee.
import type { ChatAction, ChatState, SerializedChatState } from './chat-types';
import { keptByHydrate } from './chat-reducer';

type Dispatch = (action: ChatAction) => void;

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

export function installTranscriptBatcher(dispatch: Dispatch): TranscriptBatcher {
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
    // React 18 batches all synchronous dispatches → single render for the whole batch
    for (const action of batch) dispatch(action);
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

/**
 * The phone's side of the cut line: apply the pending batch FIRST, then replace
 * state with the host's copy. Every event the phone received before this
 * hydrate is already inside the snapshot (the host flushed the same way before
 * serializing), so applying them after the replace would apply them twice —
 * and a stale turn-complete would end the turn the snapshot shows in flight.
 */
export function applyChatHydrate(dispatch: Dispatch, snapshot: SerializedChatState, getState?: () => ChatState): string[] {
  // Presumes the host's per-client queue (remote-server.ts restoreClient): nothing
  // ABOVE the cut line reaches the phone before its hydrate, so flushing first can
  // only apply what the snapshot already holds — never drop something newer.

  flushTranscriptActions();
  // Which sessions this apply leaves as the phone's own copy, read from the state the
  // reducer is about to apply to — after the flush — with the reducer's own rule
  // (batch 2 §6: the shim shows "may be out of date" while any session is kept).
  const kept = getState ? keptByHydrate(getState(), snapshot) : [];
  dispatch({ type: 'HYDRATE_CHAT_STATE', sessions: snapshot });
  return kept;
}
