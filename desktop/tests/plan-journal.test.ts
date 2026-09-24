// Tests for PlanJournal — the single writer of sessions/<slug>/<parentId>.plans.json
// (specialists plans, Task 2). Real filesystem per test, same fixture style as
// specialist-delegation-ledger.test.ts: NativeHome(tempRoot), no fs mocking.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import {
  PlanJournal, PlanFenceError, PlanJournalUnreadableError, PlanJournalIntegrityError, projectPlan,
} from '../src/main/harness/plans/plan-journal';
import type { PlanEvent, PlanRecord, PlanRef } from '../src/main/harness/plans/types';
import type { PlanDocumentV1 } from '../src/main/harness/plans/schema';

const REF: PlanRef = { cwd: '/some/project', sessionId: 'parent-1' };

const DOC: PlanDocumentV1 = {
  goal: 'Review the auth module',
  steps: [
    { id: 's1', kind: 'map', specialist: 'reviewer', task: 'Review {item}\nmore detail', summary: 'Plain sentence.', items: ['a.ts', 'b.ts'] },
    { id: 's2', kind: 'combine', specialist: 'worker', task: 'Combine the reviews', summary: 'Plain sentence.', of: 's1' },
    { id: 'loop', kind: 'repeat', specialist: 'worker', task: 'Iterate', summary: 'Plain sentence.', max_iterations: 3, until: 'tests pass',
      steps: [{ id: 'fix', kind: 'map', specialist: 'worker', task: 'Fix it', summary: 'Plain sentence.', items: ['x'] }] },
  ],
};

// WHY manifest.specialists only carries a definitionFingerprint, and binding/
// pricing live under manifest.steps (spending rework stage 1, design §2/§5):
// a per-step model override means two steps naming the same specialist can
// freeze different bindings.
function record(planId: string, overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    planId, toolUseId: `tool-${planId}`, document: DOC, maximumAttempts: 6, maxFanOut: 2,
    usedTokens: 0, status: 'proposed', seq: 1, createdAt: 10,
    manifest: {
      modelLabel: 'Test model',
      specialists: { reviewer: { definitionFingerprint: 'r1' }, worker: { definitionFingerprint: 'w1' } },
      steps: {},
      permissionFingerprint: 'perm-1',
    },
    steps: ['s1', 's2', 'loop', 'fix'].map((id) => ({ id, status: 'pending' as const, attempts: [] })),
    fenceEpoch: 0,
    ...overrides,
  };
}

let root: string; let home: NativeHome; let events: PlanEvent[]; let clock: number;
let alive: Set<number>;
const journalFor = (instanceId: string, pid: number) => new PlanJournal({
  home, now: () => clock, identity: { instanceId, pid }, isProcessAlive: (p) => alive.has(p),
  onEvent: (e) => events.push(e), leaseTtlMs: 1000,
});
let journal: PlanJournal;
const filePath = () => path.join(root, '.youcoded', journal.relPath(REF));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-journal-'));
  home = new NativeHome(root); events = []; clock = 1000; alive = new Set();
  journal = journalFor('inst-a', 111);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function seed(...recs: PlanRecord[]): Promise<void> {
  await journal.mutate(REF, (file) => { file.plans.push(...recs); });
  events = [];
}

