// Dev-only scenario driver. Scripted user turns are declared test inputs, never disguised model autonomy.
import {validateFixtureChange} from './lab-faults.mjs';
export function validateScenario(steps) {
  if (!Array.isArray(steps)||!steps.length||steps.length>100) throw new Error('Scenario requires 1–100 declared steps');
  for (const [index,step] of steps.entries()) {
    if (!step||!['user','compact','external-change'].includes(step.kind)) throw new Error('Unsupported scenario action');
    if(step.kind==='external-change'){
      validateFixtureChange(step);
      if(process.platform!=='linux')throw new Error('Controller mutation requires Linux');
      if(!steps.slice(0,index).some(s=>s?.kind==='user')||!steps.slice(index+1).some(s=>s?.kind==='user'))throw new Error('External change must be between user turns');
    }
    if (step.kind==='user'&&(typeof step.text!=='string'||!step.text.trim())) throw new Error('User step needs text');
    if (step.label && !['initial','followup','correction','nudge','clarification-answer'].includes(step.label)) throw new Error('Unsupported input label');
  }
}

export async function runScenario({sessionId,host,steps,settle,externalChange,onStep=()=>{}}) {
  validateScenario(steps);
  if(steps.some(s=>s.kind==='external-change')&&typeof externalChange!=='function')throw new Error('External change controller is unavailable');
  const results=[];
  for (const [index,step] of steps.entries()) {
    const start=performance.now();
    let outcome;
    if(step.kind==='external-change'){
      try{const evidence=await externalChange(step);outcome={status:evidence?.applied===true?'completed':'failed',evidence,controllerOwned:true};}
      catch(error){outcome={status:'failed',reason:'external-change-refused',controllerOwned:true,evidence:error?.evidence??null};}
    } else if (step.kind==='compact') {
      const result=await host.compact(sessionId);
      outcome=result.ok?{status:'completed',compactionSucceeded:true}:{status:'failed',reason:result.reason??'compaction-refused'};
    } else {
      const receipt=host.send(sessionId,step.text);
      outcome=receipt.status==='sent'?await settle():{status:'failed',reason:`send-${receipt.status}`};
    }
    const row={index,kind:step.kind,label:step.label??(step.kind==='user'?'followup':null),...outcome,durationMs:performance.now()-start};
    results.push(row);await onStep(row);
    if (outcome.status!=='completed') return {status:outcome.status,steps:results,unexecutedSteps:steps.length-results.length};
  }
  return {status:'completed',steps:results,unexecutedSteps:0};
}
