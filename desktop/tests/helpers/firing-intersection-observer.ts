// WHY: the no-op IntersectionObserver stubs in several tests (e.g.
// files-tab-list-view.test.tsx:53) never fire, and useChunkedReveal's jsdom
// fallback only triggers when the global is ABSENT — so a list under a no-op
// stub would sit at one chunk and a test would pass while the list is stranded.
// This stub records every observed element and fires on demand.
type Cb = (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;
export function installFiringIntersectionObserver() {
  const prev = (globalThis as any).IntersectionObserver;
  const live = new Set<{ cb: Cb; els: Set<Element> }>();
  (globalThis as any).IntersectionObserver = class {
    private rec: { cb: Cb; els: Set<Element> };
    constructor(cb: Cb) { this.rec = { cb, els: new Set() }; live.add(this.rec); }
    observe(el: Element) { this.rec.els.add(el); }
    unobserve(el: Element) { this.rec.els.delete(el); }
    disconnect() { live.delete(this.rec); }
    takeRecords() { return []; }
  };
  return {
    fireAll() {
      // WHY isConnected: a real observer never reports an element that has left
      // the page. Without this filter a hook still watching a REPLACED sentinel
      // (grid ↔ list view) would be fired anyway and the stranded-list bug would
      // pass its own test.
      for (const r of [...live]) {
        const entries = [...r.els].filter((el) => el.isConnected).map((target) => ({ isIntersecting: true, target }));
        if (entries.length) r.cb(entries);
      }
    },
    restore() { (globalThis as any).IntersectionObserver = prev; },
  };
}