describe('strict read and quarantine', () => {
  it('a missing journal reads as absent, creates nothing, and initializes lazily on first write', async () => {
    expect(await journal.read(REF)).toEqual({ kind: 'absent' });
    expect(await journal.list(REF)).toEqual([]);
    expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false);
    await journal.mutate(REF, (file) => { file.plans.push(record('p1')); });
    const onDisk = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    expect(onDisk.v).toBe(2);
    expect(onDisk.plans[0].planId).toBe('p1');
  });

  it.each([
    ['malformed JSON', Buffer.from('{"v":2,"plans":[{"toolUseId":"tool-9" \xff', 'latin1'), /not valid JSON/],
    ['unsupported version', Buffer.from(JSON.stringify({ v: 3, plans: [] })), /version 3/],
    ['wrong shape', Buffer.from(JSON.stringify({ v: 2, plans: [{ planId: 'x' }] })), /expected layout/],
  ])('%s: bytes are quarantined verbatim and every write is refused', async (_label, bytes, detail) => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), bytes);

    const read = await journal.read(REF);
    expect(read.kind).toBe('invalid');
    if (read.kind !== 'invalid') throw new Error('unreachable');
    expect(read.detail).toMatch(detail);
    expect(fs.readFileSync(read.quarantinePath).equals(bytes)).toBe(true);

    await expect(journal.mutate(REF, (file) => { file.plans.push(record('p1')); })).rejects.toBeInstanceOf(PlanJournalUnreadableError);
    await expect(journal.recoverInterrupted(REF)).rejects.toBeInstanceOf(PlanJournalUnreadableError);
    // Original bytes untouched; exactly one quarantine copy however often we look.
    expect(fs.readFileSync(filePath()).equals(bytes)).toBe(true);
    await journal.read(REF);
    const copies = fs.readdirSync(path.dirname(filePath())).filter((f) => f.includes('.quarantine-'));
    expect(copies).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('a pause launch value this build has never heard of is ignored, never a reason to quarantine every plan in the file', async () => {
    // Review finding 5: `launch` has been widened twice ('drift', then
    // 'not-ready') without a journal version bump. A strict enum means a
    // journal written by a NEWER build fails the whole-file parse on an older
    // one, which quarantines every plan for that folder — and ~/.youcoded/ is
    // synced between machines, so a rollback or a second machine reaches it.
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const plan = record('p1', {
      status: 'paused',
      paused: { stepId: 's1', kind: 'launch-failed', reason: 'it stopped' },
    });
    fs.writeFileSync(filePath(), JSON.stringify({
      v: 2,
      plans: [{ ...plan, paused: { ...plan.paused, launch: 'something-a-later-build-added' } }],
    }));
    const read = await journal.read(REF);
    expect(read.kind).toBe('valid');
    const kept = (await journal.get(REF, 'p1'))!;
    // The plan survives whole; only the value nobody here understands is gone.
    expect(kept.paused).toEqual({ stepId: 's1', kind: 'launch-failed', reason: 'it stopped' });
    expect(fs.readdirSync(path.dirname(filePath())).filter((f) => f.includes('.quarantine-'))).toEqual([]);
  });

  // Spending rework stage 1, design §2, decision 33.4 / open question 7
  // ("resolved here"): a v1 journal is not damaged — it is a shape this
  // build no longer reads. It is retired silently: archived byte-for-byte
  // next to the live path, and the conversation starts a fresh, empty v2
  // journal with no failed card.
  it('a v1 journal is retired to <file>.v1-retired and reads as absent, with no failed card', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const v1Bytes = Buffer.from(JSON.stringify({ v: 1, plans: [{ planId: 'old-demo', toolUseId: 'tool-old', status: 'proposed' }] }));
    fs.writeFileSync(filePath(), v1Bytes);

    const read = await journal.read(REF);
    expect(read).toEqual({ kind: 'absent' });
    expect(await journal.list(REF)).toEqual([]);

    const retiredPath = `${filePath()}.v1-retired`;
    expect(fs.existsSync(retiredPath)).toBe(true);
    expect(fs.readFileSync(retiredPath).equals(v1Bytes)).toBe(true);
    expect(fs.existsSync(filePath())).toBe(false);

    // The next write starts a fresh, empty v2 journal at the live path.
    await journal.mutate(REF, (file) => { file.plans.push(record('p1')); });
    const onDisk = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    expect(onDisk.v).toBe(2);
    expect(onDisk.plans.map((p: PlanRecord) => p.planId)).toEqual(['p1']);
  });

  it('a v1 journal is also retired on the mutate() path, not only on read()', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify({ v: 1, plans: [{ planId: 'old-demo' }] }));
    await journal.mutate(REF, (file) => { file.plans.push(record('p1')); });
    expect(fs.existsSync(`${filePath()}.v1-retired`)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    expect(onDisk.v).toBe(2);
    expect(onDisk.plans.map((p: PlanRecord) => p.planId)).toEqual(['p1']);
  });

  it('an unreadable journal projects each recoverable card as failed rather than disappearing', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), '{"v":1,"plans":[{"planId":"p9","toolUseId":"tool-9","status":"running","seq":7,"x":1},{"planId":"p8","toolUseId":"tool\\"8", oops');
    const views = await journal.list(REF);
    expect(views.map((v) => [v.toolUseId, v.status, v.seq, v.title])).toEqual([
      // seq = the damaged record's own seq, so the failed state replaces the
      // stale card now and a repaired journal (seq >= 7) can replace it later.
      ['tool-9', 'failed', 7, ''],
      // No recoverable seq → 0; escaped ids are unescaped; empty title lets
      // the card fall back to its own wording instead of "Plan: a plan".
      ['tool"8', 'failed', 0, ''],
    ]);
    // Product decision 6: each failed card carries the real reason, verbatim.
    expect(views.map((v) => v.failure?.detail)).toEqual([
      expect.stringMatching(/^The saved plan file is not valid JSON/),
      expect.stringMatching(/^The saved plan file is not valid JSON/),
    ]);
  });

  // WHY no approximateLimit/budgetTokens/setupTokens assertions any more
  // (spending rework stage 1, design §1/§2): all three are retired — see
  // shared/types.ts and plan-journal.ts's matching WHY comments.
  it('projects a failed record\'s own detail', async () => {
    await journal.mutate(REF, (file) => {
      const rec = record('p1', { status: 'failed', failure: { detail: 'The specialist definition file could not be read.' } });
      file.plans.push(rec);
    });
    const [view] = await journal.list(REF);
    expect(view.failure).toEqual({ detail: 'The specialist definition file could not be read.' });
    expect(view.steps[0]).toMatchObject({ id: 's1' });
  });
});

