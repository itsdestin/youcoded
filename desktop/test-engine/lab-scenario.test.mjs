import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from './lab-scenario.mjs';

test('scripted human follow-ups use one native session and label nudges explicitly',async()=>{
 const calls=[], observations=[];
 const host={send:(id,text)=>{calls.push([id,text]);return {status:'sent'};},compact:async()=>({ok:true})};
 const result=await runScenario({sessionId:'one',host,
  steps:[{kind:'user',text:'Do it',label:'initial'},{kind:'user',text:'Keep it concise',label:'correction'}],
  settle:async()=>({status:'completed'}),onStep:row=>observations.push(row)});
 assert.equal(result.status,'completed'); assert.deepEqual(calls,[['one','Do it'],['one','Keep it concise']]);
 assert.equal(observations[1].label,'correction'); assert.equal(result.steps.length,2);
});
test('failed external changes are checkpointed before stopping, for throws and unconfirmed receipts',async()=>{
 for(const mode of ['throw','unconfirmed']){
  let sends=0;const saved=[];
  const result=await runScenario({sessionId:'x',host:{send(){sends++;return {status:'sent'};}},settle:async()=>({status:'completed'}),
   steps:[{kind:'user',text:'inspect'},{kind:'external-change',file:'note.txt',expectedBefore:'old',replacement:'new'},{kind:'user',text:'continue'}],
   externalChange:()=>{if(mode==='throw')throw Object.assign(new Error('simulated failure'),{evidence:{applied:false,restorationVerified:false}});return {applied:false};},onStep:row=>saved.push(row)});
  assert.equal(result.status,'failed');assert.equal(result.unexecutedSteps,1);assert.equal(sends,1);
  assert.equal(saved.length,2);assert.equal(saved[1].kind,'external-change');assert.equal(saved[1].status,'failed');
  if(mode==='throw')assert.equal(saved[1].evidence.restorationVerified,false);
 }
});

test('compaction must be observed successful, not assumed from requested action',async()=>{
 const host={send:()=>({status:'sent'}),compact:async()=>({ok:false,reason:'summary-failed'})};
 const result=await runScenario({sessionId:'x',host,steps:[{kind:'compact'}],settle:async()=>({status:'completed'})});
 assert.equal(result.status,'failed'); assert.equal(result.steps[0].reason,'summary-failed');
});
test('a failed turn stops the scenario instead of scoring later missing turns',async()=>{
 let calls=0; const host={send:()=>{calls++;return {status:'sent'};}};
 const r=await runScenario({sessionId:'x',host,steps:[{kind:'user',text:'first'},{kind:'user',text:'second'}],settle:async()=>({status:'timeout'})});
 assert.equal(calls,1);assert.equal(r.status,'timeout');assert.equal(r.unexecutedSteps,1);
});
test('refuses invalid scenarios before any work and does not invent user clarification answers',async()=>{
 let calls=0; const host={send:()=>{calls++;return {status:'sent'};}};
 await assert.rejects(runScenario({sessionId:'x',host,steps:[{kind:'user',text:'valid'},{kind:'automatic-user-answer'}],settle:async()=>({status:'completed'})}),/unsupported/i);
 assert.equal(calls,0);
});
