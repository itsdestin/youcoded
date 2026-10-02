import type { SessionChatState } from './chat-types';
import { HISTORY_EXPAND_PROMPT_ID } from './chat-types';
import { getVisibleScreenText } from '../hooks/terminal-registry';
import { readInputFocus, inputIsBlocked, type InputFocus } from '../parser/cc-input-focus';

// Shared safety gate for programmatic PTY writes.
//
// Why this module exists (2026-07-09 stray-Enter investigation): while a
// permission request, AskUserQuestion, or plan approval is pending, Claude
// Code's native Ink select menu is LIVE in the PTY at the same time YouCoded
// shows its chat card (the card answers via the hook socket, but the terminal
// menu still listens for keystrokes — that's how PlanApprovalCard answers the
// plan menu, by typing a row's number). Any byte YouCoded writes to the PTY in
// that window is menu input: a bare `\r` presses Enter on the highlighted
// option, silently auto-answering the question or auto-approving the permission.
//
// Every AUTOMATED PTY writer (submit-retry nudge, chat sends, command sends)
// must consult these predicates first. Deliberate menu-driving writes
// (PlanApprovalCard keys, TrustGate buttons, terminal-view keystrokes) must NOT
// go through this gate — driving the menu is their whole purpose.

/**
 * True when the session very likely has a live Ink select menu in its PTY:
 * a current-turn tool awaiting approval (permission prompt, AskUserQuestion,
 * ExitPlanMode) or an uncompleted interactive prompt (trust / resume dialogs
 * scraped from the terminal).
 *
 * Scans activeTurnToolIds only — toolCalls is a session-lifetime Map that
 * keeps stale awaiting-approval entries from ended turns.
 */
export function hasPendingInteraction(session: SessionChatState): boolean {
  for (const id of session.activeTurnToolIds) {
    if (session.toolCalls.get(id)?.status === 'awaiting-approval') return true;
  }
  for (const entry of session.timeline) {
    // The "See previous messages" marker rides the `prompt` kind but is a
    // display affordance, not a live Ink menu — it has no answerable buttons
    // and no keystroke is waiting on it. Counting it here silently locked ALL
    // sends on every resumed session, until the user happened to click it.
    // (fix 2026-07-17)
    //
    // Perf cycle 2 retired the marker: nothing pushes it any more, and ChatView
    // skips it when rendering. The exclusion STAYS because a session timeline
    // persisted by an older build can still contain one, and inheriting that
    // would re-lock sends with no way to clear it.
    if (entry.kind === 'prompt'
        && entry.prompt.promptId !== HISTORY_EXPAND_PROMPT_ID
        && !entry.prompt.completed) {
      return true;
    }
  }
  return false;
}

/**
 * WHICH kind of interaction is blocking sends — the send-refusal copy names it
 * (2026-07-30 permission-ask-timeout spec §4). With the app now holding an
 * unanswered ask for up to 2 hours, a generic "answer the prompt" reads as a
 * mystery lock once it has sat a while; an 'approval' card is in the chat, so
 * the copy points there. Same scan, same fields as hasPendingInteraction —
 * kept parallel (not derived from its boolean) so the two cannot disagree.
 */
export function pendingInteractionKind(session: SessionChatState): 'approval' | 'prompt' | null {
  for (const id of session.activeTurnToolIds) {
    if (session.toolCalls.get(id)?.status === 'awaiting-approval') return 'approval';
  }
  for (const entry of session.timeline) {
    if (entry.kind === 'prompt'
        && entry.prompt.promptId !== HISTORY_EXPAND_PROMPT_ID
        && !entry.prompt.completed) {
      return 'prompt';
    }
  }
  return null;
}

/**
 * The SCREEN's verdict, for what the chat state cannot see: is something other than Claude Code's message box holding the keyboard right now?
 *
 * WHY (2026-10-01, one-core R6-4 fix): origin/master gained this gate (popups work, 2026-09-29) AFTER the one-core series branched, so the series
 * lost it. Without it a chat message typed while Claude Code shows a pop-up no hook reports — most visibly the "Switch model?" confirmation a typed
 * /model opens mid-conversation — is swallowed (its Enter answers the pop-up with "Yes") while the bubble looks sent and "Simmering" never ends,
 * and the lost-message retry's bare Enter answers it too. Returns null when the message box is live, or when there is no readable terminal (no
 * verdict, so no new refusal). Detector: parser/cc-input-focus.ts (shape-based, replayed against 104 real captures on master).
 */
