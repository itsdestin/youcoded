// desktop/src/main/native-title-feeder.ts
//
// Auto-titles native-runtime sessions (Task 7 — M2 item 5). CC sessions get
// their title from the Auto-Title hook -> ~/.claude/topics -> the inline
// topic-watcher in ipc-handlers.ts (search `startWatching`). Native sessions
// have no such feed — the harness never writes to ~/.claude/topics — so this
// module generates a title itself: ONE bound-model call per session, fired at
// the first turn-complete, using the session's own first user message as
// context.
//
// WHY the title never touches the session JSONL: the native session file is
// single-writer append-only and its header is written once at session start
// and never rewritten (harness/session-store.ts). A title generated here
// lands ONLY through the injected `onTitle` effect — the conversation store
// (via noteTitleChanged) and the live SessionInfo.name (via the rename
// fan-out) — never in the file itself. Don't "fix" this into a header
// rewrite; it would break the single-writer invariant.
//
// WHY ordering doesn't matter here: this fires on the transcript-event EMIT
// for 'turn-complete', which happens before the JSONL append for that turn
// is guaranteed to have settled on disk. That race is irrelevant to this
// module specifically because the title write never reads or writes the
// session file — it only reads the in-memory firstUserText this feeder
// already captured from the SAME event stream.
//
// M6 hook: once capability tiers exist (Plan C's capability registry — NOT
// on master as of this task), skip below the floor instead of attempting.
// There is no floor gating today; every resolvable binding is attempted.
//
// Deps are all injected effects (see NativeTitleFeederDeps) so every one can
// be made to reject in tests — the #177 lesson (youcoded #177): a fake that
// cannot express failure certifies the bug it should have caught.

import { withChatGptRequest } from './providers/chatgpt-request-diagnostics';
import type { TranscriptEvent } from '../shared/types';
import type { ModelBinding } from '../shared/provider-types';

const MAX_ATTEMPTS = 3;
// Parity with harness/session-store.ts's DERIVED_TITLE_MAX — both are the
// same "short title" contract, just fed by different sources (CC-derived
// fallback title vs. this model-generated one).
const TITLE_MAX_LEN = 60;
const FIRST_MESSAGE_CHARS = 500;

export interface NativeTitleFeederDeps {
  /** Calls the bound model with the title prompt. Expected to reject on any
   *  provider/network/timeout failure — the feeder treats a rejection as a
   *  silent, retryable miss and never surfaces an error event to the UI.
   *  Callers are responsible for bounding this call (e.g. a 15s
   *  AbortSignal.timeout race) — a bare unbounded await here would hang the
   *  feeder the same way an unbounded compaction await hangs a turn. */
  generate: (binding: ModelBinding, prompt: string) => Promise<string>;
  /** The session's current model binding, or null when unresolved (session
   *  ended, provider removed mid-session, etc.) — an honest skip, not a
   *  throw, and NOT a consumed attempt. */
  getBinding: (sessionId: string) => ModelBinding | null;
  /** True if the session already has a real (non-placeholder) title —
   *  checked fresh on every turn-complete rather than cached, since this
   *  feeder's in-memory `done` flag doesn't survive an app restart but a
   *  title written by a previous run (or a future user-rename UI) does. */
  hasTitle: (sessionId: string) => Promise<boolean>;
  /** Writes the generated title through — both halves (store + live session
   *  name) are the caller's responsibility; this module only decides WHEN
   *  and WHAT to write. */
  onTitle: (sessionId: string, title: string) => Promise<void>;
}

interface SessionState {
  firstUserText?: string;
  attempts: number;
  done: boolean;
  // Synchronous re-entrancy guard (Task 7 review): true from the moment attempt()
  // begins until it settles. Two turn-complete events can arrive back-to-back
  // during a TAKEOVER or RESUME transition — the holder's final turn plus the
  // requester's replayed one, or a rapid interrupt→resume — and without this both
  // would pass the hasTitle/getBinding checks and each call generate + onTitle,
  // double-titling the session (and burning two of the three attempts at once).
  // Set BEFORE the first await so the second overlapping attempt short-circuits.
  inFlight: boolean;
}

