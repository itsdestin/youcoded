import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const runner = fileURLToPath(new URL('./lab-runner.mjs', import.meta.url));
// Workspace evaluator owns scoring; isolated worker only emits content-free receipts.
import { analyzeContinuationEpisodes } from '../../../scripts/harness-lab/continuation-metrics.mjs';
import {analyzeActivity} from '../../../scripts/harness-lab/activity-normalize.mjs';
// Optional retained proof from the SAME test invocation; ordinary runs leave no
// outputs outside their disposable temp tree. Never inject a controller receipt.
function saveNativeProof(name,raw,analysis,checks){
 if(!process.env.YC_NATIVE_PROOF_DIR)return;
 const dir=path.join(process.env.YC_NATIVE_PROOF_DIR,name);fs.mkdirSync(dir,{recursive:true});
 for(const [file,value] of Object.entries({'raw.json':raw,'analysis.json':analysis,'fixture-checks.json':checks}))fs.writeFileSync(path.join(dir,file),JSON.stringify(value,null,2)+'\n');
}

test('scripted production runtime smoke writes output, usage, events without credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-lab-smoke-'));
  try {
    const cwd = path.join(root, 'task'); fs.mkdirSync(cwd);
    const out = path.join(root, 'result.json');
    const result = spawnSync(process.execPath, [runner, '--smoke', '--cwd', cwd, '--out', out], {
      encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: root },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const record = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(record.status, 'completed');
    assert.equal(record.success, null); // model stop is NOT verification
    assert.equal(record.synthetic, true);
    assert.equal(record.runtime, 'createRuntime/NativeSessionHost');
    assert.match(record.buildFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(record.timingScope, 'launcher-including-runtime-startup');
    assert.ok(record.requests.length >= 2);
    assert.equal(fs.readFileSync(path.join(cwd, 'lab-smoke.txt'), 'utf8'), 'production host smoke\n');
    assert.ok(record.events.some(e => e.type === 'tool-result'));
    assert.ok(record.finalText.includes('smoke'));
    assert.equal(record.activity.clock.kind,'monotonic-ms');
    assert.equal(record.launcherObservation.end-record.launcherObservation.start,record.wallClockMs);
    assert.notEqual(record.launcherObservation.clock.id,record.activity.clock.id);
    assert.ok(record.activity.observation.end>=record.activity.observation.start);
    const receipts=record.activity.receipts;
    assert.ok(receipts.some(r=>r.kind==='execution-start'));
    assert.ok(receipts.some(r=>r.kind==='execution-end'));
    const submit=receipts.find(r=>r.kind==='tool-submit'),execute=receipts.find(r=>r.kind==='execution-start');
    assert.equal(submit.toolCallId,execute.toolCallId);assert.ok(execute.at>=submit.at);
    assert.ok(receipts.some(r=>r.kind==='phase-delta'&&r.phase==='answer-stream'));
    assert.ok(!JSON.stringify(record.activity).includes('production host smoke'));
    const analysis=analyzeActivity(record),actualEnd=receipts.find(r=>r.kind==='execution-end'&&r.toolCallId===execute.toolCallId);
    assert.equal(analysis.toolLatency[0].executionMs,actualEnd.at-execute.at);
    const resultReceipt=receipts.find(r=>r.kind==='tool-result'&&r.toolCallId===submit.toolCallId);
    assert.equal(analysis.toolLatency[0].submissionToResultMs,resultReceipt.at-submit.at);
    assert.equal(analysis.timeline.window.start,record.activity.observation.start);
    assert.equal(analysis.timeline.window.end,record.activity.observation.end);
    assert.equal(analysis.collectedActivity.coverage,'measured');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ordinary configuration records native SDK tool failure rerun and background shell followup without a smoke profile',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-ordinary-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);
  const command='test -f fixed.txt';
  const script=[{toolName:'Bash',input:{command,description:'Check fixture'}},
   {toolName:'Write',input:{file_path:path.join(cwd,'fixed.txt'),content:'fixed\n'}},
   {toolName:'Bash',input:{command,description:'Check fixture'}},
   {toolName:'Bash',input:{command:'while [ ! -f .lab-shell-release ]; do sleep 0.01; done; printf finished',run_in_background:true,description:'Wait for fixture release'}},
   {toolName:'Write',input:{file_path:path.join(cwd,'release.txt'),content:'release\n'}},
   {text:'Waiting for the command notice.'},
   {toolName:'Write',input:{file_path:path.join(cwd,'continued.txt'),content:'SHELL-OK\n'}}];
  const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify({cwd,taskId:'ordinary-native',arm:'offline-native',comparisonKey:'ordinary-diagnostic',repetition:0,provider:'openrouter',model:'offline-scripted',prompt:'Perform the declared checks, then write continued.txt after the background command finishes.',maxRequests:12,timeoutMs:15000,scriptedResponses:script,offlineShellControl:'release-after-terminal'}));
  const out=path.join(root,'run.json');
  const p=spawnSync(process.execPath,[runner,'--offline-script','--config',config,'--out',out],{encoding:'utf8',timeout:25000,env:{PATH:process.env.PATH,HOME:root}});
  assert.equal(p.status,0,p.stderr+p.stdout);
  const raw=JSON.parse(fs.readFileSync(out,'utf8'));assert.equal(raw.synthetic,false);assert.equal(raw.configuration.transport,'offline-scripted-sdk');
  assert.equal(fs.readFileSync(path.join(cwd,'continued.txt'),'utf8'),'SHELL-OK\n');
  assert.ok(raw.runtimeTelemetry.rows.some(r=>r.kind==='sdk-start'));
  assert.ok(raw.runtimeTelemetry.rows.some(r=>r.kind==='execution-end'&&r.status==='failed'));
  assert.ok(raw.runtimeTelemetry.rows.some(r=>r.kind==='shell-state'&&r.status==='exited'&&r.exitCode===0));
  assert.ok(raw.runtimeTelemetry.rows.some(r=>r.kind==='notice-delivery'&&r.noticeKind==='shell'));
  assert.ok(raw.runtimeTelemetry.rows.some(r=>r.kind==='scheduler-state'));
  const a=analyzeActivity(raw);assert.equal(a.runtimeObserved.provenance,'runtime-observed');
  assert.equal(a.runtimeObserved.recovery.sameCheckPasses.length,1);
  assert.equal(a.runtimeObserved.recovery.sameCheckPasses[0].causalRepairVerified,false);
  assert.ok(a.runtimeObserved.shells.some(s=>s.exitCode===0));
  assert.equal(a.runtimeObserved.scheduler.continuous,false);
  assert.ok(a.runtimeObserved.decisions.some(d=>d.provenance==='runtime-permission-policy'&&d.decision==='allow'));
  assert.ok(a.runtimeObserved.decisions.every(d=>d.human===false));
  assert.equal(a.runtimeObserved.crossChecks.rawSdkRequestIdsMatch,true);
  assert.ok(a.runtimeObserved.shells.some(s=>s.firstSubsequentToolId));
  assert.equal(a.outcome.verified,null);
  saveNativeProof('ordinary-positive',raw,a,{requiredWrite:true,checkedBy:'host test readback',expected:'SHELL-OK\\n',passed:fs.readFileSync(path.join(cwd,'continued.txt'),'utf8')==='SHELL-OK\n'});
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});

