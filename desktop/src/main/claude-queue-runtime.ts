import type { ClaudeControlBridge } from './claude-control-bridge';
import type { SessionManager } from './session-manager';
import { ClaudeQueue } from './claude-queue';
import { ClaudeQueueStore } from './claude-queue-store';
import { retainQueueAttachments } from './claude-queue-attachments';
import { prepareClaudeQueueInput } from './claude-queue-input';
import { ClaudeQueueTransport } from './claude-queue-transport';
import type { QueueJournal } from '../shared/conversation-queue-types';
import type { ConversationQueueAction, ConversationQueueReply } from '../shared/conversation-queue-channel-types';
import type { SessionLiveBody } from '../shared/session-live-types';

interface Options {
 userDataRoot(): string;
 bridge: ClaudeControlBridge;
 manager: Pick<SessionManager, 'getSession' | 'sendInput' | 'queueWorkerCommand'>;
 inputSafe(sessionId: string): boolean;
 waitInputSafe?(sessionId: string, deadline: number): Promise<boolean>;
 working(sessionId: string): boolean;
 publish(sessionId: string, body: SessionLiveBody): void;
 noteSend(sessionId: string, sendId: string): void;
}
/** How long an idle send may stay out of the strip while it is being delivered (its bubble is already drawn). */
const IMMEDIATE_HIDE_MS = 8000;
/** Recent confirmed sends whose transcript identity is republished with every queue snapshot. */
const BOUND_SENDS = 16;
interface Binding { incarnation: string; conversationId?: string; queueId?: string; ready: Promise<void>; clearId?: string; transitioning?: boolean }
/** One lazy instance per runtime. No userData read/staging before final dev profile selection. */
export class ClaudeQueueRuntime {
 private service?: Promise<{ queue: ClaudeQueue; transport: ClaudeQueueTransport }>;
 private readonly bindings = new Map<string, Binding>();
 private closed = false;
 private readonly issues = new Map<string,{ message: string; queueItemId?: string }>();
 private readonly composerBusy = new Set<string>();
 private readonly republishTimers = new Map<string, ReturnType<typeof setTimeout>>();
 private readonly onReady: (id: string, incarnation: string) => void;
 private readonly onState: (id: string, state: { claudeSessionId?: string }) => void;
 constructor(private readonly options: Options) {
  this.onReady = (id, incarnation) => {
   const previous = this.bindings.get(id);
   if (previous && previous.incarnation !== incarnation) { previous.transitioning = true; return; } // explicit reopen required for reloaded worker capability
   this.bindings.set(id, previous ?? { incarnation, ready: Promise.resolve() });
  };
  this.onState = (id, state) => {
   const b = this.bindings.get(id); if (!b || !state.claudeSessionId || this.closed) return;
   const identity = state.claudeSessionId;
   b.ready = b.ready.then(async () => {
    const { queue, transport } = await this.get();
    if (b.queueId && b.conversationId !== identity) {
     // Receipt of a different ID alone is NOT a Clear authorization. Freeze; the
     // authoritative lifecycle hook/our executing Clear resolves the replacement.
     b.transitioning = true;
     await queue.freezeForClear(b.queueId, b.incarnation); return;
    }
    if (!b.queueId) {
     const queueId = await queue.bind({ provider: 'claude', conversationId: identity }, b.incarnation);
     b.queueId = queueId; b.conversationId = identity;
     transport.bind(id, { queueId, incarnation: b.incarnation, alias: { provider: 'claude', conversationId: identity }, cwd: this.options.manager.getSession(id)?.cwd ?? '' });
     this.publish(id, queue.snapshot(queueId));
    }
   }).catch(() => { b.transitioning = true; });
  };
  options.bridge.setQueueInitializer(async () => { await this.get(); });
  options.bridge.on('native-ready', this.onReady); options.bridge.on('state', this.onState);
 }
 private get(): Promise<{ queue: ClaudeQueue; transport: ClaudeQueueTransport }> {
  this.service ??= (async () => {
   const queue = new ClaudeQueue({ storage: new ClaudeQueueStore(this.options.userDataRoot()), ready: (root, input) => [...this.bindings].some(([id,b]) => b.queueId === root && b.incarnation === input.incarnation && !b.transitioning && this.options.inputSafe(id)), publish: r => {
    for (const [id,b] of this.bindings) if (b.queueId === r.queueId) this.publish(id,r);
   } });
   const transport = new ClaudeQueueTransport({ queue, worker: (id,c) => this.options.manager.queueWorkerCommand(id,c), inputSafe: id => this.options.inputSafe(id), waitInputSafe: this.options.waitInputSafe,
    prepare: (p,cwd) => prepareClaudeQueueInput({text:p.originalText,attachments:p.preparedAttachments ?? p.attachments,cwd}),
    onIssue: (id,issue) => { this.issues.set(id,{ message: issue.message, ...(issue.queueItemId ? { queueItemId: issue.queueItemId } : {}) }); const root=this.bindings.get(id)?.queueId;if(root)this.publish(id,queue.snapshot(root)); },
    onComposerBusy: (id,busy) => { if (busy) this.composerBusy.add(id); else this.composerBusy.delete(id); const root=this.bindings.get(id)?.queueId;if(root)this.publish(id,queue.snapshot(root)); } });
   await queue.restore(); this.options.bridge.attachQueueTransport(transport); return { queue, transport };
  })();
  return this.service;
 }
 private publish(id: string, r: QueueJournal): void {
  const now = Date.now();
  // A problem belongs to one message; once that message has left the queue, its note goes too.
  const issue = this.issues.get(id);
  if (issue?.queueItemId && !r.items.some(i => i.queueItemId === issue.queueItemId)) this.issues.delete(id);
  let nextReveal = Infinity;
  // WHY: immediate readiness is a classification, not a hide timer. Unknown and genuinely
  // waiting work remains visible; an accepted receipt is tracked internally until its UUID arrives.
  // WHY the IMMEDIATE_HIDE_MS cap (2026-10-22): the chat now draws an idle send's bubble at once, so a hidden item that
  // stalls would look sent while nothing happens. After the cap it shows in the strip, which takes its bubble's place.
  const hidden = (i: QueueJournal['items'][number]) => {
   if (!i.immediate || !(i.status === 'delivering' || (i.status === 'waiting' && !this.options.working(id) && this.options.inputSafe(id)))) return false;
   const left = i.timestamp + IMMEDIATE_HIDE_MS - now;
   if (left <= 0) return false;
   nextReveal = Math.min(nextReveal, left); return true;
  };
  const visible = r.items.filter(i => !i.attempt?.receipt && !hidden(i));
  const firstWaiting = visible.find(i => i.status === 'waiting' && (!r.paused || i.pauseBypass));
  const noticeOf = (i: QueueJournal['items'][number]): string | undefined => {
   const current = this.issues.get(id);
   if (current && (current.queueItemId ? current.queueItemId === i.queueItemId : i === visible[0])) return current.message;
   if (this.composerBusy.has(id) && i === firstWaiting) return 'Waiting for the message box in the terminal to be empty.';
   return undefined;
  };
  this.options.publish(id, { kind: 'queue', queueIdentity: { queueId: r.queueId, sendEpoch: r.sendEpoch }, paused: r.paused,
   queue: visible.map(i => { const notice = noticeOf(i); return { queueId: i.queueItemId, content: i.displayContent, timestamp: i.timestamp, sendId: i.sendId, sendEpoch: i.sendEpoch, attachments: [...i.attachments], status: i.status, editing: !!i.checkout, paused: r.paused && !i.pauseBypass, ...(notice ? { notice } : {}) }; }),
   // Which transcript line each recent send became, so every screen can show what the person typed instead of the
   // text the queue gave Claude Code, and confirm the sender's instant bubble by identity rather than by wording.
   bound: r.tombstones.filter(t => t.reason === 'confirmed' && t.transcriptUuid).slice(-BOUND_SENDS).map(t => ({ sendId: t.sendId, uuid: t.transcriptUuid! })) });
  const pending = this.republishTimers.get(id); if (pending) { clearTimeout(pending); this.republishTimers.delete(id); }
  if (nextReveal !== Infinity) {
   const timer = setTimeout(() => { this.republishTimers.delete(id); const root = this.bindings.get(id)?.queueId; if (root && this.service) void this.service.then(s => this.publish(id, s.queue.snapshot(root))).catch(() => {}); }, nextReveal + 50);
   timer.unref?.(); this.republishTimers.set(id, timer);
  }
 }
 /** Wake only after authoritative parsed terminal changes/reconnect, never from a guessed timer. */
 wake(id: string): void { if (this.service && this.options.inputSafe(id)) void this.service.then(s => s.transport.requestIdle(id)).catch(() => {}); }
 async identityChanged(id: string, source: string, conversationId: string): Promise<void> {
  const b = this.bindings.get(id); if (!b) return;
  // WHY: hooks, Clear receipts and raw state share this chain. Checking identity
  // outside it lets a duplicate freeze AGAIN after the first durable rebind.
  const transition = b.ready.then(async () => {
   if (this.closed || this.bindings.get(id) !== b || !b.queueId) return;
   const s = await this.get();
   if (b.conversationId === conversationId) return;
   b.transitioning = true;
   const c = await s.queue.freezeForClear(b.queueId, b.incarnation); await s.transport.revoke(id);
   // WHY rebind on an outside change too (plan "Yes, clear context", /clear or /resume typed in
   // the terminal): staying frozen refused EVERY later send in the session with "Conversation
   // identity changed" until it was reopened. The hook gate upstream already refuses foreign
   // remaps, and rebindAfterClear leaves retained messages paused — they never auto-deliver into
   // the new conversation; only new sends (pauseBypass) and a deliberate Send now go through.
   const ours = source === 'clear' && !!b.clearId && b.clearId === c.clearId;
   if (!ours) {
    if (b.clearId) return; // our own Clear is mid-flight: its receipt rebinds
    await s.queue.beginClear(b.queueId, c.clearId); // throws (stays frozen) only while a delivery is unresolved
   }
   await s.queue.rebindAfterClear(b.queueId, c.clearId, { provider: 'claude', conversationId }, b.incarnation);
   s.transport.rebind(id, { queueId: b.queueId, incarnation: b.incarnation, alias: { provider: 'claude', conversationId }, cwd: this.options.manager.getSession(id)?.cwd ?? '' });
   b.conversationId = conversationId; b.transitioning = false; b.clearId = undefined;
  });
  b.ready = transition.catch(() => { b.transitioning = true; });
  await transition;
 }
 async action(id: string, action: ConversationQueueAction): Promise<ConversationQueueReply> {
  const b = this.bindings.get(id);
  if (action.kind === 'stop' && !this.closed && this.options.manager.getSession(id)) {
   // WHY: deliberate cancellation must not wait for bridge health, binding IO or cleanup replies.
   this.options.manager.sendInput(id,'\x1b');
   if(b)void b.ready.then(async()=>{const s=await this.get();const revoke=s.transport.revoke(id).catch(()=>{});if(b.queueId)await s.queue.stop(b.queueId,b.incarnation);await revoke;}).catch(()=>{});
   return {status:'done'};
  }
  if (!b) return {status:'unavailable'};
  if (this.closed || !this.options.bridge.isReady(id)) return { status: 'unknown', message: 'The queue connection is no longer ready. Check the conversation before sending again.' };
  try {
   await b.ready; if (!b.queueId) return { status: 'rejected', message: 'Conversation queue is still starting.' };
   const { queue, transport } = await this.get(); const root = b.queueId;
   let snapshot=queue.snapshot(root);
   // Only a NEW deliberate identity lookup may roll a fully drained history. Enqueue retries retain their captured epoch.
   if(action.kind==='identity'&&!snapshot.items.length&&!queue.hasWriteBarrier(root)&&(snapshot.tombstones.length>=1024||snapshot.cancelledCheckouts.length>=1024)) {
    await queue.rotateSendEpoch(root,snapshot.sendEpoch);snapshot=queue.snapshot(root);
   }
   const identity = { queueId: root, sendEpoch: snapshot.sendEpoch };
   if (action.kind === 'identity') return { status: 'identity', identity };
   // WHY (2026-10-22 phone reliability): a phone whose send lost its answer (a frozen laptop, a drop) kept the request and
   // refused every different message until the exact text was retyped. The queue's items and tombstones are durable and
   // keyed by sendId, so it can say whether it ever accepted that send — read-only, nothing is resent.
   if (action.kind === 'lookup') {
    if (action.queueId !== root) return { status: 'unknown', message: 'Conversation identity changed.' };
    const found = snapshot.items.some(i => i.sendId === action.sendId) || snapshot.tombstones.some(t => t.sendId === action.sendId);
    return { status: 'lookup', identity, found };
   }
   if (action.kind === 'enqueue') {
    if (action.queueId !== root || b.transitioning) throw Error('Conversation identity changed. Review the message before sending again.');
    const result = await queue.enqueue(root, action.payload,p=>retainQueueAttachments(this.options.userDataRoot(),root,p.attachments), !this.options.working(id) && this.options.inputSafe(id) && !queue.hasWriteBarrier(root)); this.options.noteSend(id,action.payload.sendId); transport.requestIdle(id);
    return { status: 'queued', identity, itemId: result.item.queueItemId, sendId: action.payload.sendId };
   }
   if (action.kind === 'dismiss') {
    const dismissed = queue.snapshot(root).items.find(i => i.queueItemId === action.itemId);
    await transport.dismiss(id, action.itemId); this.issues.delete(id); this.publish(id, queue.snapshot(root));
    // WHY wake (2026-10-22): dismissing the message that paused a running queue lifts that pause (ClaudeQueue.releaseCause),
    // and the messages behind it should continue without a click each. A queue still paused for another reason ignores the wake.
    transport.requestIdle(id);
    // The words go back to the person's message box (only an empty one; the screen decides), so dismissing loses nothing.
    return { status: 'done', ...(dismissed ? { restore: { text: dismissed.originalText, attachments: [...dismissed.attachments] } } : {}) };
   }
   if (action.kind === 'remove') { await queue.remove(root, action.itemId); return { status: 'done' }; }
   if (action.kind === 'checkout') return { status: 'reserved', item: await queue.checkout(root, action.itemId, action.token) };
   if (action.kind === 'ack') { await queue.ackCheckout(root, action.token); return { status: 'done' }; }
   if (action.kind === 'cancel') { await queue.cancelCheckout(root, action.token); return { status: 'done' }; }
   if (action.kind === 'send-now') {
    const selected=queue.snapshot(root).items.find(i=>i.queueItemId===action.itemId);
    if(selected?.status==='uncertain'&&selected.attempt){const confirmed=await transport.reconcile(id,selected.attempt.attemptId);if(confirmed){this.issues.delete(id);this.publish(id,queue.snapshot(root));}return confirmed?{status:'done'}:{status:'unknown',message:'Delivery remains unconfirmed after restart. Review the original conversation '+selected.attempt.alias.conversationId+'. The saved message has not been resent.'};}
    this.issues.delete(id);
    // Interrupt promptly once, but do not reorder/resume until native composer cleanup is classified.
    const cleanup=transport.revokeAndWait(id);
    if(this.options.working(id))this.options.manager.sendInput(id,'\x1b');
    await cleanup;
    await queue.prioritize(root,action.itemId,b.incarnation,false);
    transport.requestIdle(id); return { status: 'done' };
   }
   if (action.kind === 'clear') {
    const c = await queue.freezeForClear(root,b.incarnation); b.clearId = c.clearId;
    await transport.revokeAndWait(id); await queue.beginClear(root,c.clearId);
    const result = await this.options.bridge.executeQueueClear(id,c.clearId);
    if (result.status !== 'accepted' || !result.claudeSessionId) return { status: 'unknown', message: 'Clear was not confirmed. Queued messages remain paused.' };
    await this.identityChanged(id,'clear',result.claudeSessionId); return { status: 'done' };
   }
   return { status: 'rejected', message: 'Unsupported queue operation.' };
  } catch (error) { return { status: 'rejected', message: error instanceof Error ? error.message : 'Queue action could not be confirmed.' }; }
 }
 async forget(id: string): Promise<void> {
  const b = this.bindings.get(id); if (!b) return;
  if (this.service) { const s = await this.service; await s.transport.unbind(id); if (b.queueId) {
    const r=s.queue.snapshot(b.queueId);
    // Closing a fully resolved queue can retire its old namespace; stale queueId/epoch requests cannot recreate it.
    if(!r.items.length&&!s.queue.hasWriteBarrier(b.queueId)&&(r.tombstones.length||r.cancelledCheckouts.length))await s.queue.rotateSendEpoch(b.queueId,r.sendEpoch);
    await s.queue.close(b.queueId,b.incarnation);
   } }
  this.bindings.delete(id);
 }
 async close(): Promise<void> {
  this.closed = true; this.options.bridge.off('native-ready',this.onReady); this.options.bridge.off('state',this.onState);
  for (const id of [...this.bindings.keys()]) await this.forget(id);
  if (this.service) await (await this.service).transport.close();
 }
}