export interface NativeTitleFeeder {
  /** Feed a native transcript event. Captures the first user-message text
   *  per session; attempts a title generation on turn-complete. */
  noteEvent: (ev: TranscriptEvent) => void;
  /** Drop a session's in-memory state (attempts counter, captured first
   *  message). Call on session destroy/exit so a reused/resumed session id
   *  starts clean and memory doesn't accumulate across the app's lifetime. */
  forget: (sessionId: string) => void;
}

// Strips a single layer of surrounding quotes, collapses newlines/whitespace
// runs into single spaces (a model reply must render as one line in the
// session pill / Resume Browser row), trims, and caps length. Returns '' for
// an empty/whitespace-only reply so the caller can treat it as a failed
// attempt rather than write a blank title.
function sanitizeTitle(raw: string): string {
  let t = (raw ?? '').trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      t = t.slice(1, -1).trim();
    }
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, TITLE_MAX_LEN);
}

export function createNativeTitleFeeder(deps: NativeTitleFeederDeps): NativeTitleFeeder {
  const sessions = new Map<string, SessionState>();

  function stateFor(sessionId: string): SessionState {
    let s = sessions.get(sessionId);
    if (!s) {
      s = { attempts: 0, done: false, inFlight: false };
      sessions.set(sessionId, s);
    }
    return s;
  }

  async function attempt(sessionId: string, state: SessionState): Promise<void> {
    // Re-entrancy guard (see SessionState.inFlight): a second turn-complete during
    // a takeover/resume transition must not run a concurrent generate + double-title.
    // Set synchronously BEFORE the first await; cleared in the finally so a failed
    // attempt still retries on the next turn-complete.
    if (state.inFlight) return;
    state.inFlight = true;
    try {
      // Re-check freshly rather than trusting a stale in-memory flag — see the
      // deps.hasTitle doc comment above for why.
      if (await deps.hasTitle(sessionId).catch(() => false)) {
        state.done = true;
        return;
      }

      const binding = deps.getBinding(sessionId);
      if (!binding) {
        // Honest skip: no binding to ask, so this isn't a "failed attempt" —
        // don't consume the attempts budget on a case the model was never
        // actually invoked for. Retried next turn-complete once a binding
        // exists (e.g. the user picks a model on a session that started
        // without one).
        return;
      }

      const firstMessage = (state.firstUserText ?? '').slice(0, FIRST_MESSAGE_CHARS);
      const prompt = `Reply with only a short 3-6 word title for this conversation. No quotes, no punctuation at the end.\n\nFirst message: ${firstMessage}`;

      state.attempts += 1;
      let raw: string;
      try {
        // WHY: title work shares the binding, never the conversation comparison baseline.
        raw = await withChatGptRequest(sessionId, 'title', () => deps.generate(binding, prompt));
      } catch {
        // Provider/timeout failure — stay silent, retry on the NEXT
        // turn-complete (bounded by MAX_ATTEMPTS above).
        return;
      }

      const title = sanitizeTitle(raw);
      if (!title) return; // empty/whitespace-only reply — treat as a failed attempt, retry later

      state.done = true;
      await deps.onTitle(sessionId, title);
    } finally {
      state.inFlight = false;
    }
  }

  return {
    noteEvent(ev: TranscriptEvent) {
      const state = stateFor(ev.sessionId);
      if (state.done) return;

      if (ev.type === 'user-message') {
        // Only the FIRST user message seeds the prompt — later messages in
        // the same session don't change what "the conversation is about"
        // for titling purposes, and re-capturing would let a long-running
        // session's title drift on every retry attempt.
        if (state.firstUserText === undefined) state.firstUserText = ev.data.text ?? '';
        return;
      }

      if (ev.type === 'turn-complete') {
        if (state.attempts >= MAX_ATTEMPTS) return;
        // Fire-and-forget: noteEvent is called synchronously from the
        // transcript-event listener and must never block it. Every path
        // inside attempt() is try/caught or a plain honest-skip return, so
        // there is no unhandled-rejection risk here.
        void attempt(ev.sessionId, state);
      }
    },
    forget(sessionId: string) {
      sessions.delete(sessionId);
    },
  };
}
