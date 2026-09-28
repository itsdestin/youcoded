// The page list, shared by the header (pinned buttons), the library and the
// host. One store, one bridge subscription, however many consumers — the
// header renders on every keystroke and must not each hold its own copy.
import { useMemo, useSyncExternalStore } from 'react';
import type { PageSummary, PagesBridge } from '../../../shared/pages-types';
import { OFFICE_PAGE_ID } from '../../../shared/pages-types';
import { useOfficeAvailable } from '../office/office-availability';

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

/** pinnedTotal: every pin the host holds, the hidden Office one too. WHY (fix round 1): main
 *  enforces MAX_PINNED_PAGES over ALL its pins, so a remote browser that cannot see a pinned
 *  Office must still count it — else its pin button looks free and main quietly refuses. */
export function usePages(): Snapshot & { pinnedTotal: number } {
  const snap = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  // WHY (Task 6): the host lists the built-in Office page wherever the add-on is installed —
  // including to a remote browser, which cannot run it. Every consumer (the rail, the library,
  // the pinned buttons, PageHost's "is the open page still listed" check) reads through here,
  // so Office is hidden in one place until this app has confirmed it can run Office.
  const office = useOfficeAvailable();
  return useMemo(() => {
    const pinnedTotal = snap.pages.filter((p) => p.pinned).length;
    if (office || !snap.pages.some((p) => p.id === OFFICE_PAGE_ID)) return { ...snap, pinnedTotal };
    return { ...snap, pages: snap.pages.filter((p) => p.id !== OFFICE_PAGE_ID), pinnedTotal };
  }, [snap, office]);
}

/** Publish a list the bridge just answered with (approve, remove, refresh):
 *  the real host also fires onChanged, the workbench fake may not. */
export function publishPages(pages: PageSummary[]): void {
  publish({ pages, loaded: true, failed: false });
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
