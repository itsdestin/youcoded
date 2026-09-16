import { describe, it, expect } from 'vitest';
import { planCompaction, pruneToolOutputs, estimateTokens, type CompactionConfig } from '../src/main/harness/compaction';
import type { ModelMessage } from 'ai';

const cfg: CompactionConfig = { contextLength: 8192, triggerTokens: 6144, protectedTokens: 4000, minPruneSavings: 1000, pruneToChars: 2000 };
const toolMsg = (id: string, chars: number): ModelMessage => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'Read', output: { type: 'text', value: 'x'.repeat(chars) } }] } as any);
const userMsg = (t: string): ModelMessage => ({ role: 'user', content: t } as any);

describe('planCompaction', () => {
  it('none when last-step input is under the trigger', () => {
    expect(planCompaction([userMsg('hi')], cfg, 100).action).toBe('none');
  });
  it('prune when over trigger and pruning frees enough', () => {
    expect(planCompaction([toolMsg('a', 40_000), toolMsg('b', 40_000), userMsg('r')], cfg, 7000).action).toBe('prune');
  });
  it('summarize when even pruning cannot get under budget', () => {
    const history = Array.from({ length: 20 }, (_, i) => userMsg('y'.repeat(3000) + i));
    expect(planCompaction(history, cfg, 8000).action).toBe('summarize');
  });
});

describe('pruneToolOutputs', () => {
  it('truncates tool outputs OUTSIDE the protected window; protected ones untouched', () => {
    const pruned = pruneToolOutputs([toolMsg('old', 40_000), userMsg('mid'), toolMsg('recent', 40_000)], cfg);
    expect((pruned[0] as any).content[0].output.value.length).toBeLessThanOrEqual(cfg.pruneToChars + 128);
    expect((pruned[0] as any).content[0].output.value).toContain('[pruned');
    expect((pruned[2] as any).content[0].output.value.length).toBe(40_000);
  });
  it('never truncates a non-tool message', () => {
    expect((pruneToolOutputs([userMsg('u'.repeat(40_000))], cfg)[0] as any).content).toBe('u'.repeat(40_000));
  });

  it('prunes an image content-output outside the protected window down to its text + a named note', () => {
    const imageMsg = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'content', value: [{ type: 'text', text: 'Read image shot.png' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: Buffer.alloc(500_000) } }] } }] } as any;
    const filler = { role: 'user', content: 'x'.repeat(8_000) } as any;   // pushes imageMsg outside protectedTokens
    const out = pruneToolOutputs([imageMsg, filler], { contextLength: 32_768, triggerTokens: 26_214, protectedTokens: 1_000, minPruneSavings: 100, pruneToChars: 4_000 });
    const output = (out[0] as any).content[0].output;
    expect(output.type).toBe('text');
    expect(output.value).toContain('Read image shot.png');
    expect(output.value).toContain('[image pruned');
    expect(JSON.stringify(out[0])).not.toContain('"data"');
  });

  it('returns an UNCHANGED tool message by identity, and only a really-pruned one as a new object', () => {
    // WHY identity matters here (cache Stage 4): the harness decides whether a
    // compaction really changed history by diffing this array PER MESSAGE
    // (harness-session.ts, maybeCompact/compactNow). Rebuilding a message whose
    // parts are all untouched makes that diff fire on a genuine no-op, which
    // bumps the accepted-history revision and invalidates a published
    // checkpoint for a history that is byte-for-byte what it was.
    const short = toolMsg('short', 10);              // already under pruneToChars
    const big = toolMsg('big', 40_000);              // the only real prune
    const filler = userMsg('x'.repeat(40_000));      // pushes both tool messages out of the window
    const out = pruneToolOutputs([short, big, filler], cfg);
    expect(out[0]).toBe(short);
    expect(out[1]).not.toBe(big);
    expect(out[2]).toBe(filler);                     // non-tool messages were always by identity
    // Byte-identical output otherwise: the pruned message is still pruned, and
    // the untouched one still carries all 10 characters.
    expect((out[1] as any).content[0].output.value).toContain('[pruned');
    expect((out[0] as any).content[0].output.value).toBe('x'.repeat(10));
  });

  it('leaves an image content-output INSIDE the protected window untouched', () => {
    // Same shape as the prune case above, but nothing pushes it out of the
    // protected window — the image must survive byte-for-byte.
    const imageMsg = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'content', value: [{ type: 'text', text: 'Read image shot.png' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: Buffer.alloc(500) } }] } }] } as any;
    const out = pruneToolOutputs([imageMsg], { contextLength: 32_768, triggerTokens: 26_214, protectedTokens: 100_000, minPruneSavings: 100, pruneToChars: 4_000 });
    expect((out[0] as any).content[0].output.type).toBe('content');
  });
});
