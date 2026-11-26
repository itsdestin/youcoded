// Runs the slash commands that have a REAL native-runtime implementation.
//
// The dispatcher (slash-command-dispatcher.ts) stays provider-agnostic: it names
// an intent (`nativeAction`) and hands back a PTY string for the Claude Code
// path. This module is the other half — the harness transport — so the three
// call sites that consume a dispatcher result (InputBar, the command drawer, and
// the skill-prompt path in App) share ONE implementation instead of each growing
// their own provider branch.
//
// Why every branch reports something: before M3, choosing /compact in a native
// session went to `guardedPtySend`, which returns false and drops it on the
// floor — no toast, no error, nothing. Replacing those silent dead ends is the
// point of this milestone, so every outcome here either succeeds or explains
// itself.
import type React from 'react';
import { getCapabilities } from '../platform';
import type { ChatAction } from './chat-types';
import type { NativeSlashAction, DispatcherResult } from './slash-command-dispatcher';
import type { SessionChatState } from './chat-types';
import { raiseBusy, raiseCant, raiseFailed, raiseNotRunning, browseSkillsAction } from './raise-notice';
import { busyWith, notRunning, NOTHING_TO_COMPACT, NOT_AN_INSTALLED_SKILL, SKILL_UNREADABLE, skillAmbiguous, skillFailed } from '../utils/notice-words';

/** User-facing copy per refusal reason. Specific and accurate — never a guessed
 *  cause (docs/error-message-standards.md). Keys mirror NativeSessionHost.compact
 *  and HarnessSession.compactNow. */
// WHY only the failures are left here (waiting-notice T2): "busy", "nothing to compact" and "not running" are can't-do-now
// notices and now go to the chat's own strip (below). These three are failures AFTER the command ran; the deck puts those in
// the chat itself (T4), so until that card exists they keep their floating notice, unchanged.
const COMPACT_REFUSAL: Record<string, string> = {
  // WHY: failed summaries no longer rewrite or prune accepted history; do not
  // promise space was freed when the model's context remains unchanged.
  'summary-failed':
    'The model couldn’t write a usable summary, so the conversation was left intact. Try again later.',
  'interrupted': 'Compaction stopped. The conversation was left as it was.',
};

/** Stop for a built-in assistant chat (the Stop button on a "still working" notice). */
const stopTurn = (sessionId: string): void => { window.claude.native.interrupt(sessionId); };

export interface NativeActionDeps {
  sessionId: string;
  dispatch: React.Dispatch<ChatAction>;
  /** Floating notice, for the failures that wait for their in-chat card (compact / clear failing after they ran). */
  onToast?: (message: string) => void;
  /** Reads a chat's state, so a "still working" notice knows when the reply ends. */
  getSession?: (sessionId: string) => SessionChatState | undefined;
  /** Legacy hosts only: capture the screen's pending card before awaiting IPC. */
  compactionOperationId?: string;
}

/**
 * Execute a native-runtime slash action. Never throws — a rejected IPC call is
 * reported like any other refusal.
 *
 * Returns true when the action actually did something, so callers can decide
 * whether to treat it as handled.
 */
