import type { PromptButton } from '../parser/ink-select-parser';
import { answerInkMenu, type InkMenuResult } from './ink-menu-driver';
import { getVisibleScreenText, onBufferReady } from '../hooks/terminal-registry';
import { nextTerminalUpdate } from '../hooks/usePlanMenu';

// The one way YouCoded answers a Claude Code Ink select menu (trust dialog,
// bypass warning, Resume Session, theme/login pickers, usage-limit menu…).
// Every PromptCard / TrustGate button click funnels through here.
//
// This is a DELIBERATE menu-driving write, so it must NOT go through
// pty-input-gate.ts — driving the live menu is the whole point (see that
// module's header).
//
// Three kinds of button:
//  • a numbered menu's button types the option's DIGIT — one byte that picks
//    and submits regardless of the cursor;
//  • a menu with no printed numbers (CC 2.1.281's startup dialogs) carries
//    `pick`, and is answered by state/ink-menu-driver.ts: one arrow per write,
//    each confirmed on screen, then Enter alone. The result says whether
//    Claude Code took it, so the card can say so if it did not;
//  • `submitInput` — a second write after a gap — only arrives from Android's
//    native detector or an older build's serialized state.

/** Gap between the navigation write and the submit write. Verified at this value
 *  against CC 2.1.220 on 2026-07-26: `UP×5 + DOWN×N` as one write, then `\r` 150ms
 *  later, committed exactly the option N arrow-steps away (for N = 1,2,3) — the
 *  same sequence in ONE write commits the option that was already highlighted. */
export const PROMPT_SUBMIT_DELAY_MS = 150;

export type PromptAnswerResult = InkMenuResult | { ok: false; reason: 'busy' | 'unreachable'; typed: false };

/** This window's identity for the host's answer lock (menu-answer-lock.ts). */
const LOCK_HOLDER = `w-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

/** Count this session's terminal updates from now on — lets the driver tell
 *  "Claude Code redrew after our Enter" from "nothing happened" (review F5). */
function outputCounter(sessionId: string): { count: () => number; stop: () => void } {
  let n = 0;
  let armed = false; // skip onBufferReady's catch-up call made at subscribe time
  const stop = onBufferReady((sid) => { if (armed && sid === sessionId) n++; });
  queueMicrotask(() => { armed = true; });
  return { count: () => n, stop };
}

/** Ask the host's per-session answer lock. 'unlocked' = this host has no lock
 *  (an older desktop or phone runtime) — answer as before it existed. */
async function acquireMenuLock(
  session: { menuLock?: (sid: string, holder: string, action: 'acquire' | 'release') => Promise<boolean> },
  sessionId: string,
): Promise<'held' | 'busy' | 'unlocked' | 'unreachable'> {
  if (!session.menuLock) return 'unlocked';
  try {
    return (await session.menuLock(sessionId, LOCK_HOLDER, 'acquire')) ? 'held' : 'busy';
  } catch (err) {
    return /remote-unsupported/.test(String((err as Error)?.message ?? err)) ? 'unlocked' : 'unreachable';
  }
}

export async function sendPromptInput(sessionId: string, button: PromptButton): Promise<PromptAnswerResult> {
  const session = (window as any).claude?.session;
  if (!session?.sendInput) return { ok: false, reason: 'menu-gone', typed: false };
  if (button.pick) {
    // One device at a time (review F4): the lock lives on the HOST, so the
    // desktop window and a phone clicking together cannot mix one's arrows
    // with the other's Enter.
    //
    // The ask itself can fail, and must never throw out of here (second review
    // F1): a thrown answer left the card "sending" forever with every button
    // dead. An older host that has no such channel answers "unsupported" — its
    // clients have no lock either, so answer unlocked, as before the lock. A
    // lost connection or a timeout means nothing can reach the session anyway:
    // type nothing and say so.
    const lock = await acquireMenuLock(session, sessionId);
    if (lock === 'busy') return { ok: false, reason: 'busy', typed: false };
    if (lock === 'unreachable') return { ok: false, reason: 'unreachable', typed: false };
    const out = outputCounter(sessionId);
    try {
      return await answerInkMenu(
        { signature: button.pick.signature, index: button.pick.index, label: button.label },
        {
          read: () => getVisibleScreenText(sessionId),
          write: (d) => session.sendInput(sessionId, d),
          settle: (ms) => nextTerminalUpdate(sessionId, ms),
          now: () => Date.now(),
          outputCount: out.count,
        },
      );
    } finally {
      out.stop();
      // Fire-and-forget, but never an unhandled rejection; the lease frees the
      // lock on the host if this release is lost.
      if (lock === 'held') Promise.resolve().then(() => session.menuLock(sessionId, LOCK_HOLDER, 'release')).catch(() => {});
    }
  }
  session.sendInput(sessionId, button.input);
  if (button.submitInput) {
    const submit = button.submitInput;
    setTimeout(() => session.sendInput(sessionId, submit), PROMPT_SUBMIT_DELAY_MS);
  }
  return { ok: true };
}

/**
 * Answer a prompt card and run `complete` (mark it answered) at the right time.
 * A numbered menu's digit is fire-and-forget, so the card completes at once. A
 * verified-navigation answer can be REFUSED (the options changed, the cursor
 * would not move); completing up front would then claim a choice Claude Code
 * never received — so it completes only on success, and the result goes back
 * to the card, which shows why it did not.
 */
export function answerPrompt(sessionId: string, button: PromptButton, complete: () => void): Promise<PromptAnswerResult> | undefined {
  if (button.pick) {
    return sendPromptInput(sessionId, button).then((r) => { if (r.ok) complete(); return r; });
  }
  void sendPromptInput(sessionId, button);
  complete();
  return undefined;
}

/** A card's last resort if an answer ever throws: the buttons come back, and
 *  the words promise nothing about the cause (it is unknown). */
export const PROMPT_UNKNOWN_FAILURE = "That may not have reached Claude Code. Check terminal view to see where it stands.";

/** What a card says when a verified answer did not go through. */
export const PROMPT_FAILURE_COPY: Record<Exclude<PromptAnswerResult, { ok: true }>['reason'], string> = {
  'menu-changed': "Claude Code's options changed before that went through, so nothing was sent. Check terminal view.",
  'menu-gone': 'This question is no longer waiting in Claude Code, so nothing was sent.',
  'not-taken': "Claude Code didn't react to that in time. Check terminal view to see where it stands.",
  busy: 'Another device is answering this right now, so nothing was sent.',
  unreachable: "YouCoded couldn't reach the computer running this session, so nothing was sent. Try again.",
};
