// Single-operation compaction wired into the driver. The planner keeps
// complete tool groups, summarizes once near the window limit, and leaves
// history untouched on failure. Only a legacy reopened history can use the
// request-only emergency fit; budget math lives in compaction-budget.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { messagesTokens, requestFixedTokens, messageTokens } from '../src/main/harness/message-size';
import { planContextBudget, summarizePrompt } from '../src/main/harness/compaction';
import { MockLanguageModelV4 } from 'ai/test';
import { makeSession, scriptModel, drainTurn, hangingFirstCallModel, HARNESS } from './helpers/harness-fakes';
import { markAppGenerated } from '../src/main/harness/compaction';
import { stream, textChunks, finishChunk } from './helpers/scripted-model';
import { COMPACTION_PROMPT } from '../src/main/harness/prompts/compaction';

it('compaction prompt carries handoff structure, provenance rules, and active Goal across notices', () => {
  expect(COMPACTION_PROMPT).toContain('## Goal');
  expect(COMPACTION_PROMPT).toContain('## User decisions');
  expect(COMPACTION_PROMPT).toContain('direct user choices or explicit approvals');
  expect(COMPACTION_PROMPT).toContain('older user request in Goal');
  expect(COMPACTION_PROMPT).toContain('up to 3 short exact quotations');
});

