// The automations service: the schedule check, what a page may start, and deleting a page's automations.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutomationsService } from '../src/main/automations/automations-service';
import type { EngineRun } from '../src/main/automations/automation-runner';
import type { AutomationSummary } from '../src/shared/automation-types';

let root: string;
let clock: number;
let started: EngineRun[];
let sent: AutomationSummary[][];
let svc: AutomationsService;

const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'automations-service-'));
  const dir = path.join(root, 'automations');
  clock = at(14, 6, 59);
  started = []; sent = [];
  svc = new AutomationsService({
    dir: () => dir, now: () => clock, broadcast: (jobs) => { sent.push(jobs); },
    // An engine whose runs end at once, so the next start is never "still running".
    engineFor: () => (run) => { started.push(run); return { done: Promise.resolve({ summary: 'ok' }), stop: () => {} }; },
  });
});
afterEach(async () => { svc.stop(); await svc.store.whenSaved(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const job = (over: Partial<AutomationSummary> = {}): AutomationSummary => ({
  id: 'one', name: 'One', instruction: 'do it', links: [], start: { kind: 'schedule', every: 'day', at: '7:00' }, model: 'm', subscription: true,
  tools: [], whenAsk: 'wait', waitHours: null, noAnswer: 'skip', late: 'run', overlap: 'both',
  unlisted: { sites: 'never', commands: 'never' }, devices: [], notify: { needs: false, news: false, fails: false },
  enabled: true, usage: { dollars: 0, tokens: 0 }, ...over,
});
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await svc.store.whenSaved(); };

describe('automations service', () => {
  it('starts a scheduled automation when its time comes, once', async () => {
    await svc.save(job());
    await svc.tick();
    expect(started).toHaveLength(0);
    clock = at(14, 7, 0);
    await svc.tick();
    clock += 30_000;
    await svc.tick();
    expect(started).toHaveLength(1);
  });

  it('never starts a paused automation or one without a schedule', async () => {
    await svc.save(job({ enabled: false }));
    await svc.save(job({ id: 'two', start: { kind: 'button', label: 'Run' } }));
    clock = at(14, 7, 0);
    await svc.tick();
    expect(started).toHaveLength(0);
  });

  it('a time missed while closed runs once, skips, or uses its other instructions, as the automation says', async () => {
    await svc.save(job({ id: 'run', late: 'run' }));
    await svc.save(job({ id: 'skip', late: 'skip' }));
    await svc.save(job({ id: 'other', late: 'fallback', lateFallback: 'Only look at today.' }));
    clock = at(16, 9, 40); // two days later: two missed times each, counted once
    await svc.tick();
    await settle();
    expect(started.map((r) => [r.job.id, r.instruction]).sort()).toEqual([['other', 'Only look at today.'], ['run', 'do it']]);
    expect((await svc.runs('skip'))[0]).toMatchObject({ outcome: 'missed', when: 'Today at 7:00' });
  });

  it('"run at another time" waits for that time', async () => {
    await svc.save(job({ late: 'later', lateAt: '18:00' }));
    clock = at(14, 9, 40);
    await svc.tick();
    expect(started).toHaveLength(0);
    clock = at(14, 18, 0);
    await svc.tick();
    expect(started).toHaveLength(1);
  });

  it('times that came due before the app opened count as missed', async () => {
    await svc.save(job());
    clock = at(14, 9, 0);
    svc.startSchedule(at(14, 6, 0));
    await settle();
    expect(started).toHaveLength(1);
  });

  it('a page starts only an automation linked to it', async () => {
    await svc.save(job({ start: { kind: 'button', label: 'Run' }, links: [{ kind: 'page', id: 'p1', name: 'A' }] }));
    expect(await svc.startFromPage('other', 'one', { kind: 'button' })).toMatchObject({ started: false, why: 'missing' });
    expect(await svc.startFromPage('p1', 'one', { kind: 'button' })).toMatchObject({ started: true });
  });

  it("a page's event starts the linked automations waiting for that event, with its information as data", async () => {
    await svc.save(job({ start: { kind: 'event', event: 'list-changed' }, links: [{ kind: 'page', id: 'p1', name: 'A' }] }));
    await svc.save(job({ id: 'two', start: { kind: 'event', event: 'list-changed' }, links: [{ kind: 'page', id: 'p2', name: 'B' }] }));
    await svc.eventFromPage('p1', 'list-changed', '{"items":3}');
    expect(started.map((r) => [r.job.id, r.instruction, r.eventData])).toEqual([['one', 'do it', '{"items":3}']]);
  });

  it('deleting a page deletes the automations chosen and unlinks the ones kept', async () => {
    await svc.save(job({ id: 'gone', links: [{ kind: 'page', id: 'p1', name: 'A' }] }));
    await svc.save(job({ id: 'kept', links: [{ kind: 'page', id: 'p1', name: 'A' }, { kind: 'page', id: 'p2', name: 'B' }] }));
    await svc.pageDeleted('p1', ['gone']);
    const list = await svc.list();
    expect(list.map((j) => [j.id, j.links.map((l) => l.id)])).toEqual([['kept', ['p2']]]);
  });

  it('a screen cannot set the counts the app keeps itself, and every change reaches the screens', async () => {
    await svc.save(job({ runsToday: 99, usage: { dollars: 50, tokens: 9 } }));
    expect((await svc.list())[0]).toMatchObject({ runsToday: 0, usage: { dollars: 0, tokens: 0 }, next: 'Today at 7:00' });
    await settle();
    expect(sent.at(-1)!.map((j) => j.id)).toEqual(['one']);
  });
});