test('ordinary native configuration collects actual clarification decisions without relabeling them human approval',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-ordinary-ask-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);const out=path.join(root,'run.json'),config=path.join(root,'config.json');
  fs.writeFileSync(config,JSON.stringify({cwd,taskId:'ordinary-clarification',arm:'offline-native',comparisonKey:'ordinary-ask',repetition:0,provider:'openrouter',model:'offline-scripted',prompt:'Ask which format to use.',maxRequests:6,timeoutMs:10000,clarificationOracle:[{question:'Choose a format',answer:'Compact'}],scriptedResponses:[{toolName:'AskUserQuestion',input:{questions:[{question:'Choose a format',header:'Format',options:[{label:'Compact',description:'Brief output'},{label:'Detailed',description:'Long output'}],multiSelect:false}]}},{text:'Compact output selected.'}]}));
  const p=spawnSync(process.execPath,[runner,'--offline-script','--config',config,'--out',out],{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,HOME:root}});
  assert.equal(p.status,0,p.stderr+p.stdout);const raw=JSON.parse(fs.readFileSync(out,'utf8')),a=analyzeActivity(raw);
  assert.ok(a.runtimeObserved.decisions.some(r=>r.toolName==='AskUserQuestion'&&r.decision==='allow'&&r.provenance==='scripted-policy'));
  assert.ok(a.runtimeObserved.decisions.every(r=>r.human===false));
  assert.equal(a.outcome.safety.observations,0);
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});

