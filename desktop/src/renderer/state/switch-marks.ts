// SWITCH MARKS, page half (2026-10-05). The hitch recorder (main/preload.ts "Switch marks", main/hitch-recorder.ts) writes one
// `switch` line per session switch; this module is how the page TELLS it a switch happened, without adding anything to
// window.claude (that bridge is shared with Android/remote) and without sending anything over IPC itself.
//
// HOW: a DOM CustomEvent on `document`. The sandboxed preload shares the page's DOM but not its JS world, so the detail is a
// JSON STRING of enums/ints (+ the session id, used by the preload only to find the pane in memory — never written anywhere).
// Nothing here runs between switches; a switch costs one small JSON string and one dispatch.
//
//   noteSwitchIntent(cause, event?)  — called where the USER asks for a switch (pill, menu row, key). Remembers the cause and the
//                                      input event's own timeStamp (performance.now() clock) so the clock starts at the input.
//   announceSwitch(...)              — called once per change of the active session (App's layout effect). Consumes the intent.
//   noteTerminalShown(chars, parsed) — called by a terminal that just became visible (child layout effects run BEFORE the App's, so
//                                      it is parked for the same commit and picked up by announceSwitch).
//   announceNoSession()              — the last session went away (ends a switch still in flight).
//
// Guard: tests/switch-marks.test.ts.
export type SwitchCause = 'pill' | 'menu' | 'key' | 'drawer' | 'auto' | 'other';

/** An input older than this is not the cause of THIS switch (e.g. a click on the already-active pill, or a switch deferred behind a dialog). */
const INTENT_FRESH_MS = 5000;

let intent: { cause: SwitchCause; t: number } | null = null;
let seq = 0;
let parkedTerminal: { chars: number; whenParsed: (cb: () => void) => void } | null = null;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The user asked to switch. `ev` is the input event when the caller has one; its timeStamp is the start of the clock. */
export function noteSwitchIntent(cause: SwitchCause, ev?: { timeStamp?: number } | null): void {
  const stamp = ev && typeof ev.timeStamp === 'number' && isFinite(ev.timeStamp) && ev.timeStamp > 0 ? ev.timeStamp : now();
  intent = { cause, t: stamp };
}

function emit(name: string, detail: Record<string, unknown>): void {
  try {
    if (typeof document === 'undefined' || typeof CustomEvent !== 'function') return;
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail) }));
  } catch { /* instrumentation never throws into the app */ }
}

export interface SwitchInfo {
  sessionId: string;
  /** False for a first selection (null -> a session): remembered as visited, but not a switch anyone waited on. */
  record: boolean;
  viewMode: 'chat' | 'terminal';
  kind: 'claude' | 'native' | 'shell';
  streaming: boolean;
  sessionCount: number;
}

/** Called once per change of the active session. */
export function announceSwitch(i: SwitchInfo): void {
  const fresh = intent && now() - intent.t <= INTENT_FRESH_MS ? intent : null;
  intent = null; // consumed: a later switch with no input of its own is "auto", never this click again
  const term = parkedTerminal;
  parkedTerminal = null;
  const q = ++seq;
  emit('yc:switch', {
    q, r: i.record ? 1 : 0, id: i.sessionId, vm: i.viewMode, k: i.kind, s: i.streaming ? 1 : 0, n: i.sessionCount,
    c: fresh ? fresh.cause : 'auto', ...(fresh ? { t: fresh.t } : {}),
    ...(i.viewMode === 'terminal' && term ? { dr: term.chars } : {}),
  });
  // Terminal view: xterm draws on a canvas, so the preload cannot watch the DOM for "done". An empty write is queued BEHIND the
  // backlog the show just drained; its callback runs when xterm has parsed all of it.
  if (i.record && i.viewMode === 'terminal' && term) term.whenParsed(() => emit('yc:switch-term', { q }));
}

/** The last session went away. */
export function announceNoSession(): void {
  intent = null;
  emit('yc:switch-none', {});
}

/** A terminal just became visible. `chars` = what its hidden backlog held before the show wrote it out. */
export function noteTerminalShown(chars: number, whenParsed: (cb: () => void) => void): void {
  parkedTerminal = { chars: Math.max(0, Math.round(chars)), whenParsed };
  // Layout effects of one commit all run synchronously, then this microtask: a show with no switch (the chat/terminal toggle) leaves nothing parked.
  const mine = parkedTerminal;
  queueMicrotask(() => { if (parkedTerminal === mine) parkedTerminal = null; });
}

/** Test seam. */
export function resetSwitchMarks(): void { intent = null; parkedTerminal = null; seq = 0; }