describe('driver compaction', () => {
  it('checks fresh input even after a low-usage completed turn, without front trimming', async () => {
    const calls: any[] = [];
    const inner = scriptModel([{ text: 'handoff', usage: { inputTokens: 3800 } }, { text: 'done' }]);
    const model = new MockLanguageModelV4({ doStream: async (o: any) => { calls.push(o); return inner.doStream(o); } });
    const events: any[] = [];
    const session = makeSession({ contextLength: 8192, model, tools: [], onEvent: e => events.push(e) });
    await session.send('first task ' + 'a'.repeat(15000));
    await session.send('new large request ' + 'x'.repeat(9000));
    expect(events.filter(e => e.type === 'compact-summary')).toHaveLength(1);
    expect(events.filter(e => e.type === 'turn-complete')).toHaveLength(2);
    expect(calls[1].prompt.some((m: any) => JSON.stringify(m).includes('first task'))).toBe(true);
  });

  it('does not run a second automatic summary for the exact failed history', async () => {
    const calls: any[] = [];
    const inner = scriptModel([{ throwError: 'summary unavailable' }]);
    const model = new MockLanguageModelV4({ doStream: async (o: any) => { calls.push(o); return inner.doStream(o); } });
    const session = makeSession({ contextLength: 8192, model, tools: [] });
    session.seedHistory([{ role: 'user', content: 'goal ' + 'a'.repeat(12000) },
      { role: 'assistant', content: 'ack' }, { role: 'user', content: 'continue ' + 'b'.repeat(11000) }] as any);
    (session as any).abort = new AbortController();
    try {
      expect(await (session as any).maybeCompact(model, {})).toBe(false);
      expect(await (session as any).maybeCompact(model, {})).toBe(false);
      expect(calls).toHaveLength(1);
    } finally { (session as any).abort = null; }
  });

  it('a failed summary fences the same history; new input releases the fence without inventing a summary', async () => {
    const calls: any[] = [];
    const inner = scriptModel([{ throwError: 'summary failed' }, { text: 'done' }, { text: 'handoff' }, { text: 'done' }]);
    const model = new MockLanguageModelV4({ doStream: async (o: any) => { calls.push(o); return inner.doStream(o); } });
    const events: any[] = [];
    const session = makeSession({ contextLength: 8192, model, tools: [], onEvent: e => events.push(e) });
    session.seedHistory([{ role: 'user', content: 'original ' + 'a'.repeat(12000) }, { role: 'assistant', content: 'ack' }] as any);
    await session.send('continue ' + 'c'.repeat(9000));
    expect(events.filter(e => e.type === 'compact-summary')).toHaveLength(0);
    expect(calls).toHaveLength(2);
    await session.send('new input ' + 'b'.repeat(500));
    expect(calls.length).toBeGreaterThan(2);
    expect((session as any).failedCompactionRevision).not.toBe((session as any).capture.revision);
    expect(events.filter(e => e.type === 'compact-summary')).toHaveLength(0);
  });

  it('fits only the outgoing request on an old reopened history whose summary cannot fit', async () => {
    const prompts: any[] = [];
    const inner = scriptModel([{ text: 'done' }]);
    const model = new MockLanguageModelV4({ doStream: async (options: any) => {
      prompts.push(options.prompt); return inner.doStream(options);
    } });
    const events: any[] = [];
    const session = makeSession({ contextLength: 8192, tools: [],
      harness: { ...HARNESS, limits: { maxTokens: 16_000 } },
      model, onEvent: e => events.push(e) });
    session.seedHistory([{ role: 'user', content: 'old goal ' + 'x'.repeat(24_000) },
      { role: 'assistant', content: 'ack' }, { role: 'user', content: 'recent question' }] as any);
    await session.send('continue');
    expect(events.filter(e => e.type === 'compact-summary')).toHaveLength(0);
    expect(prompts).toHaveLength(1); // no unsafe summary call
    expect(JSON.stringify(prompts[0])).not.toContain('x'.repeat(24_000));
    expect(JSON.stringify(session.acceptedHistory().messages)).toContain('x'.repeat(24_000));
    expect(events.some(e => e.type === 'turn-complete')).toBe(true);
  });

  it('rejects a completed summary that leaves too little room for the next request', async () => {
    const events: any[] = [];
    const session = makeSession({ contextLength: 8192, onEvent: e => events.push(e),
      model: scriptModel([{ text: 'x'.repeat(12_000) }]) });
    session.seedHistory([{ role: 'user', content: 'original goal' },
      { role: 'assistant', content: 'working '.repeat(1000) },
      { role: 'user', content: 'continue' }] as any);
    const original = (session as any).history.slice();
    expect(await session.compactNow()).toEqual({ ok: false, reason: 'summary-failed' });
    expect((session as any).history).toEqual(original);
    expect(events.filter(e => e.type === 'compact-summary')).toHaveLength(0);
  });
  it('reserves margin and final instruction message framing when fitting summary input', async () => {
    const calls: any[] = [];
    const inner = scriptModel([{ text: 'summary' }]);
    const model = new MockLanguageModelV4({ doStream: async (options: any) => {
      calls.push(options); return inner.doStream(options);
    } });
    const session = makeSession({ contextLength: 8192, model });
    const span = [
      { role: 'user', content: 'goal' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'big', toolName: 'Read', output: { type: 'text', value: 'x'.repeat(28000) } }] },
    ] as any;
    (session as any).abort = new AbortController();
    try {
      await (session as any).generateSummary(model, span, {});
      expect(calls).toHaveLength(1);
      const plan = planContextBudget({ contextLength: 8192,
        fixedCost: requestFixedTokens((session as any).systemText, {}),
        summaryOverhead: Math.ceil(summarizePrompt().length / 4), maxTokens: 256 });
      const body = calls[0].prompt.filter((m: any) => m.role !== 'system');
      const sentSpan = body.slice(0, -1);
      expect(plan.fixedCost + messagesTokens(sentSpan) + messageTokens({ role: 'user', content: summarizePrompt() })
        + plan.summaryAllowance + plan.margin).toBeLessThanOrEqual(plan.contextLength);
    } finally { (session as any).abort = null; }
  });

  it('cleans a throwing summary stream watchdog before a subsequent operation', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const model = new MockLanguageModelV4({ doStream: async () => ({
        stream: new ReadableStream({ start(controller) {
          for (const chunk of stream(...textChunks('t', calls++ ? 'summary' : 'first'), finishChunk('stop'))) controller.enqueue(chunk);
          controller.close();
        } }),
      }) });
      const session = makeSession({ model });
      // Force the consumer (not SDK setup) to throw during a text chunk.
      // This pinpoints the finally path after the watchdog has been armed.
      let watchdog: (() => void) | null = null;
      Object.defineProperty(session, 'rearmSummaryWatchdog', {
        configurable: true,
        set(fn: (() => void) | null) { watchdog = fn ? () => { throw new Error('stream consumer broke'); } : null; },
        get() { return watchdog; },
      });
      const span = [{ role: 'user', content: 'goal' }] as any;
      const first = new AbortController();
      (session as any).abort = first;
      const failed = (session as any).generateSummary(model, span, {});
      const rejection = expect(failed).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
      expect((session as any).rearmSummaryWatchdog).toBeNull();
      delete (session as any).rearmSummaryWatchdog;
      const next = new AbortController();
      (session as any).abort = next;
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      expect(next.signal.aborted).toBe(false);
      const succeeded = expect((session as any).generateSummary(model, span, {})).resolves.toMatchObject({ text: 'summary' });
      await vi.advanceTimersByTimeAsync(0);
      await succeeded;
      expect(next.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('shortens an oversized retired tool output only in the summary request', async () => {
    const calls: any[] = [];
    const inner = scriptModel([{ text: '## Goal\n- Continue the task.' }]);
    const model = new MockLanguageModelV4({ doStream: async (options: any) => {
      calls.push(options);
      return inner.doStream(options);
    } });
    const session = makeSession({ contextLength: 8192, model });
    const history = [
      { role: 'user', content: 'original goal' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'big', toolName: 'Read', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'big', toolName: 'Read', output: { type: 'text', value: 'x'.repeat(28_000) } }] },
      { role: 'assistant', content: 'read complete' },
      { role: 'user', content: 'continue' },
    ] as any;
    session.seedHistory(history);
    expect(await session.compactNow()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const toolCopy = calls[0].prompt.find((m: any) => m.role === 'tool');
    expect(toolCopy.content[0].output.value).toContain('[output shortened]');
    expect(history[2].content[0].output.value).toHaveLength(28_000);
    expect((session as any).history.at(-1)).toBe(history[4]);
  });
  it('refuses an oversized retired prefix instead of silently trimming its original request or tool group', async () => {
    const events: any[] = [];
    const session = makeSession({ contextLength: 4096, onEvent: e => events.push(e), model: scriptModel([{ text: 'summary' }]) });
    const original = [
      { role: 'user', content: 'ORIGINAL REQUEST ' + 'x'.repeat(16000) },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'Read', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'Read', output: { type: 'text', value: 'result' } }] },
      { role: 'user', content: 'new request' },
    ] as any;
    session.seedHistory(original);
    expect(await session.compactNow()).toEqual({ ok: false, reason: 'summary-failed' });
    expect((session as any).history).toEqual(original);
    expect(events.some(e => e.type === 'compact-summary')).toBe(false);
  });
  it('manual compact on an empty history remains a no-op', async () => {
    const session = makeSession({ model: scriptModel([{ text: 'unused' }]) });
    expect(await session.compactNow()).toEqual({ ok: false, reason: 'nothing-to-compact' });
  });
  it('prunes when last step reports high input tokens — no compact-summary', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 8192, onEvent: (e) => events.push(e),
      model: scriptModel([
        { toolCalls: [{ name: 'Read', input: { file_path: 'big.txt' } }], usage: { inputTokens: 7000 } },
        { text: 'done' },
      ]),
    });
    await drainTurn(session, 'read the big file');
    expect(events.some((e) => e.type === 'compact-summary')).toBe(false);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('does not emit a summary when the retired prefix is too large to summarize intact', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 8192, seedBulkHistoryTokens: 4000, onEvent: (e) => events.push(e),
      model: scriptModel([{ text: 'SUMMARY: user wants X; did Y.' }, { text: 'here is the answer' }]),
    });
    await drainTurn(session, 'continue');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(0);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('FAIL-SAFE: a summary call that throws does not error the turn (falls through to truncation)', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 8192, onEvent: (e) => events.push(e),
      model: scriptModel([{ throwError: 'summary model exploded' }]),
    });
    session.seedHistory([{ role: 'user', content: 'original' }, { role: 'assistant', content: 'ack' }, { role: 'user', content: 'latest' }] as any);
    const before = session.acceptedHistory().messages;
    expect(await session.compactNow()).toEqual({ ok: false, reason: 'summary-failed' });
    expect(session.acceptedHistory().messages).toEqual(before);
    expect(events.some((e) => e.type === 'session-error')).toBe(false);
  });

  it('C1: a STALLED summary stream never wedges the turn — interrupt ends it and the session survives', async () => {
    // The summary runs on the same (here: stalled) model. A bare `for await`
    // would block forever; the abort-raced consumption must let interrupt() end
    // the turn, and the session must NOT stay bricked (abort cleared → a later
    // send does not throw the re-entrancy guard).
    const events: any[] = [];
    let hung = false;
    const session = makeSession({
      contextLength: 8192, seedBulkHistoryTokens: 4000, onEvent: (e) => events.push(e),
      model: hangingFirstCallModel(() => { hung = true; }),
    });
    const p = drainTurn(session, 'continue');
    while (!hung) await new Promise((r) => setTimeout(r, 2));   // wait until the summary stream stalls
    session.interrupt();
    await p;                                                    // MUST resolve, not hang
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
    expect(events.some((e) => e.type === 'compact-summary')).toBe(false);  // stalled → no summary emitted
    // Not bricked: a follow-up send completes cleanly on the same session.
    await drainTurn(session, 'again');
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('I3 thrash guard: a keep-dominated history summarizes AT MOST once per turn (not once per step)', async () => {
    // Recent turns alone exceed the trigger (usage 3500 > 4096*0.75), so
    // planCompaction says "summarize" every step — but the CONDENSABLE span (the
    // few small messages before the last-2-turn boundary) is trivial. Without the
    // guard that would fire a summary model-call + a dead compact-summary EVERY
    // step (~one per step); the guard caps it at one (here: zero) per turn.
    const events: any[] = [];
    const session = makeSession({
      contextLength: 4096, onEvent: (e) => events.push(e),
      model: scriptModel([
        { toolCalls: [{ name: 'Read', input: { file_path: 'a.txt' } }], usage: { inputTokens: 3500 } },
        { toolCalls: [{ name: 'Read', input: { file_path: 'b.txt' } }], usage: { inputTokens: 3500 } },
        { toolCalls: [{ name: 'Read', input: { file_path: 'c.txt' } }], usage: { inputTokens: 3500 } },
        { text: 'done' },
      ]),
    });
    // Tiny condensable span (<500 tokens) before the last-2-turn boundary.
    session.seedHistory([
      { role: 'assistant', content: 'aa' } as any,
      { role: 'user', content: 'u1' } as any,
      { role: 'assistant', content: 'bb' } as any,
      { role: 'user', content: 'u2' } as any,
    ]);
    await drainTurn(session, 'go');
    expect(events.filter((e) => e.type === 'compact-summary').length).toBeLessThanOrEqual(1);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('manual selection can retire older work across injected rules while retaining the newest request', async () => {
    // history: user A (real) -> assistant -> tool -> injected rule -> injected rule -> user B (real).
    // Only 2 REAL user turns exist, so the fix must protect BOTH — the cut lands
    // at user A (index 0), leaving nothing before it condensable. The pre-fix
    // count (every role:'user' message, injected or not) would instead see 4
    // "turns" and cut at the last-2 of those — landing at the second injected
    // rule and pushing user A's whole turn (plus the tool result answering it)
    // into the discarded/summarized span.
    const session = makeSession({ contextLength: 4096, model: scriptModel([{ text: 'SUMMARY' }]) });
    session.seedHistory([
      { role: 'user', content: 'USER-A: fix the login bug' } as any,
      { role: 'assistant', content: 'looking into it' } as any,
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'text', value: 'file contents' } }],
      } as any,
      markAppGenerated({ role: 'user', content: '<project-rule source="r1">\nRule body 1\n</project-rule>' } as any),
      markAppGenerated({ role: 'user', content: '<project-rule source="r2">\nRule body 2\n</project-rule>' } as any),
      { role: 'user', content: 'USER-B: also check the signup flow' } as any,
    ]);
    const result = await session.compactNow();
    // Both real turns land inside the protected window -> nothing left to
    // summarize. Under the bug this resolves { ok: true } instead, because a
    // non-empty span [userA, assistant, tool, rule1] gets summarized away.
    expect(result).toEqual({ ok: true });
    expect((session as any).history.at(-1).content).toBe('USER-B: also check the signup flow');
  });

  it('with three real turns, a small manual tail retains the newest turn', async () => {
    // { ok: false, reason: 'nothing-to-compact' } is also what an OVER-aggressive
    // detector produces if it wrongly excludes real user messages too (not just
    // injected ones) — so the test above alone can't tell "counts injected rules
    // as turns" (under-counts) apart from "excludes some real turns" (over-counts).
    // This fixture has 3 real turns, so a correct cut is non-empty and must land
    // exactly on the SECOND real turn (userIdx[length-2]), pinning both directions.
    const session = makeSession({ contextLength: 4096, model: scriptModel([{ text: 'SUMMARY' }]) });
    session.seedHistory([
      { role: 'user', content: 'USER-A: turn one' } as any,                                              // idx 0 — real
      { role: 'assistant', content: 'ack A' } as any,                                                     // idx 1
      markAppGenerated({ role: 'user', content: '<project-rule source="r1">\nRule body 1\n</project-rule>' } as any),        // idx 2 — injected
      { role: 'user', content: 'USER-B: turn two' } as any,                                                // idx 3 — real (expected cut)
      { role: 'assistant', content: 'ack B' } as any,                                                      // idx 4
      markAppGenerated({ role: 'user', content: '<project-rule source="r2">\nRule body 2\n</project-rule>' } as any),        // idx 5 — injected
      { role: 'user', content: 'USER-C: turn three' } as any,                                              // idx 6 — real
    ]);
    const result = await session.compactNow();
    // A correct cut (index 3, USER-B) summarizes away [USER-A, ack A, rule1] and
    // keeps [USER-B, ack B, rule2, USER-C] verbatim. Under EITHER miscount this
    // diverges: under-counting (treats rules as turns) would cut at index 5
    // (the second injected rule) instead of index 3; over-counting (drops real
    // turns too) would report nothing-to-compact instead of summarizing.
    expect(result).toEqual({ ok: true });
    const history = (session as any).history as any[];
    expect(history[0].content).toContain('[Earlier conversation summary]');
    expect(history[1].content).toBe('USER-C: turn three');   // kept verbatim — cut landed AT it, not past it
    expect(JSON.stringify(history)).not.toContain('USER-A');   // summarized away
  });
});