describe('mutation chokepoint', () => {
  it('every visible mutation bumps that plan\'s seq and emits exactly one projected PlanView', async () => {
    await journal.mutate(REF, (file) => { file.plans.push(record('p1'), record('p2')); });
    expect(events.map((e) => [e.plan.planId, e.plan.seq])).toEqual([['p1', 1], ['p2', 1]]);
    events = [];
    await journal.mutate(REF, (file) => { file.plans[0].status = 'stopped'; });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ sessionId: 'parent-1', plan: projectPlan((await journal.get(REF, 'p1'))!) });
    expect(events[0].plan).toMatchObject({ planId: 'p1', status: 'stopped', seq: 2 });
    // A mutation that changes nothing writes nothing and emits nothing.
    events = [];
    const before = fs.readFileSync(filePath(), 'utf8');
    await journal.mutate(REF, () => {});
    expect(events).toEqual([]);
    expect(fs.readFileSync(filePath(), 'utf8')).toBe(before);
  });

  it('a no-change or throwing mutate on an absent journal leaves no directory behind', async () => {
    await journal.mutate(REF, () => {});
    await expect(journal.mutate(REF, () => { throw new Error('nope'); })).rejects.toThrow('nope');
    expect(fs.existsSync(path.join(root, '.youcoded'))).toBe(false);
  });

  it('the first real write to an absent journal runs the mutation once and emits once', async () => {
    let runs = 0;
    await journal.mutate(REF, (file) => { runs++; file.plans.push(record('p1')); });
    expect(runs).toBe(1);
    expect(events.map((e) => [e.plan.planId, e.plan.seq])).toEqual([['p1', 1]]);
    expect((await journal.get(REF, 'p1'))!.seq).toBe(1);
  });

  it('a throwing mutation writes nothing and emits nothing', async () => {
    await seed(record('p1'));
    await expect(journal.mutate(REF, (file) => { file.plans[0].status = 'running'; throw new Error('nope'); })).rejects.toThrow('nope');
    expect((await journal.get(REF, 'p1'))!.status).toBe('proposed');
    expect(events).toEqual([]);
  });

  // WHY no ceilingTokens/ceilingUsd/budgetTokens assertions any more
  // (spending rework stage 1, design §1/§2, decision 34): none of the three
  // exist any more — there is no per-step token budget to sum.
  it('projects top-level rows, repeat bodies with their iteration multiplier, and the card fields', () => {
    const view = projectPlan(record('p1', { status: 'running', usedTokens: 5, startedAt: 20, autoApproved: true }));
    expect(view).toMatchObject({
      planId: 'p1', toolUseId: 'tool-p1', title: 'Review the auth module', status: 'running',
      model: { label: 'Test model' }, usedTokens: 5, autoApproved: true, seq: 1,
    });
    // Decision 33: a repeat is ONE row that CONTAINS its body — the loop, its
    // round cap and its stop condition now have somewhere to appear.
    expect(view.steps.map((s) => [s.id, s.kind, s.fanOut, s.title])).toEqual([
      ['s1', 'map', 2, 'Review {item}'],
      ['s2', 'combine', 1, 'Combine the reviews'],
      ['loop', 'repeat', 3, 'Iterate'],
    ]);
    expect(view.steps[2].rounds).toBe(3);
    expect(view.steps[2].until).toBe('tests pass');
    // The body rows are exactly the rows the flattened projection produced.
    expect(view.steps[2].body!.map((s) => [s.id, s.kind, s.fanOut, s.title])).toEqual([
      ['fix', 'map', 3, 'Fix it'],
    ]);
  });

  // The card knew only "2 reviewers" and never on WHAT, although the document's
  // own item list is exactly that answer (Destin, 2026-09-18: "it's still a bit
  // hard to tell … what the plan will do from this card").
  it('carries a fan-out step\'s item labels and the assistant\'s own sentence onto the card', () => {
    const summary = 'Two reviewers each read one file and report what they find.';
    const document: PlanDocumentV1 = { ...DOC, steps: [{ ...DOC.steps[0], summary }, ...DOC.steps.slice(1)] };
    const view = projectPlan(record('p1', { document }));

    expect(view.steps[0].items).toEqual(['a.ts', 'b.ts']);
    expect(view.steps[0].summary).toBe(summary);
    // A combine runs one specialist on an earlier step's results — no items.
    expect(view.steps[1].items).toBeUndefined();
    // A repeat-body row's fan-out is its items TIMES the rounds, so naming the
    // items beside "3 workers" would misdescribe what will happen.
    expect(view.steps[2].kind).toBe('repeat');
    expect(view.steps[2].items).toBeUndefined();
  });

  // The plan already records which earlier step a checking or combining step
  // consumes, and the executor feeds exactly those reports in as its input —
  // but the card never showed it, so the reader could not tell how one step
  // flowed into the next (Destin, 2026-09-18).
  it('carries the earlier step a checking or combining step consumes onto the card', () => {
    const view = projectPlan(record('p1'));
    // s2 combines s1: the card can now name both ends of that edge.
    expect(view.steps[1].kind).toBe('combine');
    expect(view.steps[1].of).toBe('s1');
    // A fan-out step consumes nothing, so it claims no input.
    expect(view.steps[0].of).toBeUndefined();
    // A repeat-body row's reference, if it had one, would name a body step;
    // this one has none and must not invent an edge.
    expect(view.steps[2].of).toBeUndefined();
  });

  // Decision 33 made `summary` required, but a journal written before that
  // change still has to draw: its row falls back to the headline it always had.
  it('leaves a step with no sentence of its own showing exactly the headline it showed before', () => {
    const older = structuredClone(DOC) as any;
    delete older.steps[0].summary;
    const view = projectPlan(record('p1', { document: older }));
    expect(view.steps[0].summary).toBeUndefined();
    expect(view.steps[0].title).toBe('Review {item}');
  });
});