test('native background shell retains missed followup and explicit Stop-held negatives',()=>{
 for(const control of ['missed-followup','stop-held']){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-shell-negative-'));
  try{
   const cwd=path.join(root,'task');fs.mkdirSync(cwd);const out=path.join(root,'run.json'),config=path.join(root,'config.json');
   const script=[{toolName:'Bash',input:{command:'while [ ! -f .lab-shell-release ]; do sleep 0.01; done; printf finished',run_in_background:true,description:'Native background command'}},{text:'Waiting for the shell.'},control==='missed-followup'?{text:'The command finished, but no followup write.'}:{toolName:'Write',input:{file_path:path.join(cwd,'continued.txt'),content:'SHELL-OK\n'}}];
   fs.writeFileSync(config,JSON.stringify({cwd,taskId:'native-shell-followup',arm:'offline-native',comparisonKey:'native-shell-control',repetition:0,provider:'openrouter',model:'offline-scripted',prompt:'After the background command finishes write continued.txt with SHELL-OK.',maxRequests:8,timeoutMs:10000,scriptedResponses:script,offlineShellControl:control==='stop-held'?'stop-held':'release-after-terminal'}));
   const p=spawnSync(process.execPath,[runner,'--offline-script','--config',config,'--out',out],{encoding:'utf8',timeout:20000,env:{PATH:process.env.PATH,HOME:root}});
   assert.equal(p.status,0,p.stderr+p.stdout);const raw=JSON.parse(fs.readFileSync(out,'utf8')),a=analyzeActivity(raw);
   assert.equal(fs.existsSync(path.join(cwd,'continued.txt')),false);
   assert.ok(a.runtimeObserved.shells.some(r=>r.exitCode===0));
   if(control==='stop-held'){
    assert.ok(raw.runtimeTelemetry.rows.some(r=>r.kind==='fixture-stop'&&r.held));
    assert.equal(a.runtimeObserved.noticeDeliveries.filter(r=>r.noticeKind==='shell'&&r.mode==='turn').length,0);
   }else assert.ok(a.runtimeObserved.noticeDeliveries.some(r=>r.noticeKind==='shell'));
   assert.equal(a.outcome.verified,null); // file checks, not model stop, decide outcome
   saveNativeProof(control,raw,a,{requiredWrite:true,checkedBy:'host test readback',passed:fs.existsSync(path.join(cwd,'continued.txt')),expectedNegative:true,stopHeld:control==='stop-held'});
  }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
 }
});

test('scripted activity profile streams actual reasoning and tool arguments through the production driver',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-activity-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);const out=path.join(root,'run.json');
  const result=spawnSync(process.execPath,[runner,'--smoke','--smoke-profile','activity-timing','--cwd',cwd,'--out',out],{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,HOME:root}});
  assert.equal(result.status,0,result.stderr+result.stdout);const raw=JSON.parse(fs.readFileSync(out,'utf8'));
  const a=analyzeActivity(raw);assert.equal(a.collectedActivity.coverage,'measured');
  for(const lane of ['reasoning-stream','answer-stream','tool-argument-stream','tool-executing','approval-wait'])assert.ok(a.timeline.laneUnionMs[lane]!==null,lane);
  assert.ok(raw.activity.receipts.some(r=>r.kind==='phase-delta'&&r.phase==='reasoning-stream'));
  assert.ok(raw.activity.receipts.some(r=>r.kind==='phase-delta'&&r.phase==='tool-argument-stream'));
  assert.equal(fs.readFileSync(path.join(cwd,'lab-smoke.txt'),'utf8'),'production host smoke\n');
  assert.ok(!JSON.stringify(a).includes('synthetic reasoning canary'));
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5});}
});

