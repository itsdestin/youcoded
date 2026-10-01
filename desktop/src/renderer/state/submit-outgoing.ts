// submit-outgoing.ts — put a built chat message on its way, and draw its bubble (one-core R5-4b).
//
// WHY this is its own file: the composer and "Send again" must send in EXACTLY the same way (same bubble, same id, same file spacing), and "Send again"
// has no composer to borrow from. The composer keeps what is its own — the draft, the toasts, the slash commands — and hands the transport here.
//
// Every send carries an id the screen makes up (`newSendId`). The computer's record notes the ids it received, so a screen that loses its connection
// mid-send can ask afterwards whether the message arrived (state/send-reconcile.ts) instead of guessing. It is NEVER resent by itself.
import type { ChatAction } from './chat-types';
import type { NativeSendResult } from '../../shared/types';
import { sendChatMessage } from '../components/native-send';
import { newSendId } from './send-ids';
import { SEND_CHECK_EVENT } from './send-reconcile';

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
}

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
