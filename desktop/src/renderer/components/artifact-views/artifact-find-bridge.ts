// artifact-find-bridge — lets the spreadsheet viewers take part in Ctrl+F find-in-document.
//
// WHY (Fix 2, 2026-10-04): the find bar (ContentFindBar) searches the page's own text, which was every cell of a
// sheet. Sheets now draw only the visible cells, so a match far down would not be in the page at all. The bar
// publishes what is typed; a sheet viewer reads it, keeps the matching cells in the page (SheetGrid `pins`), and
// asks the bar to look again once they are there. The bar needs no other change and every other viewer is
// untouched: if nothing reads the query, nothing happens.
import { useSyncExternalStore } from 'react';

let query = '';
const queryListeners = new Set<() => void>();
const rewalkListeners = new Set<() => void>();

/** The bar says what is typed ('' when it closes). Only the artifact viewer's bar publishes — not the chat's. */
export function publishFindQuery(q: string): void {
  if (q === query) return;
  query = q;
  queryListeners.forEach((l) => l());
}

export function useArtifactFindQuery(): string {
  return useSyncExternalStore(
    (l) => { queryListeners.add(l); return () => { queryListeners.delete(l); }; },
    () => query,
    () => '',
  );
}

/** A sheet put its matching cells in the page: the bar should count and highlight again. */
export function requestFindRewalk(): void {
  rewalkListeners.forEach((l) => l());
}

export function onFindRewalk(l: () => void): () => void {
  rewalkListeners.add(l);
  return () => { rewalkListeners.delete(l); };
}

/** Most matching cells a sheet keeps in the page for one search. A search can match thousands of cells; each one
 *  kept costs a cell (and its row) in the page, so the first this many in reading order are reachable. */
export const MAX_FIND_CELLS = 300;

/** Tests only: read the published query without a React hook. */
export const getFindQueryForTest = () => query;
