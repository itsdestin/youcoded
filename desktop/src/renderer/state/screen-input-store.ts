// screen-input-store.ts — what holds each Claude Code session's keyboard, as the COMPUTER last said (shared/cc-input-focus.ts, read by
// main/session-screens.ts and published as `session:live {kind:'input-block'}`).
//
// WHY a tiny module store and not chat state (sync with master's popups work, 2026-10-01): the send gates (pty-input-gate.ts) must answer
// synchronously at the moment of a send, from anywhere (InputBar, App's command writers, the retry nudge, "Send anyway"'s wait loop), and this fact is
// not part of the conversation: it is never saved, never replayed, and says nothing once the session is gone. A phone has no terminal to read, so
// this store, filled from the computer's published reading, is its ONLY source; the computer's windows read the same store, so no screen holds a second
// opinion that could disagree with the one the computer gave everyone.
import type { InputBlock } from '../../shared/cc-input-focus';

const blocks = new Map<string, InputBlock>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of [...listeners]) listener(); };

/**
 * Tells you when a session's reading CHANGES (waiting-notice T1): the "held back" notice in a chat's strip
 * leaves the moment the pop-up that caused it closes, and nothing else tells it. WHY change-only: the computer
 * publishes a reading on every `session:live` message, mostly unchanged; waking every listener for each one would
 * make an open notice re-check itself for no reason.
 */
export function subscribeScreenInputBlocks(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const same = (a: InputBlock | undefined, b: InputBlock | null): boolean =>
  !a || !b ? !a && !b : JSON.stringify(a) === JSON.stringify(b);

/** Record the computer's latest reading for a session (`null` = Claude Code's message box is live). */
export function setScreenInputBlock(sessionId: string, block: InputBlock | null): void {
  if (same(blocks.get(sessionId), block)) return;
  if (block) blocks.set(sessionId, block);
  else blocks.delete(sessionId);
  notify();
}

/** What holds the session's keyboard right now, or null (message box live, or the computer has not said). */
export function getScreenInputBlock(sessionId: string): InputBlock | null {
  return blocks.get(sessionId) ?? null;
}

/** Forget everything (tests; and a reconnect that is about to be re-told the current facts). */
export function clearScreenInputBlocks(): void {
  const hadAny = blocks.size > 0;
  blocks.clear();
  // WHY notify on clear too: a reconnect forgets every pop-up, so notices waiting on one must re-check.
  if (hadAny) notify();
}
