import { createHash, randomUUID } from 'node:crypto';
import type { QueueAlias, QueueAttempt, QueueCheckout, QueueClaim, QueueClaimInput, QueueEnqueueResult, QueueItem, QueueJournal, QueuePayload, QueueStorage, QueueTombstone } from '../shared/conversation-queue-types';
import { ClaudeQueueStore, canRetireQueue, validateQueueJournal, validateQueuePayload } from './claude-queue-store';

export interface ClaudeQueueOptions {
  storage: QueueStorage;
  publish?: (snapshot: QueueJournal) => void;
  now?: () => number;
  /** Synchronous authoritative readiness only; transport waits MUST happen outside this service. */
  ready?: (queueId: string, input: QueueClaimInput) => boolean;
  maxItems?: number;
  maxTombstones?: number;
  /** Cancelled checkouts kept per send epoch (default and ceiling 1024). WHY an option: a test that fills the real 1,024 took ~27 s. */
  maxCheckouts?: number;
}
// Worst-case JSON escaping for two replacement alias copies and a new live incarnation (256 UTF-16 units each).
const CLEAR_RESERVATION_BYTES = 8192;
const sameAlias = (a: QueueAlias, b: QueueAlias) => a.provider === b.provider && a.conversationId === b.conversationId;
const fingerprint = (p: QueuePayload) => createHash('sha256').update(JSON.stringify([p.sendEpoch, p.sendId, p.originalText, p.attachments, p.displayContent])).digest('hex');
const identity = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const sameCheckout = (a: QueueCheckout, b: QueueCheckout) => a.checkoutId === b.checkoutId && a.sessionId === b.sessionId && a.draftRevision === b.draftRevision && a.sendEpoch === b.sendEpoch;
function validateCheckout(c: QueueCheckout): void {
  if (!c || !identity(c.checkoutId) || !identity(c.sessionId) || !Number.isSafeInteger(c.draftRevision) || c.draftRevision < 0) throw Error('Invalid checkout');
}
function validAlias(a: QueueAlias): void { if (!a || a.provider !== 'claude' || !identity(a.conversationId)) throw Error('Invalid queue alias'); }
function attemptMatches(a: QueueAttempt, b: QueueAttempt): boolean {
  return a.attemptId === b.attemptId && a.queueItemId === b.queueItemId && a.sendId === b.sendId && sameAlias(a.alias, b.alias)
    && a.incarnation === b.incarnation && a.boundaryId === b.boundaryId && a.boundarySeq === b.boundarySeq && a.wireHash === b.wireHash && a.createdAt === b.createdAt;
}

