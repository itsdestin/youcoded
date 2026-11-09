// Fixture oracle, not a simulated human guessing answers and not a permission bypass.
export function clarificationDecision(payload,oracle=[],scope){
  if(!Array.isArray(oracle))throw new Error('Clarification oracle must be an array');
  const entries=new Map();
  for(const row of oracle){
    if(typeof row?.question!=='string'||!row.question.trim()||typeof row.answer!=='string'||!row.answer.trim())
      throw new Error('Each oracle entry needs exact question and answer text');
    if(entries.has(row.question))throw new Error('Duplicate clarification oracle question');
    if(row.classification&&!['necessary','unnecessary','unclassified'].includes(row.classification))throw new Error('Invalid fixture classification');
    entries.set(row.question,row);
  }
  const denied=reason=>({decision:{behavior:'deny'},scripted:true,evidence:[],reason});
  if(scope&&(scope.specialist||!scope.expectedSessionId||scope.sessionId!==scope.expectedSessionId))return denied('Clarification oracle belongs only to the declared root session');
  if(payload?.tool_name!=='AskUserQuestion')return denied('Not a clarification request; ordinary permission denial retained');
  const questions=payload.tool_input?.questions;
  if(!Array.isArray(questions)||!questions.length)return denied('Malformed questions');
  if(questions.some(q=>!entries.has(q.question)))return denied('Question not covered by declared answer oracle');
  const answers=Object.fromEntries(questions.map(q=>[q.question,entries.get(q.question).answer]));
  return {decision:{behavior:'allow',updatedInput:{...payload.tool_input,answers}},scripted:true,
    evidence:questions.map(q=>({question:q.question,answer:entries.get(q.question).answer,
      classification:entries.get(q.question).classification??'unclassified',source:'fixture-oracle'}))};
}
