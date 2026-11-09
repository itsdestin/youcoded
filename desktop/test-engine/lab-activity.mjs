import {randomUUID} from 'node:crypto';
const KINDS=new Set(['request-start','request-end','first-byte','phase-start','phase-delta','phase-end',
  'tool-submit','tool-result','execution-start','execution-end','ask-start','ask-end','root-input','stop','turn-end']);
const PHASES=new Set(['reasoning-stream','answer-stream','tool-argument-stream']);
/** Content-free process-local receipts. No wall/monotonic cross-process subtraction. */
export function createActivityCapture({now=()=>performance.now(),id=randomUUID(),limit=100000}={}){
 const record={schemaVersion:1,clock:{id,kind:'monotonic-ms'},observation:{start:now(),end:null,status:'open'},receipts:[],dropped:0};
 return {record,emit(kind,data={}){
  if(!KINDS.has(kind))return;
  if(record.receipts.length>=limit){record.dropped++;return;}
  const row={kind,at:now(),scope:data.scope==='child'?'child':'parent'};
  for(const k of ['id','requestId','toolCallId','sessionId'])if(typeof data[k]==='string')row[k]=data[k];
  if(PHASES.has(data.phase))row.phase=data.phase;
  if(['completed','failed','interrupted','denied','allowed','cancelled','incomplete'].includes(data.status))row.status=data.status;
  record.receipts.push(row);
 },finish(status){record.observation.end=now();record.observation.status=['completed','failed','interrupted'].includes(status)?status:'interrupted';return record;}};
}
