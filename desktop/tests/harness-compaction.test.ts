// Two-stage compaction wired into the driver (spec §4.4). These pin the driver
// SEAM: PRUNE-first stays silent (no compact-summary), SUMMARIZE emits exactly
// one compact-summary and keeps working, and a summary model call that throws is
// a NON-fatal fall-through (fitToContext remains the hard floor) — never a
// session-error. The compaction MATH itself is pinned in compaction.test.ts.
import { describe, it, expect } from 'vitest';
import { makeSession, scriptModel, drainTurn, hangingFirstCallModel } from './helpers/harness-fakes';

describe('driver compaction', () => {
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

  it('emits compact-summary and keeps working when pruning is insufficient', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => events.push(e),
      model: scriptModel([{ text: 'SUMMARY: user wants X; did Y.' }, { text: 'here is the answer' }]),
    });
    await drainTurn(session, 'continue');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(1);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('FAIL-SAFE: a summary call that throws does not error the turn (falls through to truncation)', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => events.push(e),
      model: scriptModel([{ throwError: 'summary model exploded' }, { text: 'answer anyway' }]),
    });
    await drainTurn(session, 'continue');
    expect(events.some((e) => e.type === 'session-error')).toBe(false);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('C1: a STALLED summary stream never wedges the turn — interrupt ends it and the session survives', async () => {
    // The summary runs on the same (here: stalled) model. A bare `for await`
    // would block forever; the abort-raced consumption must let interrupt() end
    // the turn, and the session must NOT stay bricked (abort cleared → a later
    // send does not throw the re-entrancy guard).
    const events: any[] = [];
    let hung = false;
    const session = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => events.push(e),
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

  it('injected <project-rule> messages do not count as user turns for the protected window', async () => {
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
      { role: 'user', content: '<project-rule source="r1">\nRule body 1\n</project-rule>' } as any,
      { role: 'user', content: '<project-rule source="r2">\nRule body 2\n</project-rule>' } as any,
      { role: 'user', content: 'USER-B: also check the signup flow' } as any,
    ]);
    const result = await session.compactNow();
    // Both real turns land inside the protected window -> nothing left to
    // summarize. Under the bug this resolves { ok: true } instead, because a
    // non-empty span [userA, assistant, tool, rule1] gets summarized away.
    expect(result).toEqual({ ok: false, reason: 'nothing-to-compact' });
  });

  it('Fix 4 (2026-08-11 review): with THREE real user turns among injected rules, the cut lands on the second real turn', async () => {
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
      { role: 'user', content: '<project-rule source="r1">\nRule body 1\n</project-rule>' } as any,        // idx 2 — injected
      { role: 'user', content: 'USER-B: turn two' } as any,                                                // idx 3 — real (expected cut)
      { role: 'assistant', content: 'ack B' } as any,                                                      // idx 4
      { role: 'user', content: '<project-rule source="r2">\nRule body 2\n</project-rule>' } as any,        // idx 5 — injected
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
    expect(history[1].content).toBe('USER-B: turn two');   // kept verbatim — cut landed AT it, not past it
    expect(JSON.stringify(history)).not.toContain('USER-A');   // summarized away
  });
});

// Cross-task interaction (2026-08-11): guard (a) above means pruneToolOutputs
// can now itself collapse an image-bearing tool output, not just summarize.
// The shownImages dedupe cache (harness-session.ts) must not keep vouching for
// an image that prune just erased — same failure class as Fix 1/Fix 2 (see
// harness-session-loop.test.ts's "shown-image cache reset" describe block),
// but triggered by PRUNE instead of /clear or summarize.
describe('shown-image cache reset on prune-caused image collapse', () => {
  it('prune collapsing an image resets the dedupe cache, even when nothing gets summarized afterward', async () => {
    const session = makeSession({ contextLength: 4096, model: scriptModel([{ text: 'unused' }]) });
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
    const filler = { role: 'user', content: 'x'.repeat(8_000) } as any;   // pushes imageMsg outside the protected window
    session.seedHistory([imageMsg, filler]);
    (session as any).shownImages.set('/fake/shot.png', 111);   // as if resolveToolImages delivered it earlier
    const result = await session.compactNow();
    // Sanity: only 1 real user turn exists, so summarize never fires — the
    // clear this test pins must come from PRUNE itself, not from the
    // summarize-triggered clear a few lines below it in maybeCompact/compactNow.
    expect(result).toEqual({ ok: false, reason: 'nothing-to-compact' });
    const history = (session as any).history as any[];
    expect(history[0].content[0].output.type).toBe('text');   // sanity: prune actually collapsed the image
    expect((session as any).shownImages.size).toBe(0);
  });

  it('prune that never touches an image leaves the dedupe cache intact', async () => {
    // A big STRING tool output outside the protected window — prune truncates
    // text here, never an image, so there is nothing stale to clear. Clearing
    // anyway would silently defeat dedupe and re-send an unrelated image on
    // every repeat Read.
    const session = makeSession({ contextLength: 4096, model: scriptModel([{ text: 'unused' }]) });
    const bigTextMsg = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'text', value: 'y'.repeat(5_000) } }],
    } as any;
    const filler = { role: 'user', content: 'x'.repeat(8_000) } as any;
    session.seedHistory([bigTextMsg, filler]);
    (session as any).shownImages.set('/fake/shot.png', 111);
    await session.compactNow();
    expect((session as any).shownImages.size).toBe(1);   // untouched — no image was pruned
    // Fix 5 (2026-08-11 review): without this, the test would still pass if
    // prune silently stopped running altogether — it only ever checked the
    // (correctly) untouched cache, never that prune actually did its job.
    const history = (session as any).history as any[];
    const prunedValue = history[0].content[0].output.value;
    expect(prunedValue.length).toBeLessThan(5_000);
    expect(prunedValue).toContain('[pruned');
  });
});
