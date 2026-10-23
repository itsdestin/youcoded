// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { queueBrowserStorage } from './helpers/queue-browser-storage';
beforeEach(()=>Object.defineProperty(window,'localStorage',{value:queueBrowserStorage(),configurable:true}));
import { sendToClaudeCode } from '../src/renderer/state/submit-outgoing';
import { pendingQueueSend } from '../src/renderer/state/pending-queue-send';
afterEach(()=>{delete(window as any).claude;window.localStorage.clear();});
describe('host queued Claude submission',()=>{
 it('draws an idle send at once as a queue bubble, takes it down if the queue refuses, and never draws a slash command',async()=>{
  let refuse=false;const action=vi.fn(async(_sid:string,a:any)=>a.kind==='identity'?{status:'identity',identity:{queueId:'root',sendEpoch:'epoch'}}:refuse?{status:'rejected',message:'Queue full'}:{status:'queued',identity:{queueId:'root',sendEpoch:'epoch'},itemId:'item',sendId:a.payload.sendId});
  (window as any).claude={session:{queue:{action},sendInput:vi.fn()}};
  const dispatch=vi.fn();
  sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'hi',content:'hi',paths:[],dispatch,drawNow:true});
  // Drawn before the queue has answered anything.
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({type:'USER_PROMPT',content:'hi',sendTransport:'queue'}));
  await vi.waitFor(()=>expect(action).toHaveBeenCalledTimes(2));
  expect(dispatch.mock.calls.some(([a])=>a.type==='SEND_DISCARD')).toBe(false);
  refuse=true;const refused=vi.fn();
  sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'no room',content:'no room',paths:[],dispatch:refused,drawNow:true});
  await vi.waitFor(()=>expect(refused).toHaveBeenCalledWith(expect.objectContaining({type:'SEND_DISCARD'})));
  const slash=vi.fn();sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'/compact',content:'/compact',paths:[],dispatch:slash,drawNow:true});
  expect(slash).not.toHaveBeenCalled();
 });
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
  await vi.waitFor(()=>expect(requests).toHaveLength(1));expect(pendingQueueSend('s','exact',['/tmp/image'])?.payload.sendEpoch).toBe('original-epoch');
  vi.resetModules();const reloaded=await import('../src/renderer/state/submit-outgoing');reloaded.sendToClaudeCode(outgoing);
  await vi.waitFor(()=>expect(requests).toHaveLength(2));expect(requests[1]).toEqual(requests[0]);expect(action.mock.calls.filter(([,a])=>a.kind==='identity')).toHaveLength(1);
  await vi.waitFor(()=>expect(pendingQueueSend('s','exact',['/tmp/image'])).toBeUndefined());
 });
 it('a different message is not held back by an earlier unconfirmed one, which is then settled by asking the queue',async()=>{
  // A frozen laptop lost the first answer; the phone used to refuse every other message until the exact text was retyped.
  const enqueues:any[]=[];let lookups=0;
  const action=vi.fn(async(_sid:string,a:any)=>{
   if(a.kind==='identity')return{status:'identity',identity:{queueId:'root',sendEpoch:'epoch'}};
   if(a.kind==='lookup'){lookups++;return{status:'lookup',identity:{queueId:'root',sendEpoch:'epoch'},found:true};}
   enqueues.push(a);if(enqueues.length===1)throw Error('lost ack');return{status:'queued'};});
  (window as any).claude={session:{queue:{action},sendInput:vi.fn()}};
  sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'first',content:'first',paths:[],dispatch:vi.fn()});
  await vi.waitFor(()=>expect(pendingQueueSend('s','first',[])).toBeDefined());
  sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'second',content:'second',paths:[],dispatch:vi.fn()});
  await vi.waitFor(()=>expect(enqueues.map(e=>e.payload.originalText)).toEqual(['first','second']));
  await vi.waitFor(()=>expect(lookups).toBe(1));
  expect(pendingQueueSend('s','first',[])).toBeUndefined();     // the queue had it: forgotten, nothing restored
 });
 it('an earlier message the queue never got comes back to the empty message box, and only then is forgotten',async()=>{
  const action=vi.fn(async(_sid:string,a:any)=>{
   if(a.kind==='identity')return{status:'identity',identity:{queueId:'root',sendEpoch:'epoch'}};
   if(a.kind==='lookup')return{status:'lookup',identity:{queueId:'root',sendEpoch:'epoch'},found:false};
   throw Error('lost ack');});
  (window as any).claude={session:{queue:{action},sendInput:vi.fn()}};
  const { settleSavedQueueSends, RESTORE_UNSENT_EVENT }=await import('../src/renderer/state/submit-outgoing');
  sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'lost words',content:'lost words',paths:[],dispatch:vi.fn()});
  await vi.waitFor(()=>expect(pendingQueueSend('s','lost words',[])).toBeDefined());
  let boxEmpty=false;const restored:string[]=[];
  const listener=(e:Event)=>{const d=(e as CustomEvent).detail;if(!boxEmpty)return;restored.push(d.text);d.restored=true;};
  window.addEventListener(RESTORE_UNSENT_EVENT,listener);
  try{
   await settleSavedQueueSends();
   expect(pendingQueueSend('s','lost words',[])).toBeDefined();  // box busy: kept, never lost
   boxEmpty=true;await settleSavedQueueSends();
   expect(restored).toEqual(['lost words']);
   expect(pendingQueueSend('s','lost words',[])).toBeUndefined();
  }finally{window.removeEventListener(RESTORE_UNSENT_EVENT,listener);}
 });
 it('with no answer from the computer, a saved send is left exactly as it was',async()=>{
  const action=vi.fn(async(_sid:string,a:any)=>{if(a.kind==='identity')return{status:'identity',identity:{queueId:'root',sendEpoch:'epoch'}};throw Error('no connection');});
  (window as any).claude={session:{queue:{action},sendInput:vi.fn()}};
  const { settleSavedQueueSends }=await import('../src/renderer/state/submit-outgoing');
  sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'kept',content:'kept',paths:[],dispatch:vi.fn()});
  await vi.waitFor(()=>expect(pendingQueueSend('s','kept',[])).toBeDefined());
  await settleSavedQueueSends();
  expect(pendingQueueSend('s','kept',[])).toBeDefined();
 });
 it.each([
  ['a computer older than the lookup', { status: 'rejected', message: 'Invalid queue action.' }],
  ['a conversation whose queue is not set up again yet', { status: 'unavailable' }],
 ])('when %s cannot say, a saved send is kept and its words are not put back',async(_why,answer)=>{
  // Putting the words back clears the saved send, and with it the id that stops the same words arriving twice.
  const action=vi.fn(async(_sid:string,a:any)=>{if(a.kind==='identity')return{status:'identity',identity:{queueId:'root',sendEpoch:'epoch'}};
   if(a.kind==='lookup')return answer;throw Error('lost ack');});
  (window as any).claude={session:{queue:{action},sendInput:vi.fn()}};
  const { settleSavedQueueSends, RESTORE_UNSENT_EVENT }=await import('../src/renderer/state/submit-outgoing');
  sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'maybe sent',content:'maybe sent',paths:[],dispatch:vi.fn()});
  await vi.waitFor(()=>expect(pendingQueueSend('s','maybe sent',[])).toBeDefined());
  const restored:string[]=[];const listener=(e:Event)=>{const d=(e as CustomEvent).detail;restored.push(d.text);d.restored=true;};
  window.addEventListener(RESTORE_UNSENT_EVENT,listener);
  try{
   await settleSavedQueueSends();
   expect(restored).toEqual([]);
   expect(pendingQueueSend('s','maybe sent',[])).toBeDefined();
  }finally{window.removeEventListener(RESTORE_UNSENT_EVENT,listener);}
 });
 it('never falls back to CR or creates a pending transcript bubble after an uncertain enqueue',async()=>{
  const dispatch=vi.fn(),sendInput=vi.fn();const action=vi.fn(async(_sid:string,a:any)=>{if(a.kind==='identity')return{status:'identity',identity:{queueId:'root',sendEpoch:'epoch'}};throw Error('receipt lost');});
  (window as any).claude={session:{queue:{action},sendInput}};
  sendToClaudeCode({sessionId:'s',provider:'claude',ptyText:'keep',content:'keep',paths:[],dispatch});
  await vi.waitFor(()=>expect(action).toHaveBeenCalledTimes(2));
  expect(sendInput).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
 });
});
