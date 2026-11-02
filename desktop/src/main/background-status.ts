// background-status.ts — what the phone shows while the app is off screen: a live "working / waiting / done" count and a
// "<session> needs you" alert, both worked out from the sessions' summaries the backend already keeps.
//
// WHY (Android background notifications, owner decision 2026-11-01): leaving the app used to leave only a permanent "Your assistant is
// running". The backend already knows each session's state (session-record.ts summaries), so it decides; the phone only displays what
// the host call 'status' hands it (Kotlin never works out counts). Electron-free like session-record.ts.
import type { SessionSummary } from '../shared/session-summary-types';

interface NeedsYou { sessionId: string; name: string; text: string }
export interface BackgroundStatus {
  /** The line under "YouCoded": only the non-zero parts, or "Ready". */
  text: string;
  working: number;
  waiting: number;
  done: number;
  /** Sessions with a question or approval waiting, newest knowledge first as the summaries list them. */
  needs: NeedsYou[];
}

/** One short line saying what a permission/question ask wants (the notification body). */
export function describeAsk(event: unknown): string {
  const payload = (event as { payload?: Record<string, any> } | null)?.payload ?? {};
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const input = (payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {}) as Record<string, any>;
  let text = '';
  if (tool === 'AskUserQuestion') {
    const q = Array.isArray(input.questions) ? input.questions[0] : null;
    text = typeof q?.question === 'string' ? q.question : 'Has a question for you';
  } else if (typeof input.command === 'string') text = `Wants to run: ${input.command}`;
  else if (typeof input.file_path === 'string') text = `Wants to change ${input.file_path.split('/').pop()}`;
  else if (tool) text = `Wants to use ${tool}`;
  else text = 'Waiting for your approval';
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function statusText(working: number, waiting: number, done: number): string {
  const parts: string[] = [];
  if (working) parts.push(`${working} working`);
  if (waiting) parts.push(`${waiting} waiting for you`);
  if (done) parts.push(`${done} done`);
  return parts.length ? parts.join(' · ') : 'Ready';
}

/**
 * Turns summaries into the status. Keeps one memory: which sessions finished a turn since the person last looked at them ("done").
 * A session is "looked at" when the app is on screen AND the page is watching that session; looking clears its done mark.
 */
export class BackgroundStatusTracker {
  private wasWorking = new Map<string, boolean>();
  private done = new Set<string>();

  update(input: {
    summaries: Record<string, SessionSummary>;
    foreground: boolean;
    watched(sessionId: string): boolean;
    nameOf(sessionId: string): string;
    askTextOf(sessionId: string): string;
  }): BackgroundStatus {
    const { summaries, foreground, watched } = input;
    let working = 0, waiting = 0;
    const needs: NeedsYou[] = [];
    for (const id of [...this.wasWorking.keys()]) if (!summaries[id]) { this.wasWorking.delete(id); this.done.delete(id); }
    for (const [id, s] of Object.entries(summaries)) {
      const viewed = foreground && watched(id);
      const isWaiting = s.awaitingCount > 0;
      const isWorking = s.working && !isWaiting;
      // A turn that just ended while nobody was looking is "done"; a new turn or a look clears it.
      if (this.wasWorking.get(id) && !s.working && s.hasHistory && !viewed) this.done.add(id);
      if (viewed || s.working || isWaiting) this.done.delete(id);
      this.wasWorking.set(id, s.working);
      if (isWaiting) {
        waiting++;
        needs.push({ sessionId: id, name: input.nameOf(id), text: input.askTextOf(id) });
      } else if (isWorking) working++;
    }
    const done = this.done.size;
    return { text: statusText(working, waiting, done), working, waiting, done, needs };
  }
}

export interface BackgroundStatusOptions {
  records: {
    summaries(): Record<string, SessionSummary>;
    openAsks(sessionId: string): unknown[];
    addSummaryListener(l: (id: string) => void): () => void;
  };
  nameOf(sessionId: string): string;
  /** Is a page (the phone's) watching this session right now? */
  watched(sessionId: string): boolean;
  /** Sends the status to the phone (host call 'status'). */
  send(status: BackgroundStatus): void;
  debounceMs?: number;
}

export interface BackgroundStatusHandle { setForeground(on: boolean): void; refresh(): void; stop(): void }

export function startBackgroundStatus(opts: BackgroundStatusOptions): BackgroundStatusHandle {
  const tracker = new BackgroundStatusTracker();
  let foreground = false;
  let last = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const run = (): void => {
    timer = null;
    if (stopped) return;
    const status = tracker.update({
      summaries: opts.records.summaries(), foreground, watched: opts.watched, nameOf: opts.nameOf,
      askTextOf: (id) => describeAsk(opts.records.openAsks(id)[0]),
    });
    const key = JSON.stringify(status);
    if (key === last) return; // nothing a notification shows changed
    last = key;
    opts.send(status);
  };
  // WHY debounce: a turn ending closes several things at once; the notification should update once, not flicker.
  const schedule = (): void => { if (!stopped && !timer) { timer = setTimeout(run, opts.debounceMs ?? 300); timer.unref?.(); } };
  const off = opts.records.addSummaryListener(schedule);
  schedule();
  return {
    setForeground(on) { foreground = on; schedule(); },
    refresh: schedule,
    stop() { stopped = true; if (timer) clearTimeout(timer); off(); },
  };
}
