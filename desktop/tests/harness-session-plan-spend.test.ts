// Specialists plans, spending rework T2 — the harness-side half of
// design §3: `planSpend.afterReply`/`beforeRequest` wired into the ordinary
// turn loop a plan specialist's HarnessSession now runs unmodified. Plan
// children use the SAME request path as any other session (T1); this suite
// is about the two hook call sites, not a separate driver.
import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessSession } from '../src/main/harness/harness-session';
import { PLAN_LIMIT_REACHED_STOP_REASON, type PlanSpendHooks, type PlanSpendReply } from '../src/main/harness/plans/plan-spend';
import { costForUsage, type ModelPricing } from '../src/main/harness/pricing';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import { textChunks, toolCallChunk, finishChunk, stream } from './helpers/scripted-model';
import { makeOpts, fakeTool } from './helpers/harness-fakes';

function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}

const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };
const PRICING: ModelPricing = { in: 3, out: 15 };

/** A planSpend stub that never refuses and records exactly what it was told. */
function alwaysAllowSpend(): PlanSpendHooks & { calls: PlanSpendReply[] } {
  const calls: PlanSpendReply[] = [];
  return {
    beforeRequest: vi.fn(async () => undefined),
    afterReply: vi.fn((r: PlanSpendReply) => { calls.push(r); }),
    calls,
  };
}

/** Scripts a sequence of streams by call index; a call past the scripted list
 *  gets a plain 'stop' — the same convention harness-session-loop.test.ts
 *  uses for its multi-step tests. */
function indexedModel(scripts: any[][]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = call < scripts.length ? scripts[call] : stream(finishChunk('stop'));
      call++;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

describe('planSpend — afterReply, one call per real step', () => {
  it('fires once per step with that steps own usage, priced like the chip', async () => {
    const read = fakeTool('Read');
    const scripts = [
      stream(toolCallChunk('c1', 'Read', { file_path: 'a' }), finishChunk('tool-calls', 100, 20)),
      stream(...textChunks('t', 'done'), finishChunk('stop', 50, 10)),
    ];
    const model = indexedModel(scripts);
    const planSpend = alwaysAllowSpend();
    const session = new HarnessSession(
      makeOpts({ tools: [read], decide: async () => ALLOW, planSpend, pricing: PRICING, free: false }),
      async () => model as any,
    );
    await session.send('go');
    expect(planSpend.afterReply).toHaveBeenCalledTimes(2);
    expect(planSpend.calls[0].usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(planSpend.calls[0].costUsd).toBeCloseTo(costForUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 }, PRICING)!, 10);
    expect(planSpend.calls[1].usage).toMatchObject({ inputTokens: 50, outputTokens: 10 });
    // beforeRequest runs at the top of EVERY step too — once before each of
    // the two real steps.
    expect(planSpend.beforeRequest).toHaveBeenCalledTimes(2);
  });

  it('reports null cost for a free session, never a guessed rate', async () => {
    const model = indexedModel([stream(...textChunks('t', 'done'), finishChunk('stop', 10, 5))]);
    const planSpend = alwaysAllowSpend();
    const session = new HarnessSession(
      makeOpts({ tools: [], planSpend, pricing: PRICING, free: true }),
      async () => model as any,
    );
    await session.send('go');
    expect(planSpend.calls).toHaveLength(1);
    expect(planSpend.calls[0].costUsd).toBeNull();
  });
});

describe('planSpend — beforeRequest refusal', () => {
  it('ends the turn with plan_limit_reached AFTER the crossing replys own tools already ran', async () => {
    const read = fakeTool('Read');
    // Only ONE scripted step: a tool call. If beforeRequest is honored, the
    // driver must never reach a second doStream call at all.
    const model = indexedModel([stream(toolCallChunk('c1', 'Read', { file_path: 'a' }), finishChunk('tool-calls'))]);
    const doStreamSpy = vi.spyOn(model, 'doStream');
    let step = 0;
    const planSpend: PlanSpendHooks = {
      // Allows the FIRST step (the one that crossed the limit on its own
      // reply — that reply's tools still run); refuses every step after.
      beforeRequest: vi.fn(async () => (step++ === 0 ? undefined : PLAN_LIMIT_REACHED_STOP_REASON)),
      afterReply: vi.fn(),
    };
    const session = new HarnessSession(
      makeOpts({ tools: [read], decide: async () => ALLOW, planSpend }),
      async () => model as any,
    );
    const events = collect(session);
    await session.send('go');
    // The crossing reply's tool call ran to completion...
    expect((read as any).calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'tool-result')).toBe(true);
    // ...but no SECOND request was ever sent.
    expect(doStreamSpy).toHaveBeenCalledTimes(1);
    expect(planSpend.afterReply).toHaveBeenCalledTimes(1);
    const complete = events.find((e) => e.type === 'turn-complete');
    expect(complete?.data.stopReason).toBe(PLAN_LIMIT_REACHED_STOP_REASON);
  });
});

