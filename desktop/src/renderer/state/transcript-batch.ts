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
// The whole frame's actions in one call, in arrival order. WHY an array
// (2026-09-16 A4): the store applies them one by one but notifies its
// subscribers once for the batch — see ChatStore.dispatchMany. applyChatHydrate
// below still takes the single-action Dispatch: a hydrate is one action.
type DispatchBatch = (actions: ChatAction[]) => void;

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

/**
 * How many times a second streamed text may redraw the chat, at most. PRODUCT TRADE-OFF — the owner may tune this.
 *
 * WHY (2026-10-04, perf fix 5): "one redraw per screen frame" means a different amount of work on every display.
 * A 60 Hz screen redraws (re-reads the live paragraph, lays out, repaints) ~60 times a second; a 180 Hz screen up
 * to 180, though text arrives at ~150 words/s at most and nobody can tell the difference past ~60 text updates a
 * second. Measured on the perf rig with the frame-rate limit lifted (a stand-in for a fast screen): 146 redraws/s
 * and the window's main thread 86% busy, against 60/s and ~45% at 60 Hz.
 * 60 means "no coarser than a 60 Hz screen already shows". Raise it (120) for smoother text on fast screens at
 * proportionally more work; `Infinity` restores one redraw per frame. Screens at or below 75 Hz are never throttled.
 */
const STREAM_REDRAW_TARGET_HZ = 60;
// Frame-period estimate: from the last FRAME_SAMPLES+1 consecutive frames this batcher saw (a gap of 40 ms or more,
// a pause between replies, starts the window over). Fewer than MIN_SAMPLES gaps, or any gap far from the median
// (variable-refresh displays, a rate change, a stalled frame, skipped frames), means "do not throttle".
const FRAME_SAMPLES = 8;
const MIN_SAMPLES = 5;
const QUIET_GAP_MS = 40;
// Keep watching frames for this long after the last words, so the estimate sees CONSECUTIVE frames (words arrive between
// frames at 150/s, so a callback armed only by a word would see every 2nd-3rd frame and learn a multiple of the period).
const WATCH_AFTER_WORDS_MS = 100;

export function installTranscriptBatcher(dispatch: DispatchBatch): TranscriptBatcher {
  const pending: ChatAction[] = [];
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // The frame time of the last frame-driven flush; null until the first (the first update after any quiet
  // spell is therefore never delayed).
  let lastFrameFlushAt: number | null = null;
  let stamps: number[] = [];
  let lastWordsFrameAt = -Infinity;

  /** Learn the display's frame period from the frames this batcher is called on. */
  function observeFrame(frameTime: number) {
    const prev = stamps[stamps.length - 1];
    if (prev !== undefined && (frameTime - prev <= 0 || frameTime - prev >= QUIET_GAP_MS)) stamps = [];
    stamps.push(frameTime);
    if (stamps.length > FRAME_SAMPLES + 1) stamps.shift();
  }

  /**
   * Flush on every k-th frame, k = floor(frames per target interval): <= 75 Hz -> 1, 90/100 -> 1, 120/144/165 -> 2,
   * 180 -> 3, 240 -> 4, 360 -> 6, so the step is never above one target interval (16.7 ms at 60) plus jitter.
   * Returns null when there is no trustworthy estimate (then every frame flushes).
   */
  function throttle(): { k: number; period: number } | null {
    if (stamps.length < MIN_SAMPLES + 1) return null;
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
    // Every gap must be near the median: jitter is tolerated, a mix of rates or a skipped frame is not.
    if (gaps.some((g) => Math.abs(g - median) > Math.max(0.35 * median, 3.2))) return null;
    // WHY first-to-last, not the median or mean of the gaps: timestamp jitter cancels at the two ends, so the
    // estimate is stable even where 1000/(target*period) sits exactly on a whole number (120, 180, 240, 360 Hz).
    const period = (stamps[stamps.length - 1] - stamps[0]) / gaps.length;
    const k = Math.max(1, Math.floor(1000 / (STREAM_REDRAW_TARGET_HZ * period) + 0.05));
    return k > 1 ? { k, period } : null;
  }

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
      rafId = requestAnimationFrame(onFrame);
    }
  }

  // The frame-driven flush. WHY the frame's own timestamp (not performance.now()): it is the vsync time the browser
  // hands every callback of the frame, so on a fast screen consecutive frames differ by exactly the display's
  // period. A caller that passes no timestamp (a test firing frames by hand) is never throttled.
  function onFrame(frameTime?: number) {
    rafId = null;
    if (disposed) return;
    if (typeof frameTime === 'number') {
      observeFrame(frameTime);
      if (pending.length === 0) {
        // Nothing to draw: only keep watching, for a short while after the last words, then stop (no idle frame loop).
        if (frameTime - lastWordsFrameAt < WATCH_AFTER_WORDS_MS) rafId = requestAnimationFrame(onFrame);
        return;
      }
      lastWordsFrameAt = frameTime;
      const t = throttle();
      // Wait until (k - 0.5) periods have passed since the last redraw: the half period absorbs timestamp jitter, so
      // a frame a hair early is not skipped (which would double the step).
      if (t && lastFrameFlushAt !== null && frameTime >= lastFrameFlushAt
          && frameTime - lastFrameFlushAt < (t.k - 0.5) * t.period) {
        // Too soon after the last redraw: keep the queue, look again next frame. Actions are only delayed, never
        // reordered or dropped, and flush() (hook events, snapshots) still applies them at once.
        rafId = requestAnimationFrame(onFrame);
        return;
      }
      lastFrameFlushAt = frameTime;
      flush();
      // Keep watching the next frames (see WATCH_AFTER_WORDS_MS); a word pushed meanwhile finds this already armed.
      if (!disposed && rafId === null && timerId === null) rafId = requestAnimationFrame(onFrame);
      return;
    }
    flush();
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