describe('5b review: a plan Comment note is not a turn', () => {
  it('the cut never separates a Comment from its history-only <plan-comment> note', async () => {
    // Three real turns; the second is a plan Comment with its model-only note.
    // Counting the note as a turn would cut AT the note, summarizing the
    // Comment away while keeping the note that refers to it.
    //
    // USER-A is padded: a manual compact's tail is min(the automatic tail,
    // half the WHOLE history's tokens) — with a tiny unpadded fixture, half
    // of everything is smaller than the USER-B-onward span, so the cut would
    // skip past USER-B to USER-C for a reason that has nothing to do with
    // the plan-comment (a budget-fit property this test isn't about). The
    // pad only grows the retired-away span, which the "not USER-A" assertion
    // below already covers.
    const session = makeSession({ contextLength: 4096, model: scriptModel([{ text: 'SUMMARY' }]) });
    session.seedHistory([
      { role: 'user', content: `USER-A: plan the review ${'x'.repeat(200)}` } as any,
      { role: 'assistant', content: 'proposed' } as any,
      { role: 'user', content: 'USER-B: only review a.ts' } as any,
      { role: 'user', content: '<plan-comment>\nAnswer with propose_plan.\n</plan-comment>' } as any,
      { role: 'assistant', content: 'revised' } as any,
      { role: 'user', content: 'USER-C: thanks' } as any,
    ]);
    expect(await session.compactNow()).toEqual({ ok: true });
    const history = (session as any).history as any[];
    expect(history[1].content).toBe('USER-B: only review a.ts');
    expect(history[2].content).toContain('<plan-comment>');
    expect(JSON.stringify(history)).not.toContain('USER-A');
  });
});

