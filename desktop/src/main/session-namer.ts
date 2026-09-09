// desktop/src/main/session-namer.ts
//
// The whole automatic-naming policy, in one place, for BOTH session lanes.
// Replaces native-title-feeder's one-shot-per-session rule with the approved
// behaviour: Off / Basic / AI, a name the user typed that automatic naming can
// never overwrite, and AI reviews at completed replies 1, 3, then every 25.
//
// WHAT COUNTS AS A REPLY: a transcript 'turn-complete' event. Both watchers
// emit it only when the model actually finished answering — the CC tailer
// requires `stop_reason !== 'tool_use'` — so a turn that ran twenty tools is
// one reply, which is what the settings copy promises.
//
// WHY the reply counter lives on disk and not just in memory: the schedule has
// to survive an app restart and a resume, and it has to merge across devices
// (max wins — a device that was closed for ten replies must not rewind it).
// Duplicate events are filtered by transcript uuid within a run, which is the
// case that actually occurs: a takeover/resume transition delivers the holder's
// final turn and the requester's replayed one back to back. Neither tailer
// re-emits history after a restart (both start at end-of-file), so the uuid set
// does not need to persist.
//
// EVERY effect is an injected dep, so each one can be made to fail in tests —
// the #177 lesson: a fake that cannot express failure certifies the bug it
// should have caught.
import type { TranscriptEvent } from '../shared/types';
import type { ModelBinding } from '../shared/provider-types';
import type { NamingPreferences } from './naming-settings';
import {
  NamingRecord, basicNameFrom, isReviewDue, sanitizeAutoName,
} from './conversations/naming-core';
import { isRealSessionName } from '../shared/session-title';

/** How many consecutive failed generations one scheduled review will spend
 *  before giving up and waiting for the next scheduled point. Without this an
 *  offline provider would be asked once per reply, forever. */
const MAX_ATTEMPTS = 3;
const FIRST_MESSAGE_CHARS = 500;
const RECENT_MESSAGE_CHARS = 300;
/** How many recent user messages the AI reviewer sees besides the opening one.
 *  Enough to notice the subject changed; small enough that the call stays cheap
 *  and can never become a transcript dump. */
const RECENT_MESSAGES = 3;

export interface SessionNamerDeps {
  /** Current preference. Read fresh on every decision — a change mid-turn
   *  must take effect on the next reply, not the next launch. */
  settings: () => NamingPreferences;
  /** Where this live session's ownership record lives, or null when the
   *  mapping is not known yet (a CC session before its first hook event).
   *  Null is an honest skip: nothing is counted and nothing is generated. */
  identify: (sessionId: string) => { provider: string; storeId: string } | null;
  readNaming: (provider: string, storeId: string) => Promise<NamingRecord | null>;
  mutateNaming: (
    provider: string, storeId: string, fn: (cur: NamingRecord) => NamingRecord,
  ) => Promise<NamingRecord>;
  /** The session's OWN model. Native sessions have one; Claude Code sessions
   *  do not — their model lives inside the CLI, which is why the CC lane falls
   *  back to askInSessionModel below instead of substituting a paid provider. */
  getBinding: (sessionId: string) => ModelBinding | null;
  generate: (binding: ModelBinding, prompt: string) => Promise<string>;
  /** Ask the conversation's own in-session model to write the name (the CC
   *  auto-title hook lane). Best-effort and free; used only when AI mode is on
   *  and no separate naming model was chosen. */
  askInSessionModel?: (sessionId: string, storeId: string) => void;
  /** The name on screen now — context for a review, and the thing a failed
   *  attempt must leave untouched. */
  currentName: (sessionId: string) => string;
  /** Does this conversation already carry a real name (stored or live)?
   *  Basic mode refuses to touch one. Provenance for names written before this
   *  feature existed is UNKNOWABLE — a title on an old conversation may well be
   *  one the user typed into some other client — and Basic's whole promise is a
   *  name derived from the opening request, which it would be replacing with
   *  the same text at best and a worse one at worst. */
  hasTitle: (sessionId: string) => Promise<boolean>;
  /** Publish an automatic name: live pill, conversation record, remote. Called
   *  only after the ownership record has been written. */
  publish: (sessionId: string, name: string) => Promise<void>;
}

interface SessionState {
  firstUserText?: string;
  recent: string[];
  seenTurns: Set<string>;
  inFlight: boolean;
  attempts: number;
  /** Bumped whenever the user renames, clears, or changes the mode. A result
   *  that comes back carrying an older number is discarded — the request it
   *  answers is no longer the one the user wants. */
  generation: number;
}

