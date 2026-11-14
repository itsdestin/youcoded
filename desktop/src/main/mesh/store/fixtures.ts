// Synthetic chat lines for tests. NO real chat content: every string here is invented filler.
// Shapes follow the field names the real writers use (Phase 0 reports), nothing more.

export const nl = (o: unknown): Buffer => Buffer.from(JSON.stringify(o) + '\n', 'utf8');

let uuidCounter = 0;
const uid = () => `u-${(uuidCounter++).toString(16).padStart(8, '0')}`;

export const cc = {
  user: (text = 'hello', extra: Record<string, unknown> = {}) =>
    nl({ type: 'user', uuid: uid(), cwd: '/synthetic/project', promptId: 'p1', message: { role: 'user', content: text }, ...extra }),
  toolResult: () => nl({ type: 'user', uuid: uid(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  interrupt: (forTool = false) =>
    nl({ type: 'user', uuid: uid(), promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: forTool ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }] } }),
  /** One content-block line of an assistant message; every block line carries the message's final stop_reason. */
  block: (msgId: string, stop: string | null, blockType: 'thinking' | 'text' | 'tool_use' = 'text', extra: Record<string, unknown> = {}) =>
    nl({ type: 'assistant', uuid: uid(), message: { id: msgId, model: 'synthetic-model-1', stop_reason: stop, content: [{ type: blockType }] }, ...extra }),
  turnDuration: () => nl({ type: 'system', subtype: 'turn_duration', durationMs: 5 }),
  compactBoundary: () => nl({ type: 'system', subtype: 'compact_boundary', uuid: uid(), compactMetadata: { trigger: 'auto' } }),
  compactSummary: () => nl({ type: 'user', uuid: uid(), isCompactSummary: true, message: { role: 'user', content: 'synthetic summary' } }),
  bookkeeping: (type: string = 'last-prompt') => nl({ type, uuid: uid(), note: 'x' }),
  title: (t = 'Synthetic title') => nl({ type: 'ai-title', aiTitle: t }),
  apiError: (msgId: string) => nl({ type: 'assistant', uuid: uid(), isApiErrorMessage: true, message: { id: msgId, model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text' }] } }),
};

export const native = {
  header: () => nl({ v: 1, sessionId: 's-1', cwd: '/synthetic/project', createdAt: 1 }),
  user: (text = 'hello') => nl({ type: 'user-message', uuid: uid(), timestamp: 1, data: { text } }),
  text: (text = 'reply') => nl({ type: 'assistant-text', uuid: uid(), timestamp: 2, data: { text } }),
  toolUse: () => nl({ type: 'tool-use', uuid: uid(), timestamp: 3, data: { name: 't' } }),
  toolResult: () => nl({ type: 'tool-result', uuid: uid(), timestamp: 4, data: { ok: true } }),
  complete: () => nl({ type: 'turn-complete', uuid: uid(), timestamp: 5, data: {} }),
  interrupt: () => nl({ type: 'user-interrupt', uuid: uid(), timestamp: 6, data: {} }),
  modelSwitch: () => nl({ type: 'model-switch', uuid: uid(), timestamp: 7, data: {} }),
};

/** Raw lines that are NOT valid JSON, or contain raw U+2028 / U+2029 inside a JSON string. */
export const awkward = {
  invalidJson: () => Buffer.from('{"type":"user","message":{"content":"broken\n', 'utf8'),
  garbage: () => Buffer.from('not json at all \xff\xfe\n', 'latin1'),
  lineSeparators: () => Buffer.from(`{"type":"user","uuid":"${uid()}","message":{"content":"a b c"}}\n`, 'utf8'),
  /** Written by hand with spaces and an escaped quote: must still round-trip as bytes. */
  spaced: () => Buffer.from('{ "type" : "user" , "message" : { "content" : "q\\"uote" } }\n', 'utf8'),
  empty: () => Buffer.from('\n', 'utf8'),
};

/** A multi-turn Claude Code conversation covering every reply-end shape. Returns lines and the line numbers that must be confirmed. */
export function ccConversation(): { lines: Buffer[]; confirmed: number[]; pending: number | null } {
  const lines: Buffer[] = [];
  const confirmed: number[] = [];
  const push = (b: Buffer) => { lines.push(b); return lines.length - 1; };
  // turn 1: tool-use turn then a streamed multi-block answer, with turn_duration (interactive)
  push(cc.user('first'));
  push(cc.block('m1', 'tool_use', 'tool_use'));
  push(cc.toolResult());
  push(cc.block('m2', 'end_turn', 'thinking'));
  const t1 = push(cc.block('m2', 'end_turn', 'text'));
  push(cc.bookkeeping('last-prompt'));
  push(cc.turnDuration()); confirmed.push(t1);
  // turn 2: headless style, no turn_duration: confirmed by the next user line
  push(cc.user('second'));
  const t2 = push(cc.block('m3', 'end_turn', 'text'));
  push(cc.title());
  // turn 3: interrupted
  push(cc.user('third')); confirmed.push(t2);
  push(cc.block('m4', 'tool_use', 'tool_use'));
  const i3 = push(cc.interrupt(true));
  // compaction boundary, then a re-written copy of recent lines
  push(cc.compactBoundary()); confirmed.push(i3);
  push(cc.compactSummary());
  push(cc.user('after compaction'));
  const t4 = push(cc.block('m5', 'end_turn', 'text'));
  push(cc.block('m6', 'end_turn', 'text')); confirmed.push(t4);
  return { lines, confirmed, pending: lines.length - 1 };
}

export function nativeConversation(): { lines: Buffer[]; confirmed: number[] } {
  const lines = [native.header(), native.user(), native.toolUse(), native.toolResult(), native.text(), native.complete(), native.modelSwitch(), native.user('b'), native.text('x'), native.interrupt()];
  return { lines, confirmed: [5, 9] };
}

