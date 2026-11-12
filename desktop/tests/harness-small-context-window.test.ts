// Three faults found on a 32k-window local model (2026-11-08, Qwen3.5-9B):
//  1. a tool result was not sized to the room left in the window,
//  2. the compaction check accepted a junk "summary" (bare tool-call markup),
//  3. the pre-check's "cannot fit" error and the engine's refusal reached the user as different errors.
// Investigation: workspace docs/active/investigations/2026-11-08-local-model-speed-and-context-faults.md
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { makeSession, scriptModel, fakeTool } from './helpers/harness-fakes';
import * as compactionMod from '../src/main/harness/compaction';
import { classifyFailure } from '../src/main/providers/provider-failure';
import { messagesTokens } from '../src/main/harness/message-size';

const BIG = 'const a = 1;\n'.repeat(3100); // ~40k chars, ~10k tokens at chars/4

function readTool(text: string) {
  return fakeTool('Read', { onExecute: () => ({ text }) });
}
function spy(inner: ReturnType<typeof scriptModel>, sink: any[]) {
  return new MockLanguageModelV4({ doStream: async (o: any) => { sink.push(o); return inner.doStream(o); } });
}
const toolResultText = (prompt: any[]): string[] => prompt.filter(m => m.role === 'tool')
  .flatMap(m => m.content).filter((p: any) => p.type === 'tool-result')
  .map((p: any) => p.output?.value ?? p.output?.text ?? JSON.stringify(p.output));

describe('tool results are sized to the room left in the window', () => {
  it('a result bigger than the room is cut, tells the model how to read the rest, and the next request is sent', async () => {
    const calls: any[] = []; const events: any[] = [];
    const model = spy(scriptModel([{ toolCalls: [{ name: 'Read', input: { file_path: '/f' } }] }, { text: 'done' }]), calls);
    const session = makeSession({ contextLength: 8192, model, tools: [readTool(BIG)], onEvent: e => events.push(e) });
    await session.send('look at the file');
    expect(events.some(e => e.type === 'session-error')).toBe(false);
    expect(events.some(e => e.type === 'turn-complete')).toBe(true);
    const sent = toolResultText(calls[1].prompt).join('');
    expect(sent.length).toBeLessThan(BIG.length / 2);
    expect(sent).toMatch(/truncated/i);
    expect(sent).toMatch(/offset\/limit/);
    // The cut result still pairs with its call.
    expect(JSON.stringify(calls[1].prompt)).toContain('"toolCallId":"c0-0"');
  });

  it('a cloud-sized window is untouched, even for a very large result', async () => {
    const calls: any[] = [];
    const huge = 'y'.repeat(95_000);
    const model = spy(scriptModel([{ toolCalls: [{ name: 'Read', input: { file_path: '/f' } }] }, { text: 'done' }]), calls);
    const session = makeSession({ contextLength: 1_000_000, model, tools: [readTool(huge)] });
    await session.send('look');
    expect(toolResultText(calls[1].prompt).join('')).toBe(huge);
  });

  it('after the cut result the history is back under the compaction trigger, so no pointless summary runs', async () => {
    const calls: any[] = [];
    const model = spy(scriptModel([
      { toolCalls: [{ name: 'Read', input: { file_path: '/a' } }] },
      { toolCalls: [{ name: 'Read', input: { file_path: '/b' } }] },
      { text: 'done' }]), calls);
    const session = makeSession({ contextLength: 8192, model, tools: [readTool(BIG)] });
    await session.send('look at both files');
    // 3 chat requests, no 4th (summary) request, and the last one fits the window.
    expect(calls).toHaveLength(3);
    expect(messagesTokens(session.acceptedHistory().messages as any)).toBeLessThan(8192);
  });
});

