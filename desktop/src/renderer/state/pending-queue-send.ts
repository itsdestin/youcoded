import type { ConversationQueueAction } from '../../shared/conversation-queue-channel-types';
type Request = Extract<ConversationQueueAction,{kind:'enqueue'}>;
const prefix=(sessionId:string)=>'youcoded:pending-queue-send:'+encodeURIComponent(sessionId)+':';
const key=(sessionId:string,request:Request)=>prefix(sessionId)+request.payload.sendId;
/** Persist BEFORE IPC: a lost reply/reload cannot turn the same draft into a fresh send identity. */
export function pendingQueueSend(sessionId:string,text?:string,files?:string[],inFlight?:ReadonlySet<string>): Request | undefined {
 const storage=window.localStorage;if(!storage)return;
 const requests:Request[]=[];
 for(let n=0;n<storage.length;n++){
  const k=storage.key(n);if(!k?.startsWith(prefix(sessionId)))continue;
  const r=JSON.parse(storage.getItem(k)!) as Request;
  if(r.kind!=='enqueue'||typeof r.queueId!=='string'||typeof r.payload?.sendEpoch!=='string'||typeof r.payload.sendId!=='string'||typeof r.payload.originalText!=='string'||!Array.isArray(r.payload.attachments))throw Error('Saved queue request could not be read. It has not been resent.');
  // WHY: an acknowledgement still in flight belongs to a distinct user intent, not a retryable lost reply.
  if(!inFlight?.has(r.payload.sendId))requests.push(r);
 }
 // WHY only the SAME draft (2026-10-22 phone reliability): returning any saved request made every different message wait
 // on it ("An earlier queued send is unconfirmed…") until the exact text was retyped. The same draft still reuses its
 // sendId, so a retry can never deliver twice; a different one goes out fresh and the old one is settled by asking.
 return requests.find(r=>r.payload.originalText===text&&JSON.stringify(r.payload.attachments)===JSON.stringify(files));
}
/** Every saved send whose answer never came, in every conversation. Unreadable rows are skipped, never thrown on. */
export function allPendingQueueSends(): Array<{ sessionId: string; request: Request }> {
 const storage=window.localStorage;if(!storage)return [];
 const out: Array<{ sessionId: string; request: Request }> = [];
 for(let n=0;n<storage.length;n++){
  const k=storage.key(n);const m=k?.match(/^youcoded:pending-queue-send:([^:]*):/);if(!m)continue;
  try{const r=JSON.parse(storage.getItem(k!)!) as Request;if(r?.kind==='enqueue'&&typeof r.payload?.sendId==='string')out.push({sessionId:decodeURIComponent(m[1]),request:r});}catch{/* skipped */}
 }
 return out;
}
export function savePendingQueueSend(sessionId:string,request:Request):void {window.localStorage.setItem(key(sessionId,request),JSON.stringify(request));}
export function clearPendingQueueSend(sessionId:string,request:Request):void {
 // Another window/newer request must never be cleared by a late acknowledgement.
 if(window.localStorage.getItem(key(sessionId,request))===JSON.stringify(request))window.localStorage.removeItem(key(sessionId,request));
}
