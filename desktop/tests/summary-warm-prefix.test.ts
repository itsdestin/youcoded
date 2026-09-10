// The compaction summary reuses the conversation's warm prefix (cache
// follow-ups item 4).
//
// The summary used to be a fresh prompt: a different system text ("You compress
// conversation history…"), no tools, the span with images stripped. Every byte
// of it differed from the conversation the provider had just cached, so the
// summary call paid full price for the whole span once more. Providers whose
// cache is a hash over the prompt prefix (OpenAI/ChatGPT, DeepSeek, llama.cpp)
// read the span warm when the summary request starts with EXACTLY the bytes the
// chat request started with: same system text, same tools, the span itself
// (which IS the front of the history), then one instruction. `toolChoice:
// 'none'` makes a tool call impossible without a retry ladder. (Anthropic's SDK
// drops the tools on 'none', so there the call is simply the plain 1x request
// it always was — and carries no cache marker, see prompt-cache.test.ts.)
//
// The summary's cost also stops vanishing: it rides the compact-summary event.
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { makeSession, scriptModel, drainTurn, HARNESS, type ScriptStep } from './helpers/harness-fakes';

/** A scripted model that records every call's full options. */
function optionsCapturingModel(steps: ScriptStep[], calls: any[]) {
  const inner = scriptModel(steps);
  return new MockLanguageModelV4({
    doStream: async (options: any) => { calls.push(options); return inner.doStream(options); },
  });
}
const text = (m: any) => (typeof m.content === 'string' ? m.content : m.content?.map((p: any) => p.text ?? '').join(''));

describe('compaction summary request', () => {
  it('starts with the chat request\'s own system text and tools, then the span as it stands in history, then one instruction — tool use disabled', async () => {
    const calls: any[] = []; const events: any[] = [];
    // A history that FITS the window (13k of 16k) but is past the trigger — the
    // ordinary case, where the span must not be front-trimmed for the summary.
    const session = makeSession({
      contextLength: 16_384, seedBulkHistoryTokens: 13_000, onEvent: (e) => events.push(e),
      model: optionsCapturingModel([{ text: 'SUMMARY.' }, { text: 'answer' }], calls),
    });
    await drainTurn(session, 'continue');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(1);
    const [summaryCall, turnCall] = calls;
    // Same system text as the conversation, byte for byte.
    expect(summaryCall.prompt[0].role).toBe('system');
    expect(summaryCall.prompt[0].content).toBe(turnCall.prompt[0].content);
    // Same tools, in the same order; tool use switched off for this one call.
    expect(summaryCall.tools?.map((t: any) => t.name)).toEqual(turnCall.tools?.map((t: any) => t.name));
    expect(summaryCall.tools?.length).toBeGreaterThan(0);
    expect(summaryCall.toolChoice).toEqual({ type: 'none' });
    expect(turnCall.toolChoice).not.toEqual({ type: 'none' });
    // The span: 13 seeded messages (~1000 tokens each, users at the odd indices,
    // the last at 11) plus the new user turn put the cut at index 11, so the
    // summary reads messages 0–10 exactly as they sit at the front of the
    // history — nothing front-trimmed — then the instruction.
    const body = summaryCall.prompt.slice(1);
    expect(body).toHaveLength(11 + 1);
    expect(text(body[0])).toMatch(/^bulk 0 /);
    expect(text(body[10])).toMatch(/^bulk 10 /);
    expect(text(body[11])).toMatch(/^Summarize the conversation so far/);
  });

  it('reads the span exactly as the previous request sent it — a prunable tool result is NOT pruned for the summary', async () => {
    // Review finding (2026-09-10): the summary was handed a pruned COPY of the
    // span, but the provider cached the UNPRUNED bytes the chat request sent —
    // so on any conversation with a moderate tool result the summary's prefix
    // diverged at that message and everything after it was billed cold.
    const calls: any[] = []; const events: any[] = [];
    const session = makeSession({
      contextLength: 16_384, harness: { ...HARNESS, limits: { maxTokens: 16_000 } }, onEvent: (e) => events.push(e),
      model: optionsCapturingModel([
        { text: 'a', usage: { inputTokens: 13_000 } },   // turn 1 (cut is 0, no summary)
        { text: 'SUMMARY.' },                             // turn 2's summary call
        { text: 'b' },                                    // turn 2's reply
      ], calls),
    });
    // One 6,000-char Read result pushed outside the protected tail by ~7,000
    // tokens of later text: prunable (to 2,000 chars), but savings < minPruneSavings.
    session.seedHistory([
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: { file_path: 'big.txt' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'Read', output: { type: 'text', value: 'r'.repeat(6000) } }] },
      { role: 'assistant', content: 'here is a long answer ' + 'w'.repeat(28_000) },
    ] as any);
    await drainTurn(session, 'thanks');
    await drainTurn(session, 'and then?');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(1);
    const [turn1, summaryCall] = calls;
    // The span is the first four messages of turn 1's request, byte for byte.
    const strip = (p: any[]) => JSON.stringify(p.filter((m) => m.role !== 'system').slice(0, 4));
    expect(strip(summaryCall.prompt)).toBe(strip(turn1.prompt));
    expect(summaryCall.prompt.find((m: any) => m.role === 'tool').content[0].output.value).toHaveLength(6000);
  });

  it('reports the summary call\'s own token usage on the compact-summary event', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => events.push(e),
      model: scriptModel([{ text: 'SUMMARY.', usage: { inputTokens: 4321, outputTokens: 55 } }, { text: 'answer' }]),
    });
    await drainTurn(session, 'continue');
    const [compaction] = events.filter((e) => e.type === 'compact-summary');
    expect(compaction.data.usage).toEqual(expect.objectContaining({ inputTokens: 4321, outputTokens: 55 }));
  });
});