describe('5b follow-up: pause facts and attempt phase reach the card', () => {
  // WHY only 'prepared'/'launched' (spending rework stage 1, design §2/§3):
  // no separate in-flight request phase exists any more.
  const attempt = (attemptId: string, phase: 'prepared' | 'launched', childId: string) => ({
    attemptId, itemIndex: 0, iteration: 0, childId, childTitle: childId, startedAt: 30,
    spentTokens: 0, phase,
  });

  it('the pause kind, tool, rounds and note survive the strict re-read and are projected', async () => {
    await seed(record('p1', {
      status: 'paused',
      paused: {
        stepId: 's1', reason: 'r', attemptId: 'a1', kind: 'unknown-outcome', tool: 'Bash',
        repeat: { rounds: 3, until: 'tests pass' }, note: '1 other specialist was cut off.',
      },
    }));
    const rec = (await journal.get(REF, 'p1'))!;
    expect(projectPlan(rec).paused).toEqual({
      stepId: 's1', reason: 'r', kind: 'unknown-outcome', tool: 'Bash',
      repeat: { rounds: 3, until: 'tests pass' }, note: '1 other specialist was cut off.',
      // Task 9b: the card's default buttons ride along (an unknown outcome
      // with no known effect counts as external → Stop · Continue).
      actions: ['continue', 'stop'],
    });
  });

  it('a pause kind the app does not know makes the journal unreadable (strict schema)', async () => {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const bad = record('p1', { status: 'paused', paused: { stepId: 's1', reason: 'r' } });
    (bad.paused as any).kind = 'made-up';
    fs.writeFileSync(filePath(), JSON.stringify({ v: 2, plans: [bad] }));
    expect((await journal.read(REF)).kind).toBe('invalid');
  });

  it('a journal written before the kind existed still reads, with no kind on the card', async () => {
    await seed(record('p1', { status: 'paused', paused: { stepId: 's1', reason: 'r' } }));
    // Task 9b: no kind reads as an unexpected problem → Stop · Continue.
    expect(projectPlan((await journal.get(REF, 'p1'))!).paused).toEqual({ stepId: 's1', reason: 'r', actions: ['continue', 'stop'] });
  });

  it('each specialist row carries its attempt phase: prepared (never sent) vs launched', () => {
    const view = projectPlan(record('p1', {
      status: 'stopped',
      steps: [
        { id: 's1', status: 'skipped', attempts: [attempt('a1', 'prepared', 'kid-1'), attempt('a2', 'launched', 'kid-2')] },
        ...['s2', 'loop', 'fix'].map((id) => ({ id, status: 'pending' as const, attempts: [] })),
      ],
    }));
    expect(view.steps[0].children!.map((c) => [c.childId, c.status, c.phase])).toEqual([
      ['kid-1', 'interrupted', 'prepared'],
      ['kid-2', 'interrupted', 'launched'],
    ]);
  });
});

