// automation-store.ts — automations and their run history on disk (finishing Pages, step 4; build plan
// youcoded-dev/docs/active/specs/2026-11-07-pages-step4-automations-technical-design.md, decision 5).
//
// Three things under ~/.youcoded/automations/:
//   jobs.json              every automation's settings
//   usage.json             per automation: this month's dollars and tokens, and how many runs started today
//   runs/<jobId>/<id>.json one file per run, newest 50 kept
//
// WHY the store holds plain facts (times as numbers, no wording): the screens' shapes in
// shared/automation-types.ts carry ready-made sentences ("Today at 7:00"); those are written when a list is
// asked for, so a saved run never shows yesterday's "Today".
//
// WHY usage is its own file and not summed from the run files: only the newest 50 runs are kept, so a busy
// automation's month (and a daily limit above 50) could not be counted from them.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../atomic-write';
import type { AutomationOutcome, AutomationSummary } from '../../shared/automation-types';

/** What is saved for an automation: its settings, without the parts worked out fresh each time it is listed. */
export type StoredAutomation = Omit<AutomationSummary, 'runsToday' | 'usage' | 'lastRun' | 'waiting' | 'next'>;

/** One run as saved: the same facts the run list shows, with real times instead of worded ones. */
export interface StoredRun {
  id: string;
  /** Milliseconds since 1970, when it started. */
  startedAt: number;
  endedAt?: number;
  outcome: AutomationOutcome;
  summary: string;
  skipped?: string[];
  dollars?: number;
  tokens: number;
}

interface UsageEntry {
  /** "2026-11" → that month's totals. Only the current month is kept. */
  month: string;
  dollars: number;
  tokens: number;
  /** "2026-11-14" → runs started that day. Only today is kept. */
  day: string;
  runsToday: number;
}

/** Newest runs kept per automation (plan decision 5). */
export const MAX_RUNS_KEPT = 50;

const pad = (n: number): string => String(n).padStart(2, '0');
/** WHY local time: the daily limit says "It can run again tomorrow", which means this device's midnight
 *  (design-review ruling 5). */