// WHY: only a successful summary retires images in the single-operation path;
// failed summary requests must not clear dedupe state for images still present.
describe('shown-image cache reset on summary', () => {
  it('summarizing away an image resets its dedupe cache', async () => {
    const session = makeSession({ contextLength: 16_384, model: scriptModel([{ text: '## Goal\n- Continue.' }]) });
    const imageMsg = {
      role: 'tool',
      content: [{
        type: 'tool-result', toolCallId: 't1', toolName: 'Read',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: 'Read shot.png' },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: Buffer.alloc(50_000) } },
          ],
        },
      }],
    } as any;
    const recent = { role: 'user', content: 'continue this task' } as any;
    session.seedHistory([{ role: 'user', content: 'inspect shot' } as any, imageMsg, recent]);
    (session as any).shownImages.set('/fake/shot.png', 111);
    expect(await session.compactNow()).toEqual({ ok: true });
    const history = (session as any).history as any[];
    expect(history.at(-1)).toBe(recent);
    expect(JSON.stringify(history)).not.toContain('image/png');
    expect((session as any).shownImages.size).toBe(0);
  });

  it('a failed summary leaves the image dedupe cache and accepted history intact', async () => {
    // An oversized user message cannot be shortened like a retired tool output.
    // A refused candidate must not claim an image was retired when it was not.
    const session = makeSession({ contextLength: 4096, model: scriptModel([{ text: 'unused' }]) });
    const bigTextMsg = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'text', value: 'y'.repeat(5_000) } }],
    } as any;
    const filler = { role: 'user', content: 'x'.repeat(8_000) } as any;
    session.seedHistory([bigTextMsg, filler]);
    (session as any).shownImages.set('/fake/shot.png', 111);
    expect(await session.compactNow()).toEqual({ ok: false, reason: 'summary-failed' });
    expect((session as any).shownImages.size).toBe(1);
    const history = (session as any).history as any[];
    expect(history[0]).toBe(bigTextMsg);
    expect(history[1]).toBe(filler);
  });
});

