// Specialists plans, spending rework T2 — chip parity (design Revision 1 D1 /
// Revision 3 F1): the plan journal's `usedUsd` and the parent conversation's
// Cost chip (the `subagent-usage` event's `costUsd`) must read the SAME
// number, because both now derive from the SAME `PlanSpend` object — one
// built by `startPlanChild`, attached to the child's HarnessSession (so the
// journal side gets written) AND to its LiveEntry (so `runPlanChild`'s
// `finally` can report its running total to the chip). A wiring bug that
// attaches two DIFFERENT PlanSpend instances at those two points, or drops
// one of them, is exactly what this suite would catch.
//
// Drives `NativeSessionHost.startPlanChild` directly against a hand-seeded
// journal record (plan-executor.test.ts's own style) rather than through a
// full propose/approve turn — the executor's own wiring of the run-flags
// callbacks into `PlanChildLaunch` is a straight pass-through already covered
// by plan-executor.ts's own review; this file is about the native-host half.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { PlanJournal } from '../src/main/harness/plans/plan-journal';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import { textChunks, toolCallChunk, finishChunk, stream } from './helpers/scripted-model';
import type { ExecutionManifest, PlanRecord, PlanRef } from '../src/main/harness/plans/types';
import type { TranscriptEvent } from '../src/shared/types';

const SID = 'plan-root';
const PARENT = { providerId: 'openrouter', modelId: 'parent-model' };
const CHILD = 'child-model';
// A real (small) window, not null — the compaction scenario below needs
// maybeCompact to have an actual context budget to trigger against; every
// other scenario is indifferent to the exact number.
const FAKE_CONTEXT = async () => ({ contextLength: 8192, totalSlots: null });

const MANIFEST: ExecutionManifest = {
  modelLabel: CHILD,
  specialists: { reviewer: { definitionFingerprint: 'r' } },
  steps: {
    s1: { binding: { providerId: 'openrouter', modelId: CHILD }, label: CHILD, pricing: { kind: 'priced', rates: { in: 3, out: 15 } }, source: 'default' },
  },
  permissionFingerprint: 'perm',
};

function planRecord(): PlanRecord {
  return {
    planId: 'p1', toolUseId: 'call-x',
    document: { goal: 'g', steps: [{ id: 's1', kind: 'map', specialist: 'reviewer', task: 'do it', summary: 'Plain sentence.', items: ['x'] }] },
    maximumAttempts: 1, maxFanOut: 1, usedTokens: 0, status: 'running', seq: 1, createdAt: 1, manifest: MANIFEST,
    steps: [{ id: 's1', status: 'running', attempts: [{ attemptId: 'a1', itemIndex: 0, iteration: 0, spentTokens: 0, phase: 'prepared' }] }],
    fenceEpoch: 0,
  };
}

let root: string;
let host: NativeSessionHost;
let events: TranscriptEvent[];
let childReply: (call: number) => any[] | 'hang';
let childCalls: number;

const childFactory = async (binding: { modelId: string }) => {
  if (binding.modelId !== CHILD) return new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: stream(finishChunk('stop')) }) }) }) as any;
  return new MockLanguageModelV4({
    doStream: async (options: any) => {
      childCalls++;
      const reply = childReply(childCalls);
      if (reply === 'hang') {
        return { stream: new ReadableStream({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); options.abortSignal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); } }) };
      }
      return { stream: simulateReadableStream({ chunks: stream(...reply) }) };
    },
  }) as any;
};

function makeHost(): NativeSessionHost {
  const home = new NativeHome(root);
  const h = new NativeSessionHost(
    new SessionStore(home), childFactory as any, FAKE_CONTEXT, async () => 'openrouter', async () => null,
    async () => ({ in: 1, out: 2 }), undefined, undefined,
    {}, undefined, undefined, home, undefined, undefined, {},
    { settleDeadlineMs: 60, heartbeatMs: 60_000, slotPollMs: 5 },
  );
  h.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return h;
}

async function launchAttempt(journal: PlanJournal, ref: PlanRef, fence: string) {
  return (host as any).startPlanChild({
    parentId: SID, specialist: resolveSpecialist('reviewer'), binding: { providerId: 'openrouter', modelId: CHILD },
    providerType: 'openrouter', parentToolCallId: 'call-x', signal: new AbortController().signal,
    tag: { planId: 'p1', stepId: 's1', attemptId: 'a1' },
    recordChild: (childId: string) => journal.mutateFenced(ref, 'p1', fence, (p) => { p.steps[0].attempts[0].childId = childId; }),
    brief: 'Review it', fence,
    isLimitReached: () => false, markLimitReached: () => {}, isWriteFailed: () => false, markWriteFailed: () => {},
  });
}

/** Every `subagent-usage` event the host emitted under SID for this run,
 *  summed — this is what the conversation's Cost chip actually adds. */
