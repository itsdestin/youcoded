// Background-status accuracy for NATIVE specialists (audit 2026-10-22, work item 1):
// B1 Stop is "interrupted" not "failed", B2/B3 resume facts, B5 replay window,
// B7 retried outcome writes, B8 report-not-yet-read fact, B9 seq across restarts.
// One file because every case drives the same real host + real ledger on disk.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { MockLanguageModelV4 } from 'ai/test';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { scriptedModel, stream, textChunks, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import { OWNER, toRunView, type DelegationRecord } from '../src/main/harness/specialists/delegation-ledger';

const EXPLORER = resolveSpecialist('explorer')!;
const NO_CONTEXT = async () => ({ contextLength: null, totalSlots: null });

function rm(dir: string): void { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); }

// A model that trickles a reply so a turn can be caught mid-flight.
function slowFactory() {
  const chunks = [...stream(...textChunks('t', 'working on it'), finishChunk('stop'))];
  return async () => new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        async start(c) { try { for (const ch of chunks) { await new Promise((r) => setTimeout(r, 40)); c.enqueue(ch); } c.close(); } catch { /* aborted */ } },
      }),
    }),
  }) as any;
}

const scripted = (scripts: any[][]) => { const m = scriptedModel(scripts); return async () => m as any; };

let root: string; let host: NativeSessionHost;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-bg-track-')); });
afterEach(async () => { await host?.destroyAll(); rm(root); });

async function boot(factory: any) {
  const home = new NativeHome(root);
  host = new NativeSessionHost(
    new SessionStore(home), factory, NO_CONTEXT, async () => null, async () => null, undefined,
    undefined, undefined, undefined, undefined, undefined, home,
  );
  await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
}
const ledger = () => (host as any).ledger;
const recOf = (childId: string): any => ledger().listFor(root, 'root-1').find((r: any) => r.childId === childId);
function rec(over: Partial<DelegationRecord> & { childId: string }): DelegationRecord {
  return {
    parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia', workDir: root, description: 'd', background: true,
    status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [], ...over,
  };
}

describe('B1: Stop on the parent records a foreground specialist as interrupted', () => {
  it('writes interrupted (not failed) and the Task call still ends with an error naming the stop', async () => {
    await boot(slowFactory());
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    const run = host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1', description: 'd',
      token: { parentId: 'root-1', writer: false },
    });
    const settled = run.then(() => 'ok', (e) => e);
    await vi.waitFor(() => expect(seen.some((e) => e.data?.agentId)).toBe(true));
    host.interrupt('root-1');
    const err = await settled;
    expect(String(err)).toMatch(/stopped/);
    await vi.waitFor(() => {
      const r = ledger().listFor(root, 'root-1')[0];
      expect(r.status).toBe('interrupted');
    });
    expect(ledger().listFor(root, 'root-1')[0].failureText).toBeUndefined();
  });
});

describe('B5: replay covers the newest runs, not the oldest 30', () => {
  it('returns every record when the ledger holds more than 30', async () => {
    await boot(scripted([stream(...textChunks('t', 'x'), finishChunk('stop'))]));
    for (let i = 0; i < 45; i++) await ledger().recordStart(root, 'root-1', rec({ childId: `c-${i}`, parentToolCallId: `tc-${i}` }));
    const runs = host.specialistRunsFor('root-1');
    expect(runs).toHaveLength(45);
    // The newest run (the one most likely still running) is present.
    expect(runs.some((r) => r.childId === 'c-44')).toBe(true);
  });
});

describe('B9: seq never goes backwards across a host restart', () => {
  it('starts above any earlier process\'s stamps (time-seeded)', () => {
    // An earlier process that ran for a day at one stamp per second, restarted just now.
    const earlier = Date.now() * 1000 - 86_400 * 1000;
    expect(toRunView(rec({ childId: 'a' })).seq!).toBeGreaterThan(earlier);
  });
  it('is still strictly increasing within one process', () => {
    const a = toRunView(rec({ childId: 'a' })).seq!; const b = toRunView(rec({ childId: 'a' })).seq!;
    expect(b).toBeGreaterThan(a);
  });
});