/** Pure host journal state machine. It grants durable tokens, never calls a model, worker or UI. */
export class ClaudeQueue {
  private records = new Map<string, QueueJournal>();
  private restored = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly maxItems: number;
  private readonly maxTombstones: number;
  private readonly maxCheckouts: number;
  constructor(private readonly options: ClaudeQueueOptions) {
    this.maxItems = Math.max(1, Math.min(64, options.maxItems ?? 64));
    this.maxTombstones = Math.max(1, Math.min(1024, options.maxTombstones ?? 1024));
    this.maxCheckouts = Math.max(1, Math.min(1024, options.maxCheckouts ?? 1024));
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    // WHY instance-owned short transitions also serialize alias binding across queues. There is
    // deliberately NO delivery callback here: Clear/receipts cannot queue behind a held fence.
    const next = this.chain.then(fn, fn); this.chain = next.catch(() => {}); return next;
  }
  private get(id: string): QueueJournal {
    if (!this.restored) throw Error('Queue service has not restored');
    const r = this.records.get(id); if (!r) throw Error('Unknown queue'); return r;
  }
  snapshot(id: string): QueueJournal { return structuredClone(this.get(id)); }
  /** Adapter gate for ALL automated body/Enter/command writes, not merely queue dequeue. */
  hasWriteBarrier(id: string): boolean {
    const r = this.get(id);
    return this.unresolved(r) || !!(r.clear && r.clear.phase !== 'rebound');
  }
  private publish(r: QueueJournal): void {
    // A screen failure after commit must not turn a durable operation into an invitation to resend.
    try { this.options.publish?.(structuredClone(r)); } catch { /* snapshot remains readable */ }
  }
  private async commit(r: QueueJournal, previous: number | null): Promise<void> {
    r.revision = previous === null ? 0 : previous + 1;
    const validated = validateQueueJournal(r);
    const reservedBytes = validated.clear?.phase === 'executing' ? CLEAR_RESERVATION_BYTES : 0;
    if (Buffer.byteLength(JSON.stringify(validated), 'utf8') + reservedBytes > ClaudeQueueStore.MAX_BYTES) throw Error('Queue journal exceeds storage bounds or Clear reservation');
    await this.options.storage.save(structuredClone(validated), previous);
    this.records.set(r.queueId, validated); this.publish(validated);
  }
  private transition<T>(id: string, change: (r: QueueJournal) => T | Promise<T>): Promise<T> {
    return this.serial(async () => {
      const previous = this.get(id); const next = structuredClone(previous); const result = await change(next);
      // Null is claim's explicit no-transition verdict (stale fence, paused, no eligible work).
      if (result !== null) await this.commit(next, previous.revision);
      return structuredClone(result);
    });
  }
  async restore(): Promise<void> {
    return this.serial(async () => {
      if (this.restored) throw Error('Queue service already restored');
      const loaded = (await this.options.storage.load()).map(validateQueueJournal);
      if (loaded.length > ClaudeQueueStore.MAX_QUEUES) throw Error('Queue registry full');
      const keys = new Set<string>(); const ids = new Set<string>();
      for (const r of loaded) {
        if (ids.has(r.queueId)) throw Error('Duplicate queue identity'); ids.add(r.queueId);
        for (const a of r.aliases) { const key = JSON.stringify(a); if (keys.has(key)) throw Error('Duplicate queue alias'); keys.add(key); }
      }
      // WHY restore all records before exposing ANY snapshot. A partial/failed load cannot
      // masquerade as an empty runnable queue. Writes are conservative even if a later one fails.
      const recovered = new Map<string, QueueJournal>();
      for (const old of loaded) {
        const r = structuredClone(old); r.live = null; r.paused = true; r.boundaryHighWater = 0;
        for (const i of r.items) {
          delete i.immediate; delete i.pauseBypass; // reload never preserves a transient readiness grant
          if (i.status === 'delivering' || i.status === 'uncertain') this.quarantine(r, i);
        }
        r.revision++;
        await this.options.storage.save(r, old.revision);
        if (canRetireQueue(r)) await this.options.storage.retire(r.queueId, r.revision);
        else recovered.set(r.queueId, r);
      }
      this.records = recovered; this.restored = true;
      for (const r of recovered.values()) this.publish(r);
    });
  }
  bind(alias: QueueAlias, incarnation: string): Promise<string> {
    return this.serial(async () => {
      if (!this.restored) throw Error('Queue service has not restored'); validAlias(alias);
      if (!identity(incarnation)) throw Error('Invalid live incarnation');
      const old = [...this.records.values()].find(r => r.aliases.some(a => sameAlias(a, alias)));
      if (old) {
        // Historical aliases route receipts only. They never grant a live binding to a different conversation.
        if (!sameAlias(old.alias, alias)) throw Error('Cannot bind a historical conversation alias');
        if (old.live && old.live.incarnation !== incarnation) throw Error('Queue already bound to another live incarnation');
        if (old.live) return old.queueId;
        const r = structuredClone(old); r.live = { incarnation }; r.boundaryHighWater = 0;
        await this.commit(r, old.revision); return r.queueId;
      }
      if (this.records.size >= ClaudeQueueStore.MAX_QUEUES) throw Error('Queue registry full');
      const r: QueueJournal = { version: 2, sendEpoch: randomUUID(), queueId: randomUUID(), revision: 0, alias: structuredClone(alias), aliases: [structuredClone(alias)], live: { incarnation }, paused: false, items: [], tombstones: [], cancelledCheckouts: [], boundaryHighWater: 0, quarantines: [], clear: null };
      r.legacyCheckoutEpoch = r.sendEpoch;
      await this.commit(r, null); return r.queueId;
    });
  }
  async enqueue(id: string, input: QueuePayload, prepare?: (payload: QueuePayload) => Promise<string[]>, immediate = false): Promise<QueueEnqueueResult> {
    // Copy at call time: renderer/caller mutation while IO is queued cannot change accepted bytes.
    const p = validateQueuePayload(input);
    return this.transition(id, async r => {
      if (p.sendEpoch !== r.sendEpoch) throw Error('Stale send epoch; do not replay this request with a new epoch');
      const existing = r.items.find(i => i.sendId === p.sendId); const tomb = r.tombstones.find(i => i.sendId === p.sendId);
      if (existing || tomb) {
        if ((existing ? fingerprint(existing) : tomb!.fingerprint) !== fingerprint(p)) throw Error('Send ID already used for different payload');
        return { duplicate: true, item: existing ?? tomb! };
      }
      // Reserve one tombstone slot for every active item. Never silently evict a dedup identity.
      if (r.items.length + r.tombstones.length >= this.maxTombstones) throw Error('Queue identity history full');
      if (r.items.length >= this.maxItems) throw Error('Queue full');
      // WHY: reserve validation/capacity before copying expiring files. Duplicate/stale/full requests create no cache entries.
      const reservedBytes=Buffer.byteLength(JSON.stringify(r),'utf8')+Buffer.byteLength(JSON.stringify(p),'utf8')+p.attachments.length*8192+16384;
      if(prepare&&reservedBytes>ClaudeQueueStore.MAX_BYTES)throw Error('Queue attachment reservation exceeds storage bounds');
      if(prepare)p.preparedAttachments=await prepare(structuredClone(p));
      const item: QueueItem = { ...p, queueItemId: randomUUID(), timestamp: (this.options.now ?? Date.now)(), status: 'waiting' };
      // WHY: pause belongs to the OLD intent, not every future conversation cycle.
      // New deliberate messages after resolution have independent eligibility, in FIFO order;
      // never promote a burst in LIFO order or auto-flush the old paused waiting items.
      if (!r.quarantines.length && !r.items.some(i => i.status === 'uncertain' && !i.attempt?.receipt) && !this.hasPendingClear(r)) {
        if (r.paused) item.pauseBypass = true;
        if (immediate && !r.items.some(i => !r.paused || i.pauseBypass)) item.immediate = true;
        if (!r.items.length && immediate) r.paused = false;
      }
      r.items.push(item);
      return { duplicate: false, item };
    });
  }
  rotateSendEpoch(id: string, expectedEpoch: string): Promise<string> {
    return this.transition(id, r => {
      if (r.sendEpoch !== expectedEpoch) throw Error('Stale send epoch');
      if (r.items.length || this.hasPendingClear(r) || r.quarantines.length) throw Error('Cannot rotate epoch with active or recoverable data');
      // WHY explicit new-request epoch: bounded dedup can reset without ever admitting an old request.
      r.sendEpoch = randomUUID(); r.tombstones = []; r.cancelledCheckouts = []; this.compactAliases(r);
      return r.sendEpoch;
    });
  }
  private hasPendingClear(r: QueueJournal): boolean { return !!r.clear && r.clear.phase !== 'rebound'; }
  private requiredAliases(r: QueueJournal, current = r.alias): QueueAlias[] {
    const aliases = [structuredClone(current)];
    for (const i of r.items) if (i.attempt && !aliases.some(a => sameAlias(a, i.attempt!.alias))) aliases.push(structuredClone(i.attempt.alias));
    return aliases;
  }
  private compactAliases(r: QueueJournal): void {
    // Retired receipt/tombstone aliases are self-contained; only current/unresolved item associations route lookup.
    r.aliases = this.requiredAliases(r);
  }
  private waiting(r: QueueJournal, itemId: string): QueueItem {
    const i = r.items.find(i => i.queueItemId === itemId);
    if (!i || i.status !== 'waiting') throw Error('Item is no longer waiting'); return i;
  }
  private retire(r: QueueJournal, i: QueueItem, reason: QueueTombstone['reason'], transcriptUuid?: string): void {
    r.items.splice(r.items.indexOf(i), 1);
    r.tombstones.push({ sendEpoch: i.sendEpoch, sendId: i.sendId, queueItemId: i.queueItemId, fingerprint: fingerprint(i), reason,
      ...(i.checkout ? { checkout: i.checkout } : {}), ...(i.attempt ? { attempt: this.attemptIdentity(i.attempt) } : {}), ...(transcriptUuid ? { transcriptUuid } : {}), ...(i.attempt?.receipt ? { nativeReceipt: i.attempt.receipt } : {}), ...(i.attempt?.admission ? { nativeAdmission: i.attempt.admission } : {}) });
    if (i.attempt) r.quarantines = r.quarantines.filter(a => a !== i.attempt!.attemptId);
  }
  remove(id: string, itemId: string): Promise<QueueItem> {
    return this.transition(id, r => { const i = this.waiting(r, itemId); if (i.checkout) throw Error('Item reserved for checkout'); this.retire(r, i, 'removed'); return i; });
  }
  /** Called only AFTER native abandonment and worker invalidation acknowledge the exact attempt. */
  dismiss(id: string, attempt: QueueAttempt): Promise<void> {
    const a = structuredClone(attempt);
    return this.transition(id, r => {
      if (r.tombstones.some(t => (t.reason === 'dismissed' || t.reason === 'confirmed') && t.attempt && attemptMatches(t.attempt, a))) return;
      const i = this.attempted(r, a);
      if (i.status !== 'uncertain') throw Error('Only unconfirmed delivery can be dismissed');
      this.retire(r, i, 'dismissed');
      for (const waiting of r.items) { delete waiting.pauseBypass; delete waiting.immediate; }
      // WHY: keep pre-existing waiting intent paused, but do not poison future queue cycles.
      if (!r.items.length && !this.hasPendingClear(r)) r.paused = false;
    });
  }
  checkout(id: string, itemId: string, editor: QueueCheckout): Promise<QueueItem> {
    validateCheckout(editor); const token = structuredClone(editor);
    return this.transition(id, r => {
      if ((token.sendEpoch !== undefined && token.sendEpoch !== r.sendEpoch) || (token.sendEpoch === undefined && r.legacyCheckoutEpoch !== r.sendEpoch)) throw Error('Stale or missing checkout epoch');
      if (r.cancelledCheckouts.some(t => t.checkoutId === token.checkoutId)) throw Error('Checkout was cancelled');
      const i = this.waiting(r, itemId);
      if (i.checkout && !sameCheckout(i.checkout, token)) throw Error('Item already reserved for another checkout');
      if ([...r.items, ...r.tombstones].some(x => x.queueItemId !== itemId && x.checkout?.checkoutId === token.checkoutId)) throw Error('Checkout ID already used');
      // Reserve cancellation history before granting ownership; never forget an old
      // terminal token and then let its delayed checkout reserve the item again.
      if (!i.checkout && r.cancelledCheckouts.length + r.items.filter(x => x.checkout).length >= this.maxCheckouts) throw Error('Checkout history full in this epoch');
      i.checkout = token; return i;
    });
  }
  ackCheckout(id: string, editor: QueueCheckout): Promise<void> {
    validateCheckout(editor); const token = structuredClone(editor);
    return this.transition(id, r => {
      if (r.tombstones.some(t => t.reason === 'edited' && t.checkout && sameCheckout(t.checkout, token))) return;
      const i = r.items.find(i => i.checkout && sameCheckout(i.checkout, token));
      if (!i || i.status !== 'waiting') throw Error('Invalid checkout acknowledgement'); this.retire(r, i, 'edited');
    });
  }
  cancelCheckout(id: string, editor: QueueCheckout): Promise<void> {
    validateCheckout(editor); const token = structuredClone(editor);
    return this.transition(id, r => {
      if (token.sendEpoch !== undefined && token.sendEpoch !== r.sendEpoch) throw Error('Stale checkout epoch');
      const terminal = r.cancelledCheckouts.find(t => t.checkoutId === token.checkoutId);
      if (terminal) { if (!sameCheckout(terminal, token)) throw Error('Conflicting checkout cancellation'); return; }
      if (r.tombstones.some(t => t.checkout && sameCheckout(t.checkout, token))) return; // already transferred; release nothing
      const owner = r.items.find(i => i.checkout?.checkoutId === token.checkoutId);
      if (owner) {
        if (!owner.checkout || !sameCheckout(owner.checkout, token)) throw Error('Invalid checkout cancellation');
        delete owner.checkout; r.cancelledCheckouts.push(token); return;
      }
      // A stale/unknown cancel is a safe terminal no-op, never permission to clear
      // somebody else's checkout. New grants always check epoch and cancelled IDs.
      if (token.sendEpoch === undefined && r.legacyCheckoutEpoch !== r.sendEpoch) return;
      if (r.cancelledCheckouts.length + r.items.filter(i => i.checkout).length >= this.maxCheckouts) throw Error('Checkout history full in this epoch');
      r.cancelledCheckouts.push(token); // fences a reordered late checkout in this epoch
    });
  }
  private live(r: QueueJournal, incarnation: string): void {
    if (!r.live || r.live.incarnation !== incarnation) throw Error('Stale live incarnation');
  }
  resume(id: string, incarnation: string): Promise<void> {
    return this.transition(id, r => { this.live(r, incarnation); if (r.clear && r.clear.phase !== 'rebound') throw Error('Clear is still frozen');
      if (r.quarantines.length) throw Error('Composer quarantine remains unresolved'); r.paused = false; });
  }
  prioritize(id: string, itemId: string, incarnation: string, active = false): Promise<{ interrupt: boolean }> {
    return this.transition(id, r => {
      this.live(r, incarnation); if (r.clear && r.clear.phase !== 'rebound') throw Error('Clear is still frozen');
      if (r.quarantines.length) throw Error('Composer quarantine remains unresolved');
      const i = this.waiting(r, itemId); if (i.checkout) throw Error('Item reserved for checkout');
      r.items.splice(r.items.indexOf(i), 1); r.items.unshift(i); r.paused = false;
      return { interrupt: active }; // intent for a future adapter, not an Escape side effect
    });
  }
  claim(id: string, input: QueueClaimInput): Promise<QueueClaim | null> {
    const token = structuredClone(input);
    return this.transition(id, r => {
      validAlias(token.alias);
      if (!identity(token.boundaryId) || !Number.isSafeInteger(token.boundarySeq) || token.boundarySeq < 1 || !/^[a-f0-9]{64}$/.test(token.wireHash)) throw Error('Invalid claim token');
      const head = r.items.find(i => i.status === 'waiting' && (!r.paused || i.pauseBypass));
      if ((r.paused && !head?.pauseBypass) || r.quarantines.length > 0 || !r.live || r.live.incarnation !== token.incarnation || !sameAlias(r.alias, token.alias)
        || token.boundarySeq <= r.boundaryHighWater
        || r.items.some(i => i.status === 'delivering') || this.options.ready?.(id, structuredClone(token)) !== true) return null;
      // Quarantined attempts keep their original evidence but are never replayed. New waiting
      // intent may proceed only through a fresh authoritative readiness token after Stop.
      const i = head; if (!i || i.checkout) return null;
      // File preparation awaits outside this chain. Never attach one head's wire/hash to a newly prioritized head.
      if (token.expectedItemId !== undefined && token.expectedItemId !== i.queueItemId) return null;
      const attempt: QueueAttempt = { attemptId: randomUUID(), queueItemId: i.queueItemId, sendId: i.sendId, alias: structuredClone(r.alias), incarnation: token.incarnation, boundaryId: token.boundaryId, boundarySeq: token.boundarySeq, wireHash: token.wireHash, createdAt: (this.options.now ?? Date.now)() };
      i.attempt = attempt; i.status = 'delivering'; r.boundaryHighWater = token.boundarySeq;
      return { item: i, attempt }; // not observable to transport until commit resolves
    });
  }
  /** Final state/readiness check for a future revocable adapter; NOT proof a native fence is held. */
  isCurrentClaim(id: string, attempt: QueueAttempt): boolean {
    const r = this.get(id); const i = r.items.find(i => i.queueItemId === attempt.queueItemId);
    if ((r.paused && !i?.pauseBypass) || r.quarantines.length > 0 || !r.live || r.live.incarnation !== attempt.incarnation || !sameAlias(r.alias, attempt.alias)
      || i?.status !== 'delivering' || !i.attempt || i.attempt.receipt || !attemptMatches(i.attempt, attempt)) return false;
    try { return this.options.ready?.(id, { boundaryId: attempt.boundaryId, boundarySeq: attempt.boundarySeq, incarnation: attempt.incarnation, alias: structuredClone(attempt.alias), wireHash: attempt.wireHash }) === true; }
    catch { return false; }
  }
  private attemptIdentity(a: QueueAttempt): QueueAttempt {
    return { attemptId: a.attemptId, queueItemId: a.queueItemId, sendId: a.sendId, alias: structuredClone(a.alias), incarnation: a.incarnation, boundaryId: a.boundaryId, boundarySeq: a.boundarySeq, wireHash: a.wireHash, createdAt: a.createdAt };
  }
  private attempted(r: QueueJournal, a: QueueAttempt): QueueItem {
    const i = r.items.find(i => i.queueItemId === a.queueItemId);
    if (!i?.attempt || !attemptMatches(i.attempt, a)) throw Error('Invalid or obsolete attempt'); return i;
  }
  admit(id: string, attempt: QueueAttempt, admission: string): Promise<void> {
    const a = structuredClone(attempt); if (!identity(admission)) throw Error('Invalid native admission');
    return this.transition(id, r => {
      const tomb = r.tombstones.find(t => t.attempt && attemptMatches(t.attempt, a));
      if (tomb) { if (tomb.nativeAdmission && tomb.nativeAdmission !== admission) throw Error('Conflicting native admission'); tomb.nativeAdmission = admission; return; }
      const i = this.attempted(r, a);
      if (i.attempt!.admission && i.attempt!.admission !== admission) throw Error('Conflicting native admission');
      i.attempt!.admission = admission; // native CAS won, but next(e) has NOT necessarily succeeded
    });
  }
  accept(id: string, attempt: QueueAttempt, receipt: string): Promise<void> {
    const a = structuredClone(attempt); if (!identity(receipt)) throw Error('Invalid native receipt');
    return this.transition(id, r => {
      const tomb = r.tombstones.find(t => t.attempt && attemptMatches(t.attempt, a));
      if (tomb) {
        if (tomb.nativeReceipt && tomb.nativeReceipt !== receipt) throw Error('Conflicting native receipt');
        tomb.nativeReceipt = receipt; return;
      }
      const i = this.attempted(r, a);
      if (i.attempt!.receipt && i.attempt!.receipt !== receipt) throw Error('Conflicting native receipt');
      i.attempt!.receipt = receipt; // full native acceptance is distinct from admission and transcript evidence
      i.status = 'uncertain'; // receipt retained for transcript reconciliation, no longer an active dispatch lock
      r.quarantines = r.quarantines.filter(id => id !== a.attemptId); // matching accepted input is no longer staged in composer
    });
  }
  confirm(id: string, attempt: QueueAttempt, transcriptUuid: string): Promise<void> {
    const a = structuredClone(attempt); if (!identity(transcriptUuid)) throw Error('Invalid transcript identity');
    return this.transition(id, r => {
      const tomb = r.tombstones.find(t => t.attempt && attemptMatches(t.attempt, a));
      if (tomb) { if (tomb.reason === 'dismissed') return; if (tomb.transcriptUuid !== transcriptUuid) throw Error('Conflicting transcript identity'); return; }
      const i = this.attempted(r, a); this.retire(r, i, 'confirmed', transcriptUuid);
    });
  }
  notSent(id: string, attempt: QueueAttempt): Promise<void> {
    const a = structuredClone(attempt);
    return this.transition(id, r => {
      const i = this.attempted(r, a); this.live(r, a.incarnation);
      if (i.status !== 'delivering' || i.attempt?.admission || i.attempt?.receipt || (r.clear && r.clear.phase !== 'rebound') || !sameAlias(r.alias, a.alias)) throw Error('Claim cannot be retried');
      i.status = 'waiting'; delete i.immediate; delete i.attempt; // caller must prove NO writes/effect, not merely a timeout
    });
  }
  private quarantine(r: QueueJournal, i: QueueItem): void {
    i.status = 'uncertain';
    if (i.attempt && !i.attempt.receipt && !r.quarantines.includes(i.attempt.attemptId)) r.quarantines.push(i.attempt.attemptId);
  }
  uncertain(id: string, attempt: QueueAttempt): Promise<void> {
    const a = structuredClone(attempt); return this.transition(id, r => {
      if (r.tombstones.some(t => t.reason === 'dismissed' && t.attempt && attemptMatches(t.attempt, a))) return;
      const i = this.attempted(r, a); this.quarantine(r, i); r.paused = true;
    });
  }
  /** Only a future adapter's definitive native pre-admission revocation + clean composer evidence may release this barrier. */
  revokeBeforeAdmission(id: string, attempt: QueueAttempt, evidence: { revocationId: string; composerEmpty: true }): Promise<void> {
    const a = structuredClone(attempt);
    if (!evidence || !identity(evidence.revocationId) || evidence.composerEmpty !== true) throw Error('Invalid revocation evidence');
    return this.transition(id, r => {
      const i = this.attempted(r, a);
      if (i.attempt!.admission || i.attempt!.receipt) throw Error('Native admission already won');
      r.quarantines = r.quarantines.filter(id => id !== a.attemptId);
      i.status = 'waiting'; delete i.immediate; delete i.pauseBypass; delete i.attempt; // leave paused/frozen; this is not automatic replay
    });
  }
  /** Trusted native terminal proof: CAS admitted, but this exact handler NEVER invoked next(e). */
  resolveNotInvoked(id: string, attempt: QueueAttempt, evidence: { notInvokedId: string; composerEmpty: true }): Promise<void> {
    const a = structuredClone(attempt);
    if (!evidence || evidence.composerEmpty !== true || evidence.notInvokedId !== a.attemptId) throw Error('Invalid not-invoked proof');
    return this.transition(id,r => {
      const i = this.attempted(r,a); if (i.attempt!.receipt) throw Error('Native acceptance already observed');
      r.quarantines = r.quarantines.filter(id => id !== a.attemptId);
      i.status = 'waiting'; delete i.immediate; delete i.pauseBypass; delete i.attempt; // preserve pause; explicit resolution is never permission to replay automatically
      r.paused = true;
    });
  }
  private unresolved(r: QueueJournal): boolean {
    return r.quarantines.length > 0 || r.items.some(i => i.attempt && !i.attempt.receipt);
  }
  /** Durable authorization gate BEFORE the actual Clear command, not just before remapping its result. */
  beginClear(id: string, clearId: string): Promise<void> {
    return this.transition(id, r => {
      if (!r.clear || r.clear.clearId !== clearId || r.clear.phase !== 'frozen') throw Error('Clear is invalid or already started');
      if (this.unresolved(r)) throw Error('Clear admission/handoff or composer quarantine is unresolved');
      this.compactAliases(r);
      // Reserve a worst-case new-alias slot BEFORE the external Clear side effect. Every
      // admission is already settled here, so no new claim can consume this reservation.
      if (this.requiredAliases(r).length >= 32) throw Error('Clear alias capacity unavailable before execution');
      r.clear.aliasReserved = true; r.clear.phase = 'executing';
      // A 256-character replacement alias can expand under JSON escaping; reserve byte room too.
      if (Buffer.byteLength(JSON.stringify(r), 'utf8') + CLEAR_RESERVATION_BYTES > ClaudeQueueStore.MAX_BYTES) throw Error('Clear alias storage reservation unavailable');
    });
  }
  stop(id: string, incarnation: string): Promise<QueueAttempt[]> {
    // Stop only invalidates the current claimed work; waiting user intent remains eligible.
    return this.transition(id, r => {
      this.live(r, incarnation);
      const revoked = r.items.flatMap(i => i.status === 'delivering' && i.attempt ? [this.attemptIdentity(i.attempt)] : []);
      for (const i of r.items) if (i.status === 'delivering' || i.status === 'uncertain') this.quarantine(r, i);
      return revoked;
    });
  }
  freezeForClear(id: string, incarnation: string): Promise<{ clearId: string; revoked: QueueAttempt[] }> {
    return this.transition(id, r => {
      this.live(r, incarnation); r.paused = true;
      r.clear ??= { clearId: randomUUID(), phase: 'frozen' }; if (r.clear.phase === 'rebound') r.clear = { clearId: randomUUID(), phase: 'frozen' };
      const revoked = r.items.flatMap(i => i.attempt ? [this.attemptIdentity(i.attempt)] : []);
      for (const i of r.items) if (i.status === 'delivering' || i.status === 'uncertain') this.quarantine(r, i);
      return { clearId: r.clear.clearId, revoked };
    });
  }
  rebindAfterClear(id: string, clearId: string, alias: QueueAlias, incarnation: string): Promise<void> {
    validAlias(alias); const replacement = structuredClone(alias);
    return this.transition(id, r => {
      if (!r.clear || r.clear.clearId !== clearId || !identity(incarnation)) throw Error('Invalid Clear binding');
      if (r.clear.phase === 'rebound') {
        if (!sameAlias(r.alias, replacement) || r.live?.incarnation !== incarnation) throw Error('Clear already rebound'); return;
      }
      if (r.clear.phase !== 'executing' || !r.clear.aliasReserved || this.unresolved(r)) throw Error('Clear must safely resolve handoff and begin before rebinding');
      if ([...this.records.values()].some(other => other.queueId !== id && other.aliases.some(a => sameAlias(a, replacement)))) throw Error('Conversation alias already bound');
      r.alias = replacement; this.compactAliases(r); r.live = { incarnation }; r.boundaryHighWater = 0; r.paused = true; r.clear.phase = 'rebound';
    });
  }
  retireClosed(id: string): Promise<void> {
    return this.serial(async () => {
      const r = this.get(id); if (!canRetireQueue(r)) throw Error('Queue still has recoverable data or a live binding');
      await this.options.storage.retire(id, r.revision); this.records.delete(id);
    });
  }
  close(id: string, incarnation: string): Promise<void> {
    return this.serial(async () => {
      const previous = this.get(id); const r = structuredClone(previous); this.live(r, incarnation);
      r.paused = true; r.live = null;
      for (const i of r.items) if (i.status === 'delivering' || i.status === 'uncertain') this.quarantine(r, i);
      await this.commit(r, previous.revision);
      if (canRetireQueue(r)) { await this.options.storage.retire(id, r.revision); this.records.delete(id); }
    });
  }
}