export async function runNativeSlashAction(
  action: NativeSlashAction,
  { sessionId, dispatch, onToast, getSession, compactionOperationId }: NativeActionDeps,
): Promise<boolean> {
  if (action.kind === 'clear') return runNativeClear({ sessionId, onToast, getSession });
  if (action.kind === 'invoke-skill') return runNativeSkill(action.skill, action.args, { sessionId, onToast, getSession });
  if (action.kind !== 'compact') return false;

  const hostOwned = getCapabilities().sessionRecord;
  let result: { ok: true } | { ok: false; reason: string; detail?: string };
  try {
    result = await window.claude.native.compact(sessionId, action.focus);
  } catch (err: any) {
    // Surface the REAL error text rather than inventing a cause.
    result = { ok: false, reason: 'error', detail: err?.message ?? String(err) };
  }

  if (result.ok) {
    // The harness emits `compact-summary` on success, and the transcript-event
    // path turns that into COMPACTION_COMPLETE — which is what clears the
    // spinner and writes the marker. Nothing to dispatch here; dispatching our
    // own COMPACTION_COMPLETE would race that one and double-insert the marker.
    return true;
  }

  // Clear the spinner the dispatcher optimistically raised (COMPACTION_PENDING),
  // otherwise a refused compaction leaves a card spinning forever. A Stop drops
  // it silently: "Compaction may have failed" would be false after a Stop.
  // WHY: on record-capable hosts only the host lifecycle owns cleanup. A concurrent IPC refusal owns no spinner.
  if (!hostOwned) dispatch(result.reason === 'interrupted'
    ? { type: 'COMPACTION_CANCELLED', sessionId, operationId: compactionOperationId }
    : {
      type: 'COMPACTION_COMPLETE',
      sessionId,
      operationId: compactionOperationId,
      markerId: `compact-failed-${Date.now()}`,
      afterContextTokens: null,
      aborted: true,
    });

  // Can't-do-now refusals: the chat's strip, with the words shared by every notice that means the same thing.
  if (result.reason === 'turn-in-flight') { raiseBusy(sessionId, 'compact-busy', busyWith('compact'), { getSession, stop: () => stopTurn(sessionId) }); return false; }
  if (result.reason === 'nothing-to-compact') { raiseCant(sessionId, 'compact-nothing', NOTHING_TO_COMPACT); return false; }
  if (result.reason === 'not-live') { raiseNotRunning(sessionId, 'compact-not-live', notRunning('compact'), getSession); return false; }
  const known = COMPACT_REFUSAL[result.reason];
  onToast?.(
    known ??
      // Unknown reason: pass the real detail through when we have one, and stay
      // non-committal when we don't, rather than asserting a cause.
      (result.detail ? `Couldn't compact: ${result.detail}` : "Couldn't compact this conversation."),
  );
  return false;
}


/**
 * /clear for a native session — a context BARRIER, not a deletion.
 *
 * The dispatcher has ALREADY dispatched CLEAR_TIMELINE optimistically, which is
 * what the user sees. This drives the durable half: the harness drops the
 * model's in-memory history and appends a `context-clear` marker so a resume
 * rebuilds from the barrier forward. The append-only log keeps every line, so
 * the conversation stays fully readable — only the model's memory resets.
 *
 * Nothing to undo on refusal: for a native session the dispatcher SKIPS its
 * optimistic CLEAR_TIMELINE (see `deferUiEffectsToRuntime`), because the visible
 * timeline can't be restored once cleared — `seenUuids` survives the clear, so a
 * transcript replay would be deduped away to nothing. Instead the UI clears only
 * when the durable `context-clear` event comes back, which means a refused clear
 * leaves the conversation exactly as it was.
 */
async function runNativeClear({ sessionId, onToast, getSession }: Omit<NativeActionDeps, 'dispatch'>): Promise<boolean> {
  let result: { ok: true } | { ok: false; reason: string; detail?: string };
  try {
    result = await window.claude.native.clear(sessionId);
  } catch (err: any) {
    result = { ok: false, reason: 'error', detail: err?.message ?? String(err) };
  }

  if (result.ok) return true;

  if (result.reason === 'turn-in-flight') { raiseBusy(sessionId, 'clear-busy', busyWith('clear'), { getSession, stop: () => stopTurn(sessionId) }); return false; }
  if (result.reason === 'not-live') { raiseNotRunning(sessionId, 'clear-not-live', notRunning('clear'), getSession); return false; }
  onToast?.(result.detail ? `Couldn't clear: ${result.detail}` : "Couldn't clear this conversation.");
  return false;
}

/** Load a skill's instructions into the conversation as one turn.
 *
 *  This is the path that works on EVERY model: the Skill TOOL is withheld from
 *  small windows (its catalog would ride every turn), but a single explicit
 *  invocation costs one injection and is affordable anywhere. */
