// automations-service.ts — the one object the app's windows and phones talk to about automations
// (finishing Pages, step 4). It owns the saved automations (automation-store), the runner
// (automation-runner) and the schedule check (schedule), and tells every screen when something changed.
//
// WHY one service with small methods that each answer with the fresh list: the screens are drawn against
// `AutomationsBridge` (shared/automation-types.ts), where every change returns the whole list, so a
// window never shows a half-updated one.
import path from 'node:path';
import type { AutomationRun, AutomationSummary } from '../../shared/automation-types';
import { AutomationStore, type StoredAutomation } from './automation-store';
import { AutomationRunner, type RunEngine, type StartResult } from './automation-runner';
import { dueSince } from './schedule';

export interface AutomationsServiceDeps {
  /** `~/.youcoded/automations` */
  dir: () => string;
  /** The engine that carries out an automation, chosen by which model runs it. */
  engineFor: (job: StoredAutomation) => RunEngine;
  /** Send the fresh list to every window and phone. */
  broadcast: (jobs: AutomationSummary[]) => void;
  now?: () => number;
}

/** How often the schedule is checked (plan decision 6). */
const TICK_MS = 30_000;

/** The parts of a saved automation that the app works out itself; a screen can never set them. */
function stored(job: AutomationSummary): StoredAutomation {
  const { runsToday: _a, usage: _b, lastRun: _c, waiting: _d, next: _e, ...rest } = job;
  return rest;
}

export class AutomationsService {
  readonly store: AutomationStore;
  readonly runner: AutomationRunner;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The last moment the schedule was checked; times that came due after it have not been acted on. */
  private lastChecked: number;
  private ticking = false;

  constructor(private readonly deps: AutomationsServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.lastChecked = this.now();
    this.store = new AutomationStore(deps.dir);
    this.runner = new AutomationRunner({ store: this.store, engineFor: deps.engineFor, onChanged: () => this.changed(), now: this.now });
  }

  /** Where a run keeps its notes and where its conversation is saved. */
  workDirFor(jobId: string): string { return path.join(this.deps.dir(), 'work', jobId); }
  transcriptFor(jobId: string, runId: string): string { return path.join(this.deps.dir(), 'runs', jobId, `${runId}.jsonl`); }

