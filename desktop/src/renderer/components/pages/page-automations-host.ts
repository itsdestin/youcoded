// page-automations-host.ts — the app's side of a page's own automation button (finishing Pages, step 4;
// deck step4.review Q-button "the kit does it", step4g G-limit).
//
// A page may start only automations LINKED to it, and learns only their name and state. The page id used
// here is the app's own (the page that is loaded in the frame), never something the page's code sends,
// and the backend checks the link again.
//
// Page -> app:  { type: PAGE_AUTOMATION_MESSAGE, id, op: 'list' | 'run' | 'event', job?, event?, data? }
// App -> page:  { type: PAGE_AUTOMATION_RESULT_MESSAGE, id, result: { ok, message? } }
//               { type: PAGE_AUTOMATIONS_STATE_MESSAGE, jobs: PageAutomationState[] }   (also after every change)
import type { AutomationSummary } from '../../../shared/automation-types';
import { automationsBridge } from '../automations/use-automations';

export const PAGE_AUTOMATION_MESSAGE = 'youcoded:automation';
export const PAGE_AUTOMATION_RESULT_MESSAGE = 'youcoded:automation:result';
export const PAGE_AUTOMATIONS_STATE_MESSAGE = 'youcoded:automations';

/** The most a page may send with an event (characters). */
const MAX_EVENT_DATA = 20_000;

export interface PageAutomationState {
  id: string;
  name: string;
  /** idle: can be started. running: going now. waiting: paused for the person's OK. limit: no more runs today. */
  state: 'idle' | 'running' | 'waiting' | 'limit';
  /** Shown on the button's hover and returned when a start is refused. */
  message?: string;
}

/** What a page is told about the automations linked to it. */
export function pageAutomationStates(jobs: readonly AutomationSummary[], pageId: string): PageAutomationState[] {
  return jobs.filter((j) => j.links.some((l) => l.kind === 'page' && l.id === pageId)).map((j) => {
    if (j.waiting) return { id: j.id, name: j.name, state: 'waiting' as const, message: 'Waiting for your OK' };
    if (j.lastRun?.outcome === 'running') return { id: j.id, name: j.name, state: 'running' as const };
    if (j.maxRunsPerDay != null && (j.runsToday ?? 0) >= j.maxRunsPerDay) {
      // The same words as the popup's greyed Run now (step4g G-limit: one rule for every start).
      return { id: j.id, name: j.name, state: 'limit' as const, message: `Daily limit reached. ${j.runsToday} of ${j.maxRunsPerDay} runs today. It can run again tomorrow.` };
    }
    return { id: j.id, name: j.name, state: 'idle' as const };
  });
}

/** Send the page its automations' states. */
export function postPageAutomations(frame: Window | null | undefined, jobs: readonly AutomationSummary[], pageId: string): void {
  try { frame?.postMessage({ type: PAGE_AUTOMATIONS_STATE_MESSAGE, jobs: pageAutomationStates(jobs, pageId) }, '*'); } catch { /* the frame went away */ }
}

/** Answer one message from the page. Returns true when the message was an automation one. */
export function handlePageAutomationMessage(d: { type?: unknown; id?: unknown; op?: unknown; job?: unknown; event?: unknown; data?: unknown }, source: Window, pageId: string, jobs: readonly AutomationSummary[]): boolean {
  if (d.type !== PAGE_AUTOMATION_MESSAGE) return false;
  if (typeof d.id !== 'string') return true;
  const id = d.id;
  const answer = (result: { ok: boolean; message?: string }) => {
    try { source.postMessage({ type: PAGE_AUTOMATION_RESULT_MESSAGE, id, result }, '*'); } catch { /* the frame went away */ }
  };
  if (d.op === 'list') { postPageAutomations(source, jobs, pageId); answer({ ok: true }); return true; }
  const start = automationsBridge()?.pageStart;
  if (!start) { answer({ ok: false, message: 'Automations are not available here.' }); return true; }
  if (d.op === 'run' && typeof d.job === 'string') {
    void start(pageId, { job: d.job }).then(answer, () => answer({ ok: false, message: 'The automation could not be started.' }));
  } else if (d.op === 'event' && typeof d.event === 'string' && d.event.length <= 200) {
    const data = typeof d.data === 'string' ? d.data : undefined;
    if (data !== undefined && data.length > MAX_EVENT_DATA) { answer({ ok: false, message: 'That is too much information to send with one event.' }); return true; }
    void start(pageId, { event: d.event, ...(data !== undefined ? { data } : {}) }).then(answer, () => answer({ ok: false, message: 'The automation could not be started.' }));
  } else {
    answer({ ok: false, message: 'That request was not understood.' });
  }
  return true;
}
