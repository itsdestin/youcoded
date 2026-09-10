// The expected-rebuild flag (cache follow-ups item 8, backend half).
//
// A cache miss is either EXPECTED — the harness itself moved the prefix (a
// prune commit, a summary, a model swap) — or a surprise that means one of the
// cache fixes regressed. The harness knows every time it moves the prefix, so it
// marks the next request and the turn that carried it. Anything with low cache
// reads and no flag is a regression to investigate; anything with the flag is
// the known price of that event. Without this, a regression in items 1–7 is
// invisible: requests keep succeeding, the bill is just higher.
import { describe, it, expect } from 'vitest';
import { makeSession, scriptModel, drainTurn } from './helpers/harness-fakes';

const turnUsage = (events: any[]) => events.filter((e) => e.type === 'turn-complete').map((e) => e.data.usage);

describe('turn-complete usage.expectedRebuild', () => {
  it('is false on an ordinary turn that moved nothing', async () => {
    const events: any[] = [];
    const session = makeSession({ onEvent: (e) => events.push(e), model: scriptModel([{ text: 'ok' }, { text: 'ok' }]) });
    await drainTurn(session, 'hello');
    await drainTurn(session, 'again');
    expect(turnUsage(events).map((u) => u.expectedRebuild)).toEqual([false, false]);
  });

  it('is true on the turn whose request followed a summary compaction', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => events.push(e),
      model: scriptModel([{ text: 'SUMMARY: user wants X; did Y.' }, { text: 'here is the answer' }]),
    });
    await drainTurn(session, 'continue');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(1);
    expect(turnUsage(events).map((u) => u.expectedRebuild)).toEqual([true]);
  });

  it('is true on the first turn after a model swap, then false again — the flag is consumed by one request', async () => {
    const events: any[] = [];
    const session = makeSession({ onEvent: (e) => events.push(e), model: scriptModel([{ text: 'a' }, { text: 'b' }, { text: 'c' }]) });
    await drainTurn(session, 'one');
    session.setBinding({ providerId: 'openrouter', modelId: 'other-model' });
    await drainTurn(session, 'two');
    await drainTurn(session, 'three');
    expect(turnUsage(events).map((u) => u.expectedRebuild)).toEqual([false, true, false]);
  });

  it('is true on the first turn after /clear — the most common deliberate prefix move a user makes', async () => {
    const events: any[] = [];
    const session = makeSession({ onEvent: (e) => events.push(e), model: scriptModel([{ text: 'a' }, { text: 'b' }]) });
    await drainTurn(session, 'one');
    expect(session.clearHistory()).toEqual({ ok: true });
    await drainTurn(session, 'two');
    expect(turnUsage(events).map((u) => u.expectedRebuild)).toEqual([false, true]);
  });

  it('a same-model setBinding (a pricing or context refresh) is NOT a rebuild', async () => {
    const events: any[] = [];
    const session = makeSession({ onEvent: (e) => events.push(e), model: scriptModel([{ text: 'a' }, { text: 'b' }]) });
    await drainTurn(session, 'one');
    session.setBinding({ providerId: 'openrouter', modelId: 'm' }, 200_000);
    await drainTurn(session, 'two');
    expect(turnUsage(events).map((u) => u.expectedRebuild)).toEqual([false, false]);
  });
});
