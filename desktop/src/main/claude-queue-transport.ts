import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { QueueAlias, QueueAttempt, QueuePayload } from '../shared/conversation-queue-types';
import { CLAUDE_QUEUE_WIRE_LIMITS } from '../shared/claude-queue-wire-limits';
import { prepareClaudeQueueInput } from './claude-queue-input';
import { verifyClaudeQueueEvidence } from './claude-queue-evidence';
import { log } from './logger';
import type { ClaudeQueue } from './claude-queue';

const id = z.string().min(1).max(256).regex(/^[^\x00-\x1f]+$/);
const offerSchema = z.object({ boundaryId: id, boundarySeq: z.number().int().positive().safe(), conversationId: id, turnId: id.nullable(), kind: z.enum(['batch', 'idle']), expiresAt: z.number().finite(), agentId: id.optional() }).strict();
const eventSchema = z.object({ kind: z.enum(['staged', 'admitted', 'accepted', 'transcript', 'revoked', 'unknown', 'recovered', 'abandoned']), attemptId: z.string().uuid(), wireHash: z.string().regex(/^[a-f0-9]{64}$/), uuid: id.optional(), composerSafe: z.boolean().optional(), beforeAdmission: z.boolean().optional(), beforeInvocation: z.boolean().optional(), detail: z.string().max(256).optional() }).strict();
export interface QueueBinding { queueId: string; incarnation: string; alias: QueueAlias; cwd: string }
export interface QueueLease extends QueueAttempt { conversationId: string; turnId: string | null; expiresAt: number; wireText: string }
export interface QueueNativeCommand { kind: 'stage' | 'revoke' | 'idle' | 'wait' | 'evidence' | 'abandon'; lease?: QueueLease; attempt?: QueueAttempt }
interface EvidenceQuery { attempt: QueueAttempt; done: Promise<boolean>; settle(result: boolean): void }
export interface QueueWorkerCommand { type: 'queue-acquire' | 'queue-enter' | 'queue-revoke' | 'queue-release' | 'queue-abandon'; attemptId: string; incarnation: string; boundarySeq: number; expiresAt: number; composerSafe?: boolean }
export interface ClaudeQueueTransportOptions {
  queue: ClaudeQueue;
  worker(sessionId: string, command: QueueWorkerCommand): Promise<{ status: string }>;
  /** Must positively establish composer input ownership, not merely absence of an error. */
  inputSafe(sessionId: string): boolean;
  waitInputSafe?(sessionId: string, deadline: number): Promise<boolean>;
  prepare?: (payload: QueuePayload, cwd: string) => Promise<{ wireText: string; files: string[] }>;
  now?: () => number;
  verifyEvidence?: (attempt: QueueAttempt, uuid: string) => Promise<boolean>;
  onIssue?: (sessionId: string, issue: { attemptId?: string; message: string }) => void;
}
interface Flow {
  lease?: QueueLease;
  binding: QueueBinding;
  finished: boolean;
  revoked: boolean;
  entered: boolean;
  workerOwned: boolean;
  stageIssued: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(): void;
  done: Promise<void>;
}
interface BindingState { binding: QueueBinding; commands: QueueNativeCommand[]; poll?: { resolve: (op: QueueNativeCommand) => void; timer: ReturnType<typeof setTimeout> }; flow?: Flow; attempts: Map<string, QueueLease>; accepted: Set<string>; confirmed: Set<string>; workerBlocked: Set<string> }
const released = { released: true as const };

