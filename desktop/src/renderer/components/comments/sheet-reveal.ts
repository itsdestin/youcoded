// Asking a spreadsheet viewer to show one of its sheet tabs. A cell comment on
// a tab that isn't showing has no cell on screen to highlight, so clicking
// its card (CommentsMargin) or its Ask-about chip (use-ref-source-highlight)
// first asks XlsxView to switch tabs, then finds the cell. Polish pass,
// 2026-09-26 (Destin: spreadsheet comments should name their sheet).
const EVENT = 'youcoded:sheet-reveal';

export function revealSheet(path: string, sheet: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { path, sheet } }));
}

/** XlsxView subscribes for its own file; returns the unsubscribe. */
export function onSheetReveal(path: string, show: (sheet: string) => void): () => void {
  const listener = (e: Event) => {
    const d = (e as CustomEvent<{ path: string; sheet: string }>).detail;
    if (d?.path === path) show(d.sheet);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
