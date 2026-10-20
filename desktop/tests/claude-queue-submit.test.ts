// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { queueBrowserStorage } from './helpers/queue-browser-storage';
beforeEach(()=>Object.defineProperty(window,'localStorage',{value:queueBrowserStorage(),configurable:true}));
import { sendToClaudeCode } from '../src/renderer/state/submit-outgoing';
import { pendingQueueSend } from '../src/renderer/state/pending-queue-send';
afterEach(()=>{delete(window as any).claude;window.localStorage.clear();});
describe('host queued Claude submission',()=>{
 it('captures root/epoch once, preserves original text/files and draws no premature or transformed-wire bubble',async()=>{
  const dispatch=vi.fn(),sendInput=vi.fn();const action=vi.fn(async(_sid:string,a:any)=>a.kind==='identity'?{status:'identity',identity:{queueId:'root',sendEpoch:'epoch'}}:{status:'queued',identity:{queueId:'root',sendEpoch:'epoch'},itemId:'item',sendId:a.payload.sendId});
  (window as any).claude={session:{queue:{action},sendInput}};
  sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'sanitized',originalText:'é\nexact @file',content:'display',paths:['/tmp/image'],dispatch});
  await vi.waitFor(()=>expect(action).toHaveBeenCalledTimes(2));
  expect(action.mock.calls[1][1]).toMatchObject({queueId:'root',payload:{sendEpoch:'epoch',originalText:'é\nexact @file',attachments:['/tmp/image'],displayContent:'display'}});
  expect(dispatch).not.toHaveBeenCalled();expect(sendInput).not.toHaveBeenCalled();
 });
 it('keeps identical rapid user intents distinct while the first enqueue acknowledgement is pending',async()=>{
  const requests:any[]=[];const releases:(()=>void)[]=[];
  const action=vi.fn(async(_sid:string,a:any)=>{if(a.kind==='identity')return{status:'identity',identity:{queueId:'root',sendEpoch:'epoch'}};requests.push(structuredClone(a));await new Promise<void>(r=>releases.push(r));return{status:'queued'};});
  (window as any).claude={session:{queue:{action},sendInput:vi.fn()}};
  const outgoing={sessionId:'rapid',provider:'claude' as const,ptyText:'hi',content:'hi',paths:[],dispatch:vi.fn()};
  sendToClaudeCode(outgoing);await vi.waitFor(()=>expect(requests).toHaveLength(1));
  sendToClaudeCode(outgoing);await vi.waitFor(()=>expect(requests).toHaveLength(2));
  const ids=requests.map(r=>r.payload.sendId);
  releases.forEach(r=>r());await vi.waitFor(()=>expect(pendingQueueSend('rapid')).toBeUndefined());
  expect(new Set(ids).size).toBe(2);
 });
 it('persists an uncertain enqueue across renderer reload and retries the identical root epoch send ID and files',async()=>{
  const requests:any[]=[];const action=vi.fn(async(_sid:string,a:any)=>{if(a.kind==='identity')return{status:'identity',identity:{queueId:'original-root',sendEpoch:'original-epoch'}};requests.push(structuredClone(a));if(requests.length===1)throw Error('lost ack');return{status:'queued'};});
  (window as any).claude={session:{queue:{action},sendInput:vi.fn()}};
  const outgoing={sessionId:'s',provider:'claude' as const,ptyText:'exact',content:'display',paths:['/tmp/image'],dispatch:vi.fn()};sendToClaudeCode(outgoing);
  await vi.waitFor(()=>expect(requests).toHaveLength(1));expect(pendingQueueSend('s')?.payload.sendEpoch).toBe('original-epoch');
  vi.resetModules();const reloaded=await import('../src/renderer/state/submit-outgoing');reloaded.sendToClaudeCode(outgoing);
  await vi.waitFor(()=>expect(requests).toHaveLength(2));expect(requests[1]).toEqual(requests[0]);expect(action.mock.calls.filter(([,a])=>a.kind==='identity')).toHaveLength(1);
  await vi.waitFor(()=>expect(pendingQueueSend('s')).toBeUndefined());
 });
 it('never falls back to CR or creates a pending transcript bubble after an uncertain enqueue',async()=>{
  const dispatch=vi.fn(),sendInput=vi.fn();const action=vi.fn(async(_sid:string,a:any)=>{if(a.kind==='identity')return{status:'identity',identity:{queueId:'root',sendEpoch:'epoch'}};throw Error('receipt lost');});
  (window as any).claude={session:{queue:{action},sendInput}};
  sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'keep',content:'keep',paths:[],dispatch});
  await vi.waitFor(()=>expect(action).toHaveBeenCalledTimes(2));
  expect(sendInput).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
 });
});
