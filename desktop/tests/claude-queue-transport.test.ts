import { describe, it, expect, vi } from 'vitest';
import { ClaudeQueue } from '../src/main/claude-queue';
import { ClaudeQueueTransport } from '../src/main/claude-queue-transport';
import type { QueueJournal, QueueStorage } from '../src/shared/conversation-queue-types';

async function fixture(inputSafe: () => boolean = () => true) {
  const records = new Map<string, QueueJournal>();
  const storage: QueueStorage = { load: async () => [], save: async r => { records.set(r.queueId, structuredClone(r)); }, retire: async id => { records.delete(id); } };
  const queue = new ClaudeQueue({ storage, ready: () => true }); await queue.restore();
  const alias = { provider: 'claude' as const, conversationId: 'conversation' }; const id = await queue.bind(alias, 'incarnation');
  const worker = vi.fn(async (_session: string, op: { type: string }) => ({ status: op.type === 'queue-acquire' ? 'owned' : op.type === 'queue-enter' ? 'entered' : ['queue-release','queue-abandon'].includes(op.type) ? 'released' : 'revoked' }));
  const transport = new ClaudeQueueTransport({ queue, worker, inputSafe, prepare: async p => ({ wireText: p.originalText, files: [] }) });
  transport.bind('app', { queueId: id, incarnation: 'incarnation', alias, cwd: '/tmp' });
  const add = (sendId = 's', text = 'head') => queue.enqueue(id, { sendEpoch: queue.snapshot(id).sendEpoch, sendId, originalText: text, displayContent: text, attachments: [] });
  const offer = (seq = 1, kind: 'batch' | 'idle' = 'batch', extra = {}) => ({ boundaryId: 'boundary-' + seq, boundarySeq: seq, conversationId: 'conversation', turnId: kind === 'batch' ? 'turn' : null, kind, expiresAt: Date.now() + 10000, ...extra });
  return { queue, id, transport, worker, add, offer, records, storage };
}
async function stage(f: Awaited<ReturnType<typeof fixture>>) {
  const op = await f.transport.poll('app', 'incarnation'); expect(op.kind).toBe('stage');
  await f.transport.event('app', 'incarnation', { kind: 'staged', attemptId: op.lease!.attemptId, wireHash: op.lease!.wireHash });
  return op.lease!;
}
describe('Claude queue transport', () => {
  it('dismisses unknown without replay, ignores late evidence, then drains fresh idle and batch cycles', async () => {
    const f = await fixture(); const original = await f.add();
    const pending = f.transport.offer('app','incarnation',f.offer()); const old = await stage(f);
    await f.transport.event('app','incarnation',{kind:'unknown',attemptId:old.attemptId,wireHash:old.wireHash}); await pending;
    const dismiss = f.transport.dismiss('app', original.item.queueItemId);
    expect(f.transport.dismiss('app', original.item.queueItemId)).toBe(dismiss);
    const op = await f.transport.poll('app','incarnation'); expect(op.kind).toBe('abandon');
    expect(f.worker.mock.calls.at(-1)?.[1].type).toBe('queue-revoke');
    await f.transport.event('app','incarnation',{kind:'abandoned',attemptId:old.attemptId,wireHash:old.wireHash}); await dismiss;
    expect(f.queue.snapshot(f.id)).toMatchObject({items:[],quarantines:[],paused:false,tombstones:[{reason:'dismissed'}]});
    await f.transport.dismiss('app', original.item.queueItemId);
    for (const kind of ['staged','admitted','accepted','transcript','revoked','unknown','recovered']) await f.transport.event('app','incarnation',{kind,attemptId:old.attemptId,wireHash:old.wireHash,uuid:'late-row'});
    expect(f.transport.canControl('app')).toBe(true);
    expect((await f.add()).duplicate).toBe(true);
    for (const [seq, kind] of [[2,'idle'],[3,'batch'],[4,'batch']] as const) {
      if (seq === 2) await f.add('fresh-2');
      const next = f.transport.offer('app','incarnation',f.offer(seq,kind)); const lease = await stage(f);
      if (seq === 2) { await f.add('fresh-3'); await f.add('fresh-4'); }
      await f.transport.event('app','incarnation',{kind:'accepted',attemptId:lease.attemptId,wireHash:lease.wireHash});
      await f.transport.event('app','incarnation',{kind:'transcript',attemptId:lease.attemptId,wireHash:lease.wireHash,uuid:'row-'+seq}); await next;
    }
    expect(f.queue.snapshot(f.id).items).toHaveLength(0);
    expect(f.worker.mock.calls.filter(c=>c[1].type==='queue-enter')).toHaveLength(4);
    await f.transport.close();
    f.storage.load = async () => structuredClone([...f.records.values()]);
    const restored = new ClaudeQueue({storage:f.storage,ready:()=>true}); await restored.restore(); await restored.bind({provider:'claude',conversationId:'conversation'},'reloaded');
    const transport = new ClaudeQueueTransport({queue:restored,worker:f.worker,inputSafe:()=>true}); transport.bind('new',{queueId:f.id,incarnation:'reloaded',alias:{provider:'claude',conversationId:'conversation'},cwd:'/tmp'});
    const calls=f.worker.mock.calls.length;
    await transport.dismiss('new',original.item.queueItemId);
    await transport.event('new','reloaded',{kind:'unknown',attemptId:old.attemptId,wireHash:old.wireHash});
    expect(transport.canControl('new')).toBe(true); expect(f.worker).toHaveBeenCalledTimes(calls);
    expect((await restored.enqueue(f.id,{sendEpoch:restored.snapshot(f.id).sendEpoch,sendId:'s',originalText:'head',displayContent:'head',attachments:[]})).duplicate).toBe(true);
    await transport.close();
  });
  it('never revokes a new queue lease when the dismissed attempt receives a delayed worker ACK', async () => {
    const f=await fixture(); const first=await f.add(); const original=f.worker.getMockImplementation()!;
    let release!:(value:{status:string})=>void;
    f.worker.mockImplementation(async(id,op)=>op.type==='queue-enter'&& !release ? new Promise<{status:string}>(r=>{release=r;}):original(id,op));
    const offered=f.transport.offer('app','incarnation',f.offer()); const op=await f.transport.poll('app','incarnation'); const old=op.lease!;
    const oldEnter=f.transport.event('app','incarnation',{kind:'staged',attemptId:old.attemptId,wireHash:old.wireHash});
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    await f.transport.event('app','incarnation',{kind:'unknown',attemptId:old.attemptId,wireHash:old.wireHash}); await offered;
    const dismissed=f.transport.dismiss('app',first.item.queueItemId); expect((await f.transport.poll('app','incarnation')).kind).toBe('abandon');
    await f.transport.event('app','incarnation',{kind:'abandoned',attemptId:old.attemptId,wireHash:old.wireHash}); await dismissed;
    await f.add('fresh'); const next=f.transport.offer('app','incarnation',f.offer(2)); const fresh=await stage(f);
    release({status:'revoked'}); await oldEnter;
    expect(f.worker.mock.calls.filter(c=>c[1].type==='queue-revoke')).toHaveLength(1);
    expect(f.queue.snapshot(f.id).items[0]).toMatchObject({status:'delivering',attempt:{attemptId:fresh.attemptId}});
    await f.transport.event('app','incarnation',{kind:'accepted',attemptId:fresh.attemptId,wireHash:fresh.wireHash}); await next; await f.transport.close();
  });
  it('does not flush paused waiting intent when an unknown is dismissed', async () => {
    const f = await fixture(); const first = await f.add(); const pending = f.transport.offer('app','incarnation',f.offer()); const lease = await stage(f);
    await f.add('paused'); await f.transport.event('app','incarnation',{kind:'unknown',attemptId:lease.attemptId,wireHash:lease.wireHash}); await pending;
    const dismiss = f.transport.dismiss('app',first.item.queueItemId); expect((await f.transport.poll('app','incarnation')).kind).toBe('abandon');
    await f.transport.event('app','incarnation',{kind:'abandoned',attemptId:lease.attemptId,wireHash:lease.wireHash}); await dismiss;
    expect(f.queue.snapshot(f.id)).toMatchObject({paused:true,quarantines:[],items:[{sendId:'paused',status:'waiting'}]});
    expect(f.transport.canControl('app')).toBe(true); // paused intent does not own live conversation input
    await f.transport.offer('app','incarnation',f.offer(2)); expect(f.worker.mock.calls.filter(c=>c[1].type==='queue-enter')).toHaveLength(1);
    await f.queue.enqueue(f.id,{sendEpoch:f.queue.snapshot(f.id).sendEpoch,sendId:'manual',originalText:'new manual',displayContent:'new manual',attachments:[]},undefined,true);
    const next=f.transport.offer('app','incarnation',f.offer(3,'idle')); const fresh=await stage(f);
    expect(fresh.sendId).toBe('manual');
    // New intent during this fresh task must form a reusable queue, independently
    // of the OLD paused item. Neither LIFO promotion nor a permanent global pause is allowed.
    await f.add('fresh-queued-one'); await f.add('fresh-queued-two');
    expect(f.queue.snapshot(f.id).items.find(i=>i.sendId==='fresh-queued-one')).toMatchObject({pauseBypass:true});
    await f.transport.event('app','incarnation',{kind:'accepted',attemptId:fresh.attemptId,wireHash:fresh.wireHash});
    await f.transport.event('app','incarnation',{kind:'transcript',attemptId:fresh.attemptId,wireHash:fresh.wireHash,uuid:'manual-row'}); await next;
    for(const [seq,sendId] of [[4,'fresh-queued-one'],[5,'fresh-queued-two']] as const){
      const draining=f.transport.offer('app','incarnation',f.offer(seq)); const queued=await stage(f); expect(queued.sendId).toBe(sendId);
      await f.transport.event('app','incarnation',{kind:'accepted',attemptId:queued.attemptId,wireHash:queued.wireHash});
      await f.transport.event('app','incarnation',{kind:'transcript',attemptId:queued.attemptId,wireHash:queued.wireHash,uuid:sendId}); await draining;
    }
    expect(f.queue.snapshot(f.id)).toMatchObject({paused:true,items:[{sendId:'paused',status:'waiting'}]});
    await f.transport.close();
  });
  it('keeps restored uncertain attempts read-only with original-conversation guidance rather than inventing an armed lease',async()=>{
    const f=await fixture();await f.add();const claim=await f.queue.claim(f.id,{boundaryId:'old-boundary',boundarySeq:1,incarnation:'incarnation',alias:{provider:'claude',conversationId:'conversation'},wireHash:'a'.repeat(64)});if(!claim)throw Error('claim');
    await f.queue.close(f.id,'incarnation');await f.transport.close();f.storage.load=async()=>structuredClone([...f.records.values()]);
    const restored=new ClaudeQueue({storage:f.storage,ready:()=>true});await restored.restore();await restored.bind({provider:'claude',conversationId:'conversation'},'new-incarnation');
    const onIssue=vi.fn();const transport=new ClaudeQueueTransport({queue:restored,worker:f.worker,inputSafe:()=>true,onIssue});transport.bind('new',{queueId:f.id,incarnation:'new-incarnation',alias:{provider:'claude',conversationId:'conversation'},cwd:'/tmp'});
    const checking=transport.reconcile('new',claim.attempt.attemptId);const query=await transport.poll('new','new-incarnation');
    expect(query).toMatchObject({kind:'evidence',attempt:claim.attempt});expect(query.lease).toBeUndefined();
    await transport.event('new','new-incarnation',{kind:'recovered',attemptId:claim.attempt.attemptId,wireHash:claim.attempt.wireHash});
    expect(await checking).toBe(false);expect(onIssue).toHaveBeenCalledWith('new',expect.objectContaining({message:expect.stringContaining('original conversation conversation')}));expect(f.worker).not.toHaveBeenCalled();expect(transport.canControl('new')).toBe(false);
    expect(restored.snapshot(f.id).items[0]).toMatchObject({status:'uncertain',attempt:{incarnation:'incarnation',alias:{conversationId:'conversation'}}});await transport.close();
  });
  it('confirms only requested durable original-attempt UUID evidence across restart without worker effects or replay', async () => {
    const f=await fixture();await f.add();const claim=await f.queue.claim(f.id,{boundaryId:'original-boundary',boundarySeq:1,incarnation:'incarnation',alias:{provider:'claude',conversationId:'conversation'},wireHash:'a'.repeat(64)});if(!claim)throw Error('claim');
    await f.queue.close(f.id,'incarnation');await f.transport.close();f.storage.load=async()=>structuredClone([...f.records.values()]);
    const queue=new ClaudeQueue({storage:f.storage,ready:()=>true});await queue.restore();await queue.bind({provider:'claude',conversationId:'conversation'},'restarted');
    const verifyEvidence=vi.fn(async()=>true);const transport=new ClaudeQueueTransport({queue,worker:f.worker,inputSafe:()=>true,verifyEvidence});transport.bind('new',{queueId:f.id,incarnation:'restarted',alias:{provider:'claude',conversationId:'conversation'},cwd:'/tmp'});
    const evidence={kind:'recovered',attemptId:claim.attempt.attemptId,wireHash:claim.attempt.wireHash,uuid:'durable-original-row'};
    await expect(transport.event('new','restarted',evidence)).rejects.toThrow('Unrequested');
    const checking=transport.reconcile('new',claim.attempt.attemptId);const op=await transport.poll('new','restarted');expect(op.kind).toBe('evidence');expect(op.attempt?.incarnation).toBe('incarnation');expect(op.lease).toBeUndefined();
    await expect(transport.event('new','incarnation',evidence)).rejects.toThrow('Stale');
    await expect(transport.event('new','restarted',{...evidence,wireHash:'b'.repeat(64)})).rejects.toThrow('Unrequested');
    expect(queue.snapshot(f.id).items).toHaveLength(1);
    await transport.event('new','restarted',evidence);expect(await checking).toBe(true);
    expect(queue.snapshot(f.id)).toMatchObject({paused:true,quarantines:[],items:[],tombstones:[{reason:'confirmed',transcriptUuid:'durable-original-row',attempt:{incarnation:'incarnation',alias:{conversationId:'conversation'}}}]});
    expect(f.worker).not.toHaveBeenCalled();await transport.close();
  });
  it('forgets a safely returned pre-worker claim so a fresh boundary can claim after input safety recovers', async () => {
    let safe = true; const f = await fixture(() => safe); await f.add(); const original = f.storage.save;
    let commit!: () => void; f.storage.save = async (...args) => { await new Promise<void>(r => { commit = r; }); await original(...args); f.storage.save = original; };
    const pending = f.transport.offer('app','incarnation',f.offer());
    await vi.waitFor(() => expect(commit).toBeTypeOf('function')); safe = false; commit(); await pending;
    expect(f.queue.snapshot(f.id).items[0].status).toBe('waiting'); expect(f.worker).not.toHaveBeenCalled();
    safe = true; const next = f.transport.offer('app','incarnation',f.offer(2)); const lease = await stage(f);
    await f.transport.event('app','incarnation',{kind:'accepted',attemptId:lease.attemptId,wireHash:lease.wireHash}); await next; await f.transport.close();
  });
  it('releases no-work and nested-agent offers without claiming or writing', async () => {
    const f = await fixture();
    expect(await f.transport.offer('app', 'incarnation', f.offer())).toEqual({ released: true });
    await f.add(); expect(await f.transport.offer('app', 'incarnation', f.offer(2, 'batch', { agentId: 'nested' }))).toEqual({ released: true });
    expect(f.worker).not.toHaveBeenCalled(); await f.transport.close();
  });
  it('claims durably, stages once, enters once and records native acceptance separately from matching transcript', async () => {
    const f = await fixture(); await f.add(); await f.add('next', 'head-two');
    const pending = f.transport.offer('app', 'incarnation', f.offer());
    const lease = await stage(f); expect(f.queue.snapshot(f.id).items[0].status).toBe('delivering');
    expect(f.worker.mock.calls.map(c => c[1].type)).toEqual(['queue-acquire', 'queue-enter']);
    await f.transport.event('app', 'incarnation', { kind: 'admitted', attemptId: lease.attemptId, wireHash: lease.wireHash });
    expect(f.queue.snapshot(f.id).items[0].attempt?.admission).toBe(lease.attemptId);
    await f.transport.event('app', 'incarnation', { kind: 'accepted', attemptId: lease.attemptId, wireHash: lease.wireHash });
    await pending; expect(f.queue.snapshot(f.id).items[0].attempt?.receipt).toBe(lease.attemptId);
    expect(f.queue.snapshot(f.id).items).toHaveLength(2);
    await f.transport.event('app', 'incarnation', { kind: 'transcript', attemptId: lease.attemptId, wireHash: lease.wireHash, uuid: 'real-human-row' });
    expect(f.queue.snapshot(f.id).items.map(i => i.sendId)).toEqual(['next']);
    const second = f.transport.offer('app', 'incarnation', f.offer(2)); const next = await stage(f);
    await f.transport.event('app', 'incarnation', { kind: 'accepted', attemptId: next.attemptId, wireHash: next.wireHash }); await second;
    await f.transport.close();
  });
  it('accepts transcript-before-receipt ordering and only permits Clear through the durable execution gate', async () => {
    const f = await fixture(); await f.add(); const pending = f.transport.offer('app', 'incarnation', f.offer()); const lease = await stage(f);
    await f.transport.event('app', 'incarnation', { kind: 'transcript', attemptId: lease.attemptId, wireHash: lease.wireHash, uuid: 'actual-row' });
    await f.transport.event('app', 'incarnation', { kind: 'accepted', attemptId: lease.attemptId, wireHash: lease.wireHash }); await pending;
    const c = await f.queue.freezeForClear(f.id, 'incarnation'); expect(f.transport.canExecuteClear('app', c.clearId)).toBe(false);
    await f.queue.beginClear(f.id, c.clearId); expect(f.transport.canExecuteClear('app', c.clearId)).toBe(true);
    expect(f.transport.canControl('app')).toBe(false); await f.transport.close();
  });
  it('retains a write barrier on unknown worker release and retries only that safe release, never Enter', async () => {
    const f = await fixture(); await f.add(); const pending = f.transport.offer('app', 'incarnation', f.offer()); const lease = await stage(f);
    const original = f.worker.getMockImplementation()!;
    f.worker.mockImplementationOnce(async (_id, op) => op.type === 'queue-release' ? { status: 'unknown' } : original(_id, op));
    await expect(f.transport.event('app', 'incarnation', { kind: 'accepted', attemptId: lease.attemptId, wireHash: lease.wireHash })).rejects.toThrow(/ownership release/);
    await pending; expect(f.transport.canControl('app')).toBe(false);
    await f.transport.retryWorkerRelease('app', lease.attemptId); expect(f.transport.canControl('app')).toBe(true);
    expect(f.worker.mock.calls.filter(c => c[1].type === 'queue-enter')).toHaveLength(1); await f.transport.close();
  });
  it('returns an untouched lease when input safety changes during worker acquisition instead of revoking an unseen native identity', async () => {
    let safe = true; const f = await fixture(() => safe); await f.add();
    const original = f.worker.getMockImplementation()!;
    f.worker.mockImplementation(async (id, op) => { const result = await original(id,op); if(op.type === 'queue-acquire') safe = false; return result; });
    const pending = f.transport.offer('app','incarnation',f.offer());
    try {
      await vi.waitFor(() => expect(f.worker.mock.calls.some(c => c[1].type === 'queue-revoke')).toBe(true));
      expect(f.queue.snapshot(f.id).items[0].status).toBe('waiting');
      expect(f.queue.snapshot(f.id).items[0].attempt).toBeUndefined();
      f.worker.mockImplementation(original); safe = true;
      const next = f.transport.offer('app','incarnation',f.offer(2)); const lease = await stage(f);
      await f.transport.event('app','incarnation',{kind:'accepted',attemptId:lease.attemptId,wireHash:lease.wireHash}); await next;
    } finally { await f.transport.close(); await pending; }
  });
  it('uses a fresh native idle offer to finish only an accepted input safe release', async () => {
    let safe = true; const f = await fixture(() => safe); await f.add();
    const pending = f.transport.offer('app', 'incarnation', f.offer()); const lease = await stage(f);
    safe = false;
    await expect(f.transport.event('app', 'incarnation', { kind: 'accepted', attemptId: lease.attemptId, wireHash: lease.wireHash })).rejects.toThrow('Input is still blocked');
    await pending;
    await f.transport.event('app', 'incarnation', { kind: 'transcript', attemptId: lease.attemptId, wireHash: lease.wireHash, uuid: 'kept-row' });
    await f.transport.offer('app', 'incarnation', f.offer(2, 'idle'));
    expect(f.worker.mock.calls.filter(c => c[1].type === 'queue-release')).toHaveLength(0);
    safe = true; await f.transport.offer('app', 'incarnation', f.offer(3, 'idle'));
    expect(f.worker.mock.calls.filter(c => c[1].type === 'queue-release')).toHaveLength(1);
    expect(f.worker.mock.calls.filter(c => c[1].type === 'queue-enter')).toHaveLength(1);
    expect(f.transport.canControl('app')).toBe(true); await f.transport.close();
  });
  it('does not flush buffered ordinary writers into a popup even after our own native input was accepted', async () => {
    let safe = true; const f = await fixture(() => safe); await f.add(); const pending = f.transport.offer('app', 'incarnation', f.offer()); const lease = await stage(f);
    safe = false;
    await expect(f.transport.event('app', 'incarnation', { kind: 'accepted', attemptId: lease.attemptId, wireHash: lease.wireHash })).rejects.toThrow(/Input is still blocked/);
    await pending; expect(f.worker.mock.calls.filter(c => c[1].type === 'queue-release')).toHaveLength(0);
    expect(f.transport.canControl('app')).toBe(false); safe = true;
    await f.transport.retryWorkerRelease('app', lease.attemptId); expect(f.worker.mock.calls.filter(c => c[1].type === 'queue-release')).toHaveLength(1);
    await f.transport.close();
  });
  it('keeps lost/ambiguous receipts uncertain without automatic replay and blocks commands', async () => {
    const f = await fixture(); await f.add(); const pending = f.transport.offer('app', 'incarnation', f.offer());
    const lease = await stage(f); await f.transport.event('app', 'incarnation', { kind: 'unknown', attemptId: lease.attemptId, wireHash: lease.wireHash }); await pending;
    expect(f.queue.snapshot(f.id)).toMatchObject({ paused: true, items: [{ status: 'uncertain' }] });
    expect(f.transport.canControl('app')).toBe(false);
    await f.transport.offer('app', 'incarnation', f.offer(2)); expect(f.worker.mock.calls.filter(c => c[1].type === 'queue-enter')).toHaveLength(1);
    await f.transport.close();
  });
  it('revokes before final Enter, retains newer human draft and never classifies uncertain staging as not sent', async () => {
    const f = await fixture(); await f.add(); const pending = f.transport.offer('app', 'incarnation', f.offer());
    const stageOp = await f.transport.poll('app', 'incarnation');
    await f.transport.revoke('app');
    const cleanup = await f.transport.poll('app', 'incarnation'); expect(cleanup.kind).toBe('revoke');
    await f.transport.event('app', 'incarnation', { kind: 'revoked', attemptId: stageOp.lease!.attemptId, wireHash: stageOp.lease!.wireHash, composerSafe: false, beforeAdmission: true });
    await pending; expect(f.worker.mock.calls.filter(c => c[1].type === 'queue-enter')).toHaveLength(0);
    expect(f.queue.snapshot(f.id).items[0].status).toBe('uncertain'); await f.transport.close();
  });
  it('supports idle readiness, stale-incarnation rejection and expired offers with no effects', async () => {
    const f = await fixture(); await f.add();
    await f.transport.offer('app', 'wrong', f.offer()); await f.transport.offer('app', 'incarnation', f.offer(2, 'batch', { expiresAt: Date.now() - 1 }));
    expect(f.worker).not.toHaveBeenCalled();
    const pending = f.transport.offer('app', 'incarnation', f.offer(3, 'idle')); const lease = await stage(f);
    expect(lease.turnId).toBeNull();
    await f.transport.event('app', 'incarnation', { kind: 'accepted', attemptId: lease.attemptId, wireHash: lease.wireHash }); await pending; await f.transport.close();
  });
  it('does not deliver a prepared head under a different item identity when priority changes during file preparation', async () => {
    const f = await fixture(); await f.add(); const second = await f.add('two', 'different text');
    const t = new ClaudeQueueTransport({ queue: f.queue, worker: f.worker, inputSafe: () => true, prepare: async p => { await f.queue.prioritize(f.id, second.item.queueItemId, 'incarnation'); return { wireText: p.originalText, files: [] }; } });
    t.bind('race', { queueId: f.id, incarnation: 'incarnation', alias: { provider: 'claude', conversationId: 'conversation' }, cwd: '/tmp' });
    await t.offer('race', 'incarnation', f.offer());
    expect(f.worker).not.toHaveBeenCalled(); expect(f.queue.snapshot(f.id).items.every(i => i.status === 'waiting')).toBe(true);
    await t.close(); await f.transport.close();
  });
  it('fails closed for a popup and refuses formatter overflow rather than truncating', async () => {
    const f = await fixture(); await f.add();
    const blocked = new ClaudeQueueTransport({ queue: f.queue, worker: f.worker, inputSafe: () => false }); blocked.bind('blocked', { queueId: f.id, incarnation: 'incarnation', alias: { provider: 'claude', conversationId: 'conversation' }, cwd: '/tmp' });
    await blocked.offer('blocked', 'incarnation', f.offer()); expect(f.worker).not.toHaveBeenCalled(); await blocked.close();
    const overflow = new ClaudeQueueTransport({ queue: f.queue, worker: f.worker, inputSafe: () => true, prepare: async () => ({ wireText: 'x'.repeat(262145), files: [] }) }); overflow.bind('overflow', { queueId: f.id, incarnation: 'incarnation', alias: { provider: 'claude', conversationId: 'conversation' }, cwd: '/tmp' });
    await overflow.offer('overflow', 'incarnation', f.offer(2)); expect(f.worker).not.toHaveBeenCalled(); expect(f.queue.snapshot(f.id).items[0].status).toBe('waiting'); await overflow.close(); await f.transport.close();
  });
});
