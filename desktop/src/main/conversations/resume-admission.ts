// One backend owner for the lease check and the session it admits. In particular,
// an in-flight acquisition cannot outlive a holder handoff and spawn a new writer.
export function createResumeAdmission<T>(deps: {
  acquire(id: string): Promise<{ ok: boolean; holder?: { device?: string } | null } | null>;
  release(id: string): Promise<void>;
  getLive(id: string): T | undefined;
}) {
  type Result = T | { status: 'lease-denied'; device?: string };
  const pending = new Map<string, Promise<Result>>();
  const handoffs = new Map<string, Promise<void>>();
  const invalidated = new Set<string>();
  const draining = new Map<string, Promise<void>>();
  const endVersions = new Map<string, number>();
  const stopping = new Map<string, Promise<void>>();
  const endedWhileOpening = new Set<string>();
  const unsafe = new Set<string>();
  const reserved = new Map<string, symbol>();
  return {
    // WHY: a pending fresh handoff must not be coalesced with an ordinary open.
    // Only its owner may enter the shared lease/startup admission lane.
    reserve(id: string): { token: symbol; release: () => void } | null {
      if (reserved.has(id) || pending.has(id) || deps.getLive(id) || unsafe.has(id)) return null;
      const token = Symbol(id);
      reserved.set(id, token);
      return { token, release: () => { if (reserved.get(id) === token) reserved.delete(id); } };
    },
    async open(id: string, start: () => Promise<T>, enabled = true, reservation?: symbol, requireLease = false): Promise<Result> {
      if (reserved.has(id) && reserved.get(id) !== reservation) return { status: 'lease-denied' };
      if (reservation && reserved.get(id) !== reservation) return { status: 'lease-denied' };
      // WHY: do not transfer an already-running writer's window ownership, and do
      // not acquire twice when two windows try to open the same conversation.
      const handoff = handoffs.get(id);
      if (handoff) await handoff;
      if (reserved.has(id) && reserved.get(id) !== reservation) return { status: 'lease-denied' };
      if (reservation && reserved.get(id) !== reservation) return { status: 'lease-denied' };
      const existing = pending.get(id);
      if (existing) return existing;
      const live = deps.getLive(id);
      if (live && !unsafe.has(id)) return live;
      if (unsafe.has(id)) throw new Error('This conversation could not be opened because its previous writer could not be stopped.');
      const attempt = (async (): Promise<Result> => {
        let held = false;
        const beforeStartEnd = endVersions.get(id) ?? 0;
        try {
          // WHY: an old session's async release must finish BEFORE this device
          // acquires the same id again (the hub keys releases by device, not generation).
          await draining.get(id);
          if (unsafe.has(id)) throw new Error('This conversation could not be opened because its previous writer could not be stopped.');
          if (enabled) {
            // A null reply still starts the lease client's optimistic local hold.
            const res = await deps.acquire(id).catch(() => null);
            if (res?.ok === false || (requireLease && res?.ok !== true)) {
              // WHY: a null lease reply still starts the legacy optimistic
              // heartbeat. Strict handoffs must undo only that local hold.
              if (requireLease && res === null) await deps.release(id);
              return { status: 'lease-denied', device: res?.holder?.device };
            }
            held = true;
          }
          if (invalidated.has(id)) {
            if (held) await deps.release(id);
            return { status: 'lease-denied' };
          }
          const result = await start();
          // The SessionManager may have exited during a native host await or
          // a CC worker may have exited before the create operation settled.
          if (endedWhileOpening.has(id)) throw new Error('This conversation ended before startup completed.');
          return result;
        } catch (e) {
          // Only this attempt may clear its hold, including a local optimistic
          // hold from an unavailable hub; a denied attempt never held one.
          // An exit during startup can still have a native append chain draining.
          // The exit promise is handled even when this attempt never reaches here.
          await stopping.get(id);
          if ((endVersions.get(id) ?? 0) !== beforeStartEnd) await draining.get(id);
          else if (held && !unsafe.has(id) && !deps.getLive(id)) await deps.release(id).catch(() => {});
          throw e;
        }
      })();
      pending.set(id, attempt);
      try { return await attempt; }
      finally {
        if (pending.get(id) === attempt) { pending.delete(id); endedWhileOpening.delete(id); }
      }
    },
    async handoff(id: string, teardown: () => Promise<void>): Promise<void> {
      const active = handoffs.get(id);
      if (active) return active;
      // Synchronous invalidation must precede the first await in the hub event.
      invalidated.add(id);
      const task = (async () => {
        try {
          await pending.get(id)?.catch(() => {});
          // No manager entry does not prove its old native writer has stopped.
          // The holder's no-live release must respect the same exit barrier.
          await stopping.get(id);
          await draining.get(id);
          if (unsafe.has(id)) return;
          await teardown();
        } finally {
          invalidated.delete(id);
        }
      })();
      handoffs.set(id, task);
      try { await task; }
      finally { if (handoffs.get(id) === task) handoffs.delete(id); }
    },
    markExit(id: string, stop: Promise<void> = Promise.resolve()): void {
      // WHY: register the stop synchronously; a late native resume may need
      // another destroy in startSession before its opener releases authority.
      const previous = stopping.get(id);
      const settled = Promise.all([previous, stop]).then(() => {}, () => { unsafe.add(id); });
      stopping.set(id, settled);
      if (pending.has(id)) endedWhileOpening.add(id);
      else this.end(id);
    },
    waitForStop(id: string): Promise<void> { return stopping.get(id) ?? Promise.resolve(); },
    protect(id: string): void { unsafe.add(id); },
    isUnsafe(id: string): boolean { return unsafe.has(id); },
    clearProtection(id: string): boolean { return unsafe.delete(id); },
    end(id: string): void {
      if (unsafe.has(id)) return;
      endVersions.set(id, (endVersions.get(id) ?? 0) + 1);
      // WHY: retain exit generations while a startup may need to coalesce its
      // release, but do not retain every conversation id for the app's lifetime.
      if (endVersions.size > 1024) for (const oldId of endVersions.keys()) {
        if (endVersions.size <= 1024) break;
        if (oldId !== id && !pending.has(oldId) && !draining.has(oldId)) endVersions.delete(oldId);
      }
      const previous = draining.get(id);
      const task = (async () => {
        await previous;
        await stopping.get(id);
        if (!unsafe.has(id)) await deps.release(id).catch(() => {});
      })();
      draining.set(id, task);
      void task.finally(() => { if (draining.get(id) === task) draining.delete(id); });
    },
    endVersion(id: string): number { return endVersions.get(id) ?? 0; },
    async releaseAbandoned(id: string, beforeDispose: number): Promise<void> {
      // WHY: destroy may itself emit session-exit and schedule release. Never
      // release a second time after an exit has already released this generation.
      await stopping.get(id);
      if ((endVersions.get(id) ?? 0) !== beforeDispose) { await draining.get(id); return; }
      if (!unsafe.has(id) && !deps.getLive(id)) await deps.release(id);
    },
    isOpening(id: string): boolean { return pending.has(id); },
    isHandingOff(id: string): boolean { return invalidated.has(id); },
  };
}
