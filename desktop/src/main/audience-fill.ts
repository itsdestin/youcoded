// audience-fill.ts — holds a screen's pushes for one session while that screen is being filled (one-core R5-2).
//
// WHY (2026-10-01 one-core R5-2): `session:open` answers with the session as of a sampled event number, and the
// screen then applies everything above it from the live stream. A push that reached the screen BEFORE the answer
// would be applied to a session that has no history yet, and then the answer's own events would be applied on top:
// a streamed paragraph drawn in the wrong order, or a permission card revived after its resolution had already
// been applied to nothing (a card with live Yes/No buttons for a question nobody is asking). So from the moment the
// ask arrives until the answer has been sent, the pushes this screen would receive for this session wait here, and
// are delivered, in order, right after the answer. Nothing is dropped and nothing is applied twice: the answer
// holds everything up to the sampled number, and these are everything above it.
//
// Electron-free: a delivery is a closure, so a window's `webContents.send` and a phone's socket write are the same here.
const DEFAULT_TIMEOUT_MS = 30_000;

interface Hold { queue: Array<() => void>; timer: ReturnType<typeof setTimeout> | null }

export class AudienceFills {
  // audience key ('w<windowId>' or 's<socketId>') -> session id -> what is waiting
  private readonly holds = new Map<string, Map<string, Hold>>();

  /**
   * Start holding `sessionId`'s pushes for this screen. Idempotent (a second begin keeps the queue and restarts the
   * timer). The timeout is a safety net: a screen that never gets its answer (a window that closed mid-fill) must not
   * sit on a queue forever, so when it fires the held pushes are delivered as they are.
   */
  begin(key: string, sessionId: string, timeoutMs = DEFAULT_TIMEOUT_MS): void {
    let bySession = this.holds.get(key);
    if (!bySession) { bySession = new Map(); this.holds.set(key, bySession); }
    let hold = bySession.get(sessionId);
    if (!hold) { hold = { queue: [], timer: null }; bySession.set(sessionId, hold); }
    if (hold.timer) clearTimeout(hold.timer);
    hold.timer = setTimeout(() => this.release(key, sessionId), timeoutMs);
    hold.timer.unref?.();
  }

  filling(key: string, sessionId: string): boolean {
    return !!this.holds.get(key)?.has(sessionId);
  }

  /** If this screen is filling this session, keep `deliver` for later and say so (true). Otherwise do nothing (false). */
  hold(key: string, sessionId: string, deliver: () => void): boolean {
    const hold = this.holds.get(key)?.get(sessionId);
    if (!hold) return false;
    hold.queue.push(deliver);
    return true;
  }

  /** The answer has been sent: deliver what waited, in order, and stop holding. */
  release(key: string, sessionId: string): void {
    const bySession = this.holds.get(key);
    const hold = bySession?.get(sessionId);
    if (!bySession || !hold) return;
    if (hold.timer) clearTimeout(hold.timer);
    bySession.delete(sessionId);
    if (bySession.size === 0) this.holds.delete(key);
    for (const deliver of hold.queue) {
      // One failing delivery (a window that closed) must not strand the rest.
      try { deliver(); } catch (err) { console.warn('[audience-fill] a held push could not be delivered:', String(err)); }
    }
  }

  /** The screen is gone (window closed, phone dropped): forget everything it was owed. */
  forget(key: string): void {
    const bySession = this.holds.get(key);
    if (!bySession) return;
    for (const hold of bySession.values()) if (hold.timer) clearTimeout(hold.timer);
    this.holds.delete(key);
  }

  /** Quit teardown. */
  clear(): void {
    for (const key of [...this.holds.keys()]) this.forget(key);
  }

  /** For tests and the memory check: how many pushes are waiting. */
  pending(): number {
    let n = 0;
    for (const m of this.holds.values()) for (const h of m.values()) n += h.queue.length;
    return n;
  }
}
