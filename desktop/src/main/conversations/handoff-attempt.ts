import { randomUUID } from 'node:crypto';
import { parseHandoffReceipt, type TransferContext } from './handoff-receipt';
import type { FreshnessCheck } from './handoff-transcript';
import { createResumeAdmission } from './resume-admission';

export type AttemptStatus<T> =
  | { status: 'waiting' | 'incomplete' | 'cancelled' | 'failed'; id: string; cause?: string }
  | { status: 'admitted'; id: string; source: 'confirmed' | 'saved-copy'; session: T };
type Admission<T> = ReturnType<typeof createResumeAdmission<T>>;
type Owner = string; // 'window:<webContents.id>' or 'remote:<connection-id>', never a device label
interface Attempt<T, O> {
  id: string; owner: Owner; context: TransferContext; options?: Readonly<O>;
  reservation: NonNullable<ReturnType<Admission<T>['reserve']>>;
  pin: { active: () => boolean; release: () => void };
  state: AttemptStatus<T>; generation: number; sent: boolean;
  holder?: { deviceId: string; device: string };
  task?: Promise<AttemptStatus<T>>;
}
class Incomplete extends Error {}
class Cancelled extends Error {}

/** Main-process owner: Task 5 connects transports to this instance, never builds a second one. */
export function createHandoffAttempts<T extends { id: string }, O>(deps: {
  deviceId: string;
  validate?: (context: TransferContext, options: O) => boolean;
  query(id: string): Promise<{ held: boolean; deviceId?: string; device?: string; self?: boolean; source?: 'hub' | 'file' | 'none' }>;
  takeover(id: string, nonce: string): Promise<unknown | null>;
  forceIfHolder?: (id: string, expectedHolderId: string) => Promise<{
    ok: boolean; op: string; sessionId: string; holder: { deviceId: string } | null
  } | null>;
  releaseForced?: (id: string) => Promise<void>;
  sync(): Promise<unknown>;
  confirm(context: TransferContext, pinActive: () => boolean, mayCommit: () => boolean): Promise<FreshnessCheck>;
  pin(id: string): { active: () => boolean; release: () => void } | null;
  project(context: TransferContext): Promise<string | null>;
  savedProject?: (context: TransferContext) => Promise<string | null>;
  start(owner: Owner, context: TransferContext, cwd: string, check: () => void, opts: Readonly<O>): Promise<T>;
  dispose(session: T): Promise<void>;
  admission: Admission<T>;
  delay(ms: number): Promise<void>;
  pollCount?: number;
}) {
  const attempts = new Map<string, Attempt<T, O>>();
  const byConversation = new Map<string, string>();
  const startedPins = new Map<string, { sessionId: string; release: () => void }>();
  // WHY: the separate force confirmation must identify the ORIGINAL holder, not a later lease occupant.
  const snapshot = (a: Attempt<T, O>) => ({ ...a.state,
    ...(a.state.status === 'incomplete' && a.holder ? { holder: { ...a.holder } } : {}) });
  function owned(owner: Owner, id: string): Attempt<T, O> {
    const a = attempts.get(id);
    if (!a || a.owner !== owner) throw new Error('Unknown handoff attempt owner or id.');
    return a;
  }
  const active = (a: Attempt<T, O>, gen: number) => a.generation === gen && a.state.status !== 'cancelled';
  function assertActive(a: Attempt<T, O>, gen: number): void { if (!active(a, gen)) throw new Cancelled(); }
  function finish(a: Attempt<T, O>, status: AttemptStatus<T>): AttemptStatus<T> {
    if (a.state.status === 'cancelled') return snapshot(a);
    a.state = status;
    if (status.status === 'admitted' || status.status === 'failed') {
      a.reservation.release(); byConversation.delete(a.context.sessionId);
      if (status.status === 'failed' && !deps.admission.isUnsafe(a.context.sessionId)) a.pin.release();
    }
    return snapshot(a);
  }
  async function admit(a: Attempt<T, O>, gen: number, source: 'confirmed' | 'saved-copy'): Promise<AttemptStatus<T>> {
    const context = a.context;
    assertActive(a, gen);
    const options = a.options;
    if (!options) return finish(a, { id: a.id, status: 'incomplete', cause: 'create parameters missing' });
    const pin = a.pin;
    try {
      const result = await deps.admission.open(context.sessionId, async () => {
        assertActive(a, gen);
        const project = await (source === 'saved-copy' ? (deps.savedProject ?? deps.project) : deps.project)(context);
        assertActive(a, gen);
        if (!project || !pin.active()) throw new Incomplete('project or pin unavailable');
        if (source === 'confirmed') {
          const check = await deps.confirm(context, pin.active, () => active(a, gen) && pin.active());
          assertActive(a, gen);
          if (check.status !== 'confirmed') throw new Incomplete(check.reason);
        }
        // WHY: import may await I/O; re-resolve rather than starting under a
        // stale project mapping. The pin survives the full asynchronous startup.
        if (await (source === 'saved-copy' ? (deps.savedProject ?? deps.project) : deps.project)(context) !== project)
          throw new Incomplete('project changed');
        assertActive(a, gen);
        let session: T | undefined;
        try {
          session = await deps.start(a.owner, context, project, () => assertActive(a, gen), options);
          assertActive(a, gen);
          return session;
        } catch (error) {
          if (session) {
            try { await deps.dispose(session); }
            catch (cleanupError) {
              deps.admission.protect(context.sessionId);
              throw new Error(`Handoff startup cleanup failed: ${String(cleanupError)}`);
            }
          }
          throw error;
        }
      }, true, a.reservation.token, true);
      if ('status' in result && result.status === 'lease-denied') return finish(a, { id: a.id, status: 'incomplete', cause: 'lease-denied' });
      const session = result as T;
      if (!active(a, gen)) {
        const beforeDispose = deps.admission.endVersion(context.sessionId);
        try { await deps.dispose(session); }
        catch (error) { deps.admission.protect(context.sessionId); throw error; }
        await deps.admission.releaseAbandoned(context.sessionId, beforeDispose);
        throw new Cancelled();
      }
      startedPins.set(session.id, { sessionId: context.sessionId, release: pin.release });
      return finish(a, { id: a.id, status: 'admitted', source, session });
    } catch (error) {
      // WHY: a timed-out generation may finish I/O after its incomplete
      // result was already delivered; it cannot rewrite that result.
      if (!active(a, gen) || error instanceof Cancelled) return snapshot(a);
      if (error instanceof Incomplete) return finish(a, { id: a.id, status: 'incomplete', cause: error.message });
      return finish(a, { id: a.id, status: 'failed', cause: String(error) });
    } finally {
      // WHY: failed disposal may leave a writer behind. Preserve the destination
      // fence alongside admission's unsafe hold until a proven stop clears it.
      if (deps.admission.isUnsafe(context.sessionId))
        startedPins.set(context.sessionId, { sessionId: context.sessionId, release: pin.release });
    }
  }
  async function poll(a: Attempt<T, O>, gen: number): Promise<AttemptStatus<T>> {
    try {
      assertActive(a, gen);
      if (!a.sent) {
        // WHY: an unavailable first query cannot establish a sender. Retry
        // discovers the holder using the same nonce, only before any send;
        // after sending, changing identity could accept a different writer.
        if (!a.context.senderDeviceId) {
          const q = await deps.query(a.context.sessionId).catch(() => null);
          assertActive(a, gen);
          if (!q?.held || q.self || q.source === 'file' || !q.deviceId || q.deviceId === deps.deviceId)
            return finish(a, { id: a.id, status: 'incomplete', cause: 'no distinct verified sender' });
          a.context = Object.freeze({ ...a.context, senderDeviceId: q.deviceId });
          a.holder = { deviceId: q.deviceId, device: q.device ?? '' };
        }
        a.sent = true; // null may be a LOST acknowledgment, never resend on retry.
        await deps.takeover(a.context.sessionId, a.context.transferNonce).catch(() => null);
      }
      assertActive(a, gen);
      const deadline = Date.now() + 25_000;
      for (let n = 0; n < (deps.pollCount ?? 25) && Date.now() < deadline; n++) {
        // Pull completion is NOT evidence; only Task 2's runtime-local receipt is.
        await deps.sync().catch(() => {});
        assertActive(a, gen);
        // The sender can still hold the lease while its receipt is in flight.
        // Do not interpret a held lease or a successful pull as a fresh snapshot.
        const q = await deps.query(a.context.sessionId).catch(() => null);
        assertActive(a, gen);
        if (q?.held && !q.self) {
          if (q.deviceId && q.deviceId !== a.context.senderDeviceId)
            return finish(a, { id: a.id, status: 'incomplete', cause: 'holder changed' });
          if (n + 1 < (deps.pollCount ?? 25)) { await deps.delay(1_000); assertActive(a, gen); }
          continue;
        }
        const result = await admit(a, gen, 'confirmed');
        if (result.status === 'admitted' || result.status === 'failed' || result.status === 'cancelled' || result.cause === 'lease-denied') return result;
        if (n + 1 < (deps.pollCount ?? 25)) { await deps.delay(1_000); assertActive(a, gen); }
      }
      return finish(a, { id: a.id, status: 'incomplete', cause: 'receipt not confirmed' });
    } catch (error) {
      return !active(a, gen) || error instanceof Cancelled ? snapshot(a) : finish(a, { id: a.id, status: 'failed', cause: String(error) });
    }
  }
  function run(a: Attempt<T, O>, work: (gen: number) => Promise<AttemptStatus<T>>, timed = false): Promise<AttemptStatus<T>> {
    const gen = ++a.generation;
    a.state = { id: a.id, status: 'waiting' };
    // WHY: sync/query can hang past the deadline. Return an incomplete result
    // promptly but keep the reservation and destination pin while the old I/O
    // drains; generation checks forbid its late continuation from importing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = work(gen);
    const task = timed ? Promise.race([operation, new Promise<AttemptStatus<T>>(resolve => {
      timer = setTimeout(() => {
        if (active(a, gen)) { a.generation++; resolve(finish(a, { id: a.id, status: 'incomplete', cause: 'receipt not confirmed' })); }
        else resolve(snapshot(a));
      }, 25_000);
    })]) : operation;
    a.task = task;
    void operation.then(() => {
      if (timer) clearTimeout(timer);
      if (a.task === task) a.task = undefined;
      if (a.state.status === 'cancelled') {
        a.reservation.release(); byConversation.delete(a.context.sessionId);
        if (!deps.admission.isUnsafe(a.context.sessionId)) a.pin.release();
      }
    }, () => { if (timer) clearTimeout(timer); if (a.task === task) a.task = undefined; });
    return task;
  }
  return {
    begin(owner: Owner, sessionId: string, provider: TransferContext['provider'], options?: O) {
      if (!owner || (options !== undefined && (!options || typeof options !== 'object')) ||
          (provider !== 'native' && provider !== 'claude') || !sessionId)
        throw new Error('Invalid handoff parameters.');
      const existing = attempts.get(byConversation.get(sessionId) ?? '');
      // WHY: a lost begin reply leaves the renderer without this id. The SAME
      // owner asking again adopts its original attempt (and nonce) instead of
      // colliding with it forever; any other owner is still refused.
      if (existing && existing.owner === owner && existing.state.status !== 'cancelled') return snapshot(existing);
      if (byConversation.has(sessionId)) throw new Error('Conversation already has a pending handoff.');
      const nonce = randomUUID();
      const proposed: TransferContext = { transferNonce: nonce, sessionId, provider, requesterDeviceId: deps.deviceId, senderDeviceId: 'pending' };
      if (!parseHandoffReceipt({ ...proposed, v: 1, byteLength: 1, sha256: '0'.repeat(64) }) ||
          (options && deps.validate && !deps.validate(proposed, options))) throw new Error('Invalid handoff create parameters.');
      // WHY: user-selected model/binding may arrive while waiting; capture the
      // create request once rather than reading a mutable renderer-owned object.
      // Clone BEFORE reserving: an uncloneable payload must not leak admission.
      const frozenOptions = options === undefined ? undefined : structuredClone(options);
      if (frozenOptions) {
        for (const value of Object.values(frozenOptions)) if (value && typeof value === 'object') Object.freeze(value);
        Object.freeze(frozenOptions);
      }
      const reservation = deps.admission.reserve(sessionId);
      if (!reservation) throw new Error('Conversation already opening or unsafe.');
      // WHY: ordinary materialization must stay fenced while we wait for the
      // sender, including across incomplete/retry and saved-copy selection.
      const pin = deps.pin(sessionId);
      if (!pin) { reservation.release(); throw new Error('Destination is already pinned.'); }
      const id = randomUUID();
      const a: Attempt<T, O> = { id, owner, options: frozenOptions, pin,
        context: { ...proposed, senderDeviceId: '' },
        reservation, state: { id, status: 'waiting' }, generation: 0, sent: false };
      attempts.set(id, a); byConversation.set(sessionId, id);
      // WHY: terminal replay is useful to a returning tab, not an unbounded
      // ledger. Never evict an active attempt or one whose cleanup is in flight.
      if (attempts.size > 256) for (const [oldId, old] of attempts) {
        if (attempts.size <= 256) break;
        if (oldId !== id && !old.task && (old.state.status === 'cancelled' ||
            old.state.status === 'admitted' || old.state.status === 'failed')) attempts.delete(oldId);
      }
      // WHY: query the ACTUAL holder install ID before sending any request.
      // Neither a hostname nor the current free lease is a final snapshot.
      void run(a, async (gen) => {
        try {
          const q = await deps.query(sessionId);
          assertActive(a, gen);
          const context = { ...a.context, senderDeviceId: q.deviceId ?? '' };
          if (!q.held || q.self || q.source === 'file' || !parseHandoffReceipt({ ...context, v: 1, byteLength: 1, sha256: '0'.repeat(64) }))
            return finish(a, { id, status: 'incomplete', cause: 'no distinct verified sender' });
          a.context = Object.freeze(context);
          a.holder = { deviceId: q.deviceId!, device: q.device ?? '' };
          return poll(a, gen);
        } catch (error) { return !active(a, gen) || error instanceof Cancelled ? snapshot(a) : finish(a, { id, status: 'incomplete', cause: 'lease query unavailable' }); }
      }, true);
      return { id, status: 'waiting' as const };
    },
    setCreateParams(owner: Owner, id: string, options: O) {
      const a = owned(owner, id);
      if (a.state.status !== 'incomplete' || a.task || a.options || !options || typeof options !== 'object' ||
          (deps.validate && !deps.validate(a.context, options))) throw new Error('Stale handoff create parameters.');
      const copied = structuredClone(options);
      for (const value of Object.values(copied)) if (value && typeof value === 'object') Object.freeze(value);
      a.options = Object.freeze(copied);
      return snapshot(a);
    },
    status(owner: Owner, id: string) { return snapshot(owned(owner, id)); },
    context(owner: Owner, id: string) { return { ...owned(owner, id).context }; },
    wait(owner: Owner, id: string) { const a = owned(owner, id); return a.task ?? Promise.resolve(snapshot(a)); },
    async retry(owner: Owner, id: string) {
      const a = owned(owner, id);
      if (a.state.status !== 'incomplete' || a.task) throw new Error('Stale handoff action.');
      return run(a, gen => poll(a, gen), true);
    },
    async savedCopy(owner: Owner, id: string, consent: boolean) {
      const a = owned(owner, id);
      if (!consent || a.state.status !== 'incomplete' || a.task) throw new Error('Stale handoff action or consent missing.');
      return run(a, gen => admit(a, gen, 'saved-copy'));
    },
    async force(owner: Owner, id: string, consent: boolean, expectedHolderId: string) {
      const a = owned(owner, id);
      if (consent !== true || a.state.status !== 'incomplete' || a.task ||
          !a.options || !a.holder || !expectedHolderId || a.holder.deviceId !== expectedHolderId)
        throw new Error('Stale handoff force action or separate holder consent missing.');
      return run(a, async (gen) => {
        let granted = false;
        let enteringAdmission = false;
        try {
          // WHY: a query alone is never authority to force; the Worker compares
          // this ORIGINAL holder atomically with the lease it overwrites.
          if (!deps.forceIfHolder || !deps.releaseForced)
            return finish(a, { id, status: 'incomplete', cause: 'conditional force unavailable' });
          const q = await deps.query(a.context.sessionId);
          assertActive(a, gen);
          if (!q.held || q.self || q.source !== 'hub' || q.deviceId !== expectedHolderId)
            return finish(a, { id, status: 'incomplete', cause: 'holder changed or unavailable' });
          const result = await deps.forceIfHolder(a.context.sessionId, expectedHolderId);
          if (result?.ok !== true || result.op !== 'force-acquire-if-holder' ||
              result.sessionId !== a.context.sessionId || result.holder?.deviceId !== deps.deviceId)
            return finish(a, { id, status: 'incomplete', cause: 'conditional force not confirmed' });
          granted = true;
          assertActive(a, gen);
          enteringAdmission = true;
          // This is saved local history, NEVER a freshness receipt. The same
          // reservation, pin, strict lease re-acquire and startup check apply.
          return await admit(a, gen, 'saved-copy');
        } catch (error) {
          return !active(a, gen) || error instanceof Cancelled ? snapshot(a)
            : finish(a, { id, status: 'incomplete', cause: 'conditional force unavailable' });
        } finally {
          // A cancelled attempt after the hub grant but before admission must
          // release its acquired lease; no writer was started and no heartbeat exists.
          if (granted && !enteringAdmission && deps.releaseForced)
            await deps.releaseForced(a.context.sessionId).catch(() => {});
        }
      });
    },
    cancel(owner: Owner, id: string) {
      const a = owned(owner, id);
      if (a.state.status === 'admitted' || a.state.status === 'failed' || a.state.status === 'cancelled') throw new Error('Stale handoff action.');
      a.generation++; a.state = { id, status: 'cancelled' };
      if (!a.task) {
        a.reservation.release(); byConversation.delete(a.context.sessionId);
        if (!deps.admission.isUnsafe(a.context.sessionId)) a.pin.release();
      }
      return snapshot(a);
    },
    hasSession(sessionId: string) { return startedPins.has(sessionId); },
    ended(sessionId: string) {
      // WHY: call only on proven stop. session-exit from ordinary destroy
      // fires before its worker is even asked to kill the PTY.
      const pin = startedPins.get(sessionId);
      if (pin) { startedPins.delete(sessionId); pin.release(); }
    },
    cancelOwner(owner: Owner) {
      for (const a of attempts.values()) if (a.owner === owner && (a.state.status === 'waiting' || a.state.status === 'incomplete')) this.cancel(owner, a.id);
    },
  };
}
