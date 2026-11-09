// Diagnostic observations from the actual worker/runtime hooks, enabled for ALL
// runs. This is not a container security boundary: task Bash has the worker uid.
import {createHash,randomUUID} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createRuntimeTelemetry({now=()=>performance.now(),limit=20000,clockId=randomUUID()}={}){
 const record={schemaVersion:1,provenance:'runtime-observed',clock:{id:clockId,kind:'monotonic-ms'},observation:{start:now(),end:null},rows:[],dropped:0,
  trust:'Native harness callback observations, not unforgeable against arbitrary same-container Bash; host outcomes and validated semantic labels are independent.',coverage:{schedulerContinuous:false,semanticLabels:false,humanInputs:false}};
 const calls=new Map();let lastState=null;
 function emit(kind,row={}){if(record.rows.length>=limit){record.dropped++;return;}record.rows.push({kind,at:now(),...row});}
 return {record,emit,
  request(r){emit(r.endedAt?'sdk-end':'sdk-start',{requestId:r.id,sessionId:r.sessionId,scope:r.scope??(r.role==='main'?'parent':'child'),status:r.error?'failed':r.endedAt?'completed':'open',inputTokens:r.usage?.inputTokens??null,outputTokens:r.usage?.outputTokens??null});},
  execution(r){emit(r.kind,{id:r.id,toolCallId:r.toolCallId,sessionId:r.sessionId,scope:r.scope,status:r.status??null});},
  transcript(e){const d=e.data??{},scope=d.agentId||d.parentAgentToolUseId?'child':'parent';
   if(e.type==='tool-use'){
    const input=d.toolInput??{},toolName=d.toolName;
    const meta={toolCallId:d.toolUseId,toolName,sessionId:d.agentId??e.sessionId,scope,commandHash:toolName==='Bash'&&typeof input.command==='string'?hash(input.command):null,inputHash:hash(input),background:toolName==='Bash'&&input.run_in_background===true};
    calls.set(d.toolUseId,meta);emit('tool-submit',meta);
   }else if(e.type==='tool-result')emit('tool-result',{...calls.get(d.toolUseId),toolCallId:d.toolUseId,scope,isError:typeof d.isError==='boolean'?d.isError:null});
   else if(e.type==='user-interrupt'||e.type==='turn-complete')emit(e.type,{sessionId:e.sessionId,scope});
   else if(e.type==='user-message'&&d.injected)emit('notice-injected',{sessionId:e.sessionId,noticeKind:d.injected,scope,shellIds:d.injectedMeta?.runs?.map(r=>r.shellId)??[]});
  },
  shell(e){const r=e.run;emit('shell-state',{sessionId:e.sessionId,shellId:r.shellId,toolCallId:r.toolUseId,status:r.status,exitCode:Number.isInteger(r.exitCode)?r.exitCode:null,stopReason:r.stopReason??null});},
  scheduler(state){const key=JSON.stringify(state);if(key!==lastState){lastState=key;emit('scheduler-state',state);}},
  finish(){record.observation.end=now();return record;}
 };
}
