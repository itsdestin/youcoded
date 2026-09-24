// Specialists plans, Task 7 — whole-lifecycle integration coverage.
//
// WHY this file exists next to the unit suites: each plan piece (journal,
// budget, executor, service, host bridge) is proven on its own, and
// native-session-host.test.ts proves the wiring one behaviour at a time. What
// nothing proved yet is a user's whole path through a plan — propose, approve,
// run in waves, pause, top up, quit, reopen, continue, comment, stop — on the
// REAL NativeSessionHost + PlanService + PlanExecutor + PlanBudget + journal,
// with only the models scripted. No network; every file lives in a temp root.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { nativeStoreSlug } from '../src/main/slug-encoding';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { stream, textChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import type { CatalogModel } from '../src/shared/provider-types';
import type { PlanView } from '../src/shared/types';

// Same ceiling the host suite uses: polls wait on a real signal, and the
// ceiling only decides how long a loaded machine may take (15 s).
const POLL_TRIES = 1_500;
const NO_CONTEXT = async () => ({ contextLength: null, totalSlots: null });

const SID = 'plan-life';
const OPENROUTER_PARENT = { providerId: 'openrouter', modelId: 'parent-model' };
const OPENROUTER_CHILD = 'deepseek/deepseek-v4-flash-0731';
// ChatGPT sign-in: the automatic specialist model for a ChatGPT conversation.
const CHATGPT_PARENT = { providerId: 'chatgpt', modelId: 'gpt-5.6-sol' };
const CATALOG: CatalogModel[] = [
  { id: OPENROUTER_CHILD, providerId: 'openrouter', label: 'DeepSeek Flash' },
  { id: 'gpt-5.6-terra', providerId: 'chatgpt', label: 'Terra' },
];

// `after`: the reply is held until that promise resolves (to prove two
// specialists were running at the same time).
type Reply = { chunks: any[]; after?: Promise<void> } | 'hang';
interface ChildCall { prompt: string; maxOutputTokens: unknown; modelId: string }

let root: string;
let host: NativeSessionHost;
let parent = OPENROUTER_PARENT;
let parentSteps: Array<any[] | { after: Promise<void>; chunks: any[] }>;
let childReply: (prompt: string, call: number) => Reply;
let childCalls: ChildCall[];
let events: any[];
let planEvents: Array<{ sessionId: string; plan: PlanView }>;
// Streams still open when a test ends (hung specialists): closed in afterEach
// so no scripted model outlives its test.
let openStreams: Array<ReadableStreamDefaultController<any>>;
// Task 12 follow-up 1: the host's clock, so a test can step past the 4-minute
// cache window without waiting. Our own leases are judged by instance id, so
// moving it never makes this process's plan look abandoned.
let clock: number;

const proposeStep = (id: string, doc: unknown) => stream(toolCallChunk(id, 'propose_plan', doc), finishChunk('tool-calls'));
const textStep = (t: string) => stream(...textChunks(`t${Math.random()}`, t), finishChunk('stop'));
const report = (text: string, inTok = 10, outTok = 5): Reply => ({ chunks: [...textChunks('r', text), finishChunk('stop', inTok, outTok)] });

/** The last user turn a specialist request carries (its brief or restart turn). */
function lastUserText(prompt: any[]): string {
  const users = prompt.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  if (!last) return '';
  return typeof last.content === 'string' ? last.content : last.content.map((p: any) => p.text ?? '').join('');
}

const factory = async (binding: { modelId: string }) => {
  if (binding.modelId !== parent.modelId) {
    return new MockLanguageModelV4({
      doStream: async (options: any) => {
        const prompt = JSON.stringify(options.prompt);
        childCalls.push({ prompt: lastUserText(options.prompt), maxOutputTokens: options.maxOutputTokens, modelId: binding.modelId });
        const reply = childReply(prompt, childCalls.length);
        if (reply === 'hang') {
          return {
            stream: new ReadableStream({
              start(c) {
                openStreams.push(c);
                c.enqueue({ type: 'stream-start', warnings: [] });
                options.abortSignal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
              },
            }),
          };
        }
        if (reply.after) {
          const gate = reply.after;
          return {
            stream: new ReadableStream({
              async start(c) {
                await gate;
                for (const chunk of stream(...reply.chunks)) c.enqueue(chunk);
                c.close();
              },
            }),
          };
        }
        return { stream: simulateReadableStream({ chunks: stream(...reply.chunks) }) };
      },
    }) as any;
  }
  return new MockLanguageModelV4({
    doStream: async () => {
      const next = parentSteps.shift() ?? textStep('ok');
      // A held parent step: `{ after, chunks }` waits for the test to release it.
      if (!Array.isArray(next)) {
        const held = next as { after: Promise<void>; chunks: any[] };
        return {
          stream: new ReadableStream({
            async start(c) {
              await held.after;
              for (const chunk of held.chunks) c.enqueue(chunk);
              c.close();
            },
          }),
        };
      }
      return { stream: simulateReadableStream({ chunks: next }) };
    },
  }) as any;
};

