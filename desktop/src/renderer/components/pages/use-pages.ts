// The page list, shared by the header (pinned buttons), the library and the
// host. One store, one bridge subscription, however many consumers — the
// header renders on every keystroke and must not each hold its own copy.
import { useSyncExternalStore } from 'react';
import type { PageSummary, PagesBridge } from '../../../shared/pages-types';

type Snapshot = { pages: PageSummary[]; loaded: boolean; failed: boolean };

let snapshot: Snapshot = { pages: [], loaded: false, failed: false };
const listeners = new Set<() => void>();
let started = false;

function bridge(): PagesBridge | undefined {
  return (window as unknown as { claude?: { pages?: PagesBridge } }).claude?.pages;
}

function publish(next: Snapshot) {
  snapshot = next;
  listeners.forEach((l) => l());
}

function start() {
  if (started) return;
  started = true;
  const b = bridge();
  if (!b) { publish({ pages: [], loaded: true, failed: false }); return; }
  b.list().then(
    (pages) => publish({ pages, loaded: true, failed: false }),
    () => publish({ pages: [], loaded: true, failed: true }),
  );
  b.onChanged((pages) => publish({ pages, loaded: true, failed: false }));
}

function subscribe(l: () => void) {
  listeners.add(l);
  start();
  return () => { listeners.delete(l); };
}

export function usePages(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** Ask the host for the list again. The library and the page view call this
 *  when they open: the first list happens at app start, and a page made since
 *  (or a project added since, whose Pages/ the host was not yet scanning) is
 *  only guaranteed to show once someone asks. Found 2026-09-17: the library
 *  showed the welcome card over a folder with two pages. */
export async function refreshPages(): Promise<void> {
  const b = bridge();
  if (!b) return;
  try { publish({ pages: await b.list(), loaded: true, failed: false }); }
  catch { publish({ pages: snapshot.pages, loaded: true, failed: true }); }
}

/** Pin or unpin. The bridge answers with the fresh list, and onChanged fires
 *  too on the real host; publishing here keeps the workbench honest when the
 *  fake does not push. */
export async function setPagePinned(id: string, pinned: boolean): Promise<void> {
  const b = bridge();
  if (!b) return;
  const pages = await b.setPinned(id, pinned);
  publish({ pages, loaded: true, failed: false });
}
