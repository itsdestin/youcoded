// Automations on disk (finishing Pages, step 4): settings, run history, and the counts behind the daily
// limit and the monthly use.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutomationStore, MAX_RUNS_KEPT, type StoredAutomation, type StoredRun } from '../src/main/automations/automation-store';

let root: string;
// WHY a fixed path per test: a store's save is queued, and one still queued when a test ends must not write
// into the next test's folder.
let dir: () => string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'automations-'));
  const fixed = path.join(root, 'automations');
  dir = () => fixed;
});
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const job = (id: string, over: Partial<StoredAutomation> = {}): StoredAutomation => ({
  id, name: id, instruction: 'do it', links: [], start: { kind: 'button', label: 'Run' }, model: 'm', subscription: true,
  tools: [], whenAsk: 'wait', waitHours: null, noAnswer: 'skip', late: 'run', overlap: 'skip-new',
  unlisted: { sites: 'never', commands: 'never' }, devices: [], notify: { needs: false, news: false, fails: false },
  enabled: true, ...over,
});
const run = (id: string, startedAt: number, over: Partial<StoredRun> = {}): StoredRun =>
  ({ id, startedAt, outcome: 'done', summary: 's', tokens: 0, ...over });

// Local noon and local 23:59 on one day, and local 00:01 on the next: the limit follows this device's clock.
const noon = new Date(2026, 10, 14, 12, 0).getTime();
const lateNight = new Date(2026, 10, 14, 23, 59).getTime();
const nextDay = new Date(2026, 10, 15, 0, 1).getTime();
const nextMonth = new Date(2026, 11, 1, 9, 0).getTime();

describe('automation store', () => {
  it('keeps saved automations across a restart and replaces one saved again', async () => {
    const a = new AutomationStore(dir);
    await a.save(job('one'));
    await a.save(job('two'));
    await a.save(job('one', { name: 'renamed' }));
    await a.whenSaved();
    const b = new AutomationStore(dir);
    expect((await b.list()).map((j) => [j.id, j.name])).toEqual([['one', 'renamed'], ['two', 'two']]);
  });

  it('refuses an id that could name a folder outside its own', async () => {
    const s = new AutomationStore(dir);
    await expect(s.save(job('../escape'))).rejects.toThrow();
    await expect(s.startRun('one', run('../../x', noon))).rejects.toThrow();
  });

  it('deleting an automation removes its settings, its counts and its saved runs', async () => {
    const s = new AutomationStore(dir);
    await s.save(job('one'));
    await s.startRun('one', run('r1', noon));
    await s.whenSaved();
    expect(existsSync(path.join(dir(), 'runs', 'one', 'r1.json'))).toBe(true);
    await s.remove('one');
    await s.whenSaved();
    expect(await s.list()).toEqual([]);
    expect(existsSync(path.join(dir(), 'runs', 'one'))).toBe(false);
    expect((await s.counts('one', noon)).runsToday).toBe(0);
  });

  it('unlinking a deleted page leaves the automation and its other links', async () => {
    const s = new AutomationStore(dir);
    await s.save(job('one', { links: [{ kind: 'page', id: 'p1', name: 'A' }, { kind: 'page', id: 'p2', name: 'B' }, { kind: 'project', id: 'p1', name: 'P' }] }));
    await s.unlinkPage('p1');
    expect((await s.get('one'))!.links.map((l) => `${l.kind}:${l.id}`)).toEqual(['page:p2', 'project:p1']);
  });

  it('counts a run on the day it starts and starts again at local midnight', async () => {
    const s = new AutomationStore(dir);
    await s.startRun('one', run('r1', noon));
    await s.startRun('one', run('r2', lateNight));
    expect((await s.counts('one', lateNight)).runsToday).toBe(2);
    expect((await s.counts('one', nextDay)).runsToday).toBe(0);
    await s.whenSaved();
    // The count survives a restart on the same day.
    const again = new AutomationStore(dir);
    await again.startRun('one', run('r3', nextDay));
    expect((await again.counts('one', nextDay)).runsToday).toBe(1);
  });

  it("adds up a month's use and starts again the next month", async () => {
    const s = new AutomationStore(dir);
    await s.addUsage('one', 0.25, 1000, noon);
    await s.addUsage('one', 0.5, 500, nextDay);
    expect(await s.counts('one', nextDay)).toMatchObject({ dollars: 0.75, tokens: 1500 });
    expect(await s.counts('one', nextMonth)).toMatchObject({ dollars: 0, tokens: 0 });
  });

  it('lists runs newest first, shows a later state of a run, and keeps only the newest', async () => {
    const s = new AutomationStore(dir);
    for (let i = 0; i < MAX_RUNS_KEPT + 3; i++) await s.startRun('one', run(`r${i}`, noon + i * 1000, { outcome: 'running' }));
    await s.updateRun('one', run(`r${MAX_RUNS_KEPT + 2}`, noon + (MAX_RUNS_KEPT + 2) * 1000, { outcome: 'done', summary: 'finished' }));
    const list = await s.runs('one');
    expect(list).toHaveLength(MAX_RUNS_KEPT);
    expect(list[0]).toMatchObject({ id: `r${MAX_RUNS_KEPT + 2}`, outcome: 'done', summary: 'finished' });
    expect(list.at(-1)!.id).toBe('r3');
  });
});