describe('repeat projection', () => {
  const LOOP: PlanDocumentV1 = {
    goal: 'Loop',
    steps: [
      { id: 'r', kind: 'repeat', specialist: 'worker', task: 'Loop', summary: 'Keep going until the tests pass.', max_iterations: 5, until: 'done',
        steps: [
          { id: 'rev', kind: 'map', specialist: 'reviewer', task: 'Review {item}', summary: 'Three helpers each read one part.', items: ['a', 'b', 'c'] },
          { id: 'chk', kind: 'verify', specialist: 'reviewer', task: 'Check', summary: 'One helper says whether it is right yet.', of: 'rev' },
        ] },
    ],
  };
  const loopRecord = () => record('p1', {
    document: LOOP,
    steps: ['r', 'rev', 'chk'].map((id) => ({ id, status: 'pending' as const, attempts: [] })),
  });

  // WHY no worst-case token assertion any more (spending rework stage 1,
  // design §1/§2, decision 34): "THE PRICING PIN" (the old ceiling-matches-
  // the-flattened-projection test) is retired along with `budgetTokens`/
  // `setupTokens`/`ceilingTokens` — there is no per-step token ceiling left
  // to keep from moving.
  it('draws a repeat as ONE row carrying its body, its rounds and its stop condition', () => {
    const view = projectPlan(loopRecord());
    expect(view.steps.map((s) => [s.id, s.kind, s.fanOut])).toEqual([['r', 'repeat', 20]]);
    expect(view.steps[0].rounds).toBe(5);
    expect(view.steps[0].until).toBe('done');
    // The body keeps its own kinds — the card no longer needs a "repeat" label
    // on every inner row, because the row above them says it once.
    expect(view.steps[0].body!.map((s) => [s.id, s.kind, s.fanOut])).toEqual([
      ['rev', 'map', 15],
      ['chk', 'verify', 5],
    ]);
  });

  it('carries the body\'s progress and spend onto the repeat\'s own row', () => {
    const attempt = (spent: number) => ({
      attemptId: `a${spent}`, itemIndex: 0, iteration: 0, childId: `c${spent}`, childTitle: 'c', startedAt: 1,
      spentTokens: spent,
      phase: 'committed' as const, terminal: 'completed' as const, completedAt: 2,
    });
    const view = projectPlan(record('p1', {
      document: LOOP, status: 'running',
      steps: [
        { id: 'r', status: 'running' as const, attempts: [] },
        { id: 'rev', status: 'running' as const, attempts: [attempt(300), attempt(400)] },
        { id: 'chk', status: 'pending' as const, attempts: [] },
      ],
    }));
    expect(view.steps[0].done).toBe(2);
    expect(view.steps[0].usedTokens).toBe(700);
  });
});

