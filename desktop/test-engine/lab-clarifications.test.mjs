import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clarificationDecision} from './lab-clarifications.mjs';
const payload={tool_name:'AskUserQuestion',tool_input:{questions:[{question:'Choose a format',options:[{label:'Compact'},{label:'Detailed'}],multiSelect:false}]}};
test('answers only a real matching question from a declared fixture oracle',()=>{
 const result=clarificationDecision(payload,[{question:'Choose a format',answer:'Compact',classification:'necessary'}]);
 assert.equal(result.decision.behavior,'allow');
 assert.equal(result.decision.updatedInput.answers['Choose a format'],'Compact');
 assert.equal(result.evidence[0].classification,'necessary');
 assert.equal(result.scripted,true);
});
test('unmapped questions remain unanswered and permissions cannot be approved by an answer oracle',()=>{
 assert.equal(clarificationDecision(payload,[]).decision.behavior,'deny');
 assert.equal(clarificationDecision({...payload,tool_name:'Bash'},[{question:'Choose a format',answer:'Compact'}]).decision.behavior,'deny');
});
test('a matching question from another session or specialist never consumes the root oracle',()=>{
 const oracle=[{question:'Choose a format',answer:'Compact'}];
 assert.equal(clarificationDecision(payload,oracle,{sessionId:'child',expectedSessionId:'root'}).decision.behavior,'deny');
 assert.equal(clarificationDecision(payload,oracle,{sessionId:'root',expectedSessionId:'root',specialist:true}).decision.behavior,'deny');
});

test('malformed or duplicate oracle questions are refused before answering',()=>{
 assert.throws(()=>clarificationDecision(payload,[{question:'Choose a format',answer:'Compact'},{question:'Choose a format',answer:'Detailed'}]),/duplicate/i);
});
