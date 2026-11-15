// automation-runner.ts — starts an automation's run, pauses it when it needs the person's OK, counts what it
// costs and records what it did (finishing Pages, step 4; build plan decisions 3, 6, 8 and the design-review
// rulings of 2026-11-14).
//
// WHY the runner knows nothing about models: Destin's rule is that "the underlying engine for any automation
// should be easily interchangeable". Everything a person can see or set (limits, waiting, answers, the run
// list) lives here once. An ENGINE is only "carry out this instruction, ask me before each step that needs
// asking, tell me what each step cost" — one for the app's own assistant, one for Claude Code, and whichever
// comes next, all behaving the same.
//
// Runs never become chats (decision 1): nothing here touches the session manager.
import type { AutomationOutcome, AutomationRun, AutomationSummary } from '../../shared/automation-types';
import type { AutomationStore, StoredAutomation, StoredRun } from './automation-store';
import { nextDue, wordAsked, wordWhen } from './schedule';

/** What an engine is handed for one run. */
export interface EngineRun {
  runId: string;
  job: StoredAutomation;
  /** The instruction for THIS run (a late run may carry other instructions). */
  instruction: string;
  /** Information a page sent with its event. WHY separate from `instruction`: a page must never be able to
   *  steer its automation, so the engine passes this to the model as quoted data (design-review ruling 3). */
  eventData?: string;
  /** The automation as it is right now (its permissions can change mid-run through "Allow from now on"). */
  current: () => StoredAutomation | undefined;
  /** Ask the person about one step. Resolves when they answer, when the wait runs out, or at once when
   *  this automation skips instead of waiting. `note` goes back to the model as the step's result. */
  ask: (q: { action: string; detail?: string; toolId?: string }) => Promise<{ allow: boolean; note: string }>;
  /** True when this run was cut off by the app closing and is being picked up again (review deck Q-closed).
   *  The engine continues from its saved conversation when it can; when it cannot it starts over and says
   *  so in its result (`startedOver`). */
  resume?: boolean;
  /** Report what a step cost. Returns false when the monthly limit is now reached: finish nothing more. */
  spent: (dollars: number, tokens: number) => Promise<boolean>;
}

export interface EngineHandle {
  /** Settles when the run ends on its own. `news` = it has something to tell the person. `startedOver` =
   *  a picked-up run could not continue and began again from the top. */
  done: Promise<{ summary: string; news?: boolean; startedOver?: boolean }>;
  /** Stop it now. `done` then rejects or resolves; either is ignored. */
  stop: () => void;
}

export type RunEngine = (run: EngineRun) => EngineHandle;

export type StartReason = 'schedule' | 'missed' | 'button' | 'event' | 'manual';

export type StartResult =
  | { started: true; runId: string }
  /** Not started, with the words the screen (or the page's own button) shows. */
  | { started: false; why: 'missing' | 'paused' | 'limit' | 'money' | 'running'; message: string };

interface LiveRun {
  jobId: string;
  record: StoredRun;
  handle: EngineHandle;
  skipped: string[];
  /** Set by stop(): how the run list should describe a run that did not end on its own. */
  ended?: { outcome: AutomationOutcome; summary: string };
  waiting?: { action: string; detail?: string; toolId?: string; askedAt: number; until: number | null; settle: (a: { allow: boolean; note: string }) => void; timer?: ReturnType<typeof setTimeout> };
}

export interface RunnerOpts {
  store: AutomationStore;
  /** The engine for an automation, chosen by its model. */
  engineFor: (job: StoredAutomation) => RunEngine;
  /** Called after anything a screen shows has changed. */
  onChanged: () => void;
  now?: () => number;
  newId?: () => string;
}

const dollars = (n: number): string => `$${n.toFixed(2)}`;

export class AutomationRunner {
  private readonly live = new Map<string, LiveRun>(); // by run id
  private readonly now: () => number;
  private readonly newId: () => string;
  private seq = 0;

