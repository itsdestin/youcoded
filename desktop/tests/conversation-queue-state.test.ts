import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
describe('host queue projection', () => {
 it('keeps authoritative paused rows visible when a fresh identical message reaches the transcript', () => {
  let state=chatReducer(new Map(),{type:'SESSION_INIT',sessionId:'s'});
  const queue=[{queueId:'old-one',content:'hi',timestamp:1,sendEpoch:'epoch',status:'waiting' as const,paused:true},{queueId:'old-two',content:'hi',timestamp:2,sendEpoch:'epoch',status:'waiting' as const,paused:true}];
  state=chatReducer(state,{type:'QUEUE_SYNCED',sessionId:'s',queue});
  const before=state.get('s')!.queuedMessages;
  state=chatReducer(state,{type:'TRANSCRIPT_USER_MESSAGE',sessionId:'s',uuid:'fresh-uuid',text:'hi',timestamp:3});
  expect(state.get('s')!.queuedMessages).toBe(before);
  expect(state.get('s')!.timeline.filter(e=>e.kind==='user')).toHaveLength(1);
 });
 it('preserves item epoch, paused/sending/checkout state and original paths across snapshots', () => {
  let state=chatReducer(new Map(),{type:'SESSION_INIT',sessionId:'s'});
  const row={queueId:'item-not-root',content:'original display',timestamp:1,sendEpoch:'epoch',sendId:'send',attachments:['/tmp/image'],status:'waiting' as const,paused:true,editing:true};
  state=chatReducer(state,{type:'QUEUE_SYNCED',sessionId:'s',queue:[row]});expect(state.get('s')!.queuedMessages[0]).toEqual(row);
  const changed={...row,paused:false,editing:false,status:'delivering' as const};
  state=chatReducer(state,{type:'QUEUE_SYNCED',sessionId:'s',queue:[changed]});expect(state.get('s')!.queuedMessages[0]).toEqual(changed);
  expect(state.get('s')!.timeline).toHaveLength(0); // no premature user bubbles for known queued intent
 });
 it('confirms an instant queue bubble by the transcript line the host says it became, whatever words Claude Code recorded', () => {
  let state=chatReducer(new Map(),{type:'SESSION_INIT',sessionId:'s'});
  state=chatReducer(state,{type:'USER_PROMPT',sessionId:'s',content:'/tmp/a.png what is this',attachments:['/tmp/a.png'],timestamp:1,sendId:'send-1',sendTransport:'queue'});
  // The same send announced again (fallback path) never draws a second bubble.
  state=chatReducer(state,{type:'USER_PROMPT',sessionId:'s',content:'/tmp/a.png what is this',attachments:['/tmp/a.png'],timestamp:2,sendId:'send-1'});
  expect(state.get('s')!.timeline.filter(e=>e.kind==='user')).toHaveLength(1);
  state=chatReducer(state,{type:'QUEUE_SYNCED',sessionId:'s',queue:[],bound:[{sendId:'send-1',uuid:'row-1'}]});
  state=chatReducer(state,{type:'TRANSCRIPT_USER_MESSAGE',sessionId:'s',uuid:'row-1',text:'something else entirely',timestamp:3});
  const users=state.get('s')!.timeline.filter(e=>e.kind==='user');
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({pending:false,uuid:'row-1',message:{content:'/tmp/a.png what is this',attachments:['/tmp/a.png']}});
 });
 it('drops the instant bubble when the transcript line arrived first as its own entry', () => {
  let state=chatReducer(new Map(),{type:'SESSION_INIT',sessionId:'s'});
  state=chatReducer(state,{type:'USER_PROMPT',sessionId:'s',content:'see @notes.md',timestamp:1,sendId:'send-1',sendTransport:'queue'});
  state=chatReducer(state,{type:'TRANSCRIPT_USER_MESSAGE',sessionId:'s',uuid:'row-1',text:'see "/abs/notes.md"',timestamp:2});
  expect(state.get('s')!.timeline.filter(e=>e.kind==='user')).toHaveLength(2);
  state=chatReducer(state,{type:'QUEUE_SYNCED',sessionId:'s',queue:[],bound:[{sendId:'send-1',uuid:'row-1'}]});
  const users=state.get('s')!.timeline.filter(e=>e.kind==='user');
  expect(users).toHaveLength(1); expect(users[0]).toMatchObject({uuid:'row-1',pending:false});
 });
 it('hands an instant bubble to the queue strip when the host lists the send there, lowering the spinner', () => {
  let state=chatReducer(new Map(),{type:'SESSION_INIT',sessionId:'s'});
  state=chatReducer(state,{type:'USER_PROMPT',sessionId:'s',content:'hi',timestamp:1,sendId:'send-1',sendTransport:'queue'});
  expect(state.get('s')!.isThinking).toBe(true);
  state=chatReducer(state,{type:'QUEUE_SYNCED',sessionId:'s',queue:[{queueId:'q',content:'hi',timestamp:1,sendEpoch:'e',sendId:'send-1',status:'waiting'}]});
  expect(state.get('s')!.timeline.filter(e=>e.kind==='user')).toHaveLength(0);
  expect(state.get('s')!.queuedMessages).toHaveLength(1); expect(state.get('s')!.isThinking).toBe(false);
 });
 it('draws a queue send recorded with attached files as file chips plus the words', () => {
  let state=chatReducer(new Map(),{type:'SESSION_INIT',sessionId:'s'});
  state=chatReducer(state,{type:'TRANSCRIPT_USER_MESSAGE',sessionId:'s',uuid:'row',text:'what is this',attachedFiles:['/q/shot.png'],timestamp:1});
  expect(state.get('s')!.timeline.find(e=>e.kind==='user')).toMatchObject({message:{content:'/q/shot.png what is this',attachments:['/q/shot.png']}});
 });
});