  // WHY coalesced: a run reports several changes in a row (started, waiting, answered); one list is sent
  // for the burst, not one per change.
  private pending = false;
  private changed(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      void this.runner.summaries().then((jobs) => this.deps.broadcast(jobs)).catch(() => { /* the next change sends a fresh list */ });
    });
  }

  // ---- what the screens call (AutomationsBridge) -------------------------------------------------------------

  list(): Promise<AutomationSummary[]> { return this.runner.summaries(); }
  runs(id: string): Promise<AutomationRun[]> { return this.runner.runs(id); }

  async save(job: AutomationSummary): Promise<AutomationSummary[]> {
    await this.store.save(stored(job));
    await this.runner.refresh(job.id);
    this.changed();
    return this.list();
  }

  async setEnabled(id: string, enabled: boolean): Promise<AutomationSummary[]> {
    const job = await this.store.get(id);
    if (job) { await this.store.save({ ...job, enabled }); await this.runner.refresh(id); this.changed(); }
    return this.list();
  }

  /** Run now. The answer says why when it did not start (the daily limit, its monthly limit). */
  async runNow(id: string): Promise<{ jobs: AutomationSummary[]; result: StartResult }> {
    const result = await this.runner.start(id, 'manual');
    return { jobs: await this.list(), result };
  }

  async answer(id: string, allow: boolean, note?: string, fromNowOn?: boolean): Promise<AutomationSummary[]> {
    await this.runner.answer(id, allow, note, fromNowOn);
    return this.list();
  }

  async remove(id: string): Promise<AutomationSummary[]> {
    await this.store.remove(id);
    await this.runner.refresh(id); // stops a run that was going
    this.changed();
    return this.list();
  }

  // ---- what a page calls -------------------------------------------------------------------------------------

  /** A page's own button or event. WHY the link is checked here, in main: a page may only start an
   *  automation linked to it, whatever id its code sends (design-review ruling 3). */
  async startFromPage(pageId: string, jobId: string, how: { kind: 'button' } | { kind: 'event'; data?: string }): Promise<StartResult> {
    const job = await this.store.get(jobId);
    if (!job || !job.links.some((l) => l.kind === 'page' && l.id === pageId)) {
      return { started: false, why: 'missing', message: 'This page has no automation by that name.' };
    }
    return this.runner.start(jobId, how.kind, how.kind === 'event' && how.data !== undefined ? { eventData: how.data } : {});
  }

  /** Every enabled automation started by this page's event of that name. */
  async eventFromPage(pageId: string, event: string, data?: string): Promise<StartResult[]> {
    const out: StartResult[] = [];
    for (const job of await this.store.list()) {
      if (job.start.kind !== 'event' || job.start.event !== event) continue;
      if (!job.links.some((l) => l.kind === 'page' && l.id === pageId)) continue;
      out.push(await this.runner.start(job.id, 'event', data !== undefined ? { eventData: data } : {}));
    }
    return out;
  }

  /** A page is being deleted (step4f F-warning): each linked automation is deleted or kept, as the person chose. */
  async pageDeleted(pageId: string, deleteAutomations: string[]): Promise<void> {
    for (const id of deleteAutomations) { await this.store.remove(id); await this.runner.refresh(id); }
    await this.store.unlinkPage(pageId);
    for (const job of await this.store.list()) await this.runner.refresh(job.id);
    this.changed();
  }

  // ---- the schedule ------------------------------------------------------------------------------------------

  /** One look at the clock. Public so a wake-from-sleep signal can ask for a look at once. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const since = this.lastChecked;
      this.lastChecked = now;
      for (const job of await this.store.list()) {
        if (!job.enabled || job.start.kind !== 'schedule') continue;
        const due = dueSince(job.start, since, now);
        if (due.kind === 'none') continue;
        if (due.kind === 'due') { await this.runner.start(job.id, 'schedule'); continue; }
        // Missed while the app was closed or the computer asleep: what happens is this automation's own
        // setting (plan#S-start). "At another time" is handled by treating that time as today's due time.
        if (job.late === 'skip') await this.runner.noteMissed(job.id, due.dueAt);
        else if (job.late === 'fallback' && job.lateFallback) await this.runner.start(job.id, 'missed', { instruction: job.lateFallback });
        else if (job.late === 'later') this.runLater(job, now);
        else await this.runner.start(job.id, 'missed');
      }
      for (const [id, at] of [...this.later]) {
        if (at > now) continue;
        this.later.delete(id);
        await this.runner.start(id, 'missed');
      }
    } finally { this.ticking = false; }
  }

  /** Missed runs waiting for their "run at another time" moment. Kept in memory: closing the app again
   *  before that time simply makes it a missed run once more at the next open. */
  private readonly later = new Map<string, number>();
  private runLater(job: StoredAutomation, now: number): void {
    const m = /^(\d{1,2}):(\d{2})$/.exec(job.lateAt ?? '');
    if (!m) { void this.runner.start(job.id, 'missed'); return; }
    const d = new Date(now);
    let at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(m[1]), Number(m[2])).getTime();
    // That time has already passed today: run now rather than wait a whole day for a late run.
    if (at <= now) at = now;
    this.later.set(job.id, at);
  }

  /** Begin checking the schedule. `since` = when the app last checked before it was closed, so times that
   *  came due while it was closed count as missed. */
  startSchedule(since?: number): void {
    if (this.timer) return;
    if (since !== undefined && since < this.lastChecked) this.lastChecked = since;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    // WHY unref: the schedule check must never keep the app from quitting.
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** When the schedule was last checked, saved at quit so the next open knows what it missed. */
  get checkedAt(): number { return this.lastChecked; }
}

let service: AutomationsService | null = null;
export function initAutomationsService(deps: AutomationsServiceDeps): AutomationsService {
  service?.stop();
  service = new AutomationsService(deps);
  return service;
}
export function getAutomationsService(): AutomationsService | null { return service; }