  constructor(private readonly opts: RunnerOpts) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `r${this.now().toString(36)}${(this.seq++).toString(36)}`);
  }

  private liveFor(jobId: string): LiveRun[] { return [...this.live.values()].filter((r) => r.jobId === jobId); }

  // ---- starting ----------------------------------------------------------------------------------------------

  async start(jobId: string, reason: StartReason, extra: { instruction?: string; eventData?: string } = {}): Promise<StartResult> {
    const { store } = this.opts;
    const job = await store.get(jobId);
    if (!job) return { started: false, why: 'missing', message: 'This automation no longer exists.' };
    // Run now works on a paused automation (the person asked for it); everything else respects the switch.
    if (!job.enabled && reason !== 'manual') return { started: false, why: 'paused', message: 'This automation is paused.' };

    const now = this.now();
    const counts = await store.counts(jobId, now);
    // One rule for every start (step4g G-limit): at its daily limit nothing starts, Run now included.
    if (job.maxRunsPerDay != null && counts.runsToday >= job.maxRunsPerDay) {
      return { started: false, why: 'limit', message: `Daily limit reached. ${counts.runsToday} of ${job.maxRunsPerDay} runs today. It can run again tomorrow.` };
    }
    if (!job.subscription && job.limit != null && counts.dollars >= job.limit) {
      const message = `Monthly limit reached: ${dollars(counts.dollars)} of ${dollars(job.limit)} used.`;
      // A scheduled run that could not start is worth a line in the run list; a pressed button already shows why.
      if (reason === 'schedule' || reason === 'missed') await this.note(jobId, 'limit', message);
      return { started: false, why: 'money', message };
    }

    const going = this.liveFor(jobId);
    if (going.length > 0) {
      if (job.overlap === 'skip-new') {
        if (reason === 'schedule' || reason === 'missed') await this.note(jobId, 'skipped', 'Skipped: its last run was still going.');
        return { started: false, why: 'running', message: 'Its last run is still going.' };
      }
      if (job.overlap === 'stop-old') for (const r of going) this.stopRun(r, 'stopped', 'Stopped: a newer run started.');
    }

    const runId = this.newId();
    const record: StoredRun = { id: runId, startedAt: now, outcome: 'running', summary: '', tokens: 0 };
    await store.startRun(jobId, record);
    const liveRun: LiveRun = { jobId, record, skipped: [], handle: undefined as unknown as EngineHandle };
    await this.launch(liveRun, job, extra);
    return { started: true, runId };
  }

  /** Hand a run to its engine and record how it ends. Shared by a fresh start and a picked-up run. */
  private async launch(liveRun: LiveRun, job: StoredAutomation, extra: { instruction?: string; eventData?: string; resume?: boolean }): Promise<void> {
    const jobId = liveRun.jobId;
    this.live.set(liveRun.record.id, liveRun);
    // Before the engine starts: its very first step already reads the permissions from here.
    this.snapshot.set(jobId, job);
    try {
      liveRun.handle = this.opts.engineFor(job)({
        runId: liveRun.record.id, job,
        instruction: extra.instruction ?? job.instruction,
        ...(extra.eventData !== undefined ? { eventData: extra.eventData } : {}),
        ...(extra.resume ? { resume: true } : {}),
        current: () => this.snapshot.get(jobId),
        ask: (q) => this.ask(liveRun, q),
        spent: (d, t) => this.spent(liveRun, d, t),
      });
    } catch (err) {
      await this.finish(liveRun, 'failed', `Couldn’t start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    void liveRun.handle.done.then(
      // "Started over" leads the line in the run list, so a run that repeated its early steps says so.
      (r) => this.finish(liveRun, liveRun.skipped.length > 0 ? 'skipped' : r.news ? 'news' : 'done', r.startedOver ? `Started over after YouCoded was closed. ${r.summary}` : r.summary),
      (err) => this.finish(liveRun, 'failed', `Stopped with an error: ${err instanceof Error ? err.message : String(err)}`),
    );
    this.opts.onChanged();
  }

  /** At app start: pick up every run that was going (or waiting for an answer) when the app last closed
   *  (review deck Q-closed). It keeps its place in the run list and is not counted as a new run today. */
  async recover(): Promise<void> {
    for (const job of await this.opts.store.list()) {
      for (const record of await this.opts.store.runs(job.id)) {
        if ((record.outcome !== 'running' && record.outcome !== 'waiting') || this.live.has(record.id)) continue;
        const liveRun: LiveRun = { jobId: job.id, record: { ...record, outcome: 'running' }, skipped: record.skipped ? [...record.skipped] : [], handle: undefined as unknown as EngineHandle };
        await this.launch(liveRun, job, { resume: true });
      }
    }
  }

  /** The automation each going run reads its permissions from; refreshed whenever one is saved. */
  private readonly snapshot = new Map<string, StoredAutomation>();
  /** Call after an automation is saved or removed, so going runs see it at their next step. */
  async refresh(jobId: string): Promise<void> {
    const job = await this.opts.store.get(jobId);
    if (job) { this.snapshot.set(jobId, job); return; }
    this.snapshot.delete(jobId);
    // Deleted with a run going: the run stops (design-review ruling 6). Its record goes with the automation.
    for (const r of this.liveFor(jobId)) this.stopRun(r, 'stopped', 'Stopped: deleted.');
  }

  /** A line in the run list for a run that never started (skipped, limit reached). */
  private async note(jobId: string, outcome: AutomationOutcome, summary: string): Promise<void> {
    const at = this.now();
    await this.opts.store.updateRun(jobId, { id: this.newId(), startedAt: at, endedAt: at, outcome, summary, tokens: 0 });
    this.opts.onChanged();
  }

  /** A scheduled time that passed while the app was closed, on an automation that skips late runs. */
  async noteMissed(jobId: string, dueAt: number): Promise<void> {
    await this.opts.store.updateRun(jobId, { id: this.newId(), startedAt: dueAt, endedAt: dueAt, outcome: 'missed', summary: 'Skipped: the computer was off or YouCoded was closed, and this automation skips late runs.', tokens: 0 });
    this.opts.onChanged();
  }

  // ---- asking ------------------------------------------------------------------------------------------------

  private ask(run: LiveRun, q: { action: string; detail?: string; toolId?: string }): Promise<{ allow: boolean; note: string }> {
    const job = this.snapshot.get(run.jobId);
    if (!job || run.ended) return Promise.resolve({ allow: false, note: 'This run has been stopped.' });
    if (job.whenAsk === 'skip') {
      run.skipped.push(q.action);
      return Promise.resolve({ allow: false, note: 'This step needs the person’s OK and this automation skips those. Carry on without it.' });
    }
    const askedAt = this.now();
    // "Until its next run" has no end for an automation without a schedule: it waits until answered.
    const until = job.waitHours != null ? askedAt + job.waitHours * 3600_000
      : job.start.kind === 'schedule' ? nextDue(job.start, askedAt) : null;
    return new Promise((settle) => {
      run.waiting = { ...q, askedAt, until, settle };
      if (until !== null) {
        const timer = setTimeout(() => this.unanswered(run), Math.max(0, until - askedAt));
        // WHY unref: a waiting automation must never keep the app from quitting.
        (timer as { unref?: () => void }).unref?.();
        run.waiting.timer = timer;
      }
      run.record = { ...run.record, outcome: 'waiting' };
      void this.opts.store.updateRun(run.jobId, run.record);
      this.opts.onChanged();
    });
  }

  private clearWaiting(run: LiveRun): LiveRun['waiting'] {
    const w = run.waiting;
    if (!w) return undefined;
    if (w.timer) clearTimeout(w.timer);
    run.waiting = undefined;
    if (!run.ended) { run.record = { ...run.record, outcome: 'running' }; void this.opts.store.updateRun(run.jobId, run.record); }
    return w;
  }

  /** The wait ran out with no answer (design-review ruling 6: recorded, and its dot clears). */
  private unanswered(run: LiveRun): void {
    const job = this.snapshot.get(run.jobId);
    const w = this.clearWaiting(run);
    if (!w) return;
    run.skipped.push(`${w.action} (no answer)`);
    if (job?.noAnswer === 'stop') {
      w.settle({ allow: false, note: 'Nobody answered in time. Stop here.' });
      this.stopRun(run, 'stopped', `Stopped: no answer to “${w.action}”.`);
    } else if (job?.noAnswer === 'fallback' && job.fallback) {
      w.settle({ allow: false, note: `Nobody answered in time. Do this instead: ${job.fallback}` });
    } else {
      w.settle({ allow: false, note: 'Nobody answered in time. Skip this step and carry on.' });
    }
    this.opts.onChanged();
  }

  /** The person answered the question on an automation. The first answer wins; a later one finds nothing waiting. */
  async answer(jobId: string, allow: boolean, note?: string, fromNowOn?: boolean): Promise<boolean> {
    const run = this.liveFor(jobId).find((r) => r.waiting);
    if (!run) return false;
    const w = this.clearWaiting(run)!;
    // "Allow from now on" (plan-d Q-fromnow): that one permission becomes Always allowed for this automation.
    if (allow && fromNowOn && w.toolId) {
      const job = await this.opts.store.get(jobId);
      if (job) {
        await this.opts.store.save({ ...job, tools: job.tools.map((t) => (t.id === w.toolId ? { ...t, mode: 'allow' as const } : t)) });
        await this.refresh(jobId);
      }
    }
    const said = note?.trim();
    if (!allow) run.skipped.push(w.action);
    w.settle(allow
      ? { allow: true, note: said ? `The person allowed it and added: ${said}` : '' }
      : { allow: false, note: said ? `The person said no: ${said}` : 'The person said no. Do not try again; carry on without it.' });
    this.opts.onChanged();
    return true;
  }

  // ---- cost --------------------------------------------------------------------------------------------------

  private async spent(run: LiveRun, d: number, t: number): Promise<boolean> {
    const { store } = this.opts;
    await store.addUsage(run.jobId, d, t, this.now());
    run.record = { ...run.record, tokens: run.record.tokens + t, ...(d > 0 || run.record.dollars !== undefined ? { dollars: (run.record.dollars ?? 0) + d } : {}) };
    const job = this.snapshot.get(run.jobId);
    if (job && !job.subscription && job.limit != null) {
      const month = await store.counts(run.jobId, this.now());
      // The step that crossed the limit finished; nothing after it starts (questions#Q-limit-hit).
      if (month.dollars >= job.limit) {
        this.stopRun(run, 'limit', `Stopped at its monthly limit: ${dollars(month.dollars)} of ${dollars(job.limit)} used.`);
        return false;
      }
    }
    return true;
  }

  // ---- ending ------------------------------------------------------------------------------------------------

  private stopRun(run: LiveRun, outcome: AutomationOutcome, summary: string): void {
    if (run.ended) return;
    run.ended = { outcome, summary };
    const w = this.clearWaiting(run);
    w?.settle({ allow: false, note: 'This run has been stopped.' });
    try { run.handle?.stop(); } catch { /* the engine was already gone */ }
    void this.finish(run, outcome, summary);
  }

  /** Stop every run of an automation (its Stop button, or the app closing). */
  stop(jobId: string, summary = 'Stopped.'): void {
    for (const r of this.liveFor(jobId)) this.stopRun(r, 'stopped', summary);
  }

  private async finish(run: LiveRun, outcome: AutomationOutcome, summary: string): Promise<void> {
    if (!this.live.delete(run.record.id)) return; // already finished (stopped, then the engine settled)
    const end = run.ended ?? { outcome, summary };
    this.clearWaiting(run);
    run.record = { ...run.record, endedAt: this.now(), outcome: end.outcome, summary: end.summary, ...(run.skipped.length ? { skipped: run.skipped } : {}) };
    // An automation deleted mid-run has no folder to write into any more.
    if (await this.opts.store.get(run.jobId)) await this.opts.store.updateRun(run.jobId, run.record);
    if (this.liveFor(run.jobId).length === 0) this.snapshot.delete(run.jobId);
    this.opts.onChanged();
  }

  // ---- what the screens read ---------------------------------------------------------------------------------

  private wordRun(r: StoredRun, now: number): AutomationRun {
    return {
      id: r.id, when: wordWhen(r.startedAt, now), outcome: r.outcome, summary: r.summary,
      ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.dollars !== undefined ? { dollars: r.dollars } : {}),
      tokens: r.tokens, seconds: Math.max(0, Math.round(((r.endedAt ?? now) - r.startedAt) / 1000)),
    };
  }

  async runs(jobId: string): Promise<AutomationRun[]> {
    const now = this.now();
    return (await this.opts.store.runs(jobId)).map((r) => this.wordRun(r, now));
  }

  async summaries(): Promise<AutomationSummary[]> {
    const { store } = this.opts;
    const now = this.now();
    const out: AutomationSummary[] = [];
    for (const job of await store.list()) {
      const [counts, runs] = await Promise.all([store.counts(job.id, now), store.runs(job.id)]);
      const waitingRun = this.liveFor(job.id).find((r) => r.waiting);
      const w = waitingRun?.waiting;
      out.push({
        ...job,
        runsToday: counts.runsToday,
        usage: { dollars: counts.dollars, tokens: counts.tokens },
        ...(runs[0] ? { lastRun: this.wordRun(runs[0], now) } : {}),
        ...(job.enabled && job.start.kind === 'schedule' ? { next: wordWhen(nextDue(job.start, now), now) } : {}),
        ...(w && waitingRun ? {
          waiting: {
            runId: waitingRun.record.id, action: w.action, ...(w.detail ? { detail: w.detail } : {}), ...(w.toolId ? { toolId: w.toolId } : {}),
            asked: wordAsked(w.askedAt, now),
            until: w.until === null ? 'It waits until you answer.' : `If you don’t answer by ${wordWhen(w.until, now).replace(/^Today at /, '')}, ${job.noAnswer === 'stop' ? 'the run stops' : job.noAnswer === 'fallback' ? 'it does its stand-in instead' : 'it skips that step'}.`,
          },
        } : {}),
      });
    }
    return out;
  }
}
