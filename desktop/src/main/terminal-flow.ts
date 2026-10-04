// Terminal flow control — main-process bookkeeping (2026-10-04, review round).
//
// The PTY worker brakes the program when the characters it handed to main stay un-acknowledged
// (pty-worker.js flow block). This class decides WHEN main passes an acknowledgement back, so the
// brake is driven only by desktop terminals that will really answer:
//
//  * A "consumer" is a desktop window whose terminal for the session has said it is ready. Each
//    consumer owes the characters sent to it and not yet confirmed (`owed`).
//  * The worker is kept owing only as much as the SLOWEST live consumer owes. Chunks nobody can
//    confirm — no consumer yet (output buffered before the terminal mounts), every consumer gone
//    (window closed/reloaded, session orphaned, app in the tray), a consumer that no longer receives
//    the session (ownership moved) — are released at once. Phones never count: they are not consumers,
//    so a slow phone cannot stall the desktop, and a phone-driven session with no desktop terminal runs
//    exactly as fast as before the brake existed (the remote ring buffer is already capped).
//  * A non-owner consumer (a second window showing the same session) counts only while it keeps
//    answering: one that has gone quiet for NON_OWNER_QUIET_MS while owing is dropped, so it can never
//    hold the owner's terminal hostage, and re-joins on its next ack.
//  * Everything is recomputed when ownership changes or a window goes, so a brake can never outlive the
//    terminal it was waiting for.
const NON_OWNER_QUIET_MS = 5000;

export interface TerminalFlowDeps {
  /** Windows (webContents ids) this session's output is routed to right now. */
  targets(sessionId: string): number[];
  isOwner(sessionId: string, windowId: number): boolean;
  alive(windowId: number): boolean;
  /** Pass `chars` of credit back to the PTY worker. */
  release(sessionId: string, chars: number): void;
  now(): number;
  /** Call `gone` once when the window is destroyed or starts reloading. */
  watch(windowId: number, gone: () => void): void;
  /** Sessions that just lost a consumer because its window went away. */
  lost(sessionIds: string[]): void;
}

interface Consumer { owed: number; lastAckAt: number; }
interface Flow { workerOwed: number; consumers: Map<number, Consumer>; }

export class TerminalFlow {
  private readonly flows = new Map<string, Flow>();
  private readonly watched = new Set<number>();
  constructor(private readonly d: TerminalFlowDeps) {}

  private flow(sid: string): Flow {
    let f = this.flows.get(sid);
    if (!f) { f = { workerOwed: 0, consumers: new Map() }; this.flows.set(sid, f); }
    return f;
  }

  /** The most any live, receiving consumer still owes (0 when there is none to wait for). */
  private desired(sid: string, f: Flow): number {
    const targets = new Set(this.d.targets(sid));
    const t = this.d.now();
    let max = 0;
    for (const [wid, c] of f.consumers) {
      if (!targets.has(wid) || !this.d.alive(wid)) continue;
      if (c.owed > 0 && !this.d.isOwner(sid, wid) && t - c.lastAckAt > NON_OWNER_QUIET_MS) continue;
      if (c.owed > max) max = c.owed;
    }
    return max;
  }

  private settle(sid: string, f: Flow): void {
    const give = f.workerOwed - this.desired(sid, f);
    if (give > 0) { f.workerOwed -= give; this.d.release(sid, give); }
  }

  /** Output of `chars` was just produced (and routed to its windows, if the session is ready). */
  output(sid: string, chars: number, routed: boolean): void {
    const f = this.flow(sid);
    f.workerOwed += chars;
    if (routed) {
      const targets = this.d.targets(sid);
      for (const [wid, c] of f.consumers) {
        if (!targets.includes(wid)) continue;
        if (c.owed === 0) c.lastAckAt = this.d.now();
        c.owed += chars;
      }
    }
    this.settle(sid, f);
  }

  /** A terminal for `sid` mounted in `wid`. `backlog` = characters about to be sent to it from the pre-mount buffer. */
  ready(sid: string, wid: number, backlog: number): void {
    const f = this.flow(sid);
    // Mounting again (reload, remount) forgets what was in flight to the old terminal — for THIS window only.
    // Other windows already drawing this session receive the same backlog, so they owe it too.
    if (backlog > 0) { const t = this.d.targets(sid); for (const [w, c] of f.consumers) if (w !== wid && t.includes(w)) c.owed += backlog; }
    f.consumers.set(wid, { owed: backlog, lastAckAt: this.d.now() });
    if (!this.watched.has(wid)) {
      this.watched.add(wid);
      this.d.watch(wid, () => { this.watched.delete(wid); this.d.lost(this.windowGone(wid)); });
    }
    this.settle(sid, f);
  }

  /** `wid`'s terminal finished drawing `chars`. Ignored unless `wid` is a consumer of `sid`. */
  ack(sid: string, wid: number, chars: number): void {
    const f = this.flows.get(sid);
    const c = f?.consumers.get(wid);
    if (!f || !c) return;
    c.owed = Math.max(0, c.owed - chars);
    c.lastAckAt = this.d.now();
    this.settle(sid, f);
  }

  /** Is anyone live and receiving who could draw this session's output? */
  hasConsumer(sid: string): boolean {
    const f = this.flows.get(sid);
    if (!f) return false;
    const targets = this.d.targets(sid);
    for (const wid of f.consumers.keys()) if (targets.includes(wid) && this.d.alive(wid)) return true;
    return false;
  }

  windowGone(wid: number): string[] {
    const lost: string[] = [];
    for (const [sid, f] of this.flows) {
      if (f.consumers.delete(wid)) { this.settle(sid, f); lost.push(sid); }
    }
    return lost;
  }

  /** Ownership/subscriptions/windows changed: nothing may stay braked for a terminal that no longer counts. */
  recompute(): void { for (const [sid, f] of this.flows) this.settle(sid, f); }

  end(sid: string): void { this.flows.delete(sid); }
}

/**
 * Call `gone` once when `wc` is destroyed, its renderer crashes, or its page itself navigates (Ctrl+R) —
 * its terminals are gone and new ones will say "ready" again. NOT a subframe or in-page navigation (an HTML
 * viewer iframe loading must not drop the terminal).
 */
export function watchWebContents(wc: { on(e: string, f: (...a: any[]) => void): unknown; removeListener(e: string, f: (...a: any[]) => void): unknown }, gone: () => void): void {
  const nav = (e: any, _url?: string, inPlace?: boolean, isMain?: boolean) => {
    const main = e?.isMainFrame ?? isMain, same = e?.isSameDocument ?? inPlace;
    if (main && !same) fire();
  };
  const fire = () => {
    wc.removeListener('destroyed', fire); wc.removeListener('render-process-gone', fire); wc.removeListener('did-start-navigation', nav);
    gone();
  };
  wc.on('destroyed', fire); wc.on('render-process-gone', fire); wc.on('did-start-navigation', nav);
}
