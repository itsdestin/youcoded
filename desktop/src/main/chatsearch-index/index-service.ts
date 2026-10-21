/**
 * chatsearch — module singleton + lifecycle, matching tag-registry-service.ts's
 * shape (module-level state, start/stop free functions, no class).
 *
 * Refresh triggers: app start, session quiesce, and any in-app metadata change.
 * The last one is load-bearing — without it a tag applied in the app UI would be
 * invisible to the CLI until the next launch.
 */

import os from 'node:os';
import { getConversationStore, onConversationMetaChanged } from '../conversations/service';
import { getTagRegistry } from '../conversations/tag-registry-service';
import { perfMark } from '../perf-marks';
import { createIndexWorkerRunner } from './index-worker-runner';

// Preserve the tested IO-core API without pulling the live service into workers.
export { refreshChatsearchIndex, resolveTranscriptPathTwoStep } from './refresh-core';

/** Coalesce bursts of metadata changes into one refresh. */
const META_DEBOUNCE_MS = 3_000;

let started = false;
let debounceTimer: NodeJS.Timeout | null = null;
let unsubscribeMeta: (() => void) | null = null;
let inFlight = false;
// Set when a trigger arrives while a cycle is already running — see the WHY
// comment at its check in refreshFromLiveState below.
let pendingRerun = false;

let generation = 0;
const runner = createIndexWorkerRunner({ onIdle: () => {
  // WHY only exit frees the writer slot: terminate may wait on filesystem IO.
  if (started && pendingRerun && !inFlight) {
    pendingRerun = false;
    void refreshFromLiveState();
  }
} });

/** Gather live inputs from the store + tag registry and run one cycle. */
async function refreshFromLiveState(): Promise<void> {
  if (!started) return;
  if (inFlight || runner.busy()) {
    // WHY remember instead of dropping: the 3s debounce only coalesces BURSTS
    // of triggers before it fires. Once fired, a cycle can legitimately run
    // longer than 3s (a large history, a slow disk) — a trigger that lands
    // during that window used to just no-op here, so a tag/note applied mid-
    // cycle stayed invisible to the CLI until the next session-end or
    // app-launch refresh, all while refreshedAt kept reporting the index as
    // current. Recording it and running one more cycle once this one finishes
    // (see the finally block below) closes that gap without a second
    // concurrent cycle racing the same build lock.
    pendingRerun = true;
    return;
  }
  const store = getConversationStore();
  if (!store) return; // store unavailable this launch — nothing to index

  inFlight = true;
  const cycle = generation;
  // WHY: the index build walks every conversation; the startup perf marks
  // need to see whether it overlaps the Resume scan and the slug repair.
  perfMark('bg:chatsearch-refresh:start');
  try {
    // WHY even tags are roots-only: registry.list() synchronously reads, parses
    // and folds every tag file despite its async signature. Do that in worker.
    let tagsRoot: string | null = null;
    try { tagsRoot = getTagRegistry()?.root() ?? null; }
    catch { /* unavailable registry degrades to unlabeled tags */ }

    // WHY roots only: list(), path checks, parsing, and metadata writes all grow
    // with history. Async wrappers around synchronous IO still freeze main.
    if (!started || cycle !== generation) return;
    await runner.run({ homeRoot: os.homedir(), storeRoot: store.root(), tagsRoot });
  } catch {
    // A failed refresh leaves the previous index in place. The next trigger
    // retries; a stale index is surfaced by the CLI's own age banner.
  } finally {
    perfMark('bg:chatsearch-refresh:done');
    inFlight = false;
    if (started && pendingRerun && !runner.busy()) {
      pendingRerun = false;
      void refreshFromLiveState();
    }
  }
}

/** Public trigger — safe to call from anywhere in main. Never throws. */
export function requestChatsearchRefresh(): void {
  if (!started) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void refreshFromLiveState(); }, META_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

export function startChatsearchIndex(): void {
  stopChatsearchIndex();
  started = true;
  unsubscribeMeta = onConversationMetaChanged(() => { requestChatsearchRefresh(); });
  // Startup scan is the load-bearing one: Claude Code sessions happen whether or
  // not the app is running, so the index is usually behind at launch.
  void refreshFromLiveState();
}

export function stopChatsearchIndex(): void {
  started = false;
  generation++;
  pendingRerun = false;
  runner.stop();
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  unsubscribeMeta?.();
  unsubscribeMeta = null;
}