describe('lease and fencing', () => {
  it('lease acquisition is compare-and-swap: a second live claimant is refused', async () => {
    await seed(record('p1'));
    const a = await journal.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    expect(a).toMatchObject({ ok: true, epoch: 1 });
    expect((await journal.get(REF, 'p1'))!.status).toBe('running');
    const b = await journalFor('inst-b', 222).acquireLease(REF, 'p1');
    expect(b).toEqual({ ok: false, reason: 'held' });
  });

  it('a live foreign lease cannot be stolen even after expiry while its process lives', async () => {
    await seed(record('p1'));
    const other = journalFor('inst-b', 222);
    expect((await other.acquireLease(REF, 'p1', { startFrom: ['proposed'] })).ok).toBe(true);
    alive.add(222);
    clock += 5000; // well past expiry
    expect(await journal.acquireLease(REF, 'p1')).toEqual({ ok: false, reason: 'held' });
    expect(await journal.recoverInterrupted(REF)).toEqual({ interrupted: [] });
    expect((await journal.get(REF, 'p1'))!.status).toBe('running');
  });

  it('a crashed owner with an unexpired lease is re-checked after expiry and then interrupted', async () => {
    await seed(record('p1'));
    const crashed = journalFor('inst-b', 222);
    const l = await crashed.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    if (!l.ok) throw new Error('setup');
    // pid 222 is dead, but the lease has not expired yet (quick relaunch).
    const first = await journal.recoverInterrupted(REF);
    expect(first).toEqual({ interrupted: [], recheckAt: 2000 });
    expect((await journal.get(REF, 'p1'))!.status).toBe('running');
    clock = first.recheckAt!;
    const second = await journal.recoverInterrupted(REF);
    expect(second).toEqual({ interrupted: ['p1'] });
    expect((await journal.get(REF, 'p1'))!.status).toBe('interrupted');
  });

  it('an unexpired lease is authoritative even if the liveness probe fails', async () => {
    await seed(record('p1'));
    await journalFor('inst-b', 222).acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    expect(await journal.acquireLease(REF, 'p1')).toEqual({ ok: false, reason: 'held' });
  });

  it('stale executors are fenced out after a takeover', async () => {
    await seed(record('p1'));
    const other = journalFor('inst-b', 222);
    const stale = await other.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    if (!stale.ok) throw new Error('setup');
    clock += 5000; // expired, and pid 222 is dead
    const fresh = await journal.acquireLease(REF, 'p1');
    if (!fresh.ok) throw new Error('takeover should succeed');
    expect(fresh.epoch).toBe(2);
    await expect(other.mutateFenced(REF, 'p1', stale.fence, (plan) => { plan.usedTokens = 99; })).rejects.toBeInstanceOf(PlanFenceError);
    await expect(other.heartbeat(REF, 'p1', stale.fence)).rejects.toBeInstanceOf(PlanFenceError);
    await journal.mutateFenced(REF, 'p1', fresh.fence, (plan) => { plan.usedTokens = 7; });
    expect((await journal.get(REF, 'p1'))!.usedTokens).toBe(7);
  });

  it('an explicit user-forced recovery may take over a live lease, with a larger epoch', async () => {
    await seed(record('p1'));
    await journalFor('inst-b', 222).acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    alive.add(222);
    const forced = await journal.acquireLease(REF, 'p1', { force: true });
    expect(forced).toMatchObject({ ok: true, epoch: 2 });
  });

  it('epochs keep rising across release, and release clears the lease silently', async () => {
    await seed(record('p1'));
    const first = await journal.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    if (!first.ok) throw new Error('setup');
    events = [];
    await journal.heartbeat(REF, 'p1', first.fence);
    await journal.releaseLease(REF, 'p1', first.fence);
    // Lease bookkeeping is not a visible change — no seq bump, no card event.
    expect(events).toEqual([]);
    expect((await journal.get(REF, 'p1'))!.lease).toBeUndefined();
    const second = await journal.acquireLease(REF, 'p1');
    expect(second).toMatchObject({ ok: true, epoch: 2 });
    if (first.ok) await expect(journal.mutateFenced(REF, 'p1', first.fence, () => {})).rejects.toBeInstanceOf(PlanFenceError);
  });

  it('heartbeat extends the lease so it does not expire under a working executor', async () => {
    await seed(record('p1'));
    const l = await journal.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    if (!l.ok) throw new Error('setup');
    clock += 900; await journal.heartbeat(REF, 'p1', l.fence);
    clock += 900; // 1800 > ttl since acquisition, but only 900 since heartbeat
    expect(await journalFor('inst-b', 222).acquireLease(REF, 'p1')).toEqual({ ok: false, reason: 'held' });
  });

  it('refuses to lease a plan that is not in an allowed state', async () => {
    await seed(record('p1'), record('p2', { status: 'completed' }));
    expect(await journal.acquireLease(REF, 'p1')).toEqual({ ok: false, reason: 'wrong-status' });
    expect(await journal.acquireLease(REF, 'p2', { startFrom: ['paused'] })).toEqual({ ok: false, reason: 'wrong-status' });
    expect(await journal.acquireLease(REF, 'nope', { startFrom: ['proposed'] })).toEqual({ ok: false, reason: 'missing' });
  });

  it('recovery turns running plans with no valid owner into interrupted and frees them', async () => {
    const leaseFor = (instanceId: string, pid: number, expiresAt: number) =>
      ({ instanceId, pid, heartbeatAt: 0, expiresAt, epoch: 1, fence: `f-${instanceId}` });
    await seed(
      record('noLease', { status: 'running', steps: [{ id: 's1', status: 'running', attempts: [] }] }),
      record('deadExpired', { status: 'running', fenceEpoch: 1, lease: leaseFor('old', 333, 500) }),
      record('samePidOtherInstance', { status: 'running', fenceEpoch: 1, lease: leaseFor('prev-run', 111, 99_999) }),
      record('liveForeign', { status: 'running', fenceEpoch: 1, lease: leaseFor('b', 222, 99_999) }),
      record('mine', { status: 'running', fenceEpoch: 1, lease: leaseFor('inst-a', 111, 500) }),
      record('proposed'),
    );
    alive.add(222);
    const { interrupted, recheckAt } = await journal.recoverInterrupted(REF);
    // liveForeign's lease (expires 99_999) is the only skipped foreign owner.
    expect(recheckAt).toBe(99_999);
    expect(interrupted.sort()).toEqual(['deadExpired', 'noLease', 'samePidOtherInstance']);
    const byId = Object.fromEntries((await journal.read(REF) as any).file.plans.map((p: PlanRecord) => [p.planId, p]));
    expect(byId.noLease.status).toBe('interrupted');
    expect(byId.noLease.lease).toBeUndefined();
    expect(byId.noLease.steps[0].status).toBe('paused');
    expect(byId.deadExpired.lease).toBeUndefined();
    expect(byId.deadExpired.fenceEpoch).toBe(1);
    expect(byId.liveForeign.status).toBe('running');
    expect(byId.mine.status).toBe('running');
    expect(events.map((e) => e.plan.status)).toEqual(['interrupted', 'interrupted', 'interrupted']);
  });
});