test('scripted follow-up preserves one production session and records correction boundaries', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-scenario-'));
  try {
    const cwd=path.join(root,'task');fs.mkdirSync(cwd);
    const scenario=path.join(root,'scenario.json');
    fs.writeFileSync(scenario,JSON.stringify([{kind:'user',text:'Write the smoke file',label:'initial'},
      {kind:'user',text:'Now answer concisely',label:'correction'}]));
    const out=path.join(root,'result.json');
    const result=spawnSync(process.execPath,[runner,'--smoke','--cwd',cwd,'--out',out,'--scenario-file',scenario],{
      encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,HOME:root}});
    assert.equal(result.status,0,result.stderr+result.stdout);
    const record=JSON.parse(fs.readFileSync(out,'utf8'));
    assert.equal(record.scenario.steps.length,2);
    assert.equal(record.scenario.steps[1].label,'correction');
    assert.equal(new Set(record.events.filter(e=>e.type==='user-message').map(e=>e.sessionId)).size,1);
    assert.equal(record.events.filter(e=>e.type==='turn-complete').length,2);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('controller external change occurs between native turns without an extra user message',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-between-turns-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);fs.writeFileSync(path.join(cwd,'user-note.txt'),'before');
  const scenario=path.join(root,'scenario.json');fs.writeFileSync(scenario,JSON.stringify([{kind:'user',text:'Write the smoke file'},
   {kind:'external-change',file:'user-note.txt',expectedBefore:'before',replacement:'user revision'},
   {kind:'user',text:'Reply briefly'}]));
  const out=path.join(root,'result.json');const result=spawnSync(process.execPath,[runner,'--smoke','--cwd',cwd,'--out',out,'--scenario-file',scenario],{encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,HOME:root}});
  assert.equal(result.status,0,result.stderr+result.stdout);const record=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.equal(fs.readFileSync(path.join(cwd,'user-note.txt'),'utf8'),'user revision');
  assert.equal(record.scenario.steps[1].evidence.kind,'external-change-between-turns');
  assert.equal(record.scenario.steps[1].evidence.applied,true);
  assert.equal(record.scenarioCheckpoints[1].finalText,null);
  assert.equal(record.events.filter(e=>e.type==='user-message'&&!e.data.injected&&!e.data.agentId).length,2);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('manual compaction scenario exercises production summary and continuation without live model calls',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-compact-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);
  const scenario=path.join(root,'scenario.json');
  fs.writeFileSync(scenario,JSON.stringify([{kind:'user',text:'Write the smoke file',label:'initial'},
    {kind:'user',text:'Remember the task',label:'followup'},{kind:'compact'},
    {kind:'user',text:'Continue after compaction',label:'followup'}]));
  const out=path.join(root,'result.json');
  const result=spawnSync(process.execPath,[runner,'--smoke','--cwd',cwd,'--out',out,'--scenario-file',scenario],{
    encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,HOME:root}});
  const record=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.equal(result.status,0,JSON.stringify({error:record.error,scenario:record.scenario}));
  assert.equal(record.scenario.steps[2].compactionSucceeded,true);
  assert.ok(record.events.some(e=>e.type==='compact-summary'));
  assert.ok(record.requests.some(r=>r.role==='compaction'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('production Edit rejects synchronized external change after Read without losing user work',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-stale-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd,'stale-note.txt'),'original\n');
  const out=path.join(root,'result.json');
  const result=spawnSync(process.execPath,[runner,'--smoke','--smoke-profile','stale-write','--cwd',cwd,'--out',out],{
    encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,HOME:root}});
  assert.equal(result.status,0,result.stderr+result.stdout);
  const record=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.equal(record.faultEvidence.applied,true);
  assert.equal(fs.readFileSync(path.join(cwd,'stale-note.txt'),'utf8'),'user changed this\n');
  assert.ok(record.events.some(e=>e.type==='tool-result'&&e.data.toolName==='Edit'&&e.data.isError===true));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('production background helper report resumes approved work without a second scripted user input',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-helper-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);
  const out=path.join(root,'result.json');
  const result=spawnSync(process.execPath,[runner,'--smoke','--smoke-profile','background-followthrough','--cwd',cwd,'--out',out],{
    encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,HOME:root}});
  const record=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.equal(result.status,0,JSON.stringify({error:record.error,finalText:record.finalText}));
  assert.equal(record.events.filter(e=>e.type==='user-message'&&!e.data.injected&&!e.data.agentId).length,1);
  const reportIndex=record.events.findIndex(e=>e.type==='user-message'&&e.data.injected==='specialist-report');
  assert.ok(reportIndex>=0,JSON.stringify(record.events.filter(e=>e.type==='tool-result')));
  assert.ok(record.events.findIndex(e=>e.type==='tool-use'&&e.data.toolName==='Write')>reportIndex);
  assert.ok(record.requests.some(r=>r.role==='specialist'));
  assert.equal(fs.readFileSync(path.join(cwd,'continued.txt'),'utf8'),'FOLLOWUP-OK\n');
  const {episode,receipts,correlation}=record.continuation;
  const verdict=analyzeContinuationEpisodes([episode]).episodes[0];
  assert.equal(verdict.noNudgeContinuation,'success');
  assert.equal(verdict.needsNudge,false);
  assert.equal(episode.coverage.parentState,false);
  assert.deepEqual(episode.states,[]);
  assert.equal(verdict.actionableIdleMs,null);
  assert.equal(episode.inputs.length,1);
  assert.ok(episode.observation.end>=verdict.deadline,'observer must stay through declared fixture deadline');
  assert.ok(receipts.some(r=>r.kind==='parent-model-request-started'&&r.sessionId===correlation.sessionId));
  assert.ok(receipts.some(r=>r.kind==='fixture-verified-write'&&r.childId===correlation.childId));
  assert.equal(record.events[reportIndex].uuid,correlation.receiptUuid);
  assert.equal(record.events[reportIndex].data.injectedMeta.childId,episode.taskId);
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:3});}
});