/** Authenticated bridge delegate, intentionally not wired into IPC/UI. No delivery wait holds the queue's journal lock. */
export class ClaudeQueueTransport {
  private readonly bindings = new Map<string, BindingState>();
  private closed = false;
  private readonly dismissals = new Map<string, { attempt: QueueAttempt; ack(): void; done: Promise<void> }>();
  private readonly evidenceQueries = new Map<string, Map<string, EvidenceQuery>>();
  constructor(private readonly options: ClaudeQueueTransportOptions) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  private issue(sessionId: string, message: string, attemptId?: string): void {
    try { this.options.onIssue?.(sessionId, { message, ...(attemptId ? { attemptId } : {}) }); } catch { /* diagnostics cannot change a durable outcome */ }
  }
  bind(sessionId: string, binding: QueueBinding): void {
    if (this.closed || this.bindings.has(sessionId)) throw Error('Queue transport already bound or closed');
    const r = this.options.queue.snapshot(binding.queueId);
    if (r.live?.incarnation !== binding.incarnation || r.alias.provider !== binding.alias.provider || r.alias.conversationId !== binding.alias.conversationId) throw Error('Queue transport identity mismatch');
    this.bindings.set(sessionId, { binding: structuredClone(binding), commands: [], attempts: new Map(), accepted: new Set(), confirmed: new Set(), workerBlocked: new Set() });
  }
  /** After the queue's durable observed-result rebind, retain OLD attempt evidence for late receipts. */
  rebind(sessionId: string, binding: QueueBinding): void {
    const s = this.bindings.get(sessionId); if (!s || s.flow || s.workerBlocked.size > 0 || [...s.attempts.keys()].some(id => !s.accepted.has(id)) || binding.queueId !== s.binding.queueId) throw Error('Cannot replace an active queue binding');
    const r = this.options.queue.snapshot(binding.queueId);
    if (r.live?.incarnation !== binding.incarnation || r.alias.conversationId !== binding.alias.conversationId || r.alias.provider !== binding.alias.provider) throw Error('Queue transport identity mismatch');
    if (binding.incarnation !== s.binding.incarnation) throw Error('Native incarnation changed; old session must be explicitly closed and reconciled');
    s.binding = structuredClone(binding); s.commands = [];
  }
  private state(sessionId: string, incarnation: string): BindingState | undefined {
    const s = this.bindings.get(sessionId); return !this.closed && s?.binding.incarnation === incarnation ? s : undefined;
  }
  private command(s: BindingState, op: QueueNativeCommand): void {
    if (s.poll) { clearTimeout(s.poll.timer); const p = s.poll; delete s.poll; p.resolve(op); }
    else { if (s.commands.length >= 4) throw Error('Queue native command lane full'); s.commands.push(op); }
  }
  requestIdle(sessionId: string): void {
    const s = this.bindings.get(sessionId);
    if (s && !s.flow && !s.commands.some(c => c.kind === 'idle')) this.command(s, { kind: 'idle' });
  }
  poll(sessionId: string, incarnation: string): Promise<QueueNativeCommand> {
    const s = this.state(sessionId, incarnation); if (!s) return Promise.resolve({ kind: 'wait' });
    if (s.poll) throw Error('Duplicate queue poll');
    if (s.commands.length) return Promise.resolve(s.commands.shift()!);
    return new Promise(resolve => { const timer = setTimeout(() => { if (s.poll?.resolve === resolve) delete s.poll; resolve({ kind: 'idle' }); }, 20000); s.poll = { resolve, timer }; });
  }
  /** Deliberate recovery queries/revokes the SAME native attempt; never resends body or Enter. */
  async reconcile(sessionId: string, attemptId: string): Promise<boolean> {
    const s = this.bindings.get(sessionId); const lease = s?.attempts.get(attemptId);
    if (!s)throw Error('Queue connection is unavailable');
    if(!lease){
      const original=this.options.queue.snapshot(s.binding.queueId).items.find(i=>i.attempt?.attemptId===attemptId);
      if(!original?.attempt)throw Error('Unknown reconciliation attempt');
      // WHY: a restored attempt has NO wire lease. Ask only for its persisted native kept-row
      // receipt, with the original identity; never send body, Enter, revoke or rearm an old lease.
      const queries = this.evidenceQueries.get(sessionId) ?? new Map<string, EvidenceQuery>();
      this.evidenceQueries.set(sessionId, queries);
      const existing = queries.get(attemptId); if (existing) return existing.done;
      let resolve!: (result: boolean) => void;
      const done = new Promise<boolean>(r => { resolve = r; });
      const timer = setTimeout(() => query.settle(false), 5000);
      const query: EvidenceQuery = { attempt: structuredClone(original.attempt), done, settle: result => {
        clearTimeout(timer); queries.delete(attemptId); resolve(result);
      } };
      queries.set(attemptId, query);
      try { this.command(s, { kind: 'evidence', attempt: query.attempt }); }
      catch { query.settle(false); }
      const confirmed = await done;
      if (this.options.queue.snapshot(s.binding.queueId).tombstones.some(t => t.reason === 'dismissed' && t.attempt?.attemptId === attemptId)) return true;
      if (!confirmed) this.issue(sessionId,'Delivery is still unconfirmed. Review the original conversation '+original.attempt.alias.conversationId+'. The saved message has not been resent.',attemptId);
      return confirmed;
    }
    this.command(s, { kind: 'revoke', lease });return true;
  }
  /** Explicit discard: first revoke Enter, then native authority, then retire intent. Never replay. */
  dismiss(sessionId: string, itemId: string): Promise<void> {
    const s = this.bindings.get(sessionId); if (!s) return Promise.reject(Error('Queue connection is unavailable'));
    const r = this.options.queue.snapshot(s.binding.queueId);
    if (r.tombstones.some(t => t.queueItemId === itemId && t.reason === 'dismissed')) return Promise.resolve();
    const item = r.items.find(i => i.queueItemId === itemId);
    if (item?.status !== 'uncertain' || !item.attempt) return Promise.reject(Error('Message is no longer unconfirmed'));
    const attempt = item.attempt; const existing = this.dismissals.get(attempt.attemptId); if (existing) return existing.done;
    let ack!: () => void; const acknowledged = new Promise<void>(resolve => { ack = resolve; });
    const pending = { attempt, ack, done: Promise.resolve() };
    this.dismissals.set(attempt.attemptId, pending);
    pending.done = (async () => {
      const lease = s.attempts.get(attempt.attemptId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (s.flow?.lease?.attemptId === attempt.attemptId) s.flow.revoked = true;
        if (lease) {
          const result = await this.options.worker(sessionId, this.workerCommand(lease, 'queue-revoke'));
          if (!['revoked','stale'].includes(result.status)) throw Error('Queue cancellation was not acknowledged');
        }
        s.commands = s.commands.filter(c => (c.lease ?? c.attempt)?.attemptId !== attempt.attemptId);
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Queue dismissal was not acknowledged. Try again.')), 5000); });
        this.command(s, { kind: 'abandon', attempt });
        await Promise.race([acknowledged, timeout]);
        if (this.state(sessionId, s.binding.incarnation) !== s) throw Error('Queue connection changed');
        if (lease) {
          // WHY: discard buffered old input instead of flushing a possible Enter into a human draft.
          const result = await this.options.worker(sessionId, this.workerCommand(lease, 'queue-abandon'));
          if (!['released','stale'].includes(result.status)) throw Error('Queue input reset was not acknowledged. Try again.');
        }
        await this.options.queue.dismiss(s.binding.queueId, attempt);
        this.evidenceQueries.get(sessionId)?.get(attempt.attemptId)?.settle(false);
        s.workerBlocked.delete(attempt.attemptId); this.forget(s, attempt.attemptId);
        if (s.flow?.lease?.attemptId === attempt.attemptId) this.finish(s, s.flow);
      } finally { if (timer) clearTimeout(timer); this.dismissals.delete(attempt.attemptId); }
    })();
    return pending.done;
  }
  /** Retry ONLY a previously authorized clean release, never body or Enter. */
  async retryWorkerRelease(sessionId: string, attemptId: string): Promise<void> {
    const s = this.bindings.get(sessionId); const lease = s?.attempts.get(attemptId);
    if (!s || !lease || !s.workerBlocked.has(attemptId)) throw Error('No unconfirmed safe worker release');
    await this.releaseWorker(sessionId, s, lease);
    const r = this.options.queue.snapshot(s.binding.queueId);
    if (!r.items.some(i => i.attempt?.attemptId === attemptId) && !r.tombstones.some(t => t.attempt?.attemptId === attemptId)) this.forget(s, attemptId);
    else if (s.accepted.has(attemptId) && s.confirmed.has(attemptId)) this.forget(s, attemptId);
  }
  canControl(sessionId: string): boolean {
    const s = this.bindings.get(sessionId); const r = s ? this.options.queue.snapshot(s.binding.queueId) : undefined;
    return !s || (!s.flow && s.workerBlocked.size === 0 && ![...s.attempts.keys()].some(id => !s.accepted.has(id)) && !this.options.queue.hasWriteBarrier(s.binding.queueId)
      && !r!.items.some(i => i.status === 'waiting' && (!r!.paused || i.pauseBypass)));
  }
  canExecuteClear(sessionId: string, clearId: string): boolean {
    const s = this.bindings.get(sessionId); if (!s || s.flow || s.workerBlocked.size > 0) return false;
    const r = this.options.queue.snapshot(s.binding.queueId);
    return r.clear?.clearId === clearId && r.clear.phase === 'executing' && r.quarantines.length === 0
      && ![...s.attempts.keys()].some(id => !s.accepted.has(id))
      && !r.items.some(i => i.attempt && !i.attempt.receipt);
  }
  async offer(sessionId: string, incarnation: string, value: unknown): Promise<typeof released> {
    const s = this.state(sessionId, incarnation); const parsed = offerSchema.safeParse(value);
    if (!s || !parsed.success || s.flow) return released;
    const offer = parsed.data;
    if (offer.agentId || offer.conversationId !== s.binding.alias.conversationId || offer.expiresAt <= this.now() || offer.expiresAt - this.now() > 15000
      || (offer.kind === 'idle' && offer.turnId !== null) || (offer.kind === 'batch' && offer.turnId === null)) return released;
    // WHY: input safety may briefly disappear after a proven clean handoff. This set
    // contains only already-authorized releases, never permission to stage/Enter or guess an outcome.
    if (this.options.inputSafe(sessionId)) for (const attemptId of s.workerBlocked) {
      try { await this.retryWorkerRelease(sessionId, attemptId); } catch { return released; }
    }
    if (this.state(sessionId, incarnation) !== s || s.flow || s.workerBlocked.size > 0 || [...s.attempts.keys()].some(id => !s.accepted.has(id))) return released;
    const snapshot = this.options.queue.snapshot(s.binding.queueId);
    const head = snapshot.items.find(i => i.status === 'waiting' && (!snapshot.paused || i.pauseBypass));
    if ((snapshot.paused && !head?.pauseBypass) || this.options.queue.hasWriteBarrier(s.binding.queueId) || !this.options.inputSafe(sessionId)) return released;
    if (!head || head.checkout || s.attempts.size >= 64) return released;
    let resolve!: () => void; const done = new Promise<void>(r => { resolve = r; });
    const flow: Flow = { binding: structuredClone(s.binding), finished: false, revoked: false, entered: false, workerOwned: false, stageIssued: false,
      timer: setTimeout(() => { void this.expire(sessionId, s, flow); }, Math.max(1, offer.expiresAt - this.now())), resolve, done };
    s.flow = flow;
    try {
      const wire = await (this.options.prepare ? this.options.prepare(head, s.binding.cwd) : prepareClaudeQueueInput({ text: head.originalText, attachments: head.attachments, cwd: s.binding.cwd }));
      if (wire.wireText.length > CLAUDE_QUEUE_WIRE_LIMITS.maxCharacters || Buffer.byteLength(JSON.stringify(wire.wireText), 'utf8') > CLAUDE_QUEUE_WIRE_LIMITS.maxJsonBytes) throw Error('Prepared queue wire exceeds limits');
      if (!this.valid(sessionId, s, flow, offer.expiresAt)) { this.finish(s, flow); return released; }
      const hash = createHash('sha256').update(wire.wireText).digest('hex');
      const claim = await this.options.queue.claim(s.binding.queueId, { boundaryId: offer.boundaryId, boundarySeq: offer.boundarySeq, incarnation, alias: s.binding.alias, wireHash: hash, expectedItemId: head.queueItemId });
      if (!claim) { this.finish(s, flow); return released; }
      flow.lease = { ...claim.attempt, conversationId: offer.conversationId, turnId: offer.turnId, expiresAt: offer.expiresAt, wireText: wire.wireText };
      s.attempts.set(claim.attempt.attemptId, flow.lease);
      // A lease returned by storage is still revocable before EACH side effect.
      if (!this.valid(sessionId, s, flow, offer.expiresAt)) {
        await this.options.queue.notSent(s.binding.queueId, claim.attempt);
        this.forget(s,claim.attempt.attemptId); // only after durable no-effect resolution; failed IO retains recovery identity
        this.finish(s, flow); return released;
      }
      const ownership = await this.options.worker(sessionId, this.workerCommand(flow.lease, 'queue-acquire'));
      // WHY: a cancellation/expiry may have completed while this old worker ACK was in flight.
      // It cannot return old intent or revoke whichever NEW flow now owns the session.
      if (flow.finished || s.flow !== flow) return released;
      if (ownership.status !== 'owned') {
        // No native stage command has been issued: releasing this reservation cannot
        // submit or erase any draft, including a late acquire acknowledgement.
        await this.options.queue.notSent(s.binding.queueId, claim.attempt);
        try { await this.releaseWorker(sessionId, s, flow.lease); this.forget(s, flow.lease.attemptId); }
        catch { /* proven no native stage, but keep an explicit worker-ownership barrier until retry */ }
        this.finish(s, flow); return released;
      }
      flow.workerOwned = true;
      if (!this.valid(sessionId, s, flow, offer.expiresAt)) { await this.revoke(sessionId, flow); }
      else { flow.stageIssued = true; this.command(s, { kind: 'stage', lease: flow.lease }); }
      await done;
    } catch (error) {
      if (flow.finished) return released; // late failures cannot resurrect a dismissed diagnostic
      this.issue(sessionId, error instanceof Error ? error.message : 'Queued delivery could not be confirmed.', flow.lease?.attemptId);
      if (flow.lease && !flow.finished) await this.quarantine(s, flow).catch(() => {});
      this.finish(s, flow);
    }
    return released;
  }
  private valid(sessionId: string, s: BindingState, f: Flow, deadline: number): boolean {
    return this.state(sessionId, f.binding.incarnation) === s && s.flow === f && !f.revoked && !f.finished && this.now() < deadline && this.options.inputSafe(sessionId);
  }
  private workerCommand(lease: QueueLease, type: QueueWorkerCommand['type'], composerSafe?: boolean): QueueWorkerCommand {
    return { type, attemptId: lease.attemptId, incarnation: lease.incarnation, boundarySeq: lease.boundarySeq, expiresAt: lease.expiresAt, ...(composerSafe === undefined ? {} : { composerSafe }) };
  }
  private finish(s: BindingState, f: Flow): void {
    if (f.finished) return; f.finished = true; clearTimeout(f.timer); if (s.flow === f) delete s.flow; f.resolve();
  }
  private async quarantine(s: BindingState, f: Flow): Promise<void> {
    if (f.lease) await this.options.queue.uncertain(s.binding.queueId, f.lease);
  }
  private async expire(sessionId: string, s: BindingState, f: Flow): Promise<void> {
    if (f.finished) return;
    try { await this.revoke(sessionId, f); await this.quarantine(s, f); } catch { /* memory/worker stays fenced even if storage failed */ }
    this.finish(s, f);
  }
  /** Clear waits for classified cleanup/expiry, not merely the worker's revoke acknowledgement. */
  async revokeAndWait(sessionId: string): Promise<void> {
    const flow=this.bindings.get(sessionId)?.flow;
    await this.revoke(sessionId);
    if(flow) await flow.done;
  }
  async revoke(sessionId: string, expected?: Flow): Promise<void> {
    const s = this.bindings.get(sessionId); const f = s?.flow; if (!s || !f || (expected && f !== expected)) return;
    f.revoked = true;
    if (f.lease) {
      await this.options.worker(sessionId, this.workerCommand(f.lease, 'queue-revoke'));
      if (!f.stageIssued) {
        // WHY: readiness can change during worker acquisition. Native never saw this
        // identity; asking it to revoke would compare against the PREVIOUS accepted lease.
        // No stage command/body/Enter was issued, so returning this intent is proven safe.
        await this.options.queue.notSent(s.binding.queueId, f.lease);
        try { await this.releaseWorker(sessionId, s, f.lease); this.forget(s, f.lease.attemptId); } catch { /* retain authorized release until input safety recovers */ }
        this.finish(s, f); return;
      }
      // Prioritize revocation over stage/idle; native CAS decides whether admission already won.
      s.commands = s.commands.filter(c => c.lease?.attemptId !== f.lease!.attemptId);
      this.command(s, { kind: 'revoke', lease: f.lease });
    }
  }
  async event(sessionId: string, incarnation: string, value: unknown): Promise<void> {
    const s = this.state(sessionId, incarnation); const event = eventSchema.parse(value);
    if (!s) throw Error('Stale queue incarnation');
    const dismissal = this.dismissals.get(event.attemptId);
    if (dismissal && dismissal.attempt.wireHash === event.wireHash) {
      if (event.kind === 'abandoned') dismissal.ack();
      return; // late ACK/receipt/revoke has no authority while the user abandons this identity
    }
    if (this.options.queue.snapshot(s.binding.queueId).tombstones.some(t => t.reason === 'dismissed' && t.attempt?.attemptId === event.attemptId && t.attempt.wireHash === event.wireHash)) return;
    if (event.kind === 'abandoned') return; // lost dismissal reply; retry reissues the same cancellation only
    if (event.kind === 'recovered') {
      const query = this.evidenceQueries.get(sessionId)?.get(event.attemptId);
      if (!query || query.attempt.wireHash !== event.wireHash) throw Error('Unrequested historical queue evidence');
      const proven = !!event.uuid && await (this.options.verifyEvidence ?? verifyClaudeQueueEvidence)(query.attempt, event.uuid);
      if (this.state(sessionId, incarnation) !== s || this.evidenceQueries.get(sessionId)?.get(event.attemptId) !== query) return;
      if (proven) await this.options.queue.confirm(s.binding.queueId, query.attempt, event.uuid!);
      query.settle(proven); return;
    }
    const lease = s.attempts.get(event.attemptId);
    if (!lease) {
      // Lost HTTP replies can repeat evidence AFTER the in-memory correlation book
      // retired it. Only exact durable tombstone evidence may acknowledge a duplicate.
      const tomb = this.options.queue.snapshot(s.binding.queueId).tombstones.find(t => t.attempt?.attemptId === event.attemptId && t.attempt.wireHash === event.wireHash);
      if (tomb && ((event.kind === 'accepted' && tomb.nativeReceipt === event.attemptId)
        || (event.kind === 'transcript' && tomb.transcriptUuid === event.uuid)
        || (event.kind === 'admitted' && tomb.nativeAdmission === event.attemptId))) return;
      throw Error('Unknown queue attempt evidence');
    }
    if (lease.wireHash !== event.wireHash) throw Error('Unknown queue attempt evidence');
    const f = s.flow?.lease?.attemptId === event.attemptId ? s.flow : undefined;
    // WHY: retain native branch and lease timing, not message bodies, when an outcome needs human reconciliation.
    if (event.kind === 'unknown' || event.kind === 'revoked') log('WARN', 'ClaudeQueue', 'Native delivery classification', { sessionId, attemptId: lease.attemptId, boundarySeq: lease.boundarySeq, ageMs: this.now() - lease.createdAt, entered: f?.entered, kind: event.kind, detail: event.detail, beforeAdmission: event.beforeAdmission, beforeInvocation: event.beforeInvocation, composerSafe: event.composerSafe });
    switch (event.kind) {
      case 'staged': {
        if (f && !f.revoked && !this.options.inputSafe(sessionId) && this.options.waitInputSafe) await this.options.waitInputSafe(sessionId,lease.expiresAt);
        if (!f) return;
        if (!this.valid(sessionId, s, f, lease.expiresAt) || !this.options.queue.isCurrentClaim(s.binding.queueId, lease)) { await this.revoke(sessionId, f); return; }
        if (f.entered) return;
        f.entered = true;
        const result = await this.options.worker(sessionId, this.workerCommand(lease, 'queue-enter'));
        if (result.status !== 'entered') await this.revoke(sessionId, f);
        return;
      }
      case 'admitted': await this.options.queue.admit(s.binding.queueId, lease, lease.attemptId); return;
      case 'accepted': {
        try { await this.options.queue.accept(s.binding.queueId, lease, lease.attemptId); }
        catch (error) { log('WARN', 'ClaudeQueue', 'Native acceptance journal failed', { attemptId: lease.attemptId, error: String(error) }); throw error; }
        if (this.dismissals.has(lease.attemptId) || this.options.queue.snapshot(s.binding.queueId).tombstones.some(t => t.reason === 'dismissed' && t.attempt?.attemptId === lease.attemptId)) return;
        s.accepted.add(lease.attemptId);
        try { await this.releaseWorker(sessionId, s, lease); }
        catch (error) { log('WARN', 'ClaudeQueue', 'Native acceptance worker release failed', { attemptId: lease.attemptId, error: String(error) }); throw error; }
        finally { if (f) this.finish(s, f); }
        if (s.confirmed.has(lease.attemptId)) this.forget(s, lease.attemptId);
        return;
      }
      case 'transcript': {
        if (!event.uuid) throw Error('Missing native transcript UUID');
        await this.options.queue.confirm(s.binding.queueId, lease, event.uuid);
        // Bounded correlation book: confirmed evidence remains durably deduplicated in queue journal.
        s.confirmed.add(event.attemptId);
        if (s.accepted.has(event.attemptId) && !s.workerBlocked.has(event.attemptId)) this.forget(s, event.attemptId);
        return;
      }
      case 'revoked': {
        if ((event.beforeAdmission === true || event.beforeInvocation === true) && event.composerSafe === true) {
          await this.releaseWorker(sessionId, s, lease);
          if (event.beforeInvocation === true) await this.options.queue.resolveNotInvoked(s.binding.queueId,lease,{notInvokedId:lease.attemptId,composerEmpty:true});
          else await this.options.queue.revokeBeforeAdmission(s.binding.queueId, lease, { revocationId: lease.attemptId, composerEmpty: true });
          this.forget(s, lease.attemptId);
        } else await this.options.queue.uncertain(s.binding.queueId, lease);
        if (f) this.finish(s, f); return;
      }
      case 'unknown':
        this.issue(sessionId, 'Queued delivery is unconfirmed. Review the conversation before trying again.', lease.attemptId);
        if (f) { await this.quarantine(s, f); this.finish(s, f); } return;
    }
  }
  private async releaseWorker(sessionId: string, s: BindingState, lease: QueueLease): Promise<void> {
    s.workerBlocked.add(lease.attemptId); // unknown acknowledgement must fence direct commands too
    // Buffered ordinary writes can contain Enter too. Cleanup of our text alone
    // is not permission to flush them while a popup/permission card owns input.
    if (!this.options.inputSafe(sessionId)) throw Error('Input is still blocked; worker ownership remains quarantined');
    const result = await this.options.worker(sessionId, this.workerCommand(lease, 'queue-release', true));
    if (!['released', 'stale'].includes(result.status)) throw Error('Worker ownership release is unconfirmed');
    s.workerBlocked.delete(lease.attemptId);
  }
  private forget(s: BindingState, attemptId: string): void {
    s.attempts.delete(attemptId); s.accepted.delete(attemptId); s.confirmed.delete(attemptId);
  }
  async unbind(sessionId: string): Promise<void> {
    const s = this.bindings.get(sessionId); if (!s) return;
    try {
      if (s.flow) { const f = s.flow; try { await this.revoke(sessionId, f); await this.quarantine(s, f); } finally { this.finish(s, f); } }
    } finally {
      for (const query of this.evidenceQueries.get(sessionId)?.values() ?? []) query.settle(false);
      this.evidenceQueries.delete(sessionId);
      if (s.poll) { clearTimeout(s.poll.timer); s.poll.resolve({ kind: 'wait' }); }
      this.bindings.delete(sessionId);
    }
  }
  async close(): Promise<void> {
    this.closed = true; // stop new offers before asynchronous revocation/storage work
    await Promise.allSettled([...this.bindings.keys()].map(id => this.unbind(id)));
  }
}
