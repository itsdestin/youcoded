import type { QueueDraftSnapshot } from './queued-edit-actions';
const draftKey=(id:string)=>'youcoded:queue-transfer-draft:'+id;
export function readQueueTransferDraft(id:string): {text:string;files:string[]} | undefined {
 const raw=window.localStorage?.getItem(draftKey(id));if(!raw)return;
 const draft=JSON.parse(raw);if(typeof draft.text!=='string'||!Array.isArray(draft.files)||!draft.files.every((p:unknown)=>typeof p==='string'))throw Error('Saved edit draft could not be read.');return draft;
}
/** Synchronous browser persistence is the transfer boundary; storage failure must prevent host acknowledgement. */
export function saveQueueTransferDraft(before:QueueDraftSnapshot,text:string,files:string[]):void {window.localStorage.setItem(draftKey(before.sessionId),JSON.stringify({text,files}));}
export function updateQueueTransferDraft(id:string,text:string,files:string[]):void {
 if(window.localStorage?.getItem(draftKey(id)))window.localStorage.setItem(draftKey(id),JSON.stringify({text,files}));
}
const editPrefix='youcoded:pending-queue-edit:';
let knownEditKeys=new Set<string>();
export const queueEditStorage = {
 load():string|null{
  const entries:unknown[]=[];knownEditKeys=new Set();
  for(let n=0;n<window.localStorage.length;n++){const key=window.localStorage.key(n);if(key?.startsWith(editPrefix)){knownEditKeys.add(key);entries.push(JSON.parse(window.localStorage.getItem(key)!));}}
  return JSON.stringify(entries);
 },
 save(value:string):void{
  const entries=JSON.parse(value) as [string,unknown][];const next=new Set<string>();
  for(const entry of entries){const key=editPrefix+encodeURIComponent(entry[0]);window.localStorage.setItem(key,JSON.stringify(entry));next.add(key);}
  // A late acknowledgement must not erase another window's newly persisted transfer.
  for(const key of knownEditKeys)if(!next.has(key))window.localStorage.removeItem(key);knownEditKeys=next;
 },
};
