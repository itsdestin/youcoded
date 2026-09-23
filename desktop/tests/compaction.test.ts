import { describe, it, expect } from 'vitest';
import { planCompaction, pruneToolOutputs, estimateTokens, selectCompactionCut, fitSummaryToolOutputs, markSummaryInput, markAppGenerated, isAppGenerated, type CompactionConfig } from '../src/main/harness/compaction';
import type { ModelMessage } from 'ai';
import { rebuildHistory } from '../src/main/harness/history-rebuild';

const cfg: CompactionConfig = { contextLength: 8192, triggerTokens: 6144, protectedTokens: 4000, minPruneSavings: 1000, pruneToChars: 2000 };
const toolMsg = (id: string, chars: number): ModelMessage => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'Read', output: { type: 'text', value: 'x'.repeat(chars) } }] } as any);
const userMsg = (t: string): ModelMessage => ({ role: 'user', content: t } as any);

describe('planCompaction', () => {
  it('none when last-step input is under the trigger', () => {
    expect(planCompaction([userMsg('hi')], cfg, 100).action).toBe('none');
  });
  it('summarizes rather than routinely pruning over the trigger', () => {
    expect(planCompaction([toolMsg('a', 40_000), toolMsg('b', 40_000), userMsg('r')], cfg, 7000).action).toBe('summarize');
  });
  it('summarize when even pruning cannot get under budget', () => {
    const history = Array.from({ length: 20 }, (_, i) => userMsg('y'.repeat(3000) + i));
    expect(planCompaction(history, cfg, 8000).action).toBe('summarize');
  });
});

describe('summarizer-only tool output fitting', () => {
  it('shortens the largest tool outputs first without mutating history or splitting parallel results', () => {
    const original = [userMsg('do this'), toolMsg('large', 12_000), toolMsg('small', 4000), userMsg('continue')];
    const snapshot = JSON.stringify(original);
    const cap = estimateTokens(original) - 900;
    const copy = fitSummaryToolOutputs(original, cap);
    expect(copy).not.toBeNull();
    expect(estimateTokens(copy!)).toBeLessThanOrEqual(cap);
    expect((copy![1] as any).content[0].output.value).toContain('[output shortened]');
    expect((copy![2] as any).content[0].output.value).toHaveLength(4000);
    expect(copy![0]).toBe(original[0]);
    expect(copy![3]).toBe(original[3]);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
  it('shortens only eligible text inside content outputs, largest first, without touching files or accepted history', () => {
    const large = 'L'.repeat(12000);
    const small = 's'.repeat(1000);
    const content = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'Read', output: { type: 'content', value: [
      { type: 'text', text: large }, { type: 'file', mediaType: 'image/png', data: Buffer.from([1, 2]) }, { type: 'text', text: small },
    ] } }] } as any;
    const history = [userMsg('goal'), content, userMsg('next')];
    const snapshot = JSON.stringify(history);
    const cap = estimateTokens(history) - 500;
    const copy = fitSummaryToolOutputs(history, cap);
    expect(copy).not.toBeNull();
    expect(estimateTokens(copy!)).toBeLessThanOrEqual(cap);
    const parts = (copy![1] as any).content[0].output.value;
    expect(parts[0].text).toContain('[output shortened]');
    expect(parts[1]).toBe(content.content[0].output.value[1]);
    expect(parts[2]).toBe(content.content[0].output.value[2]);
    expect(JSON.stringify(history)).toBe(snapshot);
    expect(copy![0]).toBe(history[0]);
    expect(copy![2]).toBe(history[2]);
  });
  it('returns unchanged copy when it fits, and refuses when only user content is oversized', () => {
    const history = [userMsg('x'.repeat(8000))];
    expect(fitSummaryToolOutputs(history, estimateTokens(history))).toEqual(history);
    expect(fitSummaryToolOutputs(history, 5)).toBeNull();
  });
});