export interface SessionNamer {
  noteEvent: (ev: TranscriptEvent) => void;
  /** Drop in-memory state for a session (exit/destroy). */
  forget: (sessionId: string) => void;
  /** Invalidate work in flight for one session — call on rename and clear. */
  invalidate: (sessionId: string) => void;
  /** Invalidate every session — call when the naming preference changes. */
  invalidateAll: () => void;
}

/**
 * Build the review prompt. Pure and exported so its bounds are testable: the
 * ONLY conversation text that leaves the machine is the user's own messages,
 * truncated. No tool output, no tool arguments, no assistant text, no thinking,
 * no specialist content — the settings explainer promises "conversation
 * excerpts", and this is what makes that promise true.
 */
export function buildNamingPrompt(input: {
  first: string; recent: string[]; current: string;
}): string {
  const lines: string[] = [
    'Name this conversation in 3-6 words. Reply with the name only: no quotes, no trailing punctuation, no explanation.',
  ];
  if (isRealSessionName(input.current)) {
    // Reviews may keep the current name — say so, or every review renames.
    lines.push(`The current name is "${input.current}". Keep it unless the conversation is now about something else.`);
  }
  lines.push('', `Opening request: ${input.first.slice(0, FIRST_MESSAGE_CHARS)}`);
  const recent = input.recent.slice(-RECENT_MESSAGES).map((t) => t.slice(0, RECENT_MESSAGE_CHARS));
  if (recent.length) {
    lines.push('', 'Most recent requests:', ...recent.map((t) => `- ${t}`));
  }
  return lines.join('\n');
}

