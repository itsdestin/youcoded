// Pruning is gated on the decision (cache follow-ups item 3).
//
// `planCompaction` already batches pruning: it answers 'prune' only when
// pruning reclaims at least `minPruneSavings`. The per-step slide came from
// `maybeCompact` pruning on the 'summarize' path TOO ("always prune first"),
// where a summary that then bails (too few user turns, a trivial span, a failed
// call) left a small, fresh edit standing in the middle of the history — a
// prefix move on every such step, so every provider re-billed everything after
// it. Now the history is touched only when the decision is 'prune' or a summary
// actually succeeds. Three consecutive requests in the stuck case must go out
// byte-identical.
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { ModelMessage } from 'ai';
import { makeSession, scriptModel, drainTurn, HARNESS, type ScriptStep } from './helpers/harness-fakes';

function promptCapturingModel(steps: ScriptStep[], prompts: any[][]) {
  const inner = scriptModel(steps);
  return new MockLanguageModelV4({
    doStream: async (options: any) => { prompts.push(options.prompt); return inner.doStream(options); },
  });
}
const PRODUCTION_RESERVE = { ...HARNESS, limits: { maxTokens: 16_000 } };

// 16k window with the production reserve → protected tail 6,553 tokens,
// minPruneSavings 1,638, trigger 10,137. One old 6,000-char Read result (would
// prune to 2,000: saves ~1,000 < 1,638, so the decision is 'summarize'), pushed
// OUTSIDE the protected tail by ~7,000 tokens of later conversation. Every step
// reports 13,000 prompt tokens (above the old 12,288 trigger too), so compaction
// is consulted on every step.
const TOOL_RESULT = 'r'.repeat(6000);
function seeded(): ModelMessage[] {
  return [
    { role: 'user', content: 'read the file' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: { file_path: 'big.txt' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'Read', output: { type: 'text', value: TOOL_RESULT } }] },
    { role: 'assistant', content: 'here is a long answer ' + 'w'.repeat(28_000) },
  ] as any;
}
const toolResultText = (prompt: any[]) => prompt.find((m) => m.role === 'tool')?.content?.[0]?.output?.value ?? prompt.find((m) => m.role === 'tool')?.content?.[0]?.result;
const prefixOf = (prompt: any[], n: number) => JSON.stringify(prompt.filter((m) => m.role !== 'system').slice(0, n));

describe('prune is gated on the compaction decision', () => {
  it('summarize path that bails (one real user turn, three steps): the old tool result is left whole and the prefix is byte-identical across steps', async () => {
    const prompts: any[][] = [];
    // One turn, three steps: two tool calls then the answer. Only ONE real user
    // turn exists besides the new one, so the cut is 0 on every step and the
    // summary bails every step — the stuck case that used to prune each time.
    const session = makeSession({
      contextLength: 16_384, harness: PRODUCTION_RESERVE,
      model: promptCapturingModel([
        { toolCalls: [{ name: 'Glob', input: { pattern: '*.md' } }], usage: { inputTokens: 13_000 } },
        { toolCalls: [{ name: 'Glob', input: { pattern: '*.ts' } }], usage: { inputTokens: 13_000 } },
        { text: 'done', usage: { inputTokens: 13_000 } },
      ], prompts),
    });
    session.seedHistory(seeded());
    await drainTurn(session, 'thanks');
    expect(prompts).toHaveLength(3);
    for (const p of prompts) expect(toolResultText(p)).toHaveLength(6000);
    expect(prefixOf(prompts[1], 4)).toBe(prefixOf(prompts[0], 4));
    expect(prefixOf(prompts[2], 4)).toBe(prefixOf(prompts[0], 4));
  });

  it('summarize path whose summary call fails: history is left untouched, not left pruned', async () => {
    const prompts: any[][] = []; const events: any[] = [];
    const session = makeSession({
      contextLength: 16_384, harness: PRODUCTION_RESERVE, onEvent: (e) => events.push(e),
      model: promptCapturingModel([
        { text: 'a', usage: { inputTokens: 13_000 } },
        { throwError: 'summary model exploded' },   // turn 2's summary call: cut > 0 now, span is the whole seed
        { text: 'b', usage: { inputTokens: 13_000 } },
      ], prompts),
    });
    session.seedHistory(seeded());
    await drainTurn(session, 'thanks');
    await drainTurn(session, 'and then?');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'turn-complete')).toHaveLength(2);
    // prompts: turn 1, the failed summary call, turn 2 — both REQUESTS still carry the whole result.
    const requests = prompts.filter((p) => !p.some((m) => m.role === 'user' && typeof m.content?.[0]?.text === 'string' && m.content[0].text.startsWith('Summarize the conversation')));
    expect(requests).toHaveLength(2);
    for (const p of requests) expect(toolResultText(p)).toHaveLength(6000);
    expect(prefixOf(requests[1], 4)).toBe(prefixOf(requests[0], 4));
  });

  it('a real prune decision still prunes (the batched path is unchanged)', async () => {
    const prompts: any[][] = [];
    const session = makeSession({
      contextLength: 16_384, harness: PRODUCTION_RESERVE,
      model: promptCapturingModel([{ text: 'a', usage: { inputTokens: 13_000 } }, { text: 'b', usage: { inputTokens: 13_000 } }], prompts),
    });
    const big = seeded();
    // A 20,000-char result prunes to 2,000: saves ~4,500 ≥ 1,638 → 'prune'.
    (big[2] as any).content[0].output.value = 'r'.repeat(20_000);
    session.seedHistory(big);
    await drainTurn(session, 'thanks');
    await drainTurn(session, 'and then?');
    expect(toolResultText(prompts[1])).not.toHaveLength(20_000);
    expect(toolResultText(prompts[1])).toContain('[pruned');
  });
});