// WHY the "recovery settles holds" describe block is GONE (spending rework
// stage 1, design §1/§3): it proved an interrupted plan's `reservedTokens`
// was given back before the card could show it — a field, and a hold, that
// no longer exist. `recoverAttempt` (plan-executor.ts) now charges nothing
// on recovery; there is nothing left to settle at the journal layer.

describe('committed reports', () => {
  async function leased(): Promise<string> {
    await seed(record('p1'));
    const l = await journal.acquireLease(REF, 'p1', { startFrom: ['proposed'] });
    if (!l.ok) throw new Error('setup');
    await journal.mutateFenced(REF, 'p1', l.fence, (plan) => {
      plan.steps[0].attempts.push({
        attemptId: 'a1', itemIndex: 0, iteration: 0,
        spentTokens: 0, phase: 'launched',
      });
    });
    return l.fence;
  }

  it('commitAttempt stamps the report once and later writes cannot alter it', async () => {
    const fence = await leased();
    await journal.commitAttempt(REF, 'p1', fence, 's1', 'a1', { terminal: 'completed', reportText: 'all good', spentTokens: 400 });
    const attempt = (await journal.get(REF, 'p1'))!.steps[0].attempts[0];
    expect(attempt).toMatchObject({ phase: 'committed', terminal: 'completed', reportText: 'all good', spentTokens: 400, completedAt: 1000 });
    expect(projectPlan((await journal.get(REF, 'p1'))!).steps[0]).toMatchObject({ done: 1, usedTokens: 400 });

    await expect(journal.commitAttempt(REF, 'p1', fence, 's1', 'a1', { terminal: 'completed', reportText: 'rewritten', spentTokens: 1 }))
      .rejects.toBeInstanceOf(PlanJournalIntegrityError);
    await expect(journal.mutateFenced(REF, 'p1', fence, (plan) => { plan.steps[0].attempts[0].reportText = 'tampered'; }))
      .rejects.toBeInstanceOf(PlanJournalIntegrityError);
    await expect(journal.mutate(REF, (file) => { file.plans[0].steps[0].attempts = []; }))
      .rejects.toBeInstanceOf(PlanJournalIntegrityError);
    expect((await journal.get(REF, 'p1'))!.steps[0].attempts[0].reportText).toBe('all good');
  });

  it('commitAttempt is fenced', async () => {
    await leased();
    await expect(journal.commitAttempt(REF, 'p1', 'forged', 's1', 'a1', { terminal: 'completed', reportText: 'x', spentTokens: 1 }))
      .rejects.toBeInstanceOf(PlanFenceError);
  });
});