describe('B8: the run says when its report has not reached the assistant', () => {
  it('a finished background run waits for a turn, is held after Stop, and clears once delivered', () => {
    const done = rec({ childId: 'a', status: 'completed', endedAt: Date.now(), background: true, delivered: false });
    expect(toRunView(done).reportPending).toBe('waiting-for-turn');
    expect(toRunView(done, { held: true }).reportPending).toBe('held-after-stop');
    expect(toRunView({ ...done, delivered: true }).reportPending).toBeUndefined();
    // Running, foreground (inline result) and interrupted runs have no report to wait for.
    expect(toRunView(rec({ childId: 'b' })).reportPending).toBeUndefined();
    expect(toRunView({ ...done, background: false }).reportPending).toBeUndefined();
    expect(toRunView({ ...done, status: 'interrupted' }).reportPending).toBeUndefined();
  });
  it('Stop re-pushes finished-but-unread runs so the card shows "held"', async () => {
    await boot(scripted([stream(...textChunks('t', 'x'), finishChunk('stop'))]));
    await ledger().recordStart(root, 'root-1', rec({ childId: 'done-1', status: 'completed', endedAt: Date.now() }));
    const events: any[] = [];
    host.on('specialists-event', (e) => events.push(e));
    host.interrupt('root-1');
    expect(events.find((e) => e.run.childId === 'done-1')?.run.reportPending).toBe('held-after-stop');
  });
  it('writing again lifts the hold, and a report still unread then says it is waiting, not held', async () => {
    await boot(scripted([stream(...textChunks('t', 'x'), finishChunk('stop')), stream(...textChunks('t', 'y'), finishChunk('stop'))]));
    await ledger().recordStart(root, 'root-1', rec({ childId: 'done-1', status: 'completed', endedAt: Date.now() }));
    host.interrupt('root-1');
    // The hand-over itself is out of scope here: make it deliver nothing, so the report stays unread.
    (host as any).drainDeliveries = async () => {};
    const events: any[] = [];
    host.on('specialists-event', (e) => events.push(e));
    host.send('root-1', 'carry on');
    await vi.waitFor(() => expect(events.some((e) => e.run.childId === 'done-1')).toBe(true));
    expect(events.filter((e) => e.run.childId === 'done-1').at(-1).run.reportPending).toBe('waiting-for-turn');
  });
});

describe('B2/B3: a resumed specialist says which card shows the live run', () => {
  it('toRunView: first run is run 1 on its own card; a resume names the resume card and marks the old report stale', () => {
    const first = toRunView(rec({ childId: 'a', status: 'failed', background: false }));
    expect(first).toMatchObject({ runNumber: 1, activeToolCallId: 'tc-1', reportStale: false });
    const resumed = toRunView(rec({ childId: 'a', background: false, runNumber: 2, activeToolCallId: 'tc-9', resumedAt: 5 }));
    expect(resumed).toMatchObject({ parentToolCallId: 'tc-1', runNumber: 2, activeToolCallId: 'tc-9', resumedAt: 5, reportStale: true });
    // A background resume's report lands on the ORIGINAL card once delivered, so it stops being stale then.
    const bgDone = rec({ childId: 'a', status: 'completed', background: true, delivered: true, runNumber: 2, activeToolCallId: 'tc-9' });
    expect(toRunView(bgDone).reportStale).toBe(false);
  });
  it('resumeSpecialist stamps the ledger with run number, resume card and time', async () => {
    await boot(scripted([stream(...textChunks('t', 'second report'), finishChunk('stop'))]));
    const { childId, title } = await host.createChild('root-1', { specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1' });
    await ledger().recordStart(root, 'root-1', rec({ childId, title, status: 'failed', background: false, endedAt: Date.now(), failureText: 'boom' }));
    await host.destroy(childId);
    const reservation = host.reserveSpecialist('root-1', { writer: false });
    if (!reservation.ok) throw new Error('no capacity');
    const t0 = Date.now();
    const out = await host.resumeSpecialist('root-1', { childId, prompt: 'again', background: false, parentToolCallId: 'tc-2', reservation: reservation.token });
    expect(out.status).toBe('ok');
    const r = recOf(childId);
    expect(r).toMatchObject({ parentToolCallId: 'tc-1', runNumber: 2, activeToolCallId: 'tc-2' });
    expect(r.resumedAt).toBeGreaterThanOrEqual(t0);
    expect(r.failureText).toBeUndefined();
  });
});

describe('B7: a failed outcome write is retried and never leaves the run "running" on screen', () => {
  async function runWithFailingWrites(failTimes: number) {
    await boot(scripted([stream(...textChunks('t', 'REPORT: ok'), finishChunk('stop'))]));
    (host as any).outcomeRetryDelaysMs = [5, 5, 5];
    const l = ledger();
    const real = l.update.bind(l);
    let failed = 0; let attempts = 0;
    l.update = async (...a: any[]) => {
      if (a[3]?.status === 'completed') { attempts++; if (failed < failTimes) { failed++; throw new Error('lock busy'); } }
      return real(...a);
    };
    const events: any[] = [];
    host.on('specialists-event', (e) => events.push(e));
    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1', description: 'd',
      token: { parentId: 'root-1', writer: false },
    });
    return { childId, events, attempts: () => attempts };
  }
  it('retries until the write lands', async () => {
    const { childId, events, attempts } = await runWithFailingWrites(2);
    // Right away the card is told the truth even though the disk write failed.
    expect(events.filter((e) => e.run.childId === childId).some((e) => e.run.status === 'completed')).toBe(true);
    await vi.waitFor(() => expect(recOf(childId).status).toBe('completed'));
    expect(attempts()).toBe(3);
  });
  it('gives up after a bounded number of tries but the live view still says completed', async () => {
    const { childId, events, attempts } = await runWithFailingWrites(99);
    await vi.waitFor(() => expect(attempts()).toBe(4)); // first try + 3 retries
    // settle: a NEGATIVE check — after the positive wait above, no fifth try follows.
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts()).toBe(4);
    expect(events.filter((e) => e.run.childId === childId).pop()!.run.status).toBe('completed');
  });
});