async function runNativeSkill(
  skill: string,
  args: string | undefined,
  { sessionId, getSession }: Omit<NativeActionDeps, 'dispatch'>,
): Promise<boolean> {
  let result: { ok: true } | { ok: false; reason: string; detail?: string };
  try {
    result = await window.claude.native.invokeSkill(sessionId, skill, args);
  } catch (err: any) {
    // Surface the REAL error text rather than inventing a cause.
    result = { ok: false, reason: 'error', detail: err?.message ?? String(err) };
  }

  if (result.ok) return true;

  // WHY these are strip notices now (waiting-notice T2): each is about THIS chat. 'not-a-skill' covers two real cases with one honest
  // sentence (a skill that isn't installed, OR a Claude Code command with no YouCoded-runtime equivalent), because the dispatcher
  // cannot tell them apart; it now carries the button to go and install one.
  switch (result.reason) {
    case 'not-a-skill': raiseCant(sessionId, 'skill-not-a-skill', NOT_AN_INSTALLED_SKILL, { actions: [browseSkillsAction()] }); return false;
    case 'turn-in-flight': raiseBusy(sessionId, 'skill-busy', busyWith('start a skill'), { getSession, stop: () => stopTurn(sessionId) }); return false;
    case 'not-live': raiseNotRunning(sessionId, 'skill-not-live', notRunning('run the skill in'), getSession); return false;
  }
  const retry = { label: 'Try again', primary: true, onClick: () => { void runNativeSkill(skill, args, { sessionId, getSession }); } };
  if (result.reason === 'unreadable') { raiseFailed(sessionId, 'skill-unreadable', SKILL_UNREADABLE, { actions: [retry] }); return false; }
  // Two skills with one name is the only detail worth showing (it names the choices). Any other detail is the computer's own
  // technical text: it goes to the console, never the screen (review A5).
  if (result.reason === 'ambiguous' && result.detail) { raiseFailed(sessionId, 'skill-error-detail', skillAmbiguous(skill, result.detail)); return false; }
  if (result.detail) console.warn(`[skill] /${skill} failed:`, result.reason, result.detail);
  raiseFailed(sessionId, 'skill-failed', skillFailed(skill), { actions: [retry] });
  return false;
}

/** Where a dispatcher result should go, given the session's provider.
 *
 *  WHY this is a function and not two inline branches: InputBar and
 *  App.runSlashResult each made this decision themselves, and both checked
 *  `handled` BEFORE `nativeAction`. That was correct while every native action
 *  was also a recognized command — and became a silent bug the moment
 *  /skill-name started riding the `handled: false` branch (so that Claude Code
 *  sessions keep forwarding unknown commands to the PTY untouched). One place
 *  owns the ordering now, and it is unit-tested.
 */
export type SlashRoute =
  | { via: 'native'; action: NativeSlashAction }
  | { via: 'pty'; text: string }
  /** Fully handled in the renderer; nothing further to do. */
  | { via: 'none' }
  /** Handled, and it WOULD have forwarded to a PTY — but this session has none.
   *  Carries the command so the caller can say so instead of dropping it. */
  | { via: 'none-native-no-pty'; command: string }
  /** Not a command we handle: the caller sends the text as a normal message. */
  | { via: 'passthrough' };

export function routeSlashResult(provider: string | undefined, result: DispatcherResult): SlashRoute {
  // Anything not explicitly native is treated as Claude Code. Routing to a
  // harness a session may not have would strand the input entirely.
  const isNative = provider === 'native';
  // A shell session is neither: it has a PTY, but the thing on the other end is
  // the user's shell, not Claude Code. It is grouped with native here so a
  // command's PTY text is REPORTED as unavailable rather than typed into it.
  const noClaudeCode = isNative || provider === 'shell';

  // BEFORE the `handled` check on purpose — see the WHY above.
  if (isNative && result.nativeAction) return { via: 'native', action: result.nativeAction };
  if (!result.handled) return { via: 'passthrough' };
  if (result.alsoSendToPty) {
    // A native session has no PTY, and this command has no harness equivalent
    // yet. Return the command so the caller can TELL the user — the pre-M3
    // behavior was `guardedPtySend` returning false into a discarded value.
    if (noClaudeCode) return { via: 'none-native-no-pty', command: result.alsoSendToPty.trim() };
    return { via: 'pty', text: result.alsoSendToPty };
  }
  return { via: 'none' };
}
