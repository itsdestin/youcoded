// menu-answer-lock.ts — one device at a time may answer a session's Claude Code
// menu by verified navigation (state/ink-menu-driver.ts).
//
// WHY on the HOST (review F4, 2026-09-24): an unnumbered startup dialog is
// answered with several separate keystrokes (arrows, then Enter). If the
// desktop window and a phone both clicked within ~100 ms, the desktop's arrows
// and the phone's Enter could combine into an answer neither person chose —
// e.g. trusting a folder. A per-device "sending" flag cannot see the other
// device; this lock lives in the main process, which every device's keystrokes
// pass through (desktop IPC and the remote WebSocket host share this one
// instance). The second device is refused and its card says "Another device
// is answering this".
//
// A lease, not a plain flag: a device that dies mid-answer must not lock the
// session forever. The driver's own worst case (every arrow waiting its full
// react time, then the leave wait) stays well under LEASE_MS.

export const MENU_ANSWER_LEASE_MS = 20_000;

export class MenuAnswerLock {
  private held = new Map<string, { holder: string; until: number }>();

  constructor(private now: () => number = Date.now) {}

  /** True if `holder` may answer now (the lock was free, expired, or already theirs). */
  acquire(sessionId: string, holder: string): boolean {
    const cur = this.held.get(sessionId);
    if (cur && cur.holder !== holder && cur.until > this.now()) return false;
    this.held.set(sessionId, { holder, until: this.now() + MENU_ANSWER_LEASE_MS });
    return true;
  }

  /** Free the lock — only its holder can. */
  release(sessionId: string, holder: string): void {
    if (this.held.get(sessionId)?.holder === holder) this.held.delete(sessionId);
  }

  /** The one IPC/WebSocket entry point: 'acquire' → granted?, 'release' → true. */
  handle(sessionId: string, holder: string, action: string): boolean {
    if (typeof sessionId !== 'string' || typeof holder !== 'string' || !holder) return false;
    if (action === 'acquire') return this.acquire(sessionId, holder);
    this.release(sessionId, holder);
    return true;
  }
}

/** The host's single instance — shared by ipc-handlers.ts and remote-server.ts. */
export const menuAnswerLock = new MenuAnswerLock();
