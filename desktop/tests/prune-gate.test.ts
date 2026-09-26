// Routine native compaction no longer prunes accepted history. Keep the
// historical failure class pinned: an unsuccessful handoff must not quietly
// rewrite the tool result the model already saw.
import { describe, it, expect } from 'vitest';
import { makeSession, scriptModel } from './helpers/harness-fakes';
import { pruneToolOutputs, type CompactionConfig } from '../src/main/harness/compaction';
import type { ModelMessage } from 'ai';

const toolResult = (value: string): ModelMessage => ({ role: 'tool', content: [{
  type: 'tool-result', toolCallId: 'c1', toolName: 'Read', output: { type: 'text', value },
}] } as ModelMessage);

const history = (): ModelMessage[] => [
  { role: 'user', content: 'read the file' },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: {} }] },
  toolResult('r'.repeat(20_000)),
  { role: 'assistant', content: 'read complete' },
  { role: 'user', content: 'continue' },
] as ModelMessage[];

describe('prune is not a routine compaction operation', () => {
  it('leaves accepted tool output whole when a manual summary fails', async () => {
    const session = makeSession({ contextLength: 16_384,
      model: scriptModel([{ throwError: 'summary model failed' }]) });
    const original = history();
    session.seedHistory(original);
    expect(await session.compactNow()).toEqual({ ok: false, reason: 'summary-failed' });
    expect((session as any).history).toEqual(original);
    expect((original[2] as any).content[0].output.value).toHaveLength(20_000);
  });

  it('does not prune the accepted result even if a summary copy is shortened', async () => {
    const session = makeSession({ contextLength: 8192,
      model: scriptModel([{ text: '## Goal\n- Continue.' }]) });
    const original = history();
    session.seedHistory(original);
    expect(await session.compactNow()).toEqual({ ok: true });
    expect((original[2] as any).content[0].output.value).toHaveLength(20_000);
    expect((session as any).history.at(-1)).toBe(original.at(-1));
  });

  it('keeps the legacy prune transform for decoding older snapshots', () => {
    const config: CompactionConfig = { contextLength: 8192, triggerTokens: 6000,
      protectedTokens: 0, minPruneSavings: 1, pruneToChars: 2000 };
    const result = pruneToolOutputs(history(), config);
    expect((result[2] as any).content[0].output.value).toContain('[pruned');
    expect((history()[2] as any).content[0].output.value).toHaveLength(20_000);
  });
});
