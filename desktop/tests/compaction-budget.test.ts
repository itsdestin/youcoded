// Compaction fires BEFORE the request trimmer (cache follow-ups item 2).
//
// The bug this pins: `fitToContext` trimmed the outgoing request at
// `ctx − maxTokens − 1024` while compaction triggered at 0.75 × ctx. With the
// manifest's flat 16,000 output reserve, a 32k local window trimmed from 15,744
// tokens while compaction waited for 24,576 — so in that band every step was
// re-trimmed from a moving front edge and llama.cpp re-read the whole
// conversation each step. Under ~17k of window the trim budget went NEGATIVE
// and the request collapsed to the newest message alone. One budget function
// now feeds the trimmer, the trigger and the request's output cap: reply
// reserve = min(maxTokens, ctx/4), trigger below the trim budget.
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { contextBudget } from '../src/main/harness/compaction';
import { makeSession, scriptModel, drainTurn, HARNESS, type ScriptStep } from './helpers/harness-fakes';

// The production output reserve. HARNESS's 256 would make the old and new
// arithmetic coincide and the driver tests below prove nothing.
const PRODUCTION_RESERVE = { ...HARNESS, limits: { maxTokens: 16_000 } };

describe('contextBudget', () => {
  it('32k window, 16k manifest reserve: the trigger sits below the trim budget (the exact case that was inverted)', () => {
    const b = contextBudget({ contextLength: 32_768, maxTokens: 16_000 });
    expect(b).toEqual({ replyReserve: 8192, trimBudget: 23_552, triggerTokens: 21_196 });
    expect(b.triggerTokens).toBeLessThan(b.trimBudget);
  });
  it('8k window: the trim budget is positive, so history no longer collapses to the newest message', () => {
    const b = contextBudget({ contextLength: 8192, maxTokens: 16_000 });
    expect(b).toEqual({ replyReserve: 2048, trimBudget: 5120, triggerTokens: 4608 });
  });
  it('200k window: the cloud trigger is unchanged from today (0.75 × ctx) and the reserve stays the manifest value', () => {
    expect(contextBudget({ contextLength: 200_000, maxTokens: 16_000 })).toEqual({ replyReserve: 16_000, trimBudget: 182_976, triggerTokens: 150_000 });
  });
  it('unknown window: assumed 32k for the budget math, the output cap left to the manifest — so compaction fires at 14,169, not 24,576', () => {
    // A cloud model the catalog could not size used to trim its request from
    // 15,744 tokens while waiting for 24,576 to compact. Pinned exactly so the
    // change is a stated fact, not a side effect (review finding 5).
    expect(contextBudget({ contextLength: null, maxTokens: 16_000 })).toEqual({ replyReserve: 16_000, trimBudget: 15_744, triggerTokens: 14_169 });
  });
});

/** A scripted model that also records every outgoing prompt. */
function promptCapturingModel(steps: ScriptStep[], prompts: any[][]) {
  const inner = scriptModel(steps);
  return new MockLanguageModelV4({
    doStream: async (options: any) => { prompts.push(options.prompt); return inner.doStream(options); },
  });
}

describe('driver: compaction happens before any request trimming', () => {
  it('32k window at ~22k of history: one summary, and the request carries the summary plus the kept tail — nothing silently trimmed', async () => {
    const events: any[] = []; const prompts: any[][] = [];
    const session = makeSession({
      contextLength: 32_768, seedBulkHistoryTokens: 22_000, onEvent: (e) => events.push(e), harness: PRODUCTION_RESERVE,
      model: promptCapturingModel([{ text: 'SUMMARY.' }, { text: 'answer' }], prompts),
    });
    await drainTurn(session, 'continue');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(1);
    // prompts[0] is the summary call; prompts[1] is the turn's request.
    const request = prompts[1].filter((m) => m.role !== 'system');
    expect(request[0].content[0].text).toMatch(/^\[Earlier conversation summary\]/);
    // The seeded bulk alternates assistant/user for 22 messages (users at the
    // odd indices, the last at 21); the cut lands on the second-to-last user
    // message counting the new turn, i.e. index 21, keeping that one message,
    // plus the new user turn. A trimmed request would show ~15 messages and no
    // summary; a collapsed one, a single message.
    expect(request).toHaveLength(1 + 1 + 1);
  });

  it('8k window at ~5k of history: compaction runs instead of collapsing the request to the newest message', async () => {
    const events: any[] = []; const prompts: any[][] = [];
    const session = makeSession({
      contextLength: 8192, seedBulkHistoryTokens: 5000, onEvent: (e) => events.push(e), harness: PRODUCTION_RESERVE,
      model: promptCapturingModel([{ text: 'SUMMARY.' }, { text: 'answer' }], prompts),
    });
    await drainTurn(session, 'continue');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(1);
    const request = prompts[1].filter((m) => m.role !== 'system');
    expect(request.length).toBeGreaterThan(1);
    expect(request[0].content[0].text).toMatch(/^\[Earlier conversation summary\]/);
  });
});
