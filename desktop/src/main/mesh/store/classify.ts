// Line classification and the reply-end trackers (seam S1's `replyEnd`). Pure functions of line bytes.
//
// WHY one analysis per line: the adapter and the store both need (a) is this a conversation line (for
// the second chain), (b) what it means for reply-end tracking, (c) a few summary facts. Parsing JSON
// once and returning all three keeps a 300 MB ingest at one parse per line.
//
// Facts this encodes (all from the Phase 0 reports, T2 findings 15-19, T21 6A, T3 F8):
//  - Claude Code writes one line PER CONTENT BLOCK and every block line carries the message's final
//    stop_reason, so a line is a reply end only once a later line shows its message is complete.
//  - `turn_duration` exists only in interactive sessions, so it can confirm but is never required.
//  - The conversation chain is an ALLOW-list (user, assistant) because a deny-list missed
//    `bridge-session` in T21.
import { createHash } from 'node:crypto';
import type { RuntimeKind } from './chain';

/** Design 5.3: a line over 64 MB is stored raw and flagged, never parsed whole. */
const MAX_PARSE_BYTES = 64 * 1024 * 1024;

export type LineKind = 'user' | 'assistant' | 'bookkeeping' | 'invalid' | 'oversize';

export interface LineInfo {
  kind: LineKind;
  /** True when the line belongs to the conversation chain. */
  conversation: boolean;
  /** Top-level `type` string when there is one (diagnostics and counts only). */
  type: string | null;
  /** Short key of message.id (Claude Code assistant lines), null when absent. */
  msgKey: string | null;
  /** Claude Code assistant line whose stop_reason is set and is not tool_use. */
  endLooking: boolean;
  /** An assistant error line Claude Code synthesised (isApiErrorMessage). */
  apiError: boolean;
  /** A user line that is the "[Request interrupted by user ...]" marker. */
  interrupt: boolean;
  /** `system` / `turn_duration` (interactive sessions only). */
  turnDuration: boolean;
  /** Native persisted `turn-complete` or `user-interrupt`. */
  nativeEnd: boolean;
  /** Summary facts, when this line carries them. */
  title?: string;
  model?: string;
  cwd?: string;
}

/**
 * Native conversation line types, derived from the native writer's event union
 * (`shared/transcript-event-types.ts`, TranscriptDataMap), because T21 left this list unfixed:
 * the user's and assistant's content and the turn markers. Everything else (the session header
 * which has no `type`, `model-switch`, `skill-invoked`, `subagent-usage`, `background-task`,
 * `replay-complete`) is bookkeeping. `tool-result` stays IN: T21 found 2 native chats whose tool-result
 * image fields were edited in place; keeping them in means such an edit is seen as a difference
 * (fails toward keeping, never toward silently merging). Replaceable constant.
 */
const NATIVE_CONVERSATION_TYPES: ReadonlySet<string> = new Set([
  'user-message', 'user-interrupt', 'assistant-text', 'tool-use', 'tool-result',
  'assistant-thinking', 'turn-complete', 'compact-summary', 'context-clear',
]);

/**
 * Version of everything in this file that changes what a stored record says (the allow-lists, the
 * stop-reason list, the reply-end rule). Stored in every index header (records.ts); bump it whenever
 * any of those change so two devices never compare conversation chains made by different rules (M5).
 */
export const CLASSIFIER_VERSION = 1;

/**
 * Review M6: the stop reasons that finish a reply, decided explicitly. `tool_use` means the turn goes on;
 * `pause_turn` means the model was paused and will continue, so it is NOT an end. An unknown string is
 * treated as an end (the previous behaviour, and the safer error: a reply is announced, never swallowed).
 */
const NON_END_STOP_REASONS: ReadonlySet<string> = new Set(['tool_use', 'pause_turn']);

const INTERRUPTS = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);

const EMPTY: Omit<LineInfo, 'kind' | 'conversation'> = {
  type: null, msgKey: null, endLooking: false, apiError: false, interrupt: false, turnDuration: false, nativeEnd: false,
};

/** First 8 bytes of SHA-256 as 16 hex chars: a compact, JSON-safe stand-in for message.id. */
const idKey = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 16);

function userText(o: any): string {
  const c = o?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  return '';
}

/**
 * Classify one raw line (bytes through the newline). Never throws. Invalid JSON and oversize lines
 * count as conversation lines: classification fails toward keeping, so a damaged or unreadable line
 * can only ever make two copies look DIFFERENT, never wrongly identical. (AMBIGUITY: the reports only
 * define the allow-list for parsed lines; this is the conservative reading.)
 */
