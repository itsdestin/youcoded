// One shared list of the person's automations (pages-finish step 4, design stage).
//
// WHY one store, not a fetch per screen (renderer-lists.md "Data several surfaces read is one
// store"): the Automations page, the page list's waiting dot and a page's Settings all read the
// same list; one fetch per mount would make the dots pop in at different times.
import { useSyncExternalStore } from 'react';
import type { AutomationSummary, AutomationsBridge } from '../../../shared/automation-types';

type Snap = { jobs: AutomationSummary[]; loaded: boolean; failed: boolean };

let snap: Snap = { jobs: [], loaded: false, failed: false };
const subs = new Set<() => void>();
let started = false;

export function automationsBridge(): AutomationsBridge | undefined {
  return (window as unknown as { claude?: { automations?: AutomationsBridge } }).claude?.automations;
}

export function publishAutomations(jobs: AutomationSummary[]): void {
  snap = { jobs, loaded: true, failed: false };
  for (const s of [...subs]) s();
}

export async function refreshAutomations(): Promise<void> {
  const b = automationsBridge();
  // No runner on this surface yet (only the workbench answers): an empty, loaded list.
  if (!b) { publishAutomations([]); return; }
  try { publishAutomations(await b.list()); }
  catch { snap = { ...snap, loaded: true, failed: true }; for (const s of [...subs]) s(); }
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  if (!started) { started = true; void refreshAutomations(); }
  return () => { subs.delete(cb); };
}

export function useAutomations(): Snap {
  return useSyncExternalStore(subscribe, () => snap, () => snap);
}

/** Page ids with a job waiting for the person, and how many jobs wait in all — for the dots. */
export function useAutomationsWaiting(): { total: number; pages: ReadonlySet<string> } {
  const { jobs } = useAutomations();
  return waitingOf(jobs);
}

let lastJobs: AutomationSummary[] | null = null;
let lastWaiting: { total: number; pages: ReadonlySet<string> } = { total: 0, pages: new Set() };
function waitingOf(jobs: AutomationSummary[]) {
  // Cached per list, so a reader's selector returns the same object until the list changes.
  if (jobs === lastJobs) return lastWaiting;
  const pages = new Set<string>();
  let total = 0;
  for (const j of jobs) {
    if (!j.waiting) continue;
    total++;
    // A waiting job lights every page it is linked to (plan deck Q-pagejobs: links, not one owner).
    for (const l of j.links) if (l.kind === 'page') pages.add(l.id);
  }
  lastJobs = jobs;
  lastWaiting = { total, pages };
  return lastWaiting;
}
