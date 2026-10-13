// submit-outgoing.ts — put a built chat message on its way, and draw its bubble (one-core R5-4b).
//
// WHY this is its own file: the composer and "Send again" must send in EXACTLY the same way (same bubble, same id, same file spacing), and "Send again"
// has no composer to borrow from. The composer keeps what is its own — the draft, the toasts, the slash commands — and hands the transport here.
//
// Every send carries an id the screen makes up (`newSendId`). The computer's record notes the ids it received, so a screen that loses its connection
// mid-send can ask afterwards whether the message arrived (state/send-reconcile.ts) instead of guessing. It is NEVER resent by itself.
import type { ChatAction, SessionChatState } from './chat-types';
import type { NativeSendResult } from '../../shared/types';
import { sendChatMessage } from '../components/native-send';
import { newSendId } from './send-ids';
import { SEND_CHECK_EVENT } from './send-reconcile';
import { runPending, optimisticScreen } from './pending-action';

/** The gap between attached-file paths sent to Claude Code: longer than Ink's 500 ms paste window, so each path is its own paste (verified on a 4-image send). */
const FILE_GAP_MS = 600;

export interface OutgoingSend {
  sessionId: string;
  provider: 'claude' | 'native' | undefined;
  /** The sanitized text (`buildOutgoingMessage(...).ptyText`). */
  ptyText: string;
  /** The bubble's text (`.content`: the file paths then the text). */
  content: string;
  /** Exact attached-file paths. */
  paths: string[];
  dispatch: (action: ChatAction) => void;
  /** Native only (one-core R6-2): draw the bubble BEFORE the computer answers. The caller says yes only on a phone whose conversation is idle, where the
   *  computer would draw the very same bubble: a send that finds a turn running is queued by the computer and drawn from its queue, never as a bubble here. */
  instant?: boolean;
}

/**
 * May a native send be drawn before the computer answers? Only when this screen's own copy of the record says nothing is going on: no turn, no tool, no
 * waiting message. A busy conversation makes the computer QUEUE the message and draw it in its own queue strip (rows with Cancel and Send-now that only the
 * computer's queue can honour), so nothing is drawn here for it; and a screen that is a moment behind a turn that started elsewhere must not flash a bubble
 * that the strip then replaces. Anything this does not clear waits for the answer, exactly as before.
 */
export function canDrawSendNow(session: Pick<SessionChatState, 'isThinking' | 'currentTurnId' | 'activeTurnToolIds' | 'queuedMessages'> | undefined): boolean {
  return !!session && !session.isThinking && !session.currentTurnId && session.activeTurnToolIds.size === 0 && session.queuedMessages.length === 0;
}

/** A reply-less Claude Code send still has no echo this long after the write: ask the computer's record whether it got the message (a refused terminal write says nothing else). */
export const CC_SEND_CHECK_MS = 6000;

/**
 * Send a message to a Claude Code session: the bubble goes up BEFORE the write (the transcript confirms it once Claude Code records the line), the
 * file paths follow one paste apart, and the text goes last with the id, so the computer notes it once the write is accepted.
 */
export function sendToClaudeCode(o: OutgoingSend): string {
  const sendId = newSendId();
  o.dispatch({ type: 'USER_PROMPT', sessionId: o.sessionId, content: o.content, timestamp: Date.now(), attachments: o.paths, sendId });
  o.paths.forEach((p, idx) => {
    setTimeout(() => { window.claude.session.sendInput(o.sessionId, p + ' '); }, idx * FILE_GAP_MS);
  });
  // The pty worker splits text + \r with a gap so Enter is not swallowed by Ink's paste buffer. An attachments-only send is just "\r".
  setTimeout(() => { window.claude.session.sendInput(o.sessionId, o.ptyText + '\r', undefined, sendId); }, o.paths.length * FILE_GAP_MS);
  // One-core R6-2: the bubble is already up (instant); a phone also checks once, a few seconds on, that the computer's terminal took the write. A bubble the echo
  // has confirmed by then costs nothing (nothing is asked); one it has not gets the computer's answer on it ("This didn't send" + Send again). Nothing is resent.
  if (optimisticScreen()) setTimeout(() => window.dispatchEvent(new CustomEvent(SEND_CHECK_EVENT)), o.paths.length * FILE_GAP_MS + CC_SEND_CHECK_MS);
  return sendId;
}

/**
 * What a native send came to:
 *  - `sent` / `queued`: the host answered (a queued one is drawn from the host's own queue, not here);
 *  - `failed`: the host refused it, or the request never left (the caller says so and keeps the draft);
 *  - `unsure`: the request left and no answer came (the connection dropped, or it timed out): the host MAY have it. The bubble is drawn with a note,
 *    and the record is asked what it got (state/send-reconcile.ts). Nothing is resent.
 */
export type NativeOutcome =
  | { status: 'sent' | 'queued'; sendId: string }
  | { status: 'failed'; result: NativeSendResult | undefined; sendId: string }
  | { status: 'unsure'; sendId: string };