// WHY: the chat dims everything above the kept tail's first user message. A
// wrong answer here fades messages the model still sees (or dims nothing).
describe('retainedTurnStart — where the chat stops dimming', () => {
  function withHistory(history: any[], origins: Array<string[] | null>) {
    const session = makeSession({ contextLength: 4096, model: scriptModel([{ text: 'SUMMARY' }]) });
    (session as any).history = history;
    (session as any).historyOrigins = origins;
    return session;
  }
  const user = (content: string) => ({ role: 'user', content });
  const assistant = (content: string) => ({ role: 'assistant', content });

  it('a tail that starts at a user message names that message', () => {
    const s = withHistory([user('A'), assistant('a'), user('B'), assistant('b')], [['uA'], ['aa'], ['uB'], ['ab']]);
    expect(s.retainedTurnStart(2)).toBe('uB');
  });

  it('a tail that starts inside a turn names the turn opener (keeps the whole turn bright)', () => {
    const s = withHistory([user('A'), assistant('a1'), assistant('a2')], [['uA'], ['a1'], ['a2']]);
    expect(s.retainedTurnStart(2)).toBe('uA');
  });

  it('looks past an event-less injected rule to the real opener', () => {
    const s = withHistory([user('A'), markAppGenerated(user('<project-rule/>') as any), assistant('a')],
      [['uA'], null, ['aa']]);
    expect(s.retainedTurnStart(2)).toBe('uA');
  });

  it('stops at a previous summary: unknown, not a guess', () => {
    const s = withHistory([markAppGenerated(user('[Earlier conversation summary]\nold') as any), assistant('a1'), assistant('a2')],
      [['sum'], ['a1'], ['a2']]);
    expect(s.retainedTurnStart(2)).toBeNull();
  });

  it('a misaligned origin map yields null', () => {
    const s = withHistory([user('A'), assistant('a')], [['uA']]);
    expect(s.retainedTurnStart(1)).toBeNull();
  });
});

