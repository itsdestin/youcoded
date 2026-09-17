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
import { resetDisabledAdaptersForTests } from '../src/main/harness/plans/budget-adapter';
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
    // The route type decides the budget adapter: ChatGPT gets the soft one.
    async (binding: { providerId: string }) => (binding.providerId === 'chatgpt' ? 'chatgpt' : 'openrouter'),
    async () => null,
    // ChatGPT sign-in has no per-token price, so its plans have a token limit only.
    async (binding: { providerId: string }) => (binding.providerId === 'chatgpt' ? null : { in: 1, out: 2 }), undefined, undefined,
    { modelCatalog: async () => CATALOG },
    undefined, undefined, home, undefined, undefined, {},
    { settleDeadlineMs: 60, heartbeatMs: 5_000, slotPollMs: 5 },
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

const liveChildren = () => [...(host as any).live.values()].filter((e: any) => e.parentSessionId === SID);
const heldTokens = (rec: any) => rec.steps.reduce((n: number, s: any) => n + s.attempts.reduce((m: number, a: any) => m + a.reservedTokens, 0), 0);

/** Everything a settled (paused/interrupted/stopped/finished) plan must no longer own. */
function expectOwnsNothing(rec: any): void {
  expect(rec.lease).toBeUndefined();
  expect(heldTokens(rec)).toBe(0);
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
    { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 2000, items: ['a.ts', 'b.ts'] },
    { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', budget_tokens: 2000, of: 'review' },
  ],
};
const isCombine = (p: string) => p.includes('Combine the reviews');
const reviewReply = (p: string): Reply => (isCombine(p) ? report('COMBINED') : report(`REPORT for ${p.includes('a.ts') ? 'a' : 'b'}`));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-plan-life-'));
  parent = OPENROUTER_PARENT;
  events = []; planEvents = []; childCalls = []; parentSteps = []; openStreams = [];
  childReply = reviewReply;
  resetDisabledAdaptersForTests();
  host = makeHost();
});

