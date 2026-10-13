// Deliverable auto-open (spec 2026-08-25 §3): when a SendUserFile result whose
// call asked for display:"render" arrives, open the file panel to the call's
// FIRST file — under seven guards, each an injected predicate so it is testable.
// React-free, fed raw transcript events by App.tsx exactly like
// artifact-tool-use-tracker.ts.
//
// WHY the freshness gate instead of a "replaying" flag: there is none. Opening
// an old conversation delivers every tool call it ever made through this same
// channel, and the session's `isThinking` toggles during that replay too. What
// IS reliable is when the result was RECORDED: native events keep their
// original `timestamp` through replay; Claude Code results carry the JSONL
// line's own time as `data.recordedAt` (transcript-watcher.ts), because the
// watcher's `timestamp` is stamped at parse time. A result older than
// FRESH_WINDOW_MS is history. And because a session switch replays the whole
// conversation, every honored toolUseId is remembered for the life of this
// renderer: the same result can never open twice, however fresh. What remains
// (spec §8): an app relaunch within a minute of a render result opens it once.
import type { TranscriptEvent } from '../../shared/types';

export const FRESH_WINDOW_MS = 60_000;
const PENDING_CAP = 200;
const HONORED_CAP = 500;

export interface DeliverableAutoOpenDeps {
  /** The focused conversation (App.tsx `sessionId` state). */
  getFocusedSessionId: () => string | null;
  /** Electron + wide viewport. False on Android, in a remote browser, and on narrow windows. */
  canAutoOpen: () => boolean;
  /** Runs `action` now, or behind the unsaved-edits dialog (guardDirtyEditor). */
  guard: (action: () => void) => void;
  /** Open a file in the panel by the same path a tile click takes. */
  open: (sessionId: string, path: string) => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface DeliverableAutoOpen {
  // WHY a TranscriptEvent, not `unknown` (M5): see the artifact tool-use tracker.
  handle: (event: TranscriptEvent) => void;
  dispose: () => void;
}

export function createDeliverableAutoOpen(deps: DeliverableAutoOpenDeps): DeliverableAutoOpen {
  const now = deps.now ?? (() => Date.now());
  // render-requesting calls, keyed by toolUseId — the result carries no input.
  const pending = new Map<string, { sessionId: string; firstFile: string }>();
  // Sessions that already auto-opened in their current reply; a user message
  // (both runtimes emit one at every turn start) opens the next slot.
  const openedThisReply = new Set<string>();
  // toolUseIds already honored — insertion-ordered so the cap evicts oldest.
  const honored = new Set<string>();
  let disposed = false;

  const handle = (event: TranscriptEvent) => {
    if (disposed) return;
    if (!event?.type || !event.sessionId) return;

    if (event.type === 'user-message') { openedThisReply.delete(event.sessionId); return; }

    if (event.type === 'tool-use') {
      if (event.data?.toolName !== 'SendUserFile') return;
      const id = event.data.toolUseId;
      const input = event.data.toolInput ?? {};
      if (!id || input.display !== 'render') return;           // #1 explicit render only
      const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
      if (!files.length) return;
      if (pending.size >= PENDING_CAP) pending.delete(pending.keys().next().value as string);
      pending.set(id, { sessionId: event.sessionId, firstFile: files[0] });
      return;
    }

    if (event.type !== 'tool-result') return;
    const id = event.data?.toolUseId;
    if (!id) return;
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    if (event.data?.isError) return;                            // nothing was sent
    const recordedAt = event.data?.recordedAt ?? event.timestamp ?? 0;
    if (now() - recordedAt > FRESH_WINDOW_MS) return;           // #4 history, not live
    if (honored.has(id)) return;                                // #7 already opened once (replay)
    if (!deps.canAutoOpen()) return;                            // #2
    if (deps.getFocusedSessionId() !== call.sessionId) return;  // #3
    if (openedThisReply.has(call.sessionId)) return;            // #5 one per reply
    openedThisReply.add(call.sessionId);
    if (honored.size >= HONORED_CAP) honored.delete(honored.values().next().value as string);
    honored.add(id);
    deps.guard(() => deps.open(call.sessionId, call.firstFile)); // #6 unsaved edits
  };

  return {
    handle,
    dispose: () => { disposed = true; pending.clear(); openedThisReply.clear(); honored.clear(); },
  };
}