// On a small window the outgoing request is trimmed (fitToContext) while the
// history itself is not. The image dedupe cache must then stop vouching for an
// image the model can no longer see, or a re-Read answers "already visible
// earlier" with no picture.
describe('shown-image cache follows the window actually sent', () => {
  const imageMsg = (id: string) => ({
    role: 'tool',
    content: [{
      type: 'tool-result', toolCallId: id, toolName: 'Read',
      output: { type: 'content', value: [
        { type: 'text', text: 'Read shot.png' },
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: Buffer.alloc(64) } },
      ] },
    }],
  }) as any;

  it('an image trimmed out of the request is forgotten, so a re-Read delivers it again', () => {
    const session = makeSession({ contextLength: 4096, model: scriptModel([{ text: 'unused' }]) });
    const filler = { role: 'user', content: 'x'.repeat(40_000) } as any; // alone overflows the window
    session.seedHistory([{ role: 'user', content: 'look' } as any, imageMsg('t1'), filler]);
    (session as any).shownImages.set('/fake/shot.png', { mtime: 111, toolCallId: 't1' });
    const fitted = (session as any).fitToContext((session as any).history) as any[];
    expect(fitted.some((m) => m.role === 'tool')).toBe(false); // sanity: the image really was trimmed
    expect((session as any).shownImages.has('/fake/shot.png')).toBe(false);
  });

  it('an image still inside the request stays remembered, so dedupe keeps working', () => {
    const session = makeSession({ contextLength: 4096, model: scriptModel([{ text: 'unused' }]) });
    session.seedHistory([{ role: 'user', content: 'look' } as any, imageMsg('t1'), { role: 'user', content: 'again' } as any]);
    (session as any).shownImages.set('/fake/shot.png', { mtime: 111, toolCallId: 't1' });
    (session as any).fitToContext((session as any).history);
    expect((session as any).shownImages.get('/fake/shot.png')).toEqual({ mtime: 111, toolCallId: 't1' });
  });
});