function makeHost(): NativeSessionHost {
  const home = new NativeHome(root);
  const h = new NativeSessionHost(
    new SessionStore(home), factory as any, NO_CONTEXT,
    async (binding: { providerId: string }) => (binding.providerId === 'chatgpt' ? 'chatgpt' : 'openrouter'),
    async () => null,
    // ChatGPT sign-in has no per-token price, so its plans' estimate/spend
    // stay in tokens (design §4/§7/§8, decision 34 Q-1/Q-5). $1/$2 per
    // MILLION input/output tokens (`costForUsage`'s own convention) for
    // everyone else — comfortably under the $1000 auto-start cap
    // (`plan-service.ts` `setAutoApprove`) even at the built-in per-type
    // estimate defaults (design §4), which run to a few hundred thousand
    // tokens.
    async (binding: { providerId: string }) => (binding.providerId === 'chatgpt' ? null : { in: 1, out: 2 }), undefined, undefined,
    { modelCatalog: async () => CATALOG },
    undefined, undefined, home, undefined, undefined, {},
    { settleDeadlineMs: 60, heartbeatMs: 5_000, slotPollMs: 5, now: () => clock },
  );
  h.on('transcript-event', (e) => events.push(e));
  h.on('plans-event', (e) => planEvents.push(e));
  return h;
}

const journalPath = () => path.join(root, '.youcoded', 'sessions', nativeStoreSlug(root), `${SID}.plans.json`);
const journal = () => JSON.parse(fs.readFileSync(journalPath(), 'utf8'));
const plan = (planId: string) => journal().plans.find((p: any) => p.planId === planId);

