import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { ClaudeQueue } from '../src/main/claude-queue';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeQueueRuntime } from '../src/main/claude-queue-runtime';
import type { ClaudeQueueTransport } from '../src/main/claude-queue-transport';
const roots: string[] = [];
function deferred() { let resolve!: () => void; const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve}; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'queue-runtime-')); roots.push(root);
 const bridge = Object.assign(new EventEmitter(), { attachQueueTransport: vi.fn(), setQueueInitializer: vi.fn(), isReady: ():boolean => true, executeQueueClear: vi.fn(async () => ({ status: 'accepted', requestId: 'clear', claudeSessionId: 'new-conversation' })) });
 const manager = { getSession: () => ({ id: 's', cwd: root, provider: 'claude' }), sendInput: vi.fn(() => true), queueWorkerCommand: vi.fn(async (_id: string, command: {type:string}) => ({ status: command.type==='queue-acquire'?'owned':command.type==='queue-release'?'released':'revoked' })) };
 const publish = vi.fn(); const noteSend = vi.fn(); let safe = false;
 const runtime = new ClaudeQueueRuntime({ userDataRoot: () => root, bridge: bridge as any, manager: manager as any, inputSafe: () => safe, working: () => false, publish, noteSend });
 bridge.emit('native-ready', 's', 'inc'); bridge.emit('state', 's', { claudeSessionId: 'conversation', turnId: null });
 await vi.waitFor(async () => expect((await runtime.action('s', { kind: 'identity' })).status).toBe('identity'));
 return { root, bridge, manager, runtime, publish, noteSend, safe: () => { safe = true; } };
}
describe('instance-owned Claude queue runtime', () => {
 it('says whether it ever accepted a send, without sending anything', async () => {
  const f=await fixture(); const identity=await f.runtime.action('s',{kind:'identity'}); if(identity.status!=='identity')throw Error('identity');
  await f.runtime.action('s',{kind:'enqueue',queueId:identity.identity.queueId,payload:{sendEpoch:identity.identity.sendEpoch,sendId:'arrived',originalText:'hi',displayContent:'hi',attachments:[]}});
  const enqueues=f.noteSend.mock.calls.length;
  expect(await f.runtime.action('s',{kind:'lookup',queueId:identity.identity.queueId,sendId:'arrived'})).toMatchObject({status:'lookup',found:true,identity:identity.identity});
  expect(await f.runtime.action('s',{kind:'lookup',queueId:identity.identity.queueId,sendId:'never-sent'})).toMatchObject({status:'lookup',found:false});
  expect(await f.runtime.action('s',{kind:'lookup',queueId:'00000000-0000-4000-8000-000000000000',sendId:'arrived'})).toMatchObject({status:'unknown'});
  expect(f.noteSend.mock.calls.length).toBe(enqueues);
  await f.runtime.close();
 });
 it('keeps an idle-ready send quiet until it genuinely waits or becomes unconfirmed', async () => {
  const f=await fixture(); f.safe(); const identity=await f.runtime.action('s',{kind:'identity'}); if(identity.status!=='identity')throw Error('identity');
  await f.runtime.action('s',{kind:'enqueue',queueId:identity.identity.queueId,payload:{sendEpoch:identity.identity.sendEpoch,sendId:'quiet',originalText:'hi',displayContent:'hi',attachments:[]}});
  expect(f.publish.mock.lastCall?.[1]).toMatchObject({queue:[]});
  const transport=f.bridge.attachQueueTransport.mock.lastCall![0] as ClaudeQueueTransport; await transport.poll('s','inc');
  const pending=transport.offer('s','inc',{boundaryId:'idle',boundarySeq:1,conversationId:'conversation',turnId:null,kind:'idle',expiresAt:Date.now()+10000});
  const staged=await transport.poll('s','inc'); expect(staged.kind).toBe('stage');
  expect(f.publish.mock.lastCall?.[1]).toMatchObject({queue:[]});
  await transport.event('s','inc',{kind:'unknown',attemptId:staged.lease!.attemptId,wireHash:staged.lease!.wireHash}); await pending;
  expect(f.publish.mock.lastCall?.[1]).toMatchObject({queue:[expect.objectContaining({status:'uncertain'})]});
  await f.runtime.close();
 });
 it('rotates drained full history only on deliberate identity lookup and retires resolved closed namespaces',async()=>{
  const f=await fixture();const old=await f.runtime.action('s',{kind:'identity'});if(old.status!=='identity')throw Error('identity');
  const original=ClaudeQueue.prototype.snapshot;const snapshot=vi.spyOn(ClaudeQueue.prototype,'snapshot').mockImplementation(function(this:ClaudeQueue,id:string){const r=original.call(this,id);r.cancelledCheckouts=Array.from({length:1024},(_,n)=>({checkoutId:'old-'+n,sessionId:'s',draftRevision:0}));return r;});
  let fresh;try{fresh=await f.runtime.action('s',{kind:'identity'});}finally{snapshot.mockRestore();}
  if(fresh.status!=='identity')throw Error('fresh identity');expect(fresh.identity.sendEpoch).not.toBe(old.identity.sendEpoch);
  expect(await f.runtime.action('s',{kind:'enqueue',queueId:old.identity.queueId,payload:{sendEpoch:old.identity.sendEpoch,sendId:'stale',originalText:'old',attachments:[],displayContent:'old'}})).toMatchObject({status:'rejected'});
  const q=await f.runtime.action('s',{kind:'enqueue',queueId:fresh.identity.queueId,payload:{sendEpoch:fresh.identity.sendEpoch,sendId:'new',originalText:'new',attachments:[],displayContent:'new'}});if(q.status!=='queued')throw Error('queued');
  await f.runtime.action('s',{kind:'remove',itemId:q.itemId});await f.runtime.forget('s');
  await expect(readFile(join(f.root,'claude-queues',fresh.identity.queueId+'.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});await f.runtime.close();
 });
 it('deliberate Stop sends exactly one Escape with an unhealthy bridge without waiting for cleanup', async () => {
  const f=await fixture();vi.spyOn(f.bridge,'isReady').mockReturnValue(false);
  expect(await f.runtime.action('s',{kind:'stop'})).toMatchObject({status:'done'});
  expect(f.manager.sendInput).toHaveBeenCalledExactlyOnceWith('s','\x1b');await f.runtime.close();
 });
 it('send-now waits for classified native cleanup before prioritizing', async () => {
  const f=await fixture();const identity=await f.runtime.action('s',{kind:'identity'});if(identity.status!=='identity')throw Error('identity');
  const q=await f.runtime.action('s',{kind:'enqueue',queueId:identity.identity.queueId,payload:{sendEpoch:identity.identity.sendEpoch,sendId:'selected',originalText:'selected',attachments:[],displayContent:'selected'}});if(q.status!=='queued')throw Error('enqueue');
  const transport=f.bridge.attachQueueTransport.mock.lastCall![0] as ClaudeQueueTransport;
  const barrier=deferred();const revoke=vi.spyOn(transport,'revokeAndWait').mockReturnValue(barrier.promise);const prioritize=vi.spyOn(ClaudeQueue.prototype,'prioritize');
  try {const sending=f.runtime.action('s',{kind:'send-now',itemId:q.itemId});await vi.waitFor(()=>expect(revoke).toHaveBeenCalled());expect(prioritize).not.toHaveBeenCalled();
   barrier.resolve();expect(await sending).toMatchObject({status:'done'});expect(prioritize).toHaveBeenCalledTimes(1);
  }finally{barrier.resolve();revoke.mockRestore();prioritize.mockRestore();await f.runtime.close();}
 });
 it('is lazy, receives actual identity and notes durable enqueue without a premature transcript bubble', async () => {
  const f = await fixture(); const identity = await f.runtime.action('s', { kind: 'identity' }); if (identity.status !== 'identity') throw Error('identity');
  const p = { sendEpoch: identity.identity.sendEpoch, sendId: 'one', originalText: 'exact @file', attachments: [], displayContent: 'display' };
  expect(await f.runtime.action('s', { kind: 'enqueue', queueId: identity.identity.queueId, payload: p })).toMatchObject({ status: 'queued' });
  expect(f.noteSend).toHaveBeenCalledWith('s', 'one'); expect(f.publish).toHaveBeenCalledWith('s', expect.objectContaining({ kind: 'queue', queue: [expect.objectContaining({ content: 'display', sendEpoch: p.sendEpoch })] }));
  await f.runtime.close();
 });
 it('awaits exact native cleanup before one Clear and accepts the authoritative identity hook before its receipt', async () => {
  const f=await fixture();f.safe();const identity=await f.runtime.action('s',{kind:'identity'});if(identity.status!=='identity')throw Error('identity');
  await f.runtime.action('s',{kind:'enqueue',queueId:identity.identity.queueId,payload:{sendEpoch:identity.identity.sendEpoch,sendId:'pending',originalText:'retain me',attachments:[],displayContent:'retain me'}});
  const transport=f.bridge.attachQueueTransport.mock.lastCall![0] as ClaudeQueueTransport;
  await transport.poll('s','inc'); // enqueue's idle wakeup
  const offered=transport.offer('s','inc',{boundaryId:'idle',boundarySeq:1,conversationId:'conversation',turnId:null,kind:'idle',expiresAt:Date.now()+15000});
  const staged=await transport.poll('s','inc');expect(staged.kind).toBe('stage');
  f.bridge.executeQueueClear.mockImplementation(async()=>{f.bridge.emit('state','s',{claudeSessionId:'new-conversation'});await f.runtime.identityChanged('s','clear','new-conversation');return {status:'accepted',requestId:'clear',claudeSessionId:'new-conversation'};});
  const clearing=f.runtime.action('s',{kind:'clear'});const revoke=await transport.poll('s','inc');expect(revoke.kind).toBe('revoke');expect(f.bridge.executeQueueClear).not.toHaveBeenCalled();
  await transport.event('s','inc',{kind:'revoked',attemptId:staged.lease!.attemptId,wireHash:staged.lease!.wireHash,composerSafe:true,beforeAdmission:true});
  expect(await clearing).toMatchObject({status:'done'});await offered;expect(f.bridge.executeQueueClear).toHaveBeenCalledTimes(1);
  expect(f.publish.mock.lastCall?.[1]).toMatchObject({paused:true,queue:[expect.objectContaining({content:'retain me',status:'waiting'})]});await f.runtime.close();
 });
 it('serializes duplicate Clear hooks, receipt and raw state without freezing the rebound queue again', async () => {
  const f=await fixture();const identity=await f.runtime.action('s',{kind:'identity'});if(identity.status!=='identity')throw Error('identity');
  const queued=await f.runtime.action('s',{kind:'enqueue',queueId:identity.identity.queueId,payload:{sendEpoch:identity.identity.sendEpoch,sendId:'retained',originalText:'keep',attachments:[],displayContent:'keep'}});if(queued.status!=='queued')throw Error('enqueue');
  const entered=deferred(),releaseRebind=deferred(),releaseDuplicate=deferred();
  const originalFreeze=ClaudeQueue.prototype.freezeForClear,originalRebind=ClaudeQueue.prototype.rebindAfterClear;let freezes=0;
  const freeze=vi.spyOn(ClaudeQueue.prototype,'freezeForClear').mockImplementation(async function(this:ClaudeQueue,...args){if(++freezes>2)await releaseDuplicate.promise;return originalFreeze.apply(this,args);});
  const rebind=vi.spyOn(ClaudeQueue.prototype,'rebindAfterClear').mockImplementation(async function(this:ClaudeQueue,...args){entered.resolve();await releaseRebind.promise;return originalRebind.apply(this,args);});
  try {
   f.bridge.executeQueueClear.mockImplementation(async()=>{
    const hook=f.runtime.identityChanged('s','clear','new-conversation');await entered.promise;
    const duplicate=f.runtime.identityChanged('s','clear','new-conversation');
    f.bridge.emit('state','s',{claudeSessionId:'new-conversation'});
    releaseRebind.resolve();await hook;releaseDuplicate.resolve();await duplicate;
    return {status:'accepted',requestId:'clear',claudeSessionId:'new-conversation'};
   });
   expect(await f.runtime.action('s',{kind:'clear'})).toMatchObject({status:'done'});
   await f.runtime.action('s',{kind:'identity'}); // drain the raw observation through the same binding chain
   const journal=JSON.parse(await readFile(join(f.root,'claude-queues',identity.identity.queueId+'.json'),'utf8'));
   expect(journal).toMatchObject({alias:{conversationId:'new-conversation'},clear:{phase:'rebound'},paused:true,quarantines:[]});
   expect(freezes).toBe(2);
   expect(await f.runtime.action('s',{kind:'send-now',itemId:queued.itemId})).toMatchObject({status:'done'});
   expect(f.publish.mock.lastCall?.[1]).toMatchObject({paused:false});
   // An outside identity change (in-terminal /resume) rebinds rather than freezing the session for good;
   // the retained message is paused again, never auto-delivered into the other conversation.
   await f.runtime.identityChanged('s','resume','external-conversation');
   expect(JSON.parse(await readFile(join(f.root,'claude-queues',identity.identity.queueId+'.json'),'utf8'))).toMatchObject({alias:{conversationId:'external-conversation'},paused:true});
  } finally {releaseRebind.resolve();releaseDuplicate.resolve();freeze.mockRestore();rebind.mockRestore();await f.runtime.close();}
 });
 it('pauses retained messages around Clear and uses one authorized command, preserving the current-only Stop byte', async () => {
  const f = await fixture(); const identity = await f.runtime.action('s', { kind: 'identity' }); if (identity.status !== 'identity') throw Error('identity');
  await f.runtime.action('s', { kind: 'enqueue', queueId: identity.identity.queueId, payload: { sendEpoch: identity.identity.sendEpoch, sendId: 'one', originalText: 'keep', attachments: [], displayContent: 'keep' } });
  expect(await f.runtime.action('s', { kind: 'stop' })).toMatchObject({ status: 'done' }); expect(f.manager.sendInput).toHaveBeenCalledExactlyOnceWith('s', '\x1b');
  expect(await f.runtime.action('s', { kind: 'clear' })).toMatchObject({ status: 'done' });
  expect(f.bridge.executeQueueClear).toHaveBeenCalledTimes(1); expect(f.publish.mock.lastCall?.[1]).toMatchObject({ paused: true, queue: [expect.objectContaining({ content: 'keep' })] });
  await f.runtime.close();
 });
 it('keeps sending after Claude Code changes conversation on its own (plan "clear context", terminal /clear)', async () => {
  const f=await fixture();
  f.bridge.emit('state','s',{claudeSessionId:'cleared-elsewhere',turnId:null});
  await f.runtime.identityChanged('s','clear','cleared-elsewhere');
  const id=await f.runtime.action('s',{kind:'identity'});if(id.status!=='identity')throw Error('identity');
  // Before the fix every later send was refused with "Conversation identity changed" until the session was reopened.
  expect(await f.runtime.action('s',{kind:'enqueue',queueId:id.identity.queueId,payload:{sendEpoch:id.identity.sendEpoch,sendId:'after',originalText:'hello',attachments:[],displayContent:'hello'}})).toMatchObject({status:'queued'});
  await f.runtime.close();
 });
});