for(const profile of ['waiting-after-report','lost-report']) test(`offline native ${profile} fault is automatically scored as failed continuation without extra input`,()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-negative-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);
  const out=path.join(root,'result.json');
  const result=spawnSync(process.execPath,[runner,'--smoke','--smoke-profile',profile,'--cwd',cwd,'--out',out],{
    encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,HOME:root}});
  assert.equal(result.status,0,result.stderr+result.stdout);
  const record=JSON.parse(fs.readFileSync(out,'utf8'));
  const {episode,receipts}=record.continuation;
  const verdict=analyzeContinuationEpisodes([episode]).episodes[0];
  assert.equal(verdict.noNudgeContinuation,'fail',JSON.stringify(record.continuation));
  assert.equal(verdict.reason,'Fixture deadline missed');
  assert.equal(verdict.actionableIdleMs,null);
  assert.equal(episode.coverage.parentState,false);
  assert.equal(episode.inputs.length,1);
  assert.equal(fs.existsSync(path.join(cwd,'continued.txt')),false);
  assert.ok(episode.observation.end>=verdict.deadline);
  if(profile==='waiting-after-report'){
    assert.ok(episode.evidence.reportDeliveredAt!==null);
    assert.ok(episode.evidence.parentRequestStartedAt>=episode.evidence.reportDeliveredAt);
    assert.ok(episode.terminal.at>=episode.evidence.parentRequestStartedAt);
    assert.equal(verdict.classification,'unknown'); // observed symptom, not guessed idle state/root cause
  }else{
    assert.equal(episode.evidence.reportDeliveredAt,null);
    assert.equal(episode.evidence.parentRequestStartedAt,null);
    assert.equal(verdict.classification,'delivery-stall');
    assert.ok(receipts.some(r=>r.kind==='lab-dropped-report'));
  }
  console.log(`continuation negative control ${profile}: ${verdict.noNudgeContinuation} (${verdict.classification})`);
 }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:3});}
});

