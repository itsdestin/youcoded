// The lease and destination pin must have the SAME proof boundary, even when
// a window close or remote destroy calls SessionManager without going through IPC.
export function createTransferredExitGate(
  admission: { protect(id: string): void; clearProtection(id: string): boolean; markExit(id: string, stop?: Promise<void>): void },
  hasSession: (sessionId: string) => boolean,
  ended: (sessionId: string) => void,
) {
  const exits = new Map<string, { conversationId: string; stop: Promise<void>; settling: boolean; failed: boolean }>();
  const proven = new Set<string>();
  function settle(sessionId: string): void {
    const exit = exits.get(sessionId);
    if (!exit || !proven.has(sessionId) || exit.settling) return;
    exit.settling = true;
    // WHY: PTY proof can arrive BEFORE session-exit even starts teardown.
    // Never free either the pin or the hub lease until BOTH barriers pass.
    void exit.stop.then(() => {
      ended(sessionId);
      admission.clearProtection(exit.conversationId);
      admission.markExit(exit.conversationId);
      // Keep a small tombstone to make duplicate exit/proof notifications
      // idempotent; failures remain fenced for the process lifetime.
      if (exits.size > 1024) for (const [id, old] of exits) {
        if (exits.size <= 1024) break;
        if (id !== sessionId && old.settling && !old.failed) { exits.delete(id); proven.delete(id); }
      }
    }, () => { exit.failed = true; /* unsafe lease and destination pin stay fenced */ });
  }
  return {
    onStopped(sessionId: string): void {
      if (!hasSession(sessionId) && !exits.has(sessionId)) return;
      proven.add(sessionId);
      settle(sessionId);
    },
    onExit(sessionId: string, conversationId: string, stop: Promise<void>): boolean {
      if (exits.has(sessionId)) return true;
      if (!hasSession(sessionId)) return false;
      // WHY: early session-exit is not stop proof. Protect even if proof
      // already arrived; asynchronous teardown may still fail afterwards.
      admission.protect(conversationId);
      exits.set(sessionId, { conversationId, stop, settling: false, failed: false });
      settle(sessionId);
      return true;
    },
  };
}
