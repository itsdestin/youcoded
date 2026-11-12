// page-save-queue.ts — what happens to a page's "save this" between the page asking and the file being written.
//
// WHY its own file (2026-11-10 review, findings 5 and 10): this lived as loose variables inside PageHost's message
// handler, where nothing could test it, and Put back had no way to reach it. Put back writes the page's files while a
// save the page asked for half a second earlier may still be waiting here; that late save then landed on top of the
// version just put back. Now Put back can (1) write what is waiting first, so "what you had" is complete in the
// Versions list, and (2) hold the queue, so the old page cannot save again before the page is loaded afresh.
//
// The rule itself is unchanged: saves are grouped (a page that saves on every keystroke writes once per pause) and
// the last one wins.

export interface PageSaveQueue {
  /** The page asked to save `data`. Ignored while held. */
  push(data: unknown): void;
  /** Write what is waiting now, and wait for it and any write already on its way. */
  flushNow(): Promise<void>;
  /** Stop taking saves (Put back is running; the page shown is about to be replaced). */
  hold(): void;
  release(): void;
  /** The view is closing: write what is waiting, take nothing more. */
  dispose(): void;
}

export function createPageSaveQueue(opts: {
  /** Writes the data; undefined when saving is not available in this window. */
  write: (data: unknown) => Promise<unknown> | undefined;
  /** True while a save is waiting or being written: the file on disk is older than the page. */
  setSaving: (saving: boolean) => void;
  delayMs?: number;
}): PageSaveQueue {
  const delay = opts.delayMs ?? 500;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { data: unknown } | null = null;
  let held = false;
  let inFlight: Promise<void> = Promise.resolve();

  const settle = () => { if (timer === null && pending === null) opts.setSaving(false); };
  const flush = (): Promise<void> => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (pending === null) return inFlight;
    const { data } = pending;
    pending = null;
    const w = opts.write(data);
    if (!w) { opts.setSaving(false); return inFlight; }
    // A newer save arriving while this one is written keeps the flag up (settle checks).
    inFlight = Promise.all([inFlight, w.then(settle, settle)]).then(() => {});
    return inFlight;
  };

  return {
    push(data) {
      if (held) return;
      pending = { data };
      opts.setSaving(true);
      if (timer === null) timer = setTimeout(() => { void flush(); }, delay);
    },
    flushNow: flush,
    hold() { held = true; },
    release() { held = false; },
    dispose() { held = true; void flush(); },
  };
}