export async function sendToNative(o: OutgoingSend): Promise<NativeOutcome> {
  const sendId = newSendId();
  if (o.instant) return sendToNativeNow(o, sendId);
  let result: NativeSendResult | undefined;
  let unknown = false;
  try {
    result = await sendChatMessage('native', o.sessionId, o.ptyText, o.paths, sendId);
  } catch (err) {
    console.error('native send invoke rejected:', err);
    unknown = !!(err as { outcomeUnknown?: boolean } | null)?.outcomeUnknown;
  }
  if (unknown) {
    o.dispatch({ type: 'USER_PROMPT', sessionId: o.sessionId, content: o.content, timestamp: Date.now(), attachments: o.paths, sendId });
    o.dispatch({ type: 'SEND_NOTE', sessionId: o.sessionId, sendId, note: 'unsure' });
    // The connection may be fine (a slow answer): ask now. If it dropped, the reconnect asks again.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SEND_CHECK_EVENT));
    return { status: 'unsure', sendId };
  }
  if (!result || result.status === 'failed') return { status: 'failed', result, sendId };
  // A 'sent' answer gets the optimistic bubble (nothing is streaming, so its position is already right); a 'queued' one draws nothing here: the
  // computer holds the queue and says so (`session:live`, kind `queue`), and every screen's strip is drawn from that.
  if (result.status !== 'queued') {
    o.dispatch({ type: 'USER_PROMPT', sessionId: o.sessionId, content: o.content, timestamp: Date.now(), attachments: o.paths, sendId });
  }
  return { status: result.status === 'queued' ? 'queued' : 'sent', sendId };
}

/**
 * The instant native send (phone, idle conversation): the bubble goes up first, then the computer answers.
 *   sent   -> the bubble stays (pending until the transcript echoes it, as ever);
 *   queued -> the computer found a turn running after all: it holds the message and draws its own queue strip, so the bubble comes down;
 *   failed -> the bubble comes down and the caller (the composer) says so and keeps the draft;
 *   no answer -> the bubble stays with "Not sure this was sent" and the record is asked (state/send-reconcile.ts); nothing is resent.
 */
async function sendToNativeNow(o: OutgoingSend, sendId: string): Promise<NativeOutcome> {
  let outcome: NativeOutcome = { status: 'sent', sendId };
  const bubble = (): ChatAction => ({ type: 'USER_PROMPT', sessionId: o.sessionId, content: o.content, timestamp: Date.now(), attachments: o.paths, sendId });
  await runPending({
    key: `send:${sendId}`,
    sessionId: o.sessionId,
    apply: () => o.dispatch(bubble()),
    async send() {
      let result: NativeSendResult | undefined;
      try {
        result = await sendChatMessage('native', o.sessionId, o.ptyText, o.paths, sendId);
      } catch (err) {
        if ((err as { outcomeUnknown?: boolean } | null)?.outcomeUnknown) throw err;
        console.error('native send invoke rejected:', err);
      }
      if (!result || result.status === 'failed') { outcome = { status: 'failed', result, sendId }; return { undo: { kind: 'refused' } }; }
      if (result.status === 'queued') { outcome = { status: 'queued', sendId }; return { undo: { kind: 'redirected' } }; }
      return 'answered';
    },
    undo: () => o.dispatch({ type: 'SEND_DISCARD', sessionId: o.sessionId, sendId }),
    // The answer never came: the message MAY be there. Its own note and the record's check settle it (the same path as a send that was not instant).
    handOff() {
      outcome = { status: 'unsure', sendId };
      o.dispatch({ type: 'SEND_NOTE', sessionId: o.sessionId, sendId, note: 'unsure' });
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SEND_CHECK_EVENT));
    },
    check: () => 'present',
  });
  return outcome;
}

/** The words and files of a sent bubble, back out of it (the bubble's content is the file paths, then the text). */
export function splitSentContent(content: string, attachments: readonly string[] | undefined): { ptyText: string; paths: string[] } {
  const paths = [...(attachments ?? [])];
  let text = content;
  const used: string[] = [];
  for (const p of paths) {
    if (!text.startsWith(p)) break;
    text = text.slice(p.length).replace(/^ /, '');
    used.push(p);
  }
  return { ptyText: text, paths: used };
}

/** Fired by Discard so the composer can take the words back (InputBar listens). Never carries anything that sends. */
export const RESTORE_UNSENT_EVENT = 'youcoded:restore-unsent-text';

/**
 * "Discard" on a message the computer provably never got: the words go back into the composer if it is empty (InputBar decides; it never overwrites a
 * draft), then the bubble goes. Sends nothing. Only ever called by the person pressing the button.
 */
export function discardUnsent(args: {
  sessionId: string;
  sendId: string;
  content: string;
  attachments: readonly string[] | undefined;
  dispatch: (action: ChatAction) => void;
}): void {
  const { ptyText } = splitSentContent(args.content, args.attachments);
  // WHY before the dispatch: nothing the person typed may vanish without a trace; the composer keeps it unless it already holds a draft.
  if (typeof window !== 'undefined' && ptyText.trim()) {
    window.dispatchEvent(new CustomEvent(RESTORE_UNSENT_EVENT, { detail: { sessionId: args.sessionId, text: ptyText } }));
  }
  args.dispatch({ type: 'SEND_DISCARD', sessionId: args.sessionId, sendId: args.sendId });
}

/**
 * "Send again" on a message that did not (or may not have) arrive: the old bubble goes and the same words go out as a NEW send. Only ever called
 * by the person pressing the button.
 */
export function sendAgain(args: {
  sessionId: string;
  sendId: string;
  provider: 'claude' | 'native' | undefined;
  content: string;
  attachments: readonly string[] | undefined;
  dispatch: (action: ChatAction) => void;
  onToast?: (message: string) => void;
}): void {
  const { ptyText, paths } = splitSentContent(args.content, args.attachments);
  args.dispatch({ type: 'SEND_DISCARD', sessionId: args.sessionId, sendId: args.sendId });
  const base: OutgoingSend = { sessionId: args.sessionId, provider: args.provider, ptyText, content: args.content, paths, dispatch: args.dispatch };
  if (args.provider === 'native') {
    void sendToNative(base).then((out) => {
      if (out.status === 'failed') args.onToast?.('Not connected — your message could not be sent. Try again when you are back online.');
    });
  } else {
    sendToClaudeCode(base);
  }
}
