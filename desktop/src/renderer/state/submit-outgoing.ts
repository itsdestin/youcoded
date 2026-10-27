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
import { requestClaudeControl } from './claude-control';
import { screenInputBlock } from './pty-input-gate';
import { pendingQueueSend, savePendingQueueSend, clearPendingQueueSend, allPendingQueueSends } from './pending-queue-send';
import { getNativeStartup } from './native-startup-store';
import { nativeStartupBlocked } from '../../shared/native-startup';
import { sendFailureCopy } from './native-send-copy';
import { announce } from '../utils/announce';

/** The gap between attached-file paths sent to Claude Code: longer than Ink's 500 ms paste window, so each path is its own paste (verified on a 4-image send). */
const FILE_GAP_MS = 600;

export interface OutgoingSend {
  sessionId: string;
  provider: 'claude' | 'native' | undefined;
  /** The sanitized text (`buildOutgoingMessage(...).ptyText`). */
  ptyText: string;
  originalText?: string;
  /** The bubble's text (`.content`: the file paths then the text). */
  content: string;
  /** Exact attached-file paths. */
  paths: string[];
  dispatch: (action: ChatAction) => void;
  /** Native only (one-core R6-2): draw the bubble BEFORE the computer answers. The caller says yes only on a phone whose conversation is idle, where the
   *  computer would draw the very same bubble: a send that finds a turn running is queued by the computer and drawn from its queue, never as a bubble here. */
  instant?: boolean;
  /** A recoverable old bubble is replaced only once the new request is accepted/uncertain. */
  replaceSendId?: string;
  /** Claude Code queue: this screen's copy says the conversation is idle (canDrawSendNow), so the bubble goes up at once. */
  drawNow?: boolean;
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
  if (typeof window.claude.session.queue?.action === 'function') {
    void sendViaHostQueue(o,sendId);
    return sendId;
  }
  return sendToClaudeLegacy(o,sendId);
}

// WHY: identical text is valid new intent while a previous send awaits its acknowledgement.
// Only settled-unknown persisted requests are retry candidates; reload intentionally resets this set.
const inFlightQueueSends = new Set<string>();
async function sendViaHostQueue(o: OutgoingSend, sendId: string): Promise<void> {
  let allowLegacyFallback=false; let activeSendId: string | undefined; let drawnSendId: string | undefined;
  // The instant bubble comes down whenever this send ends up NOT in the queue (refused, fallen back, unknown).
  const undraw=()=>{if(drawnSendId){o.dispatch({type:'SEND_DISCARD',sessionId:o.sessionId,sendId:drawnSendId});drawnSendId=undefined;}};
  try {
    // The same draft resumes its saved send (same sendId: the queue cannot take it twice). A different draft is never held
    // back by an older unconfirmed one any more; that one is settled by asking the queue once this send is on its way.
    let request=pendingQueueSend(o.sessionId,o.originalText??o.ptyText,o.paths,inFlightQueueSends);
    // WHY draw now (Destin, 2026-10-22: "the message should appear when i send it"): before the queue, the terminal path drew
    // the bubble at Send; the queue path drew nothing until Claude Code recorded the line. Only an idle conversation gets one
    // (a busy one shows the message in the queue strip instead), never a slash command (it may get no echo), and the
    // 'queue' transport keeps the terminal's retry Enter away from it. Confirmed by identity (QUEUE_SYNCED `bound`).
    if(o.drawNow&&!(o.originalText??o.ptyText).trimStart().startsWith('/')){drawnSendId=request?.payload.sendId??sendId;o.dispatch({type:'USER_PROMPT',sessionId:o.sessionId,content:o.content,timestamp:Date.now(),attachments:o.paths,sendId:drawnSendId,sendTransport:'queue'});}
    if(!request){
     allowLegacyFallback=true;
     const identity = await window.claude.session.queue.action(o.sessionId,{kind:'identity'});
     allowLegacyFallback=false;
     if (identity.status === 'unavailable') { undraw(); sendToClaudeLegacy(o,sendId); return; }
     if (identity.status !== 'identity') throw Error('Queue identity is not ready. The original message was not submitted.');
     request={kind:'enqueue',queueId:identity.identity.queueId,payload:{sendEpoch:identity.identity.sendEpoch,sendId,originalText:o.originalText??o.ptyText,attachments:[...o.paths],displayContent:o.content}};
     savePendingQueueSend(o.sessionId,request);
    }
    activeSendId=request.payload.sendId; inFlightQueueSends.add(activeSendId);
    const result = await window.claude.session.queue.action(o.sessionId,request);
    if (result.status === 'queued') {clearPendingQueueSend(o.sessionId,request);void settleSavedQueueSends(o.sessionId);return;} // host strip/transcript only
    if (result.status === 'unavailable') throw Error('Queue availability changed. Check the conversation before sending again.');
    throw Error('message' in result ? result.message : 'Queued delivery could not be confirmed.');
  } catch (error) {
    // A settled failure is already a recovery candidate, even while the notice module loads.
    if(activeSendId){inFlightQueueSends.delete(activeSendId);activeSendId=undefined;}
    const unsupported=error as {code?:unknown;channel?:unknown};
    if(allowLegacyFallback&&unsupported?.code==='REMOTE_UNSUPPORTED'&&unsupported.channel==='session:queue-action'){undraw();sendToClaudeLegacy(o,sendId);return;}
    undraw();
    // No legacy Enter after an uncertain action. Existing notice + unsent refill is deliberate,
    // not a fabricated history row matching transformed file-read instruction text.
    const { announce } = await import('../utils/announce');
    announce(error instanceof Error ? error.message : 'Message outcome is unknown. Check the queue and conversation before trying again.');
    window.dispatchEvent(new CustomEvent(RESTORE_UNSENT_EVENT,{detail:{sessionId:o.sessionId,text:o.originalText ?? o.ptyText,paths:[...o.paths]}}));
  } finally { if(activeSendId)inFlightQueueSends.delete(activeSendId); }
}