export function createSessionNamer(deps: SessionNamerDeps): SessionNamer {
  const sessions = new Map<string, SessionState>();

  function stateFor(sessionId: string): SessionState {
    let s = sessions.get(sessionId);
    if (!s) {
      s = { recent: [], seenTurns: new Set(), inFlight: false, attempts: 0, generation: 0 };
      sessions.set(sessionId, s);
    }
    return s;
  }

  /**
   * Count one completed reply, then review if one is due.
   *
   * WHY the count is NOT inside the in-flight guard: a review can take up to
   * fifteen seconds (the generate timeout), and on a fast-replying session
   * several replies land inside that window. Guarding the count as well as the
   * generation silently dropped them, so the schedule drifted longer and
   * longer on exactly the busiest conversations. The count is a locked
   * increment on its own; only the model call needs to be exclusive.
   */
  async function review(sessionId: string, state: SessionState): Promise<void> {
    // Did THIS call take the generation guard? The finally below must only
    // release a flag it set — a concurrent call that returns early (mode Off,
    // no review due) would otherwise clear the flag of the review that is
    // actually running, and the next reply would start a second generation.
    let acquired = false;
    try {
      const prefs = deps.settings();
      // Off does not merely discard results — it never counts, never reads a
      // model and never writes. Turning AI on later therefore finds a stale
      // counter and names the conversation on its NEXT completed reply, which
      // is the enable-later rule the design owed.
      if (prefs.mode === 'off') return;

      const ident = deps.identify(sessionId);
      if (!ident) return; // no store identity yet — an honest skip, not a failure

      const existing = await deps.readNaming(ident.provider, ident.storeId).catch(() => null);
      // The user owns this name. Do not count toward a schedule that will never
      // run, do not read a model, do not write. This is the guarantee the whole
      // feature is named after.
      if (existing?.manual) return;

      const counted = await deps.mutateNaming(ident.provider, ident.storeId, (cur) => (
        // Re-checked under the lock: a rename that landed between the read
        // above and this write must stop the counter too.
        cur.manual ? cur : { ...cur, replies: cur.replies + 1 }
      ));
      if (counted.manual || !isReviewDue(counted)) return;

      // Re-entrancy guard for the GENERATION only. Two reviews falling due
      // back to back (a takeover/resume transition, or a reply landing while a
      // slow one runs) must not each ask a model and double-name the session.
      if (state.inFlight) return;
      state.inFlight = true;
      acquired = true;
      const generation = state.generation;

      if (prefs.mode === 'basic') {
        // Basic quotes the opening request and then keeps that name — it does
        // not claim to notice the subject changing, so a second pass would only
        // rewrite the same text. A conversation that already had a name when
        // Basic was switched on keeps it, for the same reason.
        if (counted.auto || await deps.hasTitle(sessionId).catch(() => true)) {
          await markReviewed(ident, counted);
          return;
        }
        const name = basicNameFrom(state.firstUserText ?? '');
        if (!name) return; // no opening message yet; try again next reply
        await commit(sessionId, state, ident, generation, name);
        return;
      }

      // AI. A chosen naming model wins; otherwise the conversation's own model.
      const binding = prefs.model ?? deps.getBinding(sessionId);
      if (!binding) {
        // A Claude Code session with no separately chosen model: its model
        // lives inside the CLI, so the free in-session lane writes the name.
        // Silently substituting a paid provider here is exactly what the
        // design forbids.
        deps.askInSessionModel?.(sessionId, ident.storeId);
        await markReviewed(ident, counted);
        return;
      }

      const prompt = buildNamingPrompt({
        first: state.firstUserText ?? '',
        recent: state.recent,
        current: deps.currentName(sessionId),
      });
      state.attempts += 1;
      let raw: string;
      try {
        raw = await deps.generate(binding, prompt);
      } catch {
        // Provider down, model removed, timeout. Stay silent — chat is not
        // interrupted and the name on screen is untouched. Retry next reply
        // until this review's budget is spent, then wait for the next one.
        if (state.attempts >= MAX_ATTEMPTS) {
          state.attempts = 0;
          await markReviewed(ident, counted).catch(() => { /* best-effort */ });
        }
        return;
      }
      const name = sanitizeAutoName(raw);
      if (!name) {
        // An empty reply is a failed attempt, not a name — never write a blank.
        if (state.attempts >= MAX_ATTEMPTS) {
          state.attempts = 0;
          await markReviewed(ident, counted).catch(() => { /* best-effort */ });
        }
        return;
      }
      state.attempts = 0;
      await commit(sessionId, state, ident, generation, name);
    } catch {
      // Naming must never take a turn down with it.
    } finally {
      if (acquired) state.inFlight = false;
    }
  }

  /** Advance the schedule cursor without changing the name. */
  async function markReviewed(
    ident: { provider: string; storeId: string }, seen: NamingRecord,
  ): Promise<void> {
    await deps.mutateNaming(ident.provider, ident.storeId, (cur) => (
      { ...cur, reviewed: Math.max(cur.reviewed, seen.replies) }
    ));
  }

  /**
   * Persist an automatic name, then publish it. Both checks that matter are
   * repeated HERE, after the await, because the model call is the window in
   * which the user renames the session or switches naming off.
   */
  async function commit(
    sessionId: string,
    state: SessionState,
    ident: { provider: string; storeId: string },
    generation: number,
    name: string,
  ): Promise<void> {
    if (generation !== state.generation) return; // superseded by a rename/clear/mode change
    if (deps.settings().mode === 'off') return;
    const at = new Date().toISOString();
    const written = await deps.mutateNaming(ident.provider, ident.storeId, (cur) => (
      // Last word under the lock: a rename that landed while the model was
      // thinking wins outright, and its record is returned untouched.
      cur.manual ? cur : { ...cur, auto: name, autoAt: at, reviewed: Math.max(cur.reviewed, cur.replies) }
    ));
    if (written.manual) return;
    if (generation !== state.generation) return; // raced again during the write
    await deps.publish(sessionId, name);
  }

  return {
    noteEvent(ev: TranscriptEvent) {
      const state = stateFor(ev.sessionId);

      if (ev.type === 'user-message') {
        const text = String((ev.data as { text?: unknown } | undefined)?.text ?? '');
        if (!text.trim()) return;
        if (state.firstUserText === undefined) state.firstUserText = text;
        state.recent.push(text);
        if (state.recent.length > RECENT_MESSAGES) state.recent.shift();
        return;
      }

      if (ev.type === 'turn-complete') {
        // Duplicate delivery of the SAME turn (takeover/resume hand-off) must
        // not spend a reply of the schedule.
        const uuid = (ev as { uuid?: string }).uuid;
        if (uuid) {
          if (state.seenTurns.has(uuid)) return;
          state.seenTurns.add(uuid);
          // Bounded: only the recent window can plausibly be re-delivered.
          if (state.seenTurns.size > 200) {
            state.seenTurns = new Set([...state.seenTurns].slice(-100));
          }
        }
        // Fire-and-forget: this runs inside a synchronous transcript-event
        // listener and must never block it. review() catches everything.
        void review(ev.sessionId, state);
      }
    },

    forget(sessionId: string) { sessions.delete(sessionId); },

    invalidate(sessionId: string) { stateFor(sessionId).generation += 1; },

    invalidateAll() { for (const s of sessions.values()) s.generation += 1; },
  };
}