test('actual production AskUserQuestion is answered only by the declared clarification oracle',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-question-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);
  const out=path.join(root,'result.json');
  const result=spawnSync(process.execPath,[runner,'--smoke','--smoke-profile','clarification','--cwd',cwd,'--out',out],{
    encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,HOME:root}});
  assert.equal(result.status,0,result.stderr+result.stdout);
  const record=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.equal(record.clarifications.length,1);
  assert.equal(record.clarifications[0].evidence[0].answer,'Compact');
  assert.equal(record.clarifications[0].scripted,true);
  assert.ok(record.events.some(e=>e.type==='tool-result'&&e.data.toolName==='AskUserQuestion'&&e.data.toolResult.includes('Compact')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('controlled context override is reported from the native session-context event, not inferred',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-context-override-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);
  const out=path.join(root,'result.json');
  const result=spawnSync(process.execPath,[runner,'--smoke','--context-window-tokens','65536','--cwd',cwd,'--out',out],{
    encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,HOME:root}});
  assert.equal(result.status,0,result.stderr+result.stdout);
  const record=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.equal(record.contextControl.source,'lab-controlled-override');
  assert.equal(record.contextControl.requestedTokens,65536);
  assert.equal(record.contextControl.observedResolvedTokens,65536);
  assert.equal(record.contextControl.providerLimit,false);
  assert.equal(record.contextControl.observation,'NativeSessionHost session-context event');
  assert.equal(record.nativeSessionContext.contextWindowTokens,65536);
  assert.ok(record.events.some(e=>e.type==='compact-summary')===false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('invalid context override is rejected before live authorization or provider access',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-invalid-context-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);
  const config=path.join(root,'config.json');
  fs.writeFileSync(config,JSON.stringify({cwd,prompt:'probe',taskId:'retention',arm:'native',comparisonKey:'first',repetition:0,
    provider:'anthropic',model:'fixture',timeoutMs:180000,maxRequests:20,contextWindowTokens:32767}));
  const result=spawnSync(process.execPath,[runner,'--allow-live','--config',config,'--out',path.join(root,'out.json')],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/contextWindowTokens \(32768–1000000 integer\)/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('automatic context pressure triggers production compaction without a compact command',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yc-lab-context-'));
 try{
  const cwd=path.join(root,'task');fs.mkdirSync(cwd);
  const scenario=path.join(root,'scenario.json');
  fs.writeFileSync(scenario,JSON.stringify(Array.from({length:16},(_,i)=>({kind:'user',label:i?'followup':'initial',text:`Round ${i}: `+'bounded fixture observation '.repeat(260)}))));
  const out=path.join(root,'result.json');
  const result=spawnSync(process.execPath,[runner,'--smoke','--smoke-profile','context-pressure','--context-window-tokens','32768','--cwd',cwd,'--out',out,'--scenario-file',scenario],{
    encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH,HOME:root}});
  assert.equal(result.status,0,result.stderr+result.stdout);
  const record=JSON.parse(fs.readFileSync(out,'utf8'));
  assert.ok(record.events.some(e=>e.type==='compact-summary'),'actual automatic summary event required');
  assert.ok(record.requests.some(r=>r.role==='compaction'));
  assert.equal(record.contextControl.source,'lab-controlled-override');
  assert.equal(record.contextControl.requestedTokens,32768);
  assert.equal(record.contextControl.observedResolvedTokens,32768);
  assert.equal(record.scenario.steps.some(s=>s.kind==='compact'),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('ephemeral key consumption is recognized but never bypasses live authorization', () => {
  const result = spawnSync(process.execPath, [runner, '--consume-key-file', '--config', '/does/not/exist'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /allow-live/i);
});

test('live runs refuse missing explicit authorization and budget before importing runtime', () => {
  const result = spawnSync(process.execPath, [runner, '--config', '/does/not/exist'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /allow-live/i);
});
