#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { observeModel } from './lab-observer.mjs';
import {createActivityCapture} from './lab-activity.mjs';
import {createRuntimeTelemetry} from './lab-runtime-telemetry.mjs';
import { canSettle, finalAnswer, configureKeyedProvider, gatewayFetch } from './lab-state.mjs';
import { runScenario } from './lab-scenario.mjs';
import { createReadMutation, applyFixtureChange } from './lab-faults.mjs';
import { clarificationDecision } from './lab-clarifications.mjs';

const require = createRequire(import.meta.url);
const activity=createActivityCapture();
const telemetry=createRuntimeTelemetry({clockId:activity.record.clock.id});
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const config = JSON.parse(raw);
if (!config.home || process.env.HOME !== config.home) throw new Error('Worker requires launcher-created private HOME');
clarificationDecision(null,config.clarificationOracle??[]); // validate fixture answers before any provider request
if (config.synthetic || config.offlineScript) globalThis.fetch = async () => { throw new Error('Network forbidden in synthetic smoke'); };
else if (config.gatewayUrl) globalThis.fetch = gatewayFetch(globalThis.fetch.bind(globalThis), config.gatewayUrl);
const { createRuntime } = require('../dist/main/create-runtime.js');
const { currentChatGptRequest } = require('../dist/main/providers/chatgpt-request-diagnostics.js');
const { DelegationLedger } = require('../dist/main/harness/specialists/delegation-ledger.js');
const sessionId = randomUUID();
const started = performance.now();
const record = { schemaVersion: 1, runtime: 'createRuntime/NativeSessionHost', rootSessionId:sessionId, synthetic: !!config.synthetic,
  arm: config.arm, taskId: config.taskId, repetition: config.repetition, comparisonKey: config.comparisonKey,
  buildFingerprint: config.buildFingerprint, timingScope: 'launcher-including-runtime-startup',
  configuration: { model: config.model, provider: config.provider, preset: config.preset ?? 'assistant',
    timeoutMs: config.timeoutMs, maxRequests: config.maxRequests,
    contextWindowTokens: config.contextWindowTokens ?? null,transport:config.offlineScript?'offline-scripted-sdk':config.synthetic?'smoke-scripted-sdk':'provider-sdk' },
  contextControl: config.contextWindowTokens === undefined ? { source: 'runtime-resolved' }
    : { source: 'lab-controlled-override', requestedTokens: config.contextWindowTokens,
      observedResolvedTokens: null, providerLimit: false },
  model: config.model, provider: config.provider, status: 'interrupted', success: null, wallClockMs: 0,
  finalText: '', requests: [], events: [], permissionRequests: [], activity:activity.record,runtimeTelemetry:telemetry.record,
  fidelity: { profile: 'production-resolved', permissions: 'full-auto-with-denied-permission-exceptions',
    clarification:config.clarificationOracle?.length?'declared-scripted-answer-oracle':'unmapped-questions-denied',
    plugins: 'clean private profile; no inherited plugins', browser: 'not attached',
    delegation: 'matched-model: budget/frontier pinned to selected model; other named models refused',
    usage: 'SDK-attempt ledger; provider-hidden retries and unreported usage remain unknown' },
  budget: config.synthetic || config.offlineScript ? null : { maxSpendUsd: config.maxSpendUsd, maxRequestUsd: config.maxRequestUsd,
    policy: config.gatewayUrl ? 'shared gateway enforces cumulative reservation budget; local request ceiling retained'
      : 'reserve declared maximum for each attempt; never release reservations; requires provider-side key cap' },
};
let outputPending = Promise.resolve();
const checkpoint = () => {
  record.wallClockMs = performance.now() - started;
  record.finalText = finalAnswer(record.events, sessionId);
  let json = JSON.stringify({ kind: 'record', record });
  if (config.apiKey) json = json.replaceAll(config.apiKey, '[REDACTED]');
  // Await the final queued write before exiting: pipe writes are not synchronous.
  outputPending = outputPending.then(() => new Promise((resolve, reject) => {
    process.stdout.write(json + '\n', error => error ? reject(error) : resolve());
  }));
  void outputPending.catch(() => {});
  return outputPending;
};
// Ephemeral encryption key never reaches disk. Private secrets remain encrypted even in test artifacts.
const encryptionKey = randomBytes(32);
const platform = {
  openExternal: async () => { throw new Error('External browser unavailable in lab'); },
  resolveAskpassPaths: async () => null,
  secretStorage: {
    isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(data) {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
  },
};
// Optional dynamic import keeps historical frozen launchers usable without the new lab helper.
const continuationProfile = config.synthetic && ['background-followthrough', 'waiting-after-report', 'lost-report'].includes(config.smokeProfile);
const continuationModule = continuationProfile ? await import('./lab-continuation.mjs') : null;
const continuation = continuationModule?.createContinuationCollector({ sessionId, now: () => performance.now(),
  verifyWrite(input) {
    const file = path.join(config.cwd, 'continued.txt');
    if (input?.file_path !== file || input.content !== 'FOLLOWUP-OK\n') return null;
    try { return fs.readFileSync(file, 'utf8') === 'FOLLOWUP-OK\n' ? 'fixture:continued.txt:exact-FOLLOWUP-OK-newline' : null; }
    catch { return null; }
  } });
let releaseChild;
const initialParentTerminal = new Promise(resolve => { releaseChild = resolve; });
let smokeStep = 0;
function smokeModel() {
  return { specificationVersion: 'v4', provider: 'lab-scripted', modelId: config.model, supportedUrls: {},
    async doStream(params) {
      const child=currentChatGptRequest()?.purpose==='specialist';
      const step = child?-1:smokeStep++;
      let call=null;
      let answer='Production host smoke completed.';
      if(config.smokeProfile==='clarification'){
        if(step===0)call={toolName:'AskUserQuestion',input:{questions:[{question:'Choose a format',header:'Format',options:[{label:'Compact',description:'Brief output'},{label:'Detailed',description:'Long output'}],multiSelect:false}]}};
      }else if(continuationProfile){
        // WHY: a real terminal signal, not a sleep, orders parent terminal before child completion.
        // This does not claim exact host-idle transition coverage.
        if(child){await initialParentTerminal;answer='FOLLOWUP-OK';}
        else if(step===0)call={toolName:'Task',input:{description:'Return fixture confirmation',prompt:'This is an offline lifecycle fixture. Do not read or edit files. Return the exact confirmation FOLLOWUP-OK as your final report.',agent:'explorer',work_dir:config.cwd,background:true,model:'parent'}};
        else if(step===1)answer='Waiting for the helper result.';
        else if(step===2 && config.smokeProfile!=='waiting-after-report')call={toolName:'Write',input:{file_path:path.join(config.cwd,'continued.txt'),content:'FOLLOWUP-OK\n'}};
        else if(step===2)answer='I acknowledge the completed helper report.';
      }else if(config.smokeProfile==='stale-write'&&step<2){
        call=step===0?{toolName:'Read',input:{file_path:path.join(config.cwd,'stale-note.txt')}}:
          {toolName:'Edit',input:{file_path:path.join(config.cwd,'stale-note.txt'),old_string:'original',new_string:'agent overwrite'}};
      }else if(config.smokeProfile!=='stale-write'&&step===0){
        call={toolName:'Write',input:{file_path:path.join(config.cwd,'lab-smoke.txt'),content:'production host smoke\n'}};
      }
      const parts = call ? [{type:'tool-call',toolCallId:`smoke-${step}`,toolName:call.toolName,input:JSON.stringify(call.input)}]
        : [{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: answer }, { type: 'text-end', id: 'answer' }];
      if(config.smokeProfile==='activity-timing'){
        // WHY: exercise the actual SDK parser, not invented assistant-thinking heartbeats.
        const diagnostic=[{type:'reasoning-start',id:'reasoning'},{type:'reasoning-delta',id:'reasoning',delta:'synthetic reasoning canary'},{type:'reasoning-end',id:'reasoning'}];
        if(call)diagnostic.push({type:'tool-input-start',id:`smoke-${step}`,toolName:call.toolName},
          {type:'tool-input-delta',id:`smoke-${step}`,delta:JSON.stringify(call.input)},{type:'tool-input-end',id:`smoke-${step}`});
        parts.unshift(...diagnostic);
      }
      parts.push({ type: 'finish', finishReason: { unified: call ? 'tool-calls' : 'stop', raw: call ? 'tool_calls' : 'stop' },
        usage: { inputTokens: { total: config.smokeProfile==='context-pressure'?Math.ceil(JSON.stringify(params.prompt).length/4)+Math.ceil(JSON.stringify(params.tools??[]).length/4):100, noCache: undefined, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } } });
      return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
    },
    async doGenerate() { throw new Error('Smoke must use streaming'); },
  };
}
let scriptedStep=0;
function scriptedModel(){return {specificationVersion:'v4',provider:'lab-scripted',modelId:config.model,supportedUrls:{},
 async doStream(){
  const step=config.scriptedResponses[scriptedStep++]??{text:'Declared offline work finished.'};
  const call=step.toolName;
  const parts=call?[{type:'tool-call',toolCallId:`offline-${scriptedStep}`,toolName:call,input:JSON.stringify(step.input)}]:[{type:'text-start',id:'answer'},{type:'text-delta',id:'answer',delta:step.text??'Done.'},{type:'text-end',id:'answer'}];
  parts.push({type:'finish',finishReason:{unified:call?'tool-calls':'stop',raw:call?'tool_calls':'stop'},usage:{inputTokens:{total:100},outputTokens:{total:20}}});
  return {stream:new ReadableStream({start(c){for(const p of parts)c.enqueue(p);c.close();}})};
 },async doGenerate(){throw Error('Offline SDK requires streaming');}};}
let runtime;
try {
  runtime = createRuntime({ userDataDir: path.join(config.home, 'profile'), appVersion: 'harness-lab',
    platform, chatgptAuth: null, sessionManager: { getSession: () => undefined } });
  await runtime.providerRegistry.init();
  const originalFactory = runtime.providerRegistry.languageModel.bind(runtime.providerRegistry);
  if (config.synthetic || config.offlineScript) {
    runtime.modelCatalog.get = async () => [];
    runtime.modelCatalog.contextLengthFor = async () => config.contextWindowTokens ?? 32768;
  } else {
    await configureKeyedProvider(runtime.providerRegistry, config.provider, config.apiKey,config.gatewayUrl);
    if (config.contextWindowTokens !== undefined) {
      // WHY: keep the controlled context experiment local to this disposable runtime; never mutate app defaults.
      runtime.modelCatalog.contextLengthFor = async () => config.contextWindowTokens;
    }
  }
  runtime.providerRegistry.languageModel = async (binding, options) => {
    if (binding.modelId !== config.model || binding.providerId !== config.provider)
      throw new Error('Matched-model lab run refuses a different delegated model');
    const model = config.offlineScript ? scriptedModel() : config.synthetic ? smokeModel() : await originalFactory(binding, options);
    return observeModel(model, { records: record.requests, context: currentChatGptRequest,
      activity, rootSessionId:sessionId, maxRequests: config.maxRequests, onRecord: row => { telemetry.request(row); continuation?.request(row); return checkpoint(); },
      beforeRequest: () => {
        // A reservation is a declared ceiling, not a guessed actual bill. Failed/unknown attempts retain it.
        if (!config.synthetic && !config.offlineScript && !config.gatewayUrl && (record.requests.length + 1) * config.maxRequestUsd > config.maxSpendUsd)
          throw new Error('Lab spending reservation exhausted before provider request');
      } });
  };
  const host = runtime.nativeHost;
  // Disposable lab host only: observe the existing permission decision closure,
  // preserving its result and all tool-layer/broker floors. Automatic policy
  // allow is NOT a human approval and an ask outcome is recorded separately.
  if(typeof host.buildDecide==='function'){
    const buildDecide=host.buildDecide.bind(host);
    host.buildDecide=(id,cwd,rules,opts)=>{
      const decide=buildDecide(id,cwd,rules,opts);
      return async(tool,subject)=>{const result=await decide(tool,subject);telemetry.emit('decision',{sessionId:id,toolName:tool,decision:result.action,provenance:'runtime-permission-policy',human:false,scope:opts?.specialistScope?'child':'parent'});return result;};
    };
  }else telemetry.emit('missing-hook',{hook:'permission-policy'});
  // Broker hook receipts below cover ALL permission asks (including tool-internal
  // clarification); do not double-count the narrower driver ask diagnostic seam.
  host.activityDiagnostic=receipt=>{if(receipt.kind.startsWith('execution-')){activity.emit(receipt.kind,receipt);telemetry.execution(receipt);}};
  const scheduler=source=>{try{telemetry.scheduler({sessionId,source,idle:host.isIdle(sessionId),queueLength:host.live?.get(sessionId)?.queue?.length??null,runningShellIds:host.shellRunsFor(sessionId).filter(r=>r.status==='running').map(r=>r.shellId)});}catch{/* Before create/after teardown is not coverage. */}};
  host.on('shell-event',e=>{telemetry.shell(e);scheduler('shell-event');});
  host.on('specialists-event',e=>{if(e.kind==='run')telemetry.emit('specialist-state',{sessionId:e.sessionId,childId:e.run.childId,status:e.run.status,background:e.run.background});scheduler('specialist-event');});
  host.on('queue-changed',e=>{telemetry.emit('queue-changed',{sessionId:e.sessionId,queueLength:e.queue.length,queueIds:e.queue.map(item=>item.id)});scheduler('queue-event');});
  // Observe actual model-facing notice delivery in ordinary runs too. This is
  // runtime telemetry, NOT an unforgeable host capability in a Bash container.
  const runtimeDeliver=host.deliverNotice.bind(host);
  host.deliverNotice=(entry,mode,text,meta)=>{telemetry.emit('notice-delivery',{sessionId:entry.sessionId??sessionId,mode,phase:'attempt',noticeKind:meta?.kind??(meta?.childId?'specialist':'unknown'),shellIds:meta?.runs?.map(r=>r.shellId)??[]});return runtimeDeliver(entry,mode,text,meta);};
  if (continuation) {
    host.on('specialists-event', event => continuation.specialist(event));
    // WHY: intercept only this disposable host. The negative control drops the actual
    // model-facing report, not its observer receipt; production notifications are unchanged.
    const deliver = host.deliverNotice.bind(host);
    host.deliverNotice = (entry, mode, text, meta) => {
      const dropped = config.smokeProfile === 'lost-report' && !!meta?.childId;
      continuation.deliveryAttempt(meta, mode, dropped);
      return dropped ? Promise.resolve() : deliver(entry, mode, text, meta);
    };
    record.continuationFixture = { thresholdMs: continuationModule.CONTINUATION_THRESHOLD_MS,
      profile: config.smokeProfile, noBlockers: true, noFurtherRootInputs: true,
      usefulFollowup: 'Successful parent Write of continued.txt with exact FOLLOWUP-OK newline, checked on disk' };
  }
  const ledger = new DelegationLedger(runtime.nativeHome);
  const binding = { providerId: config.provider, modelId: config.model };
  await host.setDelegatedModel('budget', binding);
  await host.setDelegatedModel('frontier', binding);
  const fault=config.faultInjection?createReadMutation(config.cwd,config.faultInjection):null;
  let terminal = false;
  let error = false;
  let lastActivity = performance.now();
  let shellControlReleased=false;
  host.on('session-context', event => {
    if (event.sessionId !== sessionId) return;
    const observed = event.context?.contextWindowTokens ?? null;
    record.contextControl.observedResolvedTokens = observed;
    record.contextControl.observation = 'NativeSessionHost session-context event';
    record.nativeSessionContext = { modelLabel: event.context?.modelLabel ?? null, contextWindowTokens: observed };
  });
  host.on('transcript-event', event => {
    record.events.push(event);
    telemetry.transcript(event);
    scheduler('transcript-event');
    const kind=({'tool-use':'tool-submit','tool-result':'tool-result','user-interrupt':'stop','turn-complete':'turn-end'})[event.type];
    if(kind)activity.emit(kind,{sessionId:event.data?.agentId??event.sessionId,toolCallId:event.data?.toolUseId,
      scope:event.data?.agentId||event.data?.parentAgentToolUseId?'child':'parent'});
    continuation?.transcript(event);
    if (continuation && event.sessionId === sessionId && !event.data?.agentId && event.type === 'turn-complete') releaseChild();
    if(fault){fault.observe(event);record.faultEvidence=fault.evidence();}
    lastActivity = performance.now();
    if (event.sessionId === sessionId && !event.data?.agentId) {
      if (['turn-complete', 'session-error', 'user-interrupt'].includes(event.type)) terminal = true;
      if (event.type === 'session-error') error = true;
      // Fixed no-provider fixture gate: background process cannot finish until
      // the actual native parent terminal event. Stop is explicit, never read
      // from model prose. No gate or file mutation exists for provider runs.
      if(config.offlineScript&&config.offlineShellControl&&!shellControlReleased&&event.type==='turn-complete'){
        shellControlReleased=true;
        if(config.offlineShellControl==='stop-held'){
          host.interrupt(sessionId);
          telemetry.emit('fixture-stop',{sessionId,provenance:'scripted-control',held:true});
        }
        fs.writeFileSync(path.join(config.cwd,'.lab-shell-release'),'release\n');
      }
    }
  });
  const pendingActivityAsks=new Map();
  host.on('hook-event', event => {
    const requestId=event.payload?._requestId;
    if(event.type==='PermissionResolved'){
      const meta=pendingActivityAsks.get(requestId);
      if(meta){activity.emit('ask-end',{...meta,status:'completed'});pendingActivityAsks.delete(requestId);}
      return;
    }
    if (event.type !== 'PermissionRequest') return;
    if(typeof requestId==='string'&&!pendingActivityAsks.has(requestId)){
      const meta={id:requestId,sessionId:event.sessionId,scope:event.payload.specialist?'child':'parent'};
      pendingActivityAsks.set(requestId,meta);activity.emit('ask-start',meta);
    }
    record.permissionRequests.push({ sessionId: event.sessionId, tool: event.payload?.tool_name ?? null });
    // Only declared fixture answers may resolve clarification. This never approves another tool's permission.
    const answer=clarificationDecision(event.payload,config.clarificationOracle??[],{sessionId:event.sessionId,expectedSessionId:sessionId,specialist:!!event.payload.specialist});
    // ONLY the synthetic activity fixture may approve its exact known Write;
    // real permissions and all other exception requests retain the denial policy.
    if(config.synthetic&&config.smokeProfile==='activity-timing'&&event.sessionId===sessionId&&!event.payload.specialist&&!event.payload.denyListed&&!event.payload.external&&event.payload.tool_name==='Write'&&event.payload.tool_input?.file_path===path.join(config.cwd,'lab-smoke.txt')&&event.payload.tool_input?.content==='production host smoke\n')answer.decision={behavior:'allow'};
    if(event.payload.tool_name==='AskUserQuestion')(record.clarifications??=[]).push({requestId:event.payload._requestId,...answer});
    telemetry.emit('decision',{requestId,sessionId:event.sessionId,toolName:event.payload.tool_name,decision:answer.decision.behavior,provenance:'scripted-policy',human:false,scope:event.payload.specialist?'child':'parent'});
    host.respondPermission(event.payload._requestId,answer.decision);
  });
  await host.create({ sessionId, cwd: config.cwd, binding, presetId: config.preset ?? 'assistant' });
  host.setPermissionMode(sessionId, config.synthetic&&config.smokeProfile==='activity-timing'?'ask':'full-auto');
  if(config.synthetic&&config.smokeProfile==='activity-timing')record.fidelity.permissions='scripted approval of exact fixture Write only; all other exceptions denied';
  record.scenario = await runScenario({ sessionId, host: {
    send(id,text) { activity.emit('root-input',{sessionId:id});telemetry.emit('root-input',{sessionId:id,provenance:'scripted-scenario',human:false});terminal=false;error=false;const sent=host.send(id,text);telemetry.emit('root-send',{sessionId:id,status:sent.status,queueId:sent.queueId??null,provenance:'scripted-scenario',human:false});scheduler('root-input');return sent; },
    compact: id=>host.compact(id),
  }, steps: config.scenarioSteps ?? [{kind:'user',text:config.prompt,label:'initial'}],
  externalChange: step=>applyFixtureChange(config.cwd,step),
  settle: async()=>{
    while (true) {
      const delegations = ledger.listFor(config.cwd, sessionId);
      const shells = host.shellRunsFor(sessionId);
      scheduler('settle-observation');
      // WHY: observation is fixture-deadline bounded even when a broken delivery never settles.
      if (continuation && !continuation.observing()) {
        record.continuation = continuation.finish();
        return { status: error ? 'failed' : 'completed' };
      }
      if (canSettle({ terminal, idle: host.isIdle(sessionId), delegations, shells })
        && performance.now() - lastActivity > 150 && !continuation?.observing()) break;
      if (performance.now() - started > config.timeoutMs) { host.interrupt(sessionId);return {status:'timeout'}; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await host.drain(sessionId);
    return {status:error?'failed':'completed'};
  }, onStep: async row=>{
    (record.scenarioCheckpoints??=[]).push({...row,finalText:row.kind==='user'?finalAnswer(record.events,sessionId):null,requestCount:record.requests.length,eventCount:record.events.length});
    await checkpoint();
  }});
  if (continuation && !record.continuation) record.continuation = continuation.finish();
  record.specialists = host.specialistRunsFor(sessionId);
  record.status = record.scenario.status;
  await checkpoint();
  await host.destroy(sessionId);
} catch (error) {
  record.status = 'failed';
  record.error = String(error.message ?? error);
  await checkpoint();
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.cleanup();
  telemetry.finish();
  activity.finish(record.status);
  await checkpoint();
}
// Runtime background services are app-lifetime. This is a single-run process, not an app host.
await outputPending;
process.exit(process.exitCode ?? (record.status === 'completed' ? 0 : 1));
