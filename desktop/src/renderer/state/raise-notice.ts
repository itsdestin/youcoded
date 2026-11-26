// raise-notice.ts — the few ways code says "that can't be done / didn't go through / can't tell" in the chat it was for.
//
// WHY one small module (waiting-notice T2): every one of these used to be a floating toast, which showed in whatever chat was on
// screen when the reply came back. Each caller now names the chat the action was FOR (never "the chat on screen at reply time"),
// and the tone / when-it-leaves rules from the deck live here once instead of in thirty call sites:
//   can't do it here or now  — amber, leaves on your next action (typing, sending, leaving the chat)
//   failed                   — red (and a red dot on the chat in the list if you are elsewhere), leaves on your next action
//   not sure it went through — amber, stays until you send again or dismiss it
import type { SessionChatState } from './chat-types';
import { clearChatNotice, showChatNotice, stillBusy, stillNotLive, type ChatNotice } from './chat-notice-store';
import { isTurnBusy } from '../hooks/useStreamingGate';
import { commandNotInNativeChat, skillWhichOne } from '../utils/notice-words';

type Extra = Pick<ChatNotice, 'actions' | 'stillTrue' | 'recheckEverySecond'>;

/**
 * The one raiser (review consolidation; it replaces four near-identical functions). Tone is the only real difference:
 *   'warn'  — amber: can't be done here or now, or not sure it went through
 *   'error' — red (and a red dot on the chat in the list if you are elsewhere): something failed
 * By default it leaves on your next action. A "not sure it went through" notice passes `leave: 'resolved'`, so it stays until you
 * send again (InputBar's send clears the strip) or you dismiss it.
 */
export function raiseNotice(
  sessionId: string, tone: 'warn' | 'error', key: string, text: string,
  extra: Extra & Partial<Pick<ChatNotice, 'leave'>> = {},
): void {
  showChatNotice(sessionId, { key, text, tone, leave: 'next-action', ...extra });
}

/**
 * "Can't do that while your assistant is still working": a Stop button, and it leaves by itself when the reply ends.
 * WHY the check on the current state first: if this screen does not (yet) know the reply is running, a "still busy" test would
 * be false at once and the notice would vanish before it was read — then it just waits for your next action like any other.
 */
export function raiseBusy(
  sessionId: string, key: string, text: string,
  io: { getSession?: (id: string) => SessionChatState | undefined; stop: () => void },
): void {
  const get = () => io.getSession?.(sessionId);
  const knownBusy = !!get() && isTurnBusy(get()!);
  raiseNotice(sessionId, 'warn', key, text, {
    actions: [{ label: 'Stop', primary: true, onClick: io.stop }],
    ...(knownBusy ? { stillTrue: stillBusy(get) } : {}),
  });
}

/**
 * "This session isn't running": it leaves when the chat is running again (a new reply is being written, or it was shown as
 * ended and no longer is). When this screen never saw it end there is no signal to wait for, so it waits for your next action.
 */
export function raiseNotRunning(
  sessionId: string, key: string, text: string,
  getSession?: (id: string) => SessionChatState | undefined,
): void {
  const get = () => getSession?.(sessionId);
  const endedAtRaise = get()?.attentionState === 'session-died';
  const isLive = () => {
    const s = get();
    if (!s) return false;
    if (s.isThinking) return true;
    return endedAtRaise && s.attentionState !== 'session-died';
  };
  raiseNotice(sessionId, 'warn', key, text, endedAtRaise ? { stillTrue: stillNotLive(isLive) } : {});
}

/** "Browse skills" asks App to open the marketplace (no prop path from here). */
export const OPEN_MARKETPLACE_EVENT = 'youcoded:open-marketplace';
export const browseSkillsAction = (): NonNullable<ChatNotice['actions']>[number] => ({
  label: 'Browse skills', primary: true,
  onClick: () => window.dispatchEvent(new Event(OPEN_MARKETPLACE_EVENT)),
});

/** "/doctor isn't available in YouCoded-runtime sessions yet." in that chat's strip (a plain terminal session has no strip: App floats its own sentence). */
export function raiseCommandNotHere(sessionId: string, command: string): void {
  raiseNotice(sessionId, 'warn', 'not-in-native-runtime', commandNotInNativeChat(command));
}

/**
 * "Two skills are called /review. Which one did you mean?": one button per skill, named by its full id (plugin:skill).
 * WHY a question and not a failure (waiting-notice T5, deck "when two skills share a name … asks which"): the words you typed
 * were fine, they just fit two skills. Pressing one runs that skill and takes the question away.
 */
const WHICH_SKILL_KEY = 'skill-which-one';
export function raiseWhichSkill(sessionId: string, skill: string, fullIds: string[], run: (fullId: string) => void): void {
  raiseNotice(sessionId, 'warn', WHICH_SKILL_KEY, skillWhichOne(skill), {
    actions: fullIds.map((id) => ({ label: id, onClick: () => { clearChatNotice(sessionId, WHICH_SKILL_KEY); run(id); } })),
  });
}