describe('group-safe retained tail', () => {
  const call = (ids: string[]) => ({ role: 'assistant', content: ids.map(id => ({ type: 'tool-call', toolCallId: id, toolName: 'Read', input: {} })) } as any);
  const result = (id: string) => toolMsg(id, 100);
  it('splits a long first turn between complete parallel batches, including multi-message results', () => {
    const history = [userMsg('goal'), call(['a', 'b']), result('a'), result('b'),
      { role: 'assistant', content: 'working'.repeat(100) } as any,
      call(['c', 'd']), result('c'), result('d'), { role: 'assistant', content: 'done' } as any];
    const tail = estimateTokens(history.slice(5));
    expect(selectCompactionCut(history, tail)).toBe(5);
    expect(selectCompactionCut(history, estimateTokens(history.slice(6)))).toBe(5);
  });
  it('prefers full turns; notices are not user turns; keeps a newest oversized group whole', () => {
    const notice = markAppGenerated(userMsg('background finished'));
    const history = [userMsg('long task'.repeat(200)), { role: 'assistant', content: 'work'.repeat(200) } as any,
      notice, markAppGenerated(userMsg('background finished again'))];
    expect(selectCompactionCut(history, estimateTokens(history.slice(2)))).toBe(0);
    expect(selectCompactionCut(history, 1)).toBe(0);
    expect(selectCompactionCut([userMsg('only')], 1)).toBe(0);
    expect(selectCompactionCut([], 100)).toBe(0);
  });
  it('retains the whole newest no-tool turn when its reply alone exceeds the tail allowance', () => {
    const history = [userMsg('old'), { role: 'assistant', content: 'old answer' } as any,
      userMsg('new request'), { role: 'assistant', content: 'oversized reply'.repeat(100) } as any];
    const cut = selectCompactionCut(history, 1);
    expect(cut).toBe(2);
    expect(history.slice(cut).map(m => m.content)).toEqual(['new request', history[3].content]);
  });
  it('does not cut off an oversized no-tool request when its short reply fits', () => {
    const history = [userMsg('old'), { role: 'assistant', content: 'old answer' } as any,
      userMsg('new request'.repeat(200)), { role: 'assistant', content: 'short reply' } as any];
    const tail = estimateTokens(history.slice(3));
    expect(selectCompactionCut(history, tail)).toBe(2);
    expect(history.slice(selectCompactionCut(history, tail))).toEqual(history.slice(2));
  });
  it('keeps an oversized no-tool turn with its trailing app notices', () => {
    const notice = markAppGenerated(userMsg('background finished'));
    const history = [userMsg('old'), { role: 'assistant', content: 'old answer' } as any,
      userMsg('new request'), { role: 'assistant', content: 'large reply'.repeat(200) } as any, notice];
    expect(selectCompactionCut(history, estimateTokens([notice]))).toBe(2);
    expect(history.slice(selectCompactionCut(history, 1))).toEqual(history.slice(2));
  });
  it('retains image-bearing result with its call, and handles no-tool chat', () => {
    const image = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'img', toolName: 'Read', output: { type: 'content', value: [{ type: 'file', mediaType: 'image/png', data: Buffer.alloc(1000) }] } }] } as any;
    const history = [userMsg('first'), { role: 'assistant', content: 'answer' } as any, userMsg('second'), call(['img']), image];
    expect(selectCompactionCut(history, estimateTokens(history.slice(2)))).toBe(2);
    expect(selectCompactionCut(history, 1)).toBe(3);
  });
  it.each([
    {
      name: 'long first turn: split after a completed batch, not at a result or follow-up',
      build: () => [userMsg('goal'), call(['a']), result('a'), { role: 'assistant', content: 'progress'.repeat(300) } as any,
        call(['b']), result('b'), { role: 'assistant', content: 'done' } as any],
      tailFrom: 5, expected: 4,
    },
    {
      name: 'oversized newest parallel batch with multi-message results and trailing notices',
      build: () => [userMsg('goal'), call(['a']), result('a'), call(['b', 'c']),
        toolMsg('b', 10_000), result('c'), toolMsg('b', 100),
        { role: 'assistant', content: 'done' } as any,
        markAppGenerated(userMsg('helper finished')), markAppGenerated(userMsg('another helper finished'))],
      tailFrom: 8, expected: 3,
    },
    {
      name: 'oversized no-tool turn with reply and notices',
      build: () => [userMsg('old'), { role: 'assistant', content: 'old answer' } as any,
        userMsg('new'.repeat(1000)), { role: 'assistant', content: 'reply' } as any,
        markAppGenerated(userMsg('notice'))],
      tailFrom: 4, expected: 2,
    },
    {
      name: 'parallel batch with image and separate result messages',
      build: () => [userMsg('old'), call(['old']), result('old'),
        call(['img', 'text']), { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'img', toolName: 'Read', output: { type: 'content', value: [{ type: 'file', mediaType: 'image/png', data: Buffer.alloc(10_000) }] } }] } as any,
        result('text'), toolMsg('img', 100), markAppGenerated(userMsg('notice'))],
      tailFrom: 7, expected: 3,
    },
    {
      name: 'no recent messages: only app notices attach to the preceding reply',
      build: () => [userMsg('old'), { role: 'assistant', content: 'reply'.repeat(300) } as any,
        markAppGenerated(userMsg('notice')), markAppGenerated(userMsg('notice 2'))],
      tailFrom: 2, expected: 0,
    },
    {
      name: 'no recent messages: empty history',
      build: () => [], tailFrom: 0, expected: 0,
    },
  ])('$name', ({ build, tailFrom, expected }) => {
    const history = build();
    expect(selectCompactionCut(history, estimateTokens(history.slice(tailFrom)))).toBe(expected);
    if (history.length) {
      expect(selectCompactionCut(history, 1)).toBe(expected);
      expect(selectCompactionCut(history, 0)).toBe(expected);
    }
  });
  it('indexes the last result of each call without rescanning the remaining history for every call', () => {
    const size = 200;
    let contentReads = 0;
    const watchedResult = (id: string): ModelMessage => {
      const message = result(id);
      return new Proxy(message, { get(target, key, receiver) {
        if (key === 'content') contentReads++;
        return Reflect.get(target, key, receiver);
      } });
    };
    const history = [userMsg('goal'), ...Array.from({ length: size }, (_, i) =>
      [call([`id-${i}`]), watchedResult(`id-${i}`)]).flat(), userMsg('next')];
    expect(selectCompactionCut(history, estimateTokens(history.slice(-1)))).toBe(history.length - 1);
    // Message sizing reads each result once; indexing should read each result
    // only a bounded number of additional times, independent of call count.
    expect(contentReads).toBeLessThan(size * 10);
  });
  it('pairs a call with its last matching result, even after a later batch', () => {
    const history = [userMsg('goal'), call(['a']), result('a'), call(['b']), result('b'),
      result('a'), userMsg('next')];
    expect(selectCompactionCut(history, estimateTokens(history.slice(3)))).toBe(6);
    expect(selectCompactionCut(history.slice(0, -1), 1)).toBe(1);
    // Missing results still keep the call's batch indivisible to the end.
    expect(selectCompactionCut([userMsg('goal'), call(['missing']), userMsg('next')], 1)).toBe(1);
  });
  it('preserves text and image parts of a marked user message in a summary-only copy', () => {
    const image = { type: 'image', image: Buffer.from([1, 2, 3]), mediaType: 'image/png' };
    const text = { type: 'text', text: 'status with screenshot' };
    const original = markAppGenerated({ role: 'user', content: [text, image] } as ModelMessage);
    const copy = markSummaryInput([original])[0];
    expect(copy).not.toBe(original);
    expect(copy.content).toEqual([{ type: 'text', text: '[App-generated, not from the user]' }, text, image]);
    expect((copy as any).content[1]).toBe(text);
    expect((copy as any).content[2]).toBe(image);
    expect(original.content).toEqual([text, image]);
  });
  it('labels only app-authored user-role content in a summary copy', () => {
    const original = [userMsg('fix this'), markAppGenerated(userMsg('finished')), userMsg('<project-rule source="x">rules</project-rule>'), userMsg('[Earlier conversation summary]\nold')];
    const copy = markSummaryInput(original);
    expect(copy[0].content).toBe('fix this');
    expect(copy[1].content).toContain('[App-generated, not from the user]');
    expect(copy.slice(2).map(m => m.content)).toEqual(original.slice(2).map(m => m.content));
    expect(original.slice(2).every(isAppGenerated)).toBe(false);
    expect(original[1].content).toBe('finished');
  });
  it('does not infer origin from a human message resembling an app marker', () => {
    for (const text of ['<project-rule source="x">hi</project-rule>', '[Earlier conversation summary]\nhi', '<specialists-status>hi', '[App-generated, not from the user]\nhi']) {
      const message = userMsg(text);
      expect(isAppGenerated(message)).toBe(false);
      expect(markSummaryInput([message])[0]).toBe(message);
      expect(isAppGenerated(rebuildHistory([{ type: 'user-message', data: { text } }] as any)[0])).toBe(false);
    }
  });
  it('retains skill-body provenance through event reconstruction', () => {
    const history = rebuildHistory([{ type: 'skill-invoked', data: { body: 'skill instructions', args: 'user arguments' } }] as any);
    expect(markSummaryInput(history)[0].content).toBe('[App-generated, not from the user]\nskill instructions\n\nuser arguments');
  });
  it('retains injected provenance through event reconstruction', () => {
    const events = [
      { type: 'user-message', data: { text: 'fix login' } },
      { type: 'user-message', data: { text: 'helper finished', injected: 'specialist-report' } },
    ] as any;
    const history = rebuildHistory(events);
    expect(markSummaryInput(history).map(m => m.content)).toEqual([
      'fix login', '[App-generated, not from the user]\nhelper finished',
    ]);
    expect(history[1].content).toBe('helper finished');
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