function sendToClaudeLegacy(o: OutgoingSend, sendId: string): string {
  // WHY: plugin prompts do not expand @file mentions. Keep every @-bearing message on the CLI composer
  // path before dispatch rather than guessing its evolving mention grammar (emails safely take that path too).
  const direct = o.paths.length === 0 && !!o.ptyText && !o.ptyText.includes('@') && !o.ptyText.trimStart().startsWith('/') && typeof window.claude.session.control === 'function';
  o.dispatch({ type: 'USER_PROMPT', sessionId: o.sessionId, content: o.content, timestamp: Date.now(), attachments: o.paths, sendId, ...(direct ? { sendTransport: 'direct' as const } : {}) });
  if (direct) {
    void requestClaudeControl(o.sessionId, { kind: 'send-text', text: o.ptyText, sendId }).then((result) => {
      if (result.status === 'unavailable') {
        // The transport has positively proved no operation was dispatched. Recheck focus after the round trip.
        if (screenInputBlock(o.sessionId)) { o.dispatch({ type: 'SEND_NOTE', sessionId: o.sessionId, sendId, note: 'not-sent' }); return; }
        o.dispatch({ type: 'SEND_TRANSPORT', sessionId: o.sessionId, sendId, transport: 'pty' });
        window.claude.session.sendInput(o.sessionId, o.ptyText + '\r', undefined, sendId);
      } else if (result.status === 'unknown' || result.status === 'rejected') {
        o.dispatch({ type: 'SEND_NOTE', sessionId: o.sessionId, sendId, note: result.status === 'unknown' ? 'unsure' : 'not-sent' });
      }
    });
    if (optimisticScreen()) setTimeout(() => window.dispatchEvent(new CustomEvent(SEND_CHECK_EVENT)), CC_SEND_CHECK_MS);
    return sendId;
  }
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
  if (nativeStartupBlocked(getNativeStartup(o.sessionId))) return { status: 'failed', result: { status: 'failed', reason: 'initializing' }, sendId };
  if (o.instant && !o.replaceSendId) return sendToNativeNow(o, sendId);
  const replaceOld = () => { if (o.replaceSendId) o.dispatch({ type: 'SEND_DISCARD', sessionId: o.sessionId, sendId: o.replaceSendId }); };
  let result: NativeSendResult | undefined;
  let unknown = false;
  try {
    result = await sendChatMessage('native', o.sessionId, o.ptyText, o.paths, sendId);
  } catch (err) {
    console.error('native send invoke rejected:', err);
    unknown = !!(err as { outcomeUnknown?: boolean } | null)?.outcomeUnknown;
  }
  if (unknown) {
    replaceOld();
    o.dispatch({ type: 'USER_PROMPT', sessionId: o.sessionId, content: o.content, timestamp: Date.now(), attachments: o.paths, sendId });
    o.dispatch({ type: 'SEND_NOTE', sessionId: o.sessionId, sendId, note: 'unsure' });
    // The connection may be fine (a slow answer): ask now. If it dropped, the reconnect asks again.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SEND_CHECK_EVENT));
    return { status: 'unsure', sendId };
  }
  if (!result || result.status === 'failed') return { status: 'failed', result, sendId };
  // WHY before the replacement bubble: discarding it afterward would clear the new turn's spinner.
  replaceOld();
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

export function retainFailedOutgoing(o: OutgoingSend, out: Extract<NativeOutcome, { status: 'failed' }>): void {
  // WHY a recoverable note: never overwrite a newer draft or silently discard the earlier text/files.
  o.dispatch({ type: 'UNSENT_RETAINED', sessionId: o.sessionId, content: o.content, timestamp: Date.now(), attachments: o.paths,
    sendId: out.sendId, note: out.result ? 'not-sent' : 'unsure' });
  if (!out.result && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SEND_CHECK_EVENT));
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

/** Fired by Discard so the composer can take the words back (InputBar listens). Never carries anything that sends.
 *  The listener sets `detail.restored` when it took them, so a caller can tell (it only takes them into an empty box). */
export const RESTORE_UNSENT_EVENT = 'youcoded:restore-unsent-text';

// WHY exported: the photo-only screen list (dev/workbench/ToastPractice) shows this toast with these very words, so the picture cannot drift from the app.
export const LOST_SEND_NOTICE = "An earlier message didn't reach your computer. It's back in the message box.";

let settling: Promise<void> | null = null;

/**
 * Settle the saved Claude Code sends whose answer never came (2026-10-22 phone reliability, cause 4): ask the conversation's
 * queue whether it ever accepted each one. Accepted: forget it. Not accepted, or the queue can no longer tell: its words go
 * back into that conversation's empty message box and it is forgotten; if the box is not empty (or not on screen) it waits for
 * the next check. A conversation that no longer exists is forgotten. No answer at all (no connection): nothing changes.
 * Never sends anything. Runs on a reconnect, at start and after a successful send; one run at a time.
 */
export function settleSavedQueueSends(onlySessionId?: string): Promise<void> {
  if (settling) return settling;
  settling = (async () => {
    const queue = (window.claude?.session as { queue?: { action?: (s: string, a: unknown) => Promise<any> } } | undefined)?.queue;
    if (typeof queue?.action !== 'function') return;
    for (const { sessionId, request } of allPendingQueueSends()) {
      if (onlySessionId && sessionId !== onlySessionId) continue;
      if (inFlightQueueSends.has(request.payload.sendId)) continue;
      let reply: any;
      try { reply = await queue.action(sessionId, { kind: 'lookup', queueId: request.queueId, sendId: request.payload.sendId }); }
      catch { continue; } // no answer: ask again next time
      if (reply?.status === 'lookup' && reply.found && reply.identity?.sendEpoch === request.payload.sendEpoch) {
        clearPendingQueueSend(sessionId, request);
        continue;
      }
      // WHY keep on any other answer (branch review F1/F6): 'unavailable' is also what a conversation whose queue the computer has
      // not set up again yet says, and a computer older than `lookup` answers 'rejected'. Neither says whether the words arrived,
      // so the saved send stays — the same words sent again still reuse its id, which is what stops a double delivery.
      if (reply?.status !== 'lookup') continue;
      const sure = reply?.status === 'lookup' && reply.identity?.sendEpoch === request.payload.sendEpoch;
      const detail: { sessionId: string; text: string; paths: string[]; restored?: boolean } = { sessionId, text: request.payload.originalText, paths: [...request.payload.attachments] };
      window.dispatchEvent(new CustomEvent(RESTORE_UNSENT_EVENT, { detail }));
      if (!detail.restored) continue; // the box is busy or not on screen: kept for the next check, never lost
      clearPendingQueueSend(sessionId, request);
      announce(sure
        ? LOST_SEND_NOTICE
        : "An earlier message may not have reached your computer. It's back in the message box — check the conversation before sending it again.", 6000);
    }
  })().finally(() => { settling = null; });
  return settling;
}

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

// WHY: the old bubble remains usable until admission; repeated presses must share that pending retry, not submit two new sends.
const pendingRetries = new Set<string>();

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
  const notify = args.onToast ?? announce;
  if (window.claude.session.canSend?.() === false) { notify('Not connected — the original message is still here.'); return; }
  const { ptyText, paths } = splitSentContent(args.content, args.attachments);
  const base: OutgoingSend = { sessionId: args.sessionId, provider: args.provider, ptyText, content: args.content, paths, dispatch: args.dispatch, replaceSendId: args.sendId };
  if (args.provider === 'native') {
    const key = JSON.stringify([args.sessionId, args.sendId]);
    if (pendingRetries.has(key)) return;
    pendingRetries.add(key);
    void sendToNative(base)
      .then(out => { if (out.status === 'failed') notify(sendFailureCopy(out.result)); })
      .finally(() => { pendingRetries.delete(key); });
  } else {
    args.dispatch({ type: 'SEND_DISCARD', sessionId: args.sessionId, sendId: args.sendId });
    sendToClaudeCode(base);
  }
}