async function waitFor(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < POLL_TRIES; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The newest card the renderer was shown for a plan (highest seq wins there too). */
function shown(planId: string): PlanView | undefined {
  const mine = planEvents.filter((e) => e.sessionId === SID && e.plan.planId === planId).map((e) => e.plan);
  return mine.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[mine.length - 1];
}
const waitForCard = (planId: string, status: PlanView['status']) =>
  waitFor(() => shown(planId)?.status === status, `the "${status}" card`);

/** Runs the plan executor is advancing (a plan can only spend through one). */
const activeRuns = (): number => (host as any).plans.executor.activeRuns();
const liveChildren = () => [...(host as any).live.values()].filter((e: any) => e.parentSessionId === SID);

/** Everything a settled (paused/interrupted/stopped/finished) plan must no
 *  longer own. WHY no held-tokens check any more (spending rework stage 1,
 *  design §1/§3): `reservedTokens` named an allowance held against a request
 *  BEFORE it was sent — the whole reservation system is gone; `afterReply`
 *  only records what a reply actually cost, AFTER the fact, so there is
 *  nothing left to hold or release. */
function expectOwnsNothing(rec: any): void {
  expect(rec.lease).toBeUndefined();
  expect(liveChildren()).toHaveLength(0);
  expect((host as any).specialistSlots.get(SID) ?? 0).toBe(0);
  expect((host as any).activeWriterChild.has(SID)).toBe(false);
  expect((host as any).plans.executor.runs.size).toBe(0);
}

/** Open the conversation and let the parent propose `doc`; resolves with the planId. */
async function propose(doc: unknown, toolUseId = 'call-plan'): Promise<string> {
  await host.create({ sessionId: SID, cwd: root, binding: parent });
  const before = fs.existsSync(journalPath()) ? journal().plans.length : 0;
  parentSteps = [proposeStep(toolUseId, doc), textStep('Here is the plan.')];
  host.send(SID, 'Make a plan');
  await waitFor(() => fs.existsSync(journalPath()) && journal().plans.length > before, 'the proposal');
  await waitFor(() => host.isIdle(SID), 'the proposing turn to end');
  return journal().plans[before].planId;
}

const REVIEW_DOC = {
  goal: 'Review two files, then sum up',
  steps: [
    { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts', 'b.ts'] },
    { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', summary: 'Plain sentence.', of: 'review' },
  ],
};
const isCombine = (p: string) => p.includes('Combine the reviews');
const reviewReply = (p: string): Reply => (isCombine(p) ? report('COMBINED') : report(`REPORT for ${p.includes('a.ts') ? 'a' : 'b'}`));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-plan-life-'));
  clock = Date.now();
  parent = OPENROUTER_PARENT;
  events = []; planEvents = []; childCalls = []; parentSteps = []; openStreams = [];
  childReply = reviewReply;
  host = makeHost();
});

afterEach(async () => {
  await host.destroyAll();
  for (const c of openStreams) { try { c.close(); } catch { /* already errored by its abort */ } }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe('specialists plans — whole lifecycles on the real host (Task 7)', () => {
  it('propose → approve → the map wave runs in parallel, then combine → completed, and the plan owns nothing', async () => {
    const planId = await propose(REVIEW_DOC);
    expect(shown(planId)).toMatchObject({ status: 'proposed' });
    // Nothing runs before the user approves. Final review F34: checked from
    // the state that would have to exist for anything to run (a run, a lease,
    // an attempt), not by sleeping and hoping.
    expect(childCalls).toHaveLength(0);
    expect(activeRuns()).toBe(0);
    expect(plan(planId).lease).toBeUndefined();
    expect(plan(planId).steps.every((s: any) => s.attempts.length === 0)).toBe(true);

    // Both map specialists are held until both have sent: they share one wave.
    let open!: () => void;
    const bothSent = new Promise<void>((r) => { open = r; });
    childReply = (p) => (isCombine(p) ? report('COMBINED') : { ...(reviewReply(p) as { chunks: any[] }), after: bothSent });
    expect(await host.approvePlan(SID, planId)).toMatchObject({ ok: true, plan: { status: 'running' } });
    await waitFor(() => childCalls.length === 2, 'both map specialists to send together');
    expect(liveChildren()).toHaveLength(2);
    // Combine waits for its inputs: while the map wave is held, the combine
    // step has no attempt at all (F34: no sleep — nothing can send without one).
    expect(plan(planId).steps[1].attempts).toHaveLength(0);
    expect(childCalls.some((c) => isCombine(c.prompt))).toBe(false);
    expect(shown(planId)!.steps.map((s) => s.status)).toEqual(['running', 'pending']);
    open();

    await waitForCard(planId, 'completed');
    const done = plan(planId);
    expect(childCalls).toHaveLength(3);
    // Combine ran last and was handed both reports, read from the journal.
    expect(isCombine(childCalls[2].prompt)).toBe(true);
    expect(childCalls[2].prompt).toContain('REPORT for a');
    expect(childCalls[2].prompt).toContain('REPORT for b');
    // T7 (design §1/§2, decision 34): no per-STEP budget caps the reply any
    // more — whatever cap a request carries is the ordinary per-turn default
    // every specialist gets, never something sized from a plan's own ceiling
    // (that ceiling is gone).
    for (const c of childCalls) expect(typeof c.maxOutputTokens).toBe('number');
    expect(done.steps.map((s: any) => s.status)).toEqual(['done', 'done']);
    expect(done.usedTokens).toBe(45);
    // The card shows the finished steps and their specialists.
    const card = shown(planId)!;
    expect(card.steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(card.steps[0].children!.map((c) => c.status)).toEqual(['completed', 'completed']);
    // Each visible change bumped seq; the renderer never saw one go backwards.
    const seqs = planEvents.filter((e) => e.plan.planId === planId).map((e) => e.plan.seq ?? 0);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expectOwnsNothing(done);
  });

  it('propose → auto-approve: a plan under the limit starts on its own and completes; one over it waits for the user', async () => {
    // T7 (design §6/§8, decision 34 Q-6): auto-start reads a DOLLAR estimate
    // now ("when the estimate is under $X"), never a token ceiling — the max
    // a limit may be set to is $1000 (`plan-service.ts` `setAutoApprove`).
    expect(await host.setPlanAutoApprove(1000)).toEqual({ ok: true });
    const auto = await propose(REVIEW_DOC);
    // The card existed as a proposal first, then started with no click.
    const statuses = planEvents.filter((e) => e.plan.planId === auto).map((e) => e.plan.status);
    expect(statuses[0]).toBe('proposed');
    await waitForCard(auto, 'completed');
    expect(plan(auto).autoApproved).toBe(true);
    expect(childCalls).toHaveLength(3);
    expectOwnsNothing(plan(auto));

    // Auto-start OFF (design §8: `underUsd: 0` = off — deterministic, unlike
    // trying to read a boundary off one particular estimate: the estimate at
    // this point comes from empty history and the built-in per-type default
    // (design §4), a different number than what the SAME doc's NEXT proposal
    // computes once this run's real cost is in history).
    expect(await host.setPlanAutoApprove(0)).toEqual({ ok: true });
    const manual = await propose(REVIEW_DOC, 'call-plan-2');
    // Auto-approve is decided inside the proposing call, which has returned.
    expect(activeRuns()).toBe(0);
    expect(plan(manual).lease).toBeUndefined();
    expect(plan(manual).status).toBe('proposed');
    expect(plan(manual).autoApproved).toBeUndefined();
    expect(childCalls).toHaveLength(3);
  });

  // Final review F3: "Run small plans without asking" must not let one reply
  // start plan after plan. Only the first under-limit proposal of a turn
  // starts by itself; the rest wait for Approve. The next turn may start one.
  it('F3: at most one plan auto-starts per assistant turn', async () => {
    expect(await host.setPlanAutoApprove(1000)).toEqual({ ok: true });
    await host.create({ sessionId: SID, cwd: root, binding: parent });
    parentSteps = [
      // Different documents: identical calls would be caught as a loop instead.
      stream(toolCallChunk('call-a', 'propose_plan', REVIEW_DOC), toolCallChunk('call-b', 'propose_plan', { ...REVIEW_DOC, goal: 'Second plan' }), finishChunk('tool-calls')),
      proposeStep('call-c', { ...REVIEW_DOC, goal: 'Third plan' }),
      textStep('Here are the plans.'),
    ];
    host.send(SID, 'Make plans');
    await waitFor(() => fs.existsSync(journalPath()) && journal().plans.length === 3, 'three proposals');
    await waitFor(() => host.isIdle(SID), 'the proposing turn to end');
    const [a, b, c] = journal().plans.map((p: any) => p.planId as string);
    const started = [a, b, c].filter((id) => plan(id).autoApproved === true);
    expect(started).toHaveLength(1);
    for (const id of [a, b, c].filter((x) => !started.includes(x))) expect(plan(id).status).toBe('proposed');
    await waitForCard(started[0], 'completed');
    expect(childCalls).toHaveLength(3);

    // A new turn may auto-start one again.
    const next = await propose(REVIEW_DOC, 'call-d');
    await waitForCard(next, 'completed');
    expect(plan(next).autoApproved).toBe(true);
  });

  // T7 (spending rework, design §1/§3/§7, decision 34): the old WARM/COLD Add
  // budget minimum machinery this described is gone entirely — a plan
  // child's request is never capped or reserved in advance, so nothing can
  // be "too big to fit". The only way a plan pauses mid-run now is a spend
  // limit the USER set (design §7), and Continue either raises it (one call,
  // `resumePlan(sid, planId, limit)`) or is refused while it is still at or
  // past it.
  it('a spend limit reached mid-run pauses the plan; Continue is refused until the SAME call raises it, then finishes without re-running the finished step', async () => {
    const doc = {
      goal: 'Two steps',
      steps: [
        { id: 'first', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts'] },
        { id: 'second', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', summary: 'Plain sentence.', of: 'first' },
      ],
    };
    const planId = await propose(doc);
    // A tiny limit: the first (map) specialist's own reply crosses it (cost
    // convention is dollars per MILLION tokens, matching `costForUsage`).
    expect(await host.setPlanLimit(SID, planId, { usd: 0.001 })).toMatchObject({ ok: true });
    childReply = (p) => (isCombine(p) ? report('COMBINED') : report('REPORT for a', 2_000, 2_000));
    await host.approvePlan(SID, planId);
    await waitForCard(planId, 'paused');
    const paused = plan(planId);
    expectOwnsNothing(paused);
    expect(paused.paused.kind).toBe('spend-limit');
    expect(paused.paused.limit).toEqual({ usd: 0.001 });
    expect(paused.usedUsd).toBeGreaterThan(0.001);
    // The crossing reply's own step is marked paused (it reported fine —
    // the crossing only refuses the NEXT request); no new wave started past
    // the limit, so combine never got an attempt.
    expect(paused.steps[0].status).toBe('paused');
    expect(paused.steps[0].attempts).toHaveLength(1);
    expect(paused.steps[1].attempts).toHaveLength(0);

    // Continue without raising it: still at or past the limit, refused.
    expect(await host.resumePlan(SID, planId)).toMatchObject({ ok: false });
    expect(childCalls).toHaveLength(1);

    const callsBefore = childCalls.length;
    const pausesBefore = planEvents.filter((e) => e.plan.planId === planId && e.plan.status === 'paused').length;
    // Raising it in the SAME call (design §7) — Continue then runs.
    expect(await host.resumePlan(SID, planId, { usd: 1 })).toMatchObject({ ok: true, plan: { status: 'running' } });
    await waitForCard(planId, 'completed');
    const after = childCalls.slice(callsBefore);
    expect(after).toHaveLength(1);   // one request: the combine specialist, starting fresh
    expect(planEvents.filter((e) => e.plan.planId === planId && e.plan.status === 'paused').length).toBe(pausesBefore);
    const done = plan(planId);
    expect(done.steps[0].attempts).toHaveLength(1);   // the finished step was never re-run
    expect(done.steps[0].attempts[0]).toEqual(paused.steps[0].attempts[0]);
    expectOwnsNothing(done);
  });

  it('app quit mid-plan → reopen shows interrupted and runs nothing → Continue finishes without replaying a finished step', async () => {
    const planId = await propose(REVIEW_DOC);
    childReply = (p) => (isCombine(p) ? 'hang' : reviewReply(p));
    await host.approvePlan(SID, planId);
    await waitFor(() => childCalls.some((c) => isCombine(c.prompt)), 'the combine specialist to send');
    const finishedBefore = plan(planId).steps[0].attempts;
    expect(finishedBefore.every((a: any) => a.phase === 'committed')).toBe(true);

    // App quit while combine is mid-request.
    await host.destroyAll();
    const quit = plan(planId);
    expect(quit.status).toBe('interrupted');
    expect(quit.lease).toBeUndefined();

    // Reopen in a fresh app instance.
    host = makeHost();
    const callsAtQuit = childCalls.length;
    expect(await host.resume(SID, root)).toBe(true);
    const views = await host.planViewsFor(SID);
    expect(views.find((v) => v.planId === planId)).toMatchObject({ status: 'interrupted' });
    // Nothing runs until Continue: no run, no lease (F34: state, not a sleep).
    expect(activeRuns()).toBe(0);
    expect(plan(planId).lease).toBeUndefined();
    expect(childCalls).toHaveLength(callsAtQuit);
    expect(liveChildren()).toHaveLength(0);

    // Continue. T7 (design §1/§3, decision 34): the cut-off request's outcome
    // is unknown, but nothing was ever reserved against it — there is no
    // top-up left to ask for. `recoverAttempt` charges nothing and the
    // interrupted attempt just restarts (its transcript ends with nothing at
    // all — no report, no tool call — so classification's "else restart"
    // applies): Continue finishes the plan directly, with no intermediate
    // pause.
    childReply = reviewReply;
    expect(await host.resumePlan(SID, planId)).toMatchObject({ ok: true, plan: { status: 'running' } });
    await waitForCard(planId, 'completed');
    const settled = plan(planId);
    expect(settled.status).toBe('completed');
    const afterReopen = childCalls.slice(callsAtQuit);
    // Exactly one fresh request: the combine specialist picking up its own work.
    expect(afterReopen).toHaveLength(1);
    expect(afterReopen.every((c) => !c.prompt.includes('Review a.ts') && !c.prompt.includes('Review b.ts'))).toBe(true);
    // The map step's finished attempts are exactly what they were before the quit.
    expect(settled.steps[0].attempts).toEqual(finishedBefore);
    // Combine continued the SAME specialist session (one fresh prompt, not a new specialist).
    expect(new Set(settled.steps[1].attempts.map((a: any) => a.childId)).size).toBe(1);
    expectOwnsNothing(settled);
  });

  it('Comment → only the follow-up turn\'s proposal becomes the trusted revised card', async () => {
    await host.create({ sessionId: SID, cwd: root, binding: parent });
    // Turn 1 proposes plan A, then (held) proposes plan B later in the SAME turn.
    let releaseB!: () => void;
    const bHeld = new Promise<void>((r) => { releaseB = r; });
    // Decision 33: a plan may not be one specialist doing one thing, so the
    // revision narrows the split to one file but KEEPS the summing step.
    const revisedDoc = { ...REVIEW_DOC, goal: 'Review only a.ts', steps: [{ ...REVIEW_DOC.steps[0], items: ['a.ts'] }, REVIEW_DOC.steps[1]] };
    parentSteps = [
      proposeStep('call-a', REVIEW_DOC),
      { after: bHeld, chunks: proposeStep('call-b', { ...REVIEW_DOC, goal: 'Something else' }) },
      textStep('Done with turn one.'),
      // Turn 2 — the one the Comment queued — proposes the revision.
      proposeStep('call-c', revisedDoc),
      textStep('Revised.'),
    ];
    host.send(SID, 'Make a plan');
    await waitFor(() => fs.existsSync(journalPath()) && journal().plans.length === 1, 'plan A');
    const a = journal().plans[0].planId;

    // The user comments on A while turn 1 is still running.
    expect(await host.commentOnPlan(SID, a, 'Only review a.ts please')).toMatchObject({ ok: true, plan: { status: 'stopped' } });
    expect(journal().pendingRevision).toMatchObject({ oldPlanId: a });
    // Turn 1's later proposal is NOT the revision, even though one is pending:
    // the link is decided by the host's turn id, never by timing or the model.
    releaseB();
    await waitFor(() => journal().plans.length === 3, 'plan B and the revised plan C');
    await waitFor(() => host.isIdle(SID), 'both turns to end');
    const [recA, recB, recC] = journal().plans;
    expect(recB.toolUseId).toBe('call-b');
    expect(recB.revisionOf).toBeUndefined();
    expect(recC.toolUseId).toBe('call-c');
    expect(recC).toMatchObject({ status: 'proposed', revisionOf: a });
    expect(recA).toMatchObject({ status: 'stopped', revisedByComment: true, revisedBy: recC.planId });
    expect(journal().pendingRevision).toBeUndefined();   // the token was spent once
    // The cards the user sees agree.
    expect(shown(a)!.status).toBe('stopped');
    expect(shown(recC.planId)).toMatchObject({ status: 'proposed' });
    // The user's own words reached the assistant as the follow-up turn.
    expect(events.some((e) => e.type === 'user-message' && String(e.data.text).includes('Only review a.ts please'))).toBe(true);

    // The old card can no longer be approved; the revised one runs as revised.
    expect(await host.approvePlan(SID, a)).toMatchObject({ ok: false });
    await host.approvePlan(SID, recC.planId);
    await waitForCard(recC.planId, 'completed');
    expect(childCalls.filter((c) => c.prompt.includes('Review '))).toHaveLength(1);   // one item: only a.ts
    expect(childCalls[0].prompt).toContain('a.ts');
  });

  it('Stop during a four-specialist wave: all four are torn down, nothing is held, and nothing runs afterwards', async () => {
    const doc = {
      goal: 'Review four files',
      steps: [
        { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] },
        { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', summary: 'Plain sentence.', of: 'review' },
      ],
    };
    const planId = await propose(doc);
    childReply = () => 'hang';
    await host.approvePlan(SID, planId);
    await waitFor(() => childCalls.length === 4, 'all four specialists to send');
    expect(liveChildren()).toHaveLength(4);
    expect((host as any).specialistSlots.get(SID)).toBe(4);
    expect(plan(planId).steps[0].attempts.every((a: any) => a.phase === 'launched')).toBe(true);

    const res = await host.stopPlan(SID, planId);
    // By the time Stop answers, the card may say stopped — and it is true.
    expect(res).toMatchObject({ ok: true, plan: { status: 'stopped' } });
    const stopped = plan(planId);
    expectOwnsNothing(stopped);
    expect(stopped.steps.map((s: any) => s.status)).toEqual(['skipped', 'skipped']);
    // T7 (design §2/§3): there is no ceiling to stay under, and no
    // `request-sent` phase any more (only prepared/launched/committed) — a
    // cut-off request is classified from its transcript on recovery, never
    // charged against an allowance that no longer exists.
    expect(stopped.steps[0].attempts.every((a: any) => ['prepared', 'launched', 'committed'].includes(a.phase))).toBe(true);
    const stopSeq = shown(planId)!.seq;
    const eventsAtStop = planEvents.length;

    // Nothing keeps going: no new requests, no heartbeat writes, no newer card.
    // F34: the executor holds no run (so no heartbeat timer and no specialist)
    // once the plan has settled — waited for, then checked.
    const mtime = fs.statSync(journalPath()).mtimeMs;
    await (host as any).plans.executor.settled(planId);
    expect(activeRuns()).toBe(0);
    expect((host as any).plans.executor.finishing.size).toBe(0);
    expect(childCalls).toHaveLength(4);
    expect(planEvents).toHaveLength(eventsAtStop);
    expect(shown(planId)!.seq).toBe(stopSeq);
    expect(fs.statSync(journalPath()).mtimeMs).toBe(mtime);
    expectOwnsNothing(plan(planId));
    // A stopped plan can't be continued.
    expect(await host.resumePlan(SID, planId)).toMatchObject({ ok: false });
    // The parent conversation is still usable.
    parentSteps = [textStep('Still here.')];
    host.send(SID, 'hello');
    await waitFor(() => events.some((e) => e.type === 'assistant-text' && e.sessionId === SID && String(e.data.text).includes('Still here.')), 'the parent to answer');
  });

  // T7 (design §4/§7/§8, decision 34 Q-1/Q-5): ChatGPT has no published
  // price, so its estimate/spend stay in TOKENS — but there is no LIMIT at
  // all unless the user sets one (no default any more). The old "soft limit"
  // — an implicit plan-wide token ceiling ChatGPT's uncappable replies could
  // only overshoot — is gone with the rest of the reservation system; the
  // same regression (one reply may cross a limit, then the plan pauses
  // before any further request) is proven here against a limit the user
  // explicitly set, exactly like PlanCard.tsx's own paused-at-limit box.
  it('ChatGPT (no published price, token limit): one reply may overshoot it, then the plan pauses before any further request', async () => {
    parent = CHATGPT_PARENT;
    const doc = {
      goal: 'Two reviews',
      steps: [
        { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts'] },
        { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', summary: 'Plain sentence.', of: 'review' },
      ],
    };
    const planId = await propose(doc);
    const rec0 = plan(planId);
    // No published price: the estimate is tokens + a plain note, never dollars.
    expect(rec0.estimate).toMatchObject({ unpricedNote: expect.any(String) });
    expect(shown(planId)).toMatchObject({ estimate: { unpricedNote: expect.any(String) } });
    const limit = 1_000;
    expect(await host.setPlanLimit(SID, planId, { tokens: limit })).toMatchObject({ ok: true });
    // The first specialist's single reply blows past the WHOLE plan's limit.
    childReply = (p) => (isCombine(p) ? report('COMBINED') : report('REPORT for a', 10, limit + 1_000));
    await host.approvePlan(SID, planId);
    await waitForCard(planId, 'paused');
    const paused = plan(planId);
    // It overshot once (charged what was really used)…
    expect(paused.usedTokens).toBeGreaterThan(limit);
    expect(paused.paused.kind).toBe('spend-limit');
    expect(paused.paused.limit).toEqual({ tokens: limit });
    // T7 (design §1): no per-step/per-plan budget sizes the reply cap any
    // more — whatever ChatGPT's request carries is the ordinary per-turn
    // default, same as every other provider's.
    expect(typeof childCalls[0].maxOutputTokens).toBe('number');
    // …and nothing more was sent after that.
    expect(childCalls).toHaveLength(1);
    expect(childCalls.some((c) => isCombine(c.prompt))).toBe(false);
    expectOwnsNothing(paused);
    // Continue without raising the limit refuses: still at or past it.
    expect(await host.resumePlan(SID, planId)).toMatchObject({ ok: false });
    expect(childCalls).toHaveLength(1);
    // Raise it, in the SAME call (design §7) — Continue then runs.
    expect(await host.resumePlan(SID, planId, { tokens: paused.usedTokens + 10_000 })).toMatchObject({ ok: true, plan: { status: 'running' } });
    await waitForCard(planId, 'completed');
    expectOwnsNothing(plan(planId));
  });

  it('a plan specialist\'s permission ask is answered through the broker, and the approved action runs', async () => {
    // Decision 33: a plan may not be one specialist run, so a summing step
    // follows the one this test is about. It launches after the removal and
    // simply reports (childReply's catch-all).
    const doc = { goal: 'Tidy up', steps: [
      { id: 'fix', kind: 'map', specialist: 'worker', task: 'Tidy {item}', summary: 'Plain sentence.', items: ['notes'] },
      { id: 'sum', kind: 'combine', specialist: 'worker', task: 'Say what was tidied', summary: 'Plain sentence.', of: 'fix' },
    ] };
    const planId = await propose(doc);
    // A specialist's approved envelope allows its ordinary tools; a removal is
    // on the always-ask list, so it reaches the user. The file lives in the
    // test's temp root (the specialist's working folder).
    const target = path.join(root, 'old-notes.txt');
    fs.writeFileSync(target, 'stale');
    childReply = (_p, call) => (call === 1
      ? { chunks: [toolCallChunk('b-1', 'Bash', { command: 'rm old-notes.txt' }), finishChunk('tool-calls', 5, 5)] }
      : report('Removed the old notes.', 5, 5));
    const asks: any[] = [];
    host.on('hook-event', (e: any) => { if (e.type === 'PermissionRequest') asks.push(e); });
    await host.approvePlan(SID, planId);
    await waitFor(() => asks.length === 1, 'the routed ask');
    // The ask names the plan and the specialist, and waits on the parent conversation.
    const attempt = plan(planId).steps[0].attempts[0];
    expect(asks[0].sessionId).toBe(SID);
    expect(asks[0].payload.specialist).toMatchObject({ childId: attempt.childId, plan: { planId, stepId: 'fix', attemptId: attempt.attemptId } });
    // Waiting on the user holds the plan as running; nothing was removed yet.
    expect(plan(planId).status).toBe('running');
    expect(fs.existsSync(target)).toBe(true);

    host.respondPermission(asks[0].payload._requestId, { behavior: 'allow' });
    await waitForCard(planId, 'completed');
    expect(fs.existsSync(target)).toBe(false);
    const view = shown(planId)!;
    expect(view.steps[0].children![0].report).toMatchObject({ status: 'completed', text: expect.stringContaining('Removed the old notes.') });
    expectOwnsNothing(plan(planId));
  });
  // Merge with master (2026-09-16) — two interactions the merge had to reconcile.
  describe('after merging master', () => {
    // Master #489: the conversation's Stop cancels only its OWN asks, so a
    // background specialist's waiting request survives it. A plan's specialist
    // belongs to the plan (interrupt() skips it), so its request must survive
    // too — before the merge, Stop cancelled it and cut the specialist off.
    it('the conversation\'s Stop leaves a plan specialist\'s waiting ask open; answering it finishes the plan', async () => {
      // Decision 33: two specialist runs at worst, or the plan is refused.
      const doc = { goal: 'Tidy up', steps: [
        { id: 'fix', kind: 'map', specialist: 'worker', task: 'Tidy {item}', summary: 'Plain sentence.', items: ['notes'] },
        { id: 'sum', kind: 'combine', specialist: 'worker', task: 'Say what was tidied', summary: 'Plain sentence.', of: 'fix' },
      ] };
      const planId = await propose(doc);
      const target = path.join(root, 'old-notes.txt');
      fs.writeFileSync(target, 'stale');
      childReply = (_p, call) => (call === 1
        ? { chunks: [toolCallChunk('b-1', 'Bash', { command: 'rm old-notes.txt' }), finishChunk('tool-calls', 5, 5)] }
        : report('Removed the old notes.', 5, 5));
      const asks: any[] = [];
      const gone: any[] = [];
      host.on('hook-event', (e: any) => {
        if (e.type === 'PermissionRequest') asks.push(e);
        if (e.type === 'PermissionExpired' || e.type === 'PermissionResolved') gone.push(e);
      });
      await host.approvePlan(SID, planId);
      await waitFor(() => asks.length === 1, 'the routed ask');
      const requestId = asks[0].payload._requestId;

      host.interrupt(SID);
      // Settle for the negative only after a positive signal: the parent is idle.
      await waitFor(() => host.isIdle(SID), 'the conversation to settle after Stop');
      expect(gone).toEqual([]);
      expect(host.pendingAskEventsFor(SID).map((e: any) => e.payload._requestId)).toContain(requestId);
      expect(plan(planId).status).toBe('running');

      expect(host.respondPermission(requestId, { behavior: 'allow' })).toBeTruthy();
      await waitForCard(planId, 'completed');
      expect(fs.existsSync(target)).toBe(false);
      expectOwnsNothing(plan(planId));
    });

    // Master #491: a stopped or failed specialist still reports what it spent
    // (the harness now carries an abandoned turn's completed-step usage on
    // user-interrupt / session-error). A plan specialist cut off by the plan's
    // Stop spent real tokens too; the conversation's Cost figure must count them.
    it('a plan specialist stopped mid-turn still reports its completed steps\' spend to the conversation', async () => {
      // Decision 33: two specialist runs at worst. The plan is stopped inside
      // step 1, so the summing step never launches and the counts below stand.
      const doc = { goal: 'Read one file', steps: [
        { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Plain sentence.', items: ['a.ts'] },
        { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Sum up', summary: 'Plain sentence.', of: 'review' },
      ] };
      const planId = await propose(doc);
      fs.writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      childReply = (_p, call) => (call === 1
        ? { chunks: [toolCallChunk('r-1', 'Read', { file_path: path.join(root, 'a.ts') }), finishChunk('tool-calls', 400, 20)] }
        : 'hang');
      await host.approvePlan(SID, planId);
      await waitFor(() => childCalls.length === 2, 'the specialist\'s second request');
      const res = await host.stopPlan(SID, planId);
      expect(res).toMatchObject({ ok: true, plan: { status: 'stopped' } });
      const reports = events.filter((e) => e.type === 'subagent-usage' && e.sessionId === SID);
      expect(reports).toHaveLength(1);
      expect(reports[0].data.usage).toMatchObject({ inputTokens: 400, outputTokens: 20 });
      expect(reports[0].data.usage.costUsd).toBeGreaterThan(0);
      expectOwnsNothing(plan(planId));
    });
  });
});
