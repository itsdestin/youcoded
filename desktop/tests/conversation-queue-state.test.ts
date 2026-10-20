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
});
