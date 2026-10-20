// Holds ownership handoffs for windows that cannot receive them yet.
//
// WHY this exists (2026-09-03): a session tear-off hands the session to a
// BrowserWindow created one statement earlier. `webContents.send` at that moment
// reaches a renderer whose React tree does not exist, and Electron DROPS a
// message with no listener rather than queueing it — measured on 41.10.7:
// a send issued right after `new BrowserWindow()` never reaches a listener
// registered 1.5 s later. So every tear-off into a fresh window silently
// skipped its entire handoff: no history hydration (the conversation rendered
// frozen at the moment the session was resumed), no "open on the session you
// just dragged", no re-send of an open permission ask.
//
// The window therefore PULLS once mounted (IPC.DETACH_CLAIM_PENDING) instead of
// being pushed at before it can listen — the same shape already used for the
// buddy overlay's boot geometry. `ready` is what keeps the two paths exclusive:
// before a window has pulled, transfers queue; after, they push. A payload is
// delivered exactly once either way, never twice and never zero times.
//
// Ids are `webContents.id` values throughout — see windowFromWcId's WHY in
// main.ts for why BrowserWindow.id is the wrong key everywhere in this app.
export class PendingAcquireQueue<T> {
  private readonly queued = new Map<number, T[]>();

  private readonly ready = new Set<number>();

  /** True once the window has pulled — i.e. its renderer is listening. */
  isReady(windowId: number): boolean {
    return this.ready.has(windowId);
  }

  /** Hold a payload for a window that has not pulled yet. */
  enqueue(windowId: number, payload: T): void {
    const list = this.queued.get(windowId);
    if (list) list.push(payload);
    else this.queued.set(windowId, [payload]);
  }

  /**
   * Mark the window ready and drain everything held for it. Idempotent: a
   * second call returns an empty list, so a renderer that remounts (dev HMR,
   * a reload) cannot replay a handoff it already applied.
   */
  claim(windowId: number): T[] {
    this.ready.add(windowId);
    const list = this.queued.get(windowId) ?? [];
    this.queued.delete(windowId);
    return list;
  }

  /** WHY: a reload keeps ownership and queued handoffs, but its old listener is gone. */
  suspend(windowId: number): void { this.ready.delete(windowId); }

  /**
   * Drop everything for a closed window. webContents ids are not reused within
   * a run, so this is about not leaking for the app's lifetime — a window that
   * closed before it ever mounted would otherwise hold its queue forever.
   */
  forget(windowId: number): void {
    this.queued.delete(windowId);
    this.ready.delete(windowId);
  }
}
