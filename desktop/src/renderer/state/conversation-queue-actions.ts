import type { ChatAction, SessionChatState } from './chat-types';
import type { InputBarHandle } from '../components/InputBar';
import type { ToastAction } from '../components/ui/Toast';
import { createQueuedEditActions } from './queued-edit-actions';
import { queueEditStorage } from './queue-transfer-storage';
import { RESTORE_UNSENT_EVENT } from './submit-outgoing';
interface Options {
 provider(id: string): string | undefined;
 composer(): InputBarHandle | null;
 session(id: string): SessionChatState | undefined;
 dispatch(action: ChatAction): void;
 toast(value: string | { message: string; durationMs?: number; actions?: ToastAction[] }): void;
}
/** Existing strip callbacks, shared provider delegation and lossless Claude checkout; no second queue UI. */
export function createConversationQueueActions(o: Options) {
 const action = (sid: string,a: Parameters<Window['claude']['session']['queue']['action']>[1]) => window.claude.session.queue.action(sid,a);
 const edits = createQueuedEditActions({ storage:queueEditStorage, api: {
  checkout: async (sid,itemId,token) => { const r=await action(sid,{kind:'checkout',itemId,token}); if(r.status==='reserved')return r; if(r.status==='unavailable')return r; throw Error('message' in r?r.message:'Checkout was not confirmed'); },
  ack: async (sid,token) => { const r=await action(sid,{kind:'ack',token}); if(r.status!=='done')throw Error('Edit acknowledgement unconfirmed'); },
  cancel: async (sid,token) => { const r=await action(sid,{kind:'cancel',token}); if(r.status!=='done')throw Error('Edit cancellation unconfirmed'); },
 }, composer: { snapshot:()=>o.composer()?.queueDraftSnapshot(), fillIfCurrent:(before,text,files)=>o.composer()?.fillQueuedDraftIfCurrent(before,text,files)??false } });
 const failure = (e: unknown) => o.toast(e instanceof Error?e.message:'Queue action could not be confirmed.');
 return {
  cancel: async (sid: string,id: string) => {
   if(o.provider(sid)==='native'){const ok=await window.claude.native.queueRemove(sid,id);o.dispatch({type:'QUEUED_MESSAGE_REMOVED',sessionId:sid,queueId:id});if(!ok)o.toast('Already sending — too late to cancel.');return;}
   try{const kind=o.session(sid)?.queuedMessages.find(q=>q.queueId===id)?.status==='uncertain'?'dismiss':'remove';const r=await action(sid,{kind,itemId:id});if(r.status!=='done')throw Error('message'in r?r.message:'Queue removal was not confirmed.');
    // WHY (2026-10-22): a dismissed unconfirmed message's words go back into THIS screen's message box (the listener fills only an empty one), so nothing is lost and resending is the person's own choice.
    if(r.restore){const detail:{sessionId:string;text:string;paths:string[];restored?:boolean}={sessionId:sid,text:r.restore.text,paths:[...r.restore.attachments]};window.dispatchEvent(new CustomEvent(RESTORE_UNSENT_EVENT,{detail}));
     // The box already held a draft (it is never overwritten): keep the words reachable instead of losing them silently.
     if(!detail.restored&&r.restore.text.trim()){void navigator.clipboard?.writeText(r.restore.text).catch(()=>{});o.toast('Your message box wasn\'t empty, so the dismissed message was copied to the clipboard.');}}}catch(e){failure(e);}
  },
  edit: async (sid: string,id: string,text: string) => {
   if(o.provider(sid)==='native'){
    if(o.composer()?.hasDraft()){o.toast('Finish or clear your current draft first.');return;}
    const ok=await window.claude.native.queueRemove(sid,id);o.dispatch({type:'QUEUED_MESSAGE_REMOVED',sessionId:sid,queueId:id});if(ok)o.composer()?.fillDraft(text);else o.toast('Already sending — too late to edit.');return;
   }
   const item=o.session(sid)?.queuedMessages.find(q=>q.queueId===id);
   const epoch=(item as {sendEpoch?:string}|undefined)?.sendEpoch;
   const outcome=await edits.edit(sid,id,epoch);
   if(outcome==='edited')return;
   if(outcome==='unknown')o.toast({message:'Edit transfer was not confirmed. Your draft and host copy have been kept.',durationMs:15000,actions:[{label:'Try again',onClick:()=>{void edits.edit(sid,id,epoch).then(r=>o.toast(r==='edited'?'Edit transfer confirmed.':'Edit is still unconfirmed; review the draft and queue.'));}}]});
   else o.toast(outcome==='draft-busy'||outcome==='draft-changed'?'Your draft changed. It was not overwritten.':'The queued message could not be edited.');
  },
  sendNow: async (sid: string,id: string) => {
   if(o.provider(sid)==='native'){const ok=await window.claude.native.queueSendNow(sid,id).catch(()=>null);if(ok!==true)o.toast('Send now was not confirmed.');return;}
   try{const r=await action(sid,{kind:'send-now',itemId:id});if(r.status!=='done')throw Error('message'in r?r.message:'Send now was not confirmed.');}catch(e){failure(e);}
  },
 };
}