const dayKey = (at: number): string => { const d = new Date(at); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthKey = (at: number): string => dayKey(at).slice(0, 7);

/** WHY checked: ids become folder names, so one with a slash or dots could reach outside the runs folder. */
const safeId = (id: string): boolean => /^[A-Za-z0-9_-]{1,80}$/.test(id);

export class AutomationStore {
  private jobs: StoredAutomation[] | null = null;
  private usage: Record<string, UsageEntry> = {};
  private loading: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly dir: () => string) {}

  private jobsFile(): string { return path.join(this.dir(), 'jobs.json'); }
  private usageFile(): string { return path.join(this.dir(), 'usage.json'); }
  private runsDir(jobId: string): string { return path.join(this.dir(), 'runs', jobId); }

  private async load(): Promise<void> {
    if (this.jobs) return;
    this.loading ??= (async () => {
      try {
        const j = JSON.parse(await fs.readFile(this.jobsFile(), 'utf8')) as { jobs?: unknown };
        this.jobs = Array.isArray(j.jobs) ? j.jobs.filter((x): x is StoredAutomation => !!x && safeId(String((x as StoredAutomation).id))) : [];
      } catch { this.jobs = []; }
      try {
        const u = JSON.parse(await fs.readFile(this.usageFile(), 'utf8')) as { usage?: Record<string, UsageEntry> };
        this.usage = u.usage && typeof u.usage === 'object' ? u.usage : {};
      } catch { this.usage = {}; }
    })();
    return this.loading;
  }

  /** One write at a time, in order; a failed write is retried by the next change (same as the page chats store). */
  private queue(work: () => Promise<void>): void {
    this.saving = this.saving.catch(() => {}).then(work);
  }
  private saveJobs(): void {
    const body = JSON.stringify({ v: 1, jobs: this.jobs ?? [] });
    this.queue(async () => { await fs.mkdir(this.dir(), { recursive: true }); await atomicWrite(this.jobsFile(), body); });
  }
  private saveUsage(): void {
    const body = JSON.stringify({ v: 1, usage: this.usage });
    this.queue(async () => { await fs.mkdir(this.dir(), { recursive: true }); await atomicWrite(this.usageFile(), body); });
  }

  /** Resolves once every change so far is on disk (tests, and a clean quit). */
  whenSaved(): Promise<void> { return this.saving.catch(() => {}); }

  async list(): Promise<StoredAutomation[]> { await this.load(); return [...this.jobs!]; }

  async get(id: string): Promise<StoredAutomation | undefined> { await this.load(); return this.jobs!.find((j) => j.id === id); }

  /** Add an automation, or replace the one with the same id. */
  async save(job: StoredAutomation): Promise<void> {
    if (!safeId(job.id)) throw new Error('automation id not allowed');
    await this.load();
    const at = this.jobs!.findIndex((j) => j.id === job.id);
    if (at >= 0) this.jobs![at] = job; else this.jobs!.push(job);
    this.saveJobs();
  }

  /** Delete an automation with its settings, its counts and its saved runs (review deck S-delete). */
  async remove(id: string): Promise<void> {
    await this.load();
    this.jobs = this.jobs!.filter((j) => j.id !== id);
    delete this.usage[id];
    this.saveJobs();
    this.saveUsage();
    if (safeId(id)) this.queue(() => fs.rm(this.runsDir(id), { recursive: true, force: true }));
  }

  /** A page was deleted and the person chose Keep for its automations: they carry on, no longer linked to it. */
  async unlinkPage(pageId: string): Promise<void> {
    await this.load();
    let changed = false;
    this.jobs = this.jobs!.map((j) => {
      const links = j.links.filter((l) => !(l.kind === 'page' && l.id === pageId));
      if (links.length === j.links.length) return j;
      changed = true;
      return { ...j, links };
    });
    if (changed) this.saveJobs();
  }

  // ---- counts ----------------------------------------------------------------------------------------------

  private entry(jobId: string, at: number): UsageEntry {
    const e = this.usage[jobId] ?? { month: monthKey(at), dollars: 0, tokens: 0, day: dayKey(at), runsToday: 0 };
    // WHY reset here and not on a timer: the count is only ever read or added to, so rolling it over at that
    // moment is always right, including after the computer slept through midnight.
    if (e.month !== monthKey(at)) { e.month = monthKey(at); e.dollars = 0; e.tokens = 0; }
    if (e.day !== dayKey(at)) { e.day = dayKey(at); e.runsToday = 0; }
    this.usage[jobId] = e;
    return e;
  }

  /** Runs started today and this month's use, as of `now`. */
  async counts(jobId: string, now = Date.now()): Promise<{ runsToday: number; dollars: number; tokens: number }> {
    await this.load();
    const e = this.entry(jobId, now);
    return { runsToday: e.runsToday, dollars: e.dollars, tokens: e.tokens };
  }

  /** Add what a step cost to this month's totals. */
  async addUsage(jobId: string, dollars: number, tokens: number, now = Date.now()): Promise<void> {
    await this.load();
    const e = this.entry(jobId, now);
    e.dollars += dollars;
    e.tokens += tokens;
    this.saveUsage();
  }

  // ---- runs ------------------------------------------------------------------------------------------------

  /** Record a run that is starting. WHY it counts on the day it starts: a run that begins at 23:59 and ends
   *  after midnight used up one of yesterday's runs, not today's (design-review ruling 5). */
  async startRun(jobId: string, run: StoredRun): Promise<void> {
    if (!safeId(jobId) || !safeId(run.id)) throw new Error('automation id not allowed');
    await this.load();
    this.entry(jobId, run.startedAt).runsToday += 1;
    this.saveUsage();
    this.writeRun(jobId, run);
    this.queue(() => this.trim(jobId));
  }

  /** Save a run's newer state (it finished, is waiting, was stopped…). */
  async updateRun(jobId: string, run: StoredRun): Promise<void> {
    if (!safeId(jobId) || !safeId(run.id)) throw new Error('automation id not allowed');
    this.writeRun(jobId, run);
  }

  private writeRun(jobId: string, run: StoredRun): void {
    const body = JSON.stringify(run);
    this.queue(async () => {
      await fs.mkdir(this.runsDir(jobId), { recursive: true });
      await atomicWrite(path.join(this.runsDir(jobId), `${run.id}.json`), body);
    });
  }

  /** An automation's saved runs, newest first. */
  async runs(jobId: string): Promise<StoredRun[]> {
    if (!safeId(jobId)) return [];
    await this.whenSaved();
    let names: string[];
    try { names = await fs.readdir(this.runsDir(jobId)); } catch { return []; }
    const out: StoredRun[] = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const r = JSON.parse(await fs.readFile(path.join(this.runsDir(jobId), n), 'utf8')) as StoredRun;
        if (r && typeof r.id === 'string' && typeof r.startedAt === 'number') out.push(r);
      } catch { /* a half-written or damaged run file is left out of the list rather than breaking it */ }
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Keep the newest runs only. Runs here inside the write queue, so it reads the folder directly. */
  private async trim(jobId: string): Promise<void> {
    let names: string[];
    try { names = await fs.readdir(this.runsDir(jobId)); } catch { return; }
    if (names.length <= MAX_RUNS_KEPT) return;
    const dated: { n: string; at: number }[] = [];
    for (const n of names) {
      try { dated.push({ n, at: (JSON.parse(await fs.readFile(path.join(this.runsDir(jobId), n), 'utf8')) as StoredRun).startedAt ?? 0 }); }
      catch { dated.push({ n, at: 0 }); }
    }
    dated.sort((a, b) => b.at - a.at);
    for (const old of dated.slice(MAX_RUNS_KEPT)) await fs.rm(path.join(this.runsDir(jobId), old.n), { force: true });
  }
}