export function screenInputBlock(sessionId: string): Exclude<InputFocus, { kind: 'message-box' } | { kind: 'unknown' }> | null {
  const focus = readInputFocus(getVisibleScreenText(sessionId));
  return inputIsBlocked(focus) ? (focus as Exclude<InputFocus, { kind: 'message-box' } | { kind: 'unknown' }>) : null;
}

/** The one refusal sentence every send-refusal site reads, so they cannot drift.
 *  "answer the card" is true of every card shape that blocks (permission, plan,
 *  question, and a kept card with its Dismiss). */
export function pendingInteractionRefusalCopy(kind: 'approval' | 'prompt' | 'screen' | null): string {
  // 'screen': only the terminal shows it (no card in the chat), so the sentence says where to look.
  if (kind === 'screen') return 'Claude Code is waiting on something in the terminal — open the terminal view and answer it first.';
  return kind === 'approval'
    ? 'Your assistant is waiting for your response — answer the card in the chat first.'
    : 'Your assistant is waiting for your response — answer the prompt first.';
}

/**
 * The refusal sentence for a programmatic write that must not go out right now, or null when it may: a pending card first (it names the card to
 * answer), then the live screen's pop-up (one-core R6-4 fix; see screenInputBlock for why).
 */
export function sendRefusalCopy(session: SessionChatState | undefined, sessionId: string): string | null {
  if (session && hasPendingInteraction(session)) return pendingInteractionRefusalCopy(pendingInteractionKind(session));
  return screenInputBlock(sessionId) ? pendingInteractionRefusalCopy('screen') : null;
}

/**
 * True only when the session is observably idle enough that a recovery `\r`
 * (useSubmitConfirmation) cannot land on anything but CC's empty input bar:
 *
 * - attentionState 'ok' — no stuck/died banner. NOTE: 'ok' alone is NOT an
 *   idle signal; it's also the normal state during an active turn (both
 *   'thinking-active' and 'unknown' buffer classes map to 'ok').
 * - no pending interaction — see hasPendingInteraction above.
 * - no running current-turn tools and no in-flight assistant turn
 *   (currentTurnId). Covers CC's queued-message behavior: a message sent
 *   mid-turn is queued and its transcript line (which clears `pending`) only
 *   appears when the queue drains, so the retry must wait for turn end —
 *   at which point either the queued message submitted (pending cleared, no
 *   retry) or the send was truly lost (retry is safe).
 *
 * isThinking is deliberately NOT consulted: it is set on USER_PROMPT and only
 * cleared by endTurn(), so in the lost-message state this gate exists to
 * recover from, isThinking stays true forever.
 */
export function canRetrySubmit(session: SessionChatState): boolean {
  if (session.attentionState !== 'ok') return false;
  if (session.currentTurnId !== null) return false;
  for (const id of session.activeTurnToolIds) {
    const status = session.toolCalls.get(id)?.status;
    if (status === 'running' || status === 'awaiting-approval') return false;
  }
  return !hasPendingInteraction(session);
}

/**
 * M1: PTY sends must only reach Claude Code sessions that still exist — for a
 * native or destroyed session, SessionManager.sendInput no-ops, so callers that
 * trusted guardedPtySend's `true` wrote phantom bubbles (program doc §2.3).
 *
 * Pure predicate for session validity:
 * - session must exist
 * - provider must be 'claude' (native sessions have no PTY worker; a SHELL
 *   session has one, but it is the USER'S shell — see below)
 * - chat state must not indicate the session has died
 *
 * Returns true for sessions still attached to Claude Code (when chat state
 * hasn't materialized yet on boot, we assume it's live and allow the send).
 */
export function canPtySend(
  session: { provider?: string } | undefined,
  chat: { attentionState?: string } | undefined,
): boolean {
  if (!session) return false;
  if (session.provider === 'native') return false;
  // A shell session HAS a PTY, so this is not "can't" but "must not": every
  // caller of this gate writes Claude Code text (/sync, /config, /model, a
  // skill invocation) and would type — and, with its trailing Enter, RUN — that
  // text in the user's own shell. The app types into a shell session exactly
  // once, at creation, and never again.
  //
  // This gate is not the whole of that promise: App.tsx's cyclePermission calls
  // session.sendInput RAW, without asking here, so it carries its own shell
  // check. Any new raw sendInput must do the same — the ones that route through
  // guardedPtySend are covered by this line.
  if (session.provider === 'shell') return false;
  if (chat?.attentionState === 'session-died') return false;
  return true;
}
