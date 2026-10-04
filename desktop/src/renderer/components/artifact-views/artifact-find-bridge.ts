// artifact-find-bridge — lets the spreadsheet viewers take part in Ctrl+F find-in-document.
//
// WHY (Fix 2 + review fix 3, 2026-10-04): the find bar (ContentFindBar) searches the page's own text, which was
// every cell of a sheet. Sheets now draw only the visible cells, so a match far down is not in the page. A sheet
// viewer registers a FIND ADAPTER here: the bar asks it for the TRUE number of matching cells (searched in the
// sheet's data, never in what happens to be drawn, so the answer does not depend on scrolling), and for
// "match number N" the sheet scrolls there and hands back the drawn cell. Every other viewer registers nothing and
// the bar behaves exactly as before.

export interface SheetFindAdapter {
  /** How many cells contain `query` (case-insensitive), in reading order. Same query, same answer, always. */
  search(query: string): number;
  /** Scroll to match number `index` (0-based, < the count last returned) and resolve with its drawn <td>. */
  reveal(index: number): Promise<HTMLElement | null>;
}

let adapter: SheetFindAdapter | null = null;
const rewalkListeners = new Set<() => void>();
const adapterListeners = new Set<() => void>();

export function registerSheetFind(a: SheetFindAdapter): () => void {
  adapter = a;
  adapterListeners.forEach((l) => l());
  return () => { if (adapter === a) { adapter = null; adapterListeners.forEach((l) => l()); } };
}
export const getSheetFind = (): SheetFindAdapter | null => adapter;
/** The bar re-reads the adapter when a viewer registers or leaves (another tab, another file). */
export function onSheetFindChange(l: () => void): () => void {
  adapterListeners.add(l);
  return () => { adapterListeners.delete(l); };
}

/** The sheet changed under an open search (a tab switch): the bar should count and highlight again. */
export function requestFindRewalk(): void {
  rewalkListeners.forEach((l) => l());
}
export function onFindRewalk(l: () => void): () => void {
  rewalkListeners.add(l);
  return () => { rewalkListeners.delete(l); };
}