export function analyseLine(runtime: RuntimeKind, line: Uint8Array): LineInfo {
  if (line.length > MAX_PARSE_BYTES) return { ...EMPTY, kind: 'oversize', conversation: true };
  let o: any;
  try { o = JSON.parse(Buffer.from(line.buffer, line.byteOffset, line.byteLength).toString('utf8')); }
  catch { return { ...EMPTY, kind: 'invalid', conversation: true }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ...EMPTY, kind: 'bookkeeping', conversation: false };
  const type: string | null = typeof o.type === 'string' ? o.type : null;
  const info: LineInfo = { ...EMPTY, kind: 'bookkeeping', conversation: false, type };
  if (typeof o.cwd === 'string') info.cwd = o.cwd;

  if (runtime === 'native') {
    if (type !== null && NATIVE_CONVERSATION_TYPES.has(type)) {
      info.conversation = true;
      info.kind = type === 'user-message' || type === 'user-interrupt' ? 'user' : 'assistant';
    }
    info.nativeEnd = type === 'turn-complete' || type === 'user-interrupt';
    return info;
  }

  // Claude Code
  if (type === 'user') { info.kind = 'user'; info.conversation = true; info.interrupt = INTERRUPTS.has(userText(o)); }
  else if (type === 'assistant') {
    info.kind = 'assistant'; info.conversation = true;
    const m = o.message;
    if (typeof m?.id === 'string') info.msgKey = idKey(m.id);
    const sr = m?.stop_reason;
    info.endLooking = typeof sr === 'string' && sr !== '' && !NON_END_STOP_REASONS.has(sr);
    info.apiError = !!o.isApiErrorMessage;
    if (typeof m?.model === 'string' && m.model !== '<synthetic>') info.model = m.model;
  } else if (type === 'system' && o.subtype === 'turn_duration') info.turnDuration = true;
  else if (type === 'ai-title' && typeof o.aiTitle === 'string') info.title = o.aiTitle;
  else if (type === 'custom-title' && typeof o.customTitle === 'string') info.title = o.customTitle;
  return info;
}

/** Tracker state; JSON-safe. `cand` is the last end-looking line, waiting to be confirmed. */
export interface ReplyState { cand: { n: number; id: string | null } | null }
export const initialReplyState = (): ReplyState => ({ cand: null });

export interface ReplyEndOptions {
  /**
   * Whether a synthetic API-error assistant line counts as a finished reply. The design leaves this to
   * round-15 C-2 ("proposed no"); the T2 prototype counts it (the app does). Default true = prototype
   * behaviour; flip here when that decision lands.
   */
  apiErrorsEndReplies?: boolean;
}

/**
 * One step of the reply-end tracker with one-line lookahead. Returns the new state and the line
 * numbers confirmed by THIS line, which may name an earlier line.
 *
 * Claude Code: remember the last end-looking line with its message id and confirm it when an assistant
 * line with a different id, any user line, or a turn_duration line arrives. Bookkeeping lines neither
 * confirm nor cancel. An interrupt line is itself a reply end (and a user line, so it first confirms
 * an earlier candidate). Native: a persisted turn-complete / user-interrupt confirms immediately.
 */
export function replyEndStep(runtime: RuntimeKind, rs: ReplyState | null, info: LineInfo, lineNo: number,
  opts: ReplyEndOptions = {}): { rs: ReplyState; confirmed: number[] } {
  const state: ReplyState = rs ?? initialReplyState();
  if (runtime === 'native') return { rs: state, confirmed: info.nativeEnd ? [lineNo] : [] };
  const apiOk = opts.apiErrorsEndReplies ?? true;
  const confirmed: number[] = [];
  let cur = state;
  const confirm = () => { if (cur.cand) { confirmed.push(cur.cand.n); cur = { cand: null }; } };
  if (info.turnDuration) { confirm(); return { rs: cur, confirmed }; }
  if (info.kind === 'assistant') {
    // WHY a missing id counts as "different from everything" (M6): an id-less line (a synthetic API error,
    // an interrupt marker's candidate) can never be a further block of the candidate's message, so waiting
    // for a different id would lose the first reply end or leave the candidate pending forever.
    if (cur.cand && (cur.cand.id === null || info.msgKey === null || cur.cand.id !== info.msgKey)) confirm();
    if (info.endLooking && (apiOk || !info.apiError)) cur = { cand: { n: lineNo, id: info.msgKey } };
    return { rs: cur, confirmed };
  }
  if (info.kind === 'user') {
    confirm();
    if (info.interrupt) cur = { cand: { n: lineNo, id: null } };
    return { rs: cur, confirmed };
  }
  return { rs: cur, confirmed };
}

/**
 * The host's idle signal: nothing more is coming, so a pending candidate is a finished reply. Kept as a
 * separate pure function so S1 itself never guesses (T2 finding 17: 62 chats end on an unconfirmed line).
 */
export function settleReplyEnd(rs: ReplyState | null): { rs: ReplyState; confirmed: number[] } {
  return rs?.cand ? { rs: { cand: null }, confirmed: [rs.cand.n] } : { rs: rs ?? initialReplyState(), confirmed: [] };
}