describe('junk summaries are refused', () => {
  const span = 'a'.repeat(20_000);
  it.each([
    ['empty', ''], ['whitespace', '  \n '],
    ['tool-call markup', '<tool_call>\n<function=Read>\n<parameter=file_path>\n/x/ModelPicker.tsx\n</parameter>\n</function>\n</tool_call>'],
    ['bare function tag', '<function=Read><parameter=file_path>/x</parameter></function>'],
    ['bare JSON tool call', '{"name":"Read","arguments":{"file_path":"/x"}}'],
    ['too short for what it replaces', 'Done.'],
  ])('rejects %s', (_n, text) => { expect((compactionMod as any).isJunkSummary(text, span.length)).toBe(true); });
  it('accepts a real summary, even one that mentions a tool call in prose', () => {
    const real = '## Goal\nUser wants to know how the model picker sorts models. '.repeat(6) + 'I called the Read tool on ModelPicker.tsx.';
    expect((compactionMod as any).isJunkSummary(real, span.length)).toBe(false);
  });

  const seed = [{ role: 'user', content: 'old goal ' + 'x'.repeat(9000) }, { role: 'assistant', content: 'ack' },
    { role: 'user', content: 'next' }, { role: 'assistant', content: 'ack' }, { role: 'user', content: 'latest' }] as any;
  const MARKUP = '<tool_call>\n<function=Read>\n<parameter=file_path>\n/x\n</parameter>\n</function>\n</tool_call>';
  const GOOD = '## Goal\nThe user asked about the old goal and its large file contents. '.repeat(4);

  // `force` = the engine itself refused the request as too long (the only caller that forces).
  async function run(steps: any[], force = true) {
    const calls: any[] = []; const events: any[] = [];
    const model = spy(scriptModel(steps), calls);
    const session = makeSession({ contextLength: 8192, model, tools: [], onEvent: e => events.push(e) });
    session.seedHistory(seed.slice());
    const before = (session as any).history.slice();
    (session as any).abort = new AbortController();
    let result: boolean;
    try { result = await (session as any).maybeCompact(model, {}, force); } finally { (session as any).abort = null; }
    return { calls, events, session, before, result };
  }

  // WHY this changed (final review F1, 2026-11-12): this is the fault as it was logged — the ENGINE
  // refused the chat as too long while our own estimate said it fit, and the model then answered the
  // summary with tool-call markup twice. Keeping history left that chat a dead end.
  it('the engine refused the chat and the model answers junk twice: one retry, then the app-written note', async () => {
    const r = await run([{ text: MARKUP }, { text: MARKUP }]);
    expect(r.calls).toHaveLength(2);
    expect(r.result).toBe(true);
    expect((r.session as any).history[0].content).toContain('The app wrote this note, not the model.');
    expect((r.session as any).history[0].content).toContain('- old goal xxx');
    expect(r.events.filter(e => e.type === 'compact-summary')).toHaveLength(1);
  });
  it('junk then a real summary: the retry is committed', async () => {
    const r = await run([{ text: MARKUP }, { text: GOOD }]);
    expect(r.result).toBe(true);
    expect(r.calls).toHaveLength(2);
    expect((r.session as any).history[0].content).toContain('Goal');
  });
  it('a good first summary costs no retry', async () => {
    const r = await run([{ text: GOOD }]);
    expect(r.result).toBe(true);
    expect(r.calls).toHaveLength(1);
  });
  // Review deck 2 Q-3 (Destin, 2026-11-12): a chat always continues. `full` cannot be sent in an 8k
  // window at all, so a model that answers nonsense twice no longer leaves it stuck.
  const full = [{ role: 'user', content: 'old goal: check the big file' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'big', toolName: 'Read', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'big', toolName: 'Read', output: { type: 'text', value: 'y'.repeat(40_000) } }] },
    { role: 'assistant', content: 'read it' }, { role: 'user', content: 'latest' }] as any;
  async function runFull(model: any) {
    const events: any[] = [];
    const session = makeSession({ contextLength: 8192, model, tools: [], onEvent: e => events.push(e) });
    session.seedHistory(full.slice());
    const before = (session as any).history.slice();
    (session as any).abort = new AbortController();
    let result: boolean;
    try { result = await (session as any).maybeCompact(model, {}, false); } finally { (session as any).abort = null; }
    return { events, session, before, result };
  }
  it('a chat too full to send continues on the app-written note when the model answers junk twice', async () => {
    const calls: any[] = [];
    const r = await runFull(spy(scriptModel([{ text: MARKUP }, { text: MARKUP }]), calls));
    expect(calls).toHaveLength(2);
    expect(r.result).toBe(true);
    const history = (r.session as any).history as any[];
    expect(history[0].content).toContain('The app wrote this note, not the model.');
    expect(history[0].content).toContain('- old goal: check the big file');
    expect(JSON.stringify(history)).not.toContain('yyyyyyyyyy');
    expect(history[history.length - 1]).toEqual({ role: 'user', content: 'latest' });
    expect(r.events.filter(e => e.type === 'compact-summary')).toHaveLength(1);
  });
  it('a summary request that FAILS (engine down, no network) never drops history, even in a full chat', async () => {
    const throwing = new MockLanguageModelV4({ doStream: async () => { throw new Error('engine is not running'); } });
    const r = await runFull(throwing);
    expect(r.result).toBe(false);
    expect((r.session as any).history).toEqual(r.before);
    expect(r.events.filter(e => e.type === 'compact-summary')).toHaveLength(0);
  });
  it('Summarise pressed after the engine refused the chat falls back to the app-written note', async () => {
    const session = makeSession({ contextLength: 8192, model: scriptModel([{ text: MARKUP }, { text: MARKUP }]), tools: [] });
    session.seedHistory(seed.slice());
    (session as any).windowRefused = true;   // what a turn ending in the engine's too-long refusal leaves behind
    expect((await session.compactNow()).ok).toBe(true);
    expect((session as any).history[0].content).toContain('The app wrote this note, not the model.');
    expect((session as any).windowRefused).toBe(false);
  });
  it('manual compact with junk twice reports summary-failed and keeps history', async () => {
    const calls: any[] = [];
    const model = spy(scriptModel([{ text: MARKUP }, { text: MARKUP }]), calls);
    const session = makeSession({ contextLength: 8192, model, tools: [] });
    session.seedHistory(seed.slice());
    const before = (session as any).history.slice();
    expect(await session.compactNow()).toEqual({ ok: false, reason: 'summary-failed' });
    expect((session as any).history).toEqual(before);
  });
});

describe('one "too long" error', () => {
  it('the pre-check failure is classified too-long, like the engine refusal', async () => {
    const engine = classifyFailure({ statusCode: 400, responseBody: JSON.stringify({ error: { type: 'exceed_context_size_error' } }) });
    expect(engine.kind).toBe('too-long');
    const events: any[] = [];
    // Instructions alone larger than the window: nothing can be summarised away, so the pre-check refuses.
    const model = scriptModel([{ text: 'never' }]);
    const session = makeSession({ contextLength: 8192, model, tools: [], onEvent: e => events.push(e), systemPrompt: 'z'.repeat(60_000) });
    await session.send('go on');
    const err = events.find(e => e.type === 'session-error')?.data;
    expect(err).toBeTruthy();
    expect(err.errorKind).toBe('too-long');
    expect(err.errorCode).toBe(engine.code);
  });
});
