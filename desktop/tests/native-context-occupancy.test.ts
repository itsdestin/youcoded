// What the context gauge is allowed to measure.
//
// Destin, 2026-07-28, on a live local session: "the 'prompt' with claude.md alone
// said it was 7000 tokens, so why would context only be 300/whatever?" The pill
// read `367 / 128.0k`. Two separate defects produced that number:
//
//   1. the provider was never asked for token counts (see provider-registry.test),
//      so inputTokens was 0 on every turn ever recorded, and
//   2. the gauge summed in+out ACROSS STEPS of a single turn — a quantity that
//      both re-counts the whole history once per step AND resets each turn, so it
//      could never answer "how full is the window?".
//
// This file pins (2): turn-complete must carry the OCCUPANCY of the window.
import { describe, it, expect } from 'vitest';
import { HarnessSession } from '../src/main/harness/harness-session';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import { makeOpts, fakeTool, makeSession, scriptModel } from './helpers/harness-fakes';

const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

function usageOf(events: TranscriptEvent[]) {
  return events.find((e) => e.type === 'turn-complete')!.data.usage as any;
}

describe('turn-complete usage — occupancy vs turn total', () => {
  it('reports the LAST step\'s prompt + reply, not the sum across steps', async () => {
    // Two steps. Each step re-sends the whole conversation, so the second step's
    // prompt (1,200) already CONTAINS the first step's — summing them to 2,200
    // would claim the model holds nearly twice what it does.
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(...textChunks('a', 'Reading.'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls', 1000, 50)),
      stream(...textChunks('b', 'Done.'), finishChunk('stop', 1200, 80)),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');

    const usage = usageOf(events);
    expect(usage.contextUsedTokens).toBe(1280);       // 1200 prompt + 80 reply
    expect(usage.inputTokens).toBe(2200);             // the turn total is still reported…
    expect(usage.contextUsedTokens).not.toBe(usage.inputTokens + usage.outputTokens);  // …but never drives the gauge
  });

  it('a single-step turn reports that step, so the two agree', async () => {
    const model = scriptedModel([stream(...textChunks('a', 'hi'), finishChunk('stop', 900, 40))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');

    expect(usageOf(events).contextUsedTokens).toBe(940);
  });

  it('falls back to an estimate when the provider reports no prompt tokens', async () => {
    // A server that ignores stream_options reports nothing. Showing an eternally
    // empty window would be worse than a rough number, so we estimate from what
    // we know we sent rather than claiming 0.
    const model = scriptedModel([stream(...textChunks('a', 'hi'), finishChunk('stop', 0, 0))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');

    const usage = usageOf(events);
    expect(usage.inputTokens).toBe(0);
    expect(usage.contextUsedTokens).toBeGreaterThan(0);   // the system prompt alone is not free
  });

  // Fix (Task 7 review): the session.contextUsedTokens ACCESSOR used to return
  // its raw internal field, which the write site (harness-session.ts ~:1412)
  // only ever sets when a step reports real usage — so for a usage-silent
  // provider it stayed null forever, even though the turn-complete payload
  // above already falls back to an estimate. That silently disabled any
  // headroom-cap consumer (e.g. a specialist's report cap) for exactly the
  // local-model case the estimate fallback exists for. Pin that the accessor
  // and the emitted payload agree.
  it('the contextUsedTokens accessor falls back like the emit site, and the two agree', async () => {
    const model = scriptedModel([stream(...textChunks('a', 'hi'), finishChunk('stop', 0, 0))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));

    // Before any turn: still not null — the accessor estimates from the
    // (empty-history) system prompt alone, same fallback as mid-session.
    expect(session.contextUsedTokens).not.toBeNull();

    await session.send('go');

    const usage = usageOf(events);
    expect(session.contextUsedTokens).not.toBeNull();
    expect(session.contextUsedTokens).toBe(usage.contextUsedTokens);
  });

  // The estimate is the ANSWER (not merely a budget) in two places: the fallback
  // above, and the occupancy left behind by a history rewrite. Tool schemas ride
  // every request, so leaving them out understated both — always optimistically,
  // and worst on the small local models that have the least room.
  it('the estimate counts the tool schemas, not just the system prompt and history', async () => {
    const model = scriptedModel([stream(...textChunks('a', 'hi'), finishChunk('stop', 0, 0))]);
    const bare = new HarnessSession(makeOpts({ tools: [] }), async () => model as any);
    const armed = new HarnessSession(
      makeOpts({ tools: [fakeTool('Read'), fakeTool('Glob'), fakeTool('Bash')] }),
      async () => model as any,
    );
    // Same empty history and the same system prompt — the ONLY difference is the
    // attached tool set, so any gap is the schemas being counted.
    expect(armed.contextUsedTokens!).toBeGreaterThan(bare.contextUsedTokens!);
  });
});

// A history rewrite that runs OUTSIDE a turn — the /compact button, /clear — gets
// no fresh reading from the provider, so before 2026-09-16 the last measured
// occupancy simply stood. The status bar kept showing the pre-compaction window
// until the user happened to send another message; after /clear it could sit at
// "3% remaining" over an empty conversation (Destin, 2026-09-16).
describe('occupancy after a history rewrite outside a turn', () => {
  /** A session plus the events it emits. Each test then plants a MEASURED
   *  reading directly, because what is under test is how a rewrite re-bases an
   *  existing measurement — driving a real turn just to obtain one would make
   *  the anchor an artifact of the scripted model's token counts. */
  function seeded(over: Parameters<typeof makeSession>[0] = {}) {
    const events: any[] = [];
    const session = makeSession({ ...over, onEvent: (e) => events.push(e) });
    return { session, events };
  }

  it('compactNow ships the window it left behind, and a before to measure it against', async () => {
    const { session, events } = seeded({
      contextLength: 40_000,
      seedBulkHistoryTokens: 8000,
      model: scriptModel([{ text: 'SUMMARY: they discussed X.' }]),
    });
    // A real measured reading first — 20,000 prompt tokens is the thing the
    // re-based figure must be anchored to, rather than thrown away.
    (session as any)._contextUsedTokens = 20_000;

    expect(await session.compactNow()).toEqual({ ok: true });

    const ev = events.find((e) => e.type === 'compact-summary');
    expect(ev).toBeDefined();
    expect(ev.data.contextUsedBefore).toBe(20_000);
    // Re-based, not re-estimated: the measurement is kept and only the ESTIMATED
    // size of what was removed is subtracted. ~8,000 tokens of bulk history went
    // into the summary, so the result must land well below the before and well
    // above zero — a fresh chars/4 estimate of the whole window would instead
    // return a number unrelated to the 20,000 that was actually measured.
    expect(ev.data.contextUsedAfter).toBeLessThan(20_000);
    expect(ev.data.contextUsedAfter).toBeGreaterThan(0);
    // And the session's own accessor agrees with what it told the UI.
    expect(session.contextUsedTokens).toBe(ev.data.contextUsedAfter);
  });

  it('clearHistory ships an occupancy that reflects an empty conversation', async () => {
    const { session, events } = seeded({ contextLength: 40_000, seedBulkHistoryTokens: 8000 });
    (session as any)._contextUsedTokens = 20_000;

    expect(session.clearHistory()).toEqual({ ok: true });

    const ev = events.find((e) => e.type === 'context-clear');
    expect(ev).toBeDefined();
    // The barrier drops the whole conversation, so nearly all of the ~8,000
    // estimated tokens of history come off the measured 20,000.
    expect(ev.data.contextUsedAfter).toBeLessThan(14_000);
    expect(ev.data.contextUsedAfter).toBeGreaterThanOrEqual(0);
    expect(session.contextUsedTokens).toBe(ev.data.contextUsedAfter);
  });

  it('never reports a negative window, however badly the estimator overshoots', async () => {
    // A session whose measured reading is far SMALLER than its estimated history
    // (a provider reporting a heavily cached prompt, say). The subtraction must
    // clamp rather than produce a negative occupancy — which would render as a
    // window more than 100% free.
    const { session } = seeded({ contextLength: 40_000, seedBulkHistoryTokens: 8000 });
    (session as any)._contextUsedTokens = 10;
    expect(session.clearHistory()).toEqual({ ok: true });
    expect(session.contextUsedTokens).toBeGreaterThanOrEqual(0);
  });
});