function chipAddedCost(): number {
  return events.filter((e) => e.type === 'subagent-usage' && e.sessionId === SID)
    .reduce((sum, e: any) => sum + (e.data.usage.costUsd ?? 0), 0);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-spend-chip-'));
  events = []; childCalls = 0;
  host = makeHost();
});
afterEach(async () => { await host.destroyAll(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

describe('plan usedUsd == the chips added cost', () => {
  it('on a clean finish', async () => {
    const home = new NativeHome(root);
    const journal = new PlanJournal({ home, identity: { instanceId: 'me', pid: 1 } });
    const ref: PlanRef = { cwd: root, sessionId: SID };
    await journal.mutate(ref, (file) => { file.plans.push(planRecord()); });
    const lease = await journal.acquireLease(ref, 'p1', { startFrom: ['running'] });
    if (!lease.ok) throw new Error('lease');
    await host.create({ sessionId: SID, cwd: root, binding: PARENT });
    childReply = () => [...textChunks('t', 'DONE'), finishChunk('stop', 100, 50)];
    const handle = await launchAttempt(journal, ref, lease.fence);
    const outcome = await handle.outcome;
    expect(outcome).toEqual({ kind: 'completed', report: 'DONE' });
    // Awaited BEFORE reading the journal — afterReply's write overlaps tool
    // execution and turn completion, so nothing else guarantees it landed yet.
    await handle.spendSettled();
    await handle.dispose();
    const p = (await journal.get(ref, 'p1'))!;
    expect(p.usedUsd).toBeGreaterThan(0);
    expect(chipAddedCost()).toBeCloseTo(p.usedUsd!, 10);
  });

  it('on a provider error', async () => {
    const home = new NativeHome(root);
    const journal = new PlanJournal({ home, identity: { instanceId: 'me', pid: 1 } });
    const ref: PlanRef = { cwd: root, sessionId: SID };
    await journal.mutate(ref, (file) => { file.plans.push(planRecord()); });
    const lease = await journal.acquireLease(ref, 'p1', { startFrom: ['running'] });
    if (!lease.ok) throw new Error('lease');
    await host.create({ sessionId: SID, cwd: root, binding: PARENT });
    // A real step's reply first (afterReply #1), THEN a non-retryable error
    // (not 429/5xx/overflow-shaped) — session-error still reports the first
    // step's usage (the "abandoned turn usage" merge note).
    const denied = Object.assign(new Error('rejected'), { statusCode: 403 });
    childReply = (call) => (call === 1
      ? [toolCallChunk('c1', 'Bash', { command: 'echo hi' }), finishChunk('tool-calls', 80, 10)]
      : [{ type: 'error', error: denied }]);
    const handle = await launchAttempt(journal, ref, lease.fence);
    const outcome = await handle.outcome;
    expect(outcome.kind).toBe('failed');
    await handle.spendSettled();
    await handle.dispose();
    const p = (await journal.get(ref, 'p1'))!;
    expect(p.usedUsd).toBeGreaterThan(0);   // the first step's spend was NOT lost
    expect(chipAddedCost()).toBeCloseTo(p.usedUsd!, 10);
  });

  it('on a user interrupt mid-turn', async () => {
    const home = new NativeHome(root);
    const journal = new PlanJournal({ home, identity: { instanceId: 'me', pid: 1 } });
    const ref: PlanRef = { cwd: root, sessionId: SID };
    await journal.mutate(ref, (file) => { file.plans.push(planRecord()); });
    const lease = await journal.acquireLease(ref, 'p1', { startFrom: ['running'] });
    if (!lease.ok) throw new Error('lease');
    await host.create({ sessionId: SID, cwd: root, binding: PARENT });
    childReply = (call) => (call === 1
      ? [toolCallChunk('c1', 'Bash', { command: 'echo hi' }), finishChunk('tool-calls', 60, 15)]
      : 'hang');
    const handle = await launchAttempt(journal, ref, lease.fence);
    // Let the first step's reply land and the second one start hanging, then abort.
    for (let i = 0; i < 200 && childCalls < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(childCalls).toBe(2);
    handle.abort();
    const outcome = await handle.outcome;
    expect(outcome).toEqual({ kind: 'interrupted' });
    await handle.spendSettled();
    await handle.dispose();
    const p = (await journal.get(ref, 'p1'))!;
    expect(p.usedUsd).toBeGreaterThan(0);   // the completed first step still counted
    expect(chipAddedCost()).toBeCloseTo(p.usedUsd!, 10);
  });

  // WHY no "across a forced compaction" case HERE (deviation, disclosed):
  // forcing `maybeCompact`'s real selectCompactionCut/planContextBudget
  // arithmetic to actually fire through the FULL native-host stack (a
  // cold-started plan child, real system prompt, a tuned small context
  // window) proved too fiddly to engineer reliably in this file without
  // risking a flaky or over-fitted test. The mechanism this suite exists to
  // prove — that afterReply's usage, whatever KIND of reply produced it,
  // reaches both the journal and the chip through the SAME `PlanSpend`
  // object — does not depend on which reply triggered it; the three
  // scenarios above already exercise that generically. Compaction's own
  // usage specifically reaching `afterReply` (design §3's other half of this
  // claim) is pinned precisely, and reliably, at the harness level instead:
  // harness-session-plan-spend.test.ts → "the summarize call raised by a
  // forced overflow retry is priced and reported too".
});
