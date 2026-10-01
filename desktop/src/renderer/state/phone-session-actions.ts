// phone-session-actions.ts — Close and the permission-mode chip, the two instant buttons whose screen state lives in App's own lists (one-core R6-2).
// Stop and a permission answer are in phone-actions.ts, Send in submit-outgoing.ts. All of them go through pending-action.ts.
//
// Every function here returns false (or does the plain old thing) on the computer's own window, so the caller keeps its existing code for that case.
import { announce } from '../utils/announce';
import { runPending, optimisticScreen, connected } from './pending-action';

/** A reply-less change (Claude Code's mode key) waits this long for the record's reading before the screen asks the computer. */
const MODE_SETTLE_MS = 6000;

/**
 * Close a conversation. On a phone it leaves the strip at once (and the screen moves to another conversation if it was the open one); the computer's answer
 * then decides. `true` or `false` from the computer both mean "it is not there now" (false = it was already gone), so the screen finishes the removal itself
 * rather than wait for the computer's separate "closed" notice; a refusal puts the pill back and says so; a lost reply waits, and the computer's own list of
 * conversations is what settles it (it is asked, never assumed).
 */
export function closeSession(o: {
  id: string;
  name?: string;
  /** The old path: ask the computer to close it. */
  destroy: () => Promise<unknown> | void;
  /** The computer's list of open conversations (the record of what exists). */
  list: () => Promise<Array<{ id: string }>>;
  /** Leave the strip and, when this was the open conversation, open another. Returns what puts the selection back. */
  leave: () => () => void;
  /** The computer closed it: finish removing it here. */
  finish: () => void;
}): void {
  if (!optimisticScreen() || !connected()) { try { void o.destroy(); } catch { /* the old path swallowed this too */ } return; }
  const label = o.name ? `"${o.name}"` : 'that conversation';
  let restore: () => void = () => {};
  void runPending({
    key: `close:${o.id}`,
    apply() { restore = o.leave(); },
    async send() { await o.destroy(); return 'answered' as const; },
    confirm: o.finish,
    undo(reason) {
      restore();
      announce(reason.kind === 'refused'
        ? `Couldn't close ${label}${reason.detail && !/^remote-unsupported/.test(reason.detail) ? `: ${reason.detail}` : '. Your computer didn\'t accept the request.'}`
        : `Couldn't confirm ${label} closed on your computer, so it is back.`);
    },
    async check() { return (await o.list()).some((s) => s.id === o.id) ? 'absent' : 'present'; },
  });
}

/** What a native session's mode chip needs from App's map of modes. */
interface ModeScreen { sessionId: string; from: string; to: string; read: () => string | undefined; write: (mode: string) => void }

/**
 * Cycle a native session's mode. On a phone the chip shows the new mode at once; the computer's answer is the mode it APPLIED, and that is what stays. A
 * refusal puts the old mode back. A lost reply is settled by ASKING THE COMPUTER what mode the session has (`readHost`): a reconnect's fill carries the
 * mode only when it changed while the phone was away, so the screen's own copy proves nothing about a change that never arrived.
 */
export function setNativeModeNow(o: ModeScreen & { set: () => Promise<unknown>; readHost: () => Promise<unknown>; valid: readonly string[] }): boolean {
  if (!optimisticScreen() || !connected()) return false;
  void runPending({
    key: `mode:${o.sessionId}`,
    sessionId: o.sessionId,
    apply: () => o.write(o.to),
    async send() {
      const applied = await o.set();
      // The remote path turns a host failure into an {ok:false} object (remote-shim): anything that is not a known mode is a refusal.
      if (typeof applied === 'string' && o.valid.includes(applied)) { o.write(applied); return 'answered' as const; }
      return { undo: { kind: 'refused' as const } };
    },
    undo() {
      // Only put the old mode back if nothing newer (the computer's own answer or push) has replaced the one this change drew.
      if (o.read() === o.to) o.write(o.from);
      announce("The permission mode didn't change. Your computer didn't confirm it.");
    },
    async check() {
      const mode = await o.readHost();      // a failed read throws: the helper tries again, then puts the old mode back
      if (typeof mode !== 'string' || !o.valid.includes(mode)) throw new Error('unreadable mode');
      o.write(mode);                        // whatever the computer has is what the chip shows
      return mode === o.to ? 'present' : 'absent';
    },
    settleAfterMs: MODE_SETTLE_MS,
  });
  return true;
}

/**
 * Cycle a Claude Code session's mode (Shift+Tab sent to its terminal; there is no reply to wait for). On a phone the chip shows the new mode at once. The
 * computer reads the mode from the terminal and publishes it (`session:permission-mode`): that reading, whatever it says, is what the chip then shows, and
 * App tells this helper it arrived (`confirmPending('mode:<session>')`). With no reading after MODE_SETTLE_MS (and a look at the record) the old mode is
 * put back and the person is told.
 */
export function cycleClaudeModeNow(o: ModeScreen & { sendKey: () => void }): boolean {
  if (!optimisticScreen() || !connected()) return false;
  void runPending({
    key: `mode:${o.sessionId}`,
    sessionId: o.sessionId,
    apply: () => o.write(o.to),
    send() { o.sendKey(); return 'sent'; },
    undo() {
      if (o.read() === o.to) o.write(o.from);
      announce("The permission mode didn't change. Your computer didn't confirm it.");
    },
    // Reached only when no reading has arrived (a reading confirms the change before this runs).
    check: () => 'absent',
    settleAfterMs: MODE_SETTLE_MS,
  });
  return true;
}