afterEach(async () => {
  await host.destroyAll();
  for (const c of openStreams) { try { c.close(); } catch { /* already errored by its abort */ } }
  resetDisabledAdaptersForTests();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe('specialists plans — whole lifecycles on the real host (Task 7)', () => {
  it('propose → approve → the map wave runs in parallel, then combine → completed, and the plan owns nothing', async () => {
    const planId = await propose(REVIEW_DOC);
    expect(shown(planId)).toMatchObject({ status: 'proposed' });
    await new Promise((r) => setTimeout(r, 30));
    expect(childCalls).toHaveLength(0);   // nothing runs before the user approves

    // Both map specialists are held until both have sent: they share one wave.
    let open!: () => void;
    const bothSent = new Promise<void>((r) => { open = r; });
    childReply = (p) => (isCombine(p) ? report('COMBINED') : { ...(reviewReply(p) as { chunks: any[] }), after: bothSent });
    expect(await host.approvePlan(SID, planId)).toMatchObject({ ok: true, plan: { status: 'running' } });
    await waitFor(() => childCalls.length === 2, 'both map specialists to send together');
    expect(liveChildren()).toHaveLength(2);
    // Combine waits for its inputs.
    await new Promise((r) => setTimeout(r, 30));
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
    // Every request was capped by what was reserved for it.
    for (const c of childCalls) expect(typeof c.maxOutputTokens).toBe('number');
    expect(done.steps.map((s: any) => s.status)).toEqual(['done', 'done']);
    expect(done.usedTokens).toBe(45);
    expect(done.usedTokens).toBeLessThanOrEqual(done.ceilingTokens);
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
    expect(await host.setPlanAutoApprove(1_000_000)).toEqual({ ok: true });
    const auto = await propose(REVIEW_DOC);
    // The card existed as a proposal first, then started with no click.
    const statuses = planEvents.filter((e) => e.plan.planId === auto).map((e) => e.plan.status);
    expect(statuses[0]).toBe('proposed');
    await waitForCard(auto, 'completed');
    expect(plan(auto).autoApproved).toBe(true);
    expect(childCalls).toHaveLength(3);
    expectOwnsNothing(plan(auto));

    // A limit below this plan's ceiling: it stays a proposal.
    const ceiling = plan(auto).ceilingTokens;
    expect(await host.setPlanAutoApprove(ceiling)).toEqual({ ok: true });   // "under", so equal is not enough
    const manual = await propose(REVIEW_DOC, 'call-plan-2');
    await new Promise((r) => setTimeout(r, 50));
    expect(plan(manual).status).toBe('proposed');
    expect(plan(manual).autoApproved).toBeUndefined();
    expect(childCalls).toHaveLength(3);
  });

  it('budget pause → Add budget of exactly the asked amount → Continue finishes the job without re-running the finished step', async () => {
    const doc = {
      goal: 'Two steps',
      steps: [
        { id: 'first', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 500, items: ['a.ts'] },
        { id: 'second', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', budget_tokens: 500, of: 'first' },
      ],
    };
    const planId = await propose(doc);
    const rec0 = plan(planId);
    const allowance = 500 + rec0.manifest.specialists.reviewer.setupTokens;
    // The combine specialist spends all but 5 tokens on a tool call, so its
    // next request can't fit: the plan pauses on it.
    childReply = (p, call) => {
      if (!isCombine(p)) return report('REPORT for a');
      return call === 2
        ? { chunks: [toolCallChunk('read-1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls', 1, allowance - 6)] }
        : report('COMBINED', 1, 1);
    };
    await host.approvePlan(SID, planId);
    await waitForCard(planId, 'paused');
    const paused = plan(planId);
    expectOwnsNothing(paused);
    expect(paused.steps.map((s: any) => s.status)).toEqual(['done', 'paused']);
    const minimum: number = paused.paused.minimumAddTokens;
    expect(minimum).toBeGreaterThan(0);
    expect(shown(planId)!.paused).toMatchObject({ minimumAddTokens: minimum });

    // Exactly the asked amount: the limit and that specialist's allowance
    // grow by precisely that, and nothing else changes.
    const ceilingBefore = paused.ceilingTokens;
    const combineAttempt = paused.steps[1].attempts[0];
    expect(await host.addPlanBudget(SID, planId, minimum)).toMatchObject({ ok: true, plan: { status: 'paused' } });
    const topped = plan(planId);
    expect(topped.ceilingTokens).toBe(ceilingBefore + minimum);
    expect(topped.steps[1].attempts[0].addedTokens).toBe(combineAttempt.addedTokens + minimum);
    expect(topped.usedTokens).toBe(paused.usedTokens);

    const callsBefore = childCalls.length;
    expect(await host.resumePlan(SID, planId)).toMatchObject({ ok: true, plan: { status: 'running' } });
    await waitForCard(planId, 'completed');
    const after = childCalls.slice(callsBefore);
    // One request: the combine specialist picking up where it stopped.
    expect(after).toHaveLength(1);
    expect(after.some((c) => c.prompt.includes('Review a.ts'))).toBe(false);
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
    expect(heldTokens(quit)).toBe(0);

    // Reopen in a fresh app instance.
    host = makeHost();
    const callsAtQuit = childCalls.length;
    expect(await host.resume(SID, root)).toBe(true);
    const views = await host.planViewsFor(SID);
    expect(views.find((v) => v.planId === planId)).toMatchObject({ status: 'interrupted' });
    await new Promise((r) => setTimeout(r, 50));
    expect(childCalls).toHaveLength(callsAtQuit);   // nothing runs until Continue
    expect(liveChildren()).toHaveLength(0);

    // Continue. The cut-off request's outcome is unknown, so it was charged in
    // full: Continue pauses at once on that specialist, asking for the top-up
    // its restart needs (never silently re-sending on money it doesn't have).
    childReply = reviewReply;
    expect(await host.resumePlan(SID, planId)).toMatchObject({ ok: true });
    await waitForCard(planId, 'paused');
    const needsTopUp = plan(planId);
    expect(needsTopUp.paused).toMatchObject({ stepId: 'sum', attemptId: needsTopUp.steps[1].attempts[0].attemptId });
    expect(needsTopUp.paused.minimumAddTokens).toBeGreaterThan(0);
    expect(childCalls).toHaveLength(callsAtQuit);   // that pause sent nothing
    expectOwnsNothing(needsTopUp);
    expect(await host.addPlanBudget(SID, planId, needsTopUp.paused.minimumAddTokens)).toMatchObject({ ok: true });
    expect(await host.resumePlan(SID, planId)).toMatchObject({ ok: true });
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
    const revisedDoc = { ...REVIEW_DOC, goal: 'Review only a.ts', steps: [{ ...REVIEW_DOC.steps[0], items: ['a.ts'] }] };
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
        { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 1000, items: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] },
        { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', budget_tokens: 1000, of: 'review' },
      ],
    };
    const planId = await propose(doc);
    childReply = () => 'hang';
    await host.approvePlan(SID, planId);
    await waitFor(() => childCalls.length === 4, 'all four specialists to send');
    expect(liveChildren()).toHaveLength(4);
    expect((host as any).specialistSlots.get(SID)).toBe(4);
    expect(heldTokens(plan(planId))).toBeGreaterThan(0);

    const res = await host.stopPlan(SID, planId);
    // By the time Stop answers, the card may say stopped — and it is true.
    expect(res).toMatchObject({ ok: true, plan: { status: 'stopped' } });
    const stopped = plan(planId);
    expectOwnsNothing(stopped);
    expect(stopped.steps.map((s: any) => s.status)).toEqual(['skipped', 'skipped']);
    // Every cut-off request was charged in full (its outcome is unknown), and
    // the limit was never passed.
    expect(stopped.usedTokens).toBeLessThanOrEqual(stopped.ceilingTokens);
    expect(stopped.steps[0].attempts.every((a: any) => a.phase !== 'request-sent')).toBe(true);
    const stopSeq = shown(planId)!.seq;
    const eventsAtStop = planEvents.length;

    // Nothing keeps going: no new requests, no heartbeat writes, no newer card.
    const mtime = fs.statSync(journalPath()).mtimeMs;
    await new Promise((r) => setTimeout(r, 150));
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

  it('ChatGPT (soft limit): one reply may overshoot, then the plan pauses before any further request', async () => {
    parent = CHATGPT_PARENT;
    const doc = {
      goal: 'Two reviews',
      steps: [
        { id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 500, items: ['a.ts'] },
        { id: 'sum', kind: 'combine', specialist: 'reviewer', task: 'Combine the reviews', budget_tokens: 500, of: 'review' },
      ],
    };
    const planId = await propose(doc);
    const rec0 = plan(planId);
    expect(rec0.approximateLimit).toBe(true);
    expect(shown(planId)).toMatchObject({ approximateLimit: true });
    const ceiling = rec0.ceilingTokens;
    // The first specialist's single reply blows past the WHOLE plan's limit.
    childReply = (p) => (isCombine(p) ? report('COMBINED') : report('REPORT for a', 10, ceiling + 1_000));
    await host.approvePlan(SID, planId);
    await waitForCard(planId, 'paused');
    const paused = plan(planId);
    // It overshot once (charged what was really used)…
    expect(paused.usedTokens).toBeGreaterThan(ceiling);
    expect(paused.ceilingUsd).toBeNull();
    expect(paused.paused.reason).toMatch(/budget/);
    // ChatGPT rejects a reply cap, so the request went without one.
    expect(childCalls[0].maxOutputTokens).toBeUndefined();
    // …and nothing more was sent after that.
    expect(childCalls).toHaveLength(1);
    expect(childCalls.some((c) => isCombine(c.prompt))).toBe(false);
    expectOwnsNothing(paused);
    // Continue without more budget sends nothing: it pauses again straight away.
    expect(await host.resumePlan(SID, planId)).toMatchObject({ ok: true });
    await waitFor(() => plan(planId).status === 'paused' && (shown(planId)?.seq ?? 0) > paused.seq, 'the second pause');
    expect(childCalls).toHaveLength(1);
    expectOwnsNothing(plan(planId));
  });

  it('a plan specialist\'s permission ask is answered through the broker, and the approved action runs', async () => {
    const doc = { goal: 'Tidy up', steps: [{ id: 'fix', kind: 'map', specialist: 'worker', task: 'Tidy {item}', budget_tokens: 3000, items: ['notes'] }] };
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
    // Master #491: a stopped or failed specialist still reports what it spent
    // (the harness now carries an abandoned turn's completed-step usage on
    // user-interrupt / session-error). A plan specialist cut off by the plan's
    // Stop spent real tokens too; the conversation's Cost figure must count them.
    it('a plan specialist stopped mid-turn still reports its completed steps\' spend to the conversation', async () => {
      const doc = { goal: 'Read one file', steps: [{ id: 'review', kind: 'map', specialist: 'reviewer', task: 'Review {item}', budget_tokens: 3000, items: ['a.ts'] }] };
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