describe('planSpend — images are not specially gated for a plan specialist', () => {
  let dir: string;
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  it('a vision-capable plan session still delivers a model-promised image', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-spend-img-'));
    const shot = path.join(dir, 'shot.png');
    fs.writeFileSync(shot, PNG);
    const read = fakeTool('Read', { onExecute: () => ({ text: 'here it is', images: [shot] }) });
    const model = indexedModel([
      stream(toolCallChunk('c1', 'Read', { file_path: 'shot.png' }), finishChunk('tool-calls')),
      stream(...textChunks('t', 'done'), finishChunk('stop')),
    ]);
    const planSpend = alwaysAllowSpend();
    const session = new HarnessSession(
      makeOpts({
        tools: [read], decide: async () => ALLOW, planSpend, isSpecialistChild: true,
        profile: { ...CLOUD_DEFAULT, supportsVision: true },
      }),
      async () => model as any,
    );
    const events = collect(session);
    await session.send('go');
    const result = events.find((e) => e.type === 'tool-result');
    expect(result?.data.images).toEqual([shot]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('compaction usage also reaches afterReply', () => {
  it('the summarize call raised by a forced overflow retry is priced and reported too', async () => {
    const read = fakeTool('Read');
    const body = JSON.stringify({ error: { metadata: { error_type: 'context_length_exceeded' } } });
    const overflow = Object.assign(new Error('rejected'), { statusCode: 400, responseBody: body });
    const scripts = [
      stream(toolCallChunk('c1', 'Read', { file_path: 'a' }), finishChunk('tool-calls', 30, 5)),
      stream({ type: 'error', error: overflow }),
      stream(...textChunks('s', 'handoff'), finishChunk('stop', 7, 2)),   // the compaction's OWN summarize call
      stream(...textChunks('a', 'done'), finishChunk('stop', 40, 8)),     // the retried step, after compaction
    ];
    const model = indexedModel(scripts);
    const planSpend = alwaysAllowSpend();
    const session = new HarnessSession(
      makeOpts({ tools: [read], decide: async () => ALLOW, planSpend, pricing: PRICING, free: false, contextLength: 8192 }),
      async () => model as any,
    );
    session.seedHistory([{ role: 'user', content: 'original ' + 'x'.repeat(10000) }, { role: 'assistant', content: 'ack' }] as any);
    await session.send('continue');
    // Three priced replies reached afterReply: the first real step (the Read
    // call), the compaction summary itself, and the retried step that
    // finally answered. The FAILED overflow attempt reported nothing (it
    // never returns a StepResult) — the same accepted gap D9 pins below.
    expect(planSpend.afterReply).toHaveBeenCalledTimes(3);
    expect(planSpend.calls.map((c) => c.usage.inputTokens)).toEqual([30, 7, 40]);
  });
});

describe('D9 — a retried request with no reported usage adds nothing', () => {
  it('the request-error withRetry silently re-sent never reaches afterReply', async () => {
    const retryable = Object.assign(new Error('rejected'), { statusCode: 429 });
    const scripts = [
      stream({ type: 'error', error: retryable }),                          // fails — no StepResult, nothing to report
      stream(...textChunks('t', 'done'), finishChunk('stop', 12, 6)),       // withRetry's re-send succeeds
    ];
    const model = indexedModel(scripts);
    const planSpend = alwaysAllowSpend();
    const session = new HarnessSession(
      makeOpts({ tools: [], planSpend, pricing: PRICING, free: false, retryDelays: [1, 1, 1] }),
      async () => model as any,
    );
    await session.send('go');
    // ONE call — for the successful retry only. The failed first attempt,
    // whatever the provider may have billed for it, is invisible here exactly
    // as it is invisible to the cost chip (Revision 1 D9, the known gap).
    expect(planSpend.afterReply).toHaveBeenCalledTimes(1);
    expect(planSpend.calls[0].usage).toMatchObject({ inputTokens: 12, outputTokens: 6 });
  });
});
