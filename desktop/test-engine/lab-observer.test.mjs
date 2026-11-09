import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeModel } from './lab-observer.mjs';
import {createActivityCapture} from './lab-activity.mjs';
const usage = { inputTokens: { total: 100, cacheRead: 60, cacheWrite: 0 }, outputTokens: { total: 20, reasoning: 5 } };
const finish = { type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' }, providerMetadata: { openrouter: { costUsd: 0.01 } } };
const model = parts => ({ specificationVersion: 'v4', provider: 'fixture', modelId: 'fake', supportedUrls: {},
  doStream: async () => ({ stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) }),
  doGenerate: async () => ({ content: [], usage }),
});
const options = { prompt: [{ role: 'system', content: 'rules' }, { role: 'user', content: [] }], tools: [] };

test('collects actual stream phase receipts on one monotonic clock without payloads or changed chunks',async()=>{
 let time=0;const activity=createActivityCapture({now:()=>++time,id:'fixture-clock'}),rows=[];
 const parts=['reasoning','text','tool-input'].flatMap(type=>[{type:type+'-start',id:'p',toolName:'private-name'},
   {type:type+'-delta',id:'p',delta:'secret-reasoning-arguments'},{type:type+'-end',id:'p'}]).concat(finish);
 const wrapped=observeModel(model(parts),{records:rows,maxRequests:1,activity,context:()=>({sessionId:'s',purpose:'specialist'})});
 assert.deepEqual(await Array.fromAsync((await wrapped.doStream(options)).stream),parts);
 const r=activity.finish('completed');assert.equal(r.clock.id,'fixture-clock');
 assert.deepEqual(r.receipts.filter(x=>x.kind==='phase-start').map(x=>x.phase),['reasoning-stream','answer-stream','tool-argument-stream']);
 assert.equal(r.receipts.filter(x=>x.kind==='phase-delta').length,3);assert.equal(r.receipts.filter(x=>x.kind==='phase-end').length,3);
 assert.equal(r.receipts[0].kind,'request-start');assert.equal(r.receipts.at(-1).status,'completed');
 assert.ok(r.receipts.every(x=>x.scope==='child'));assert.equal(r.receipts[0].requestId,rows[0].id);
 assert.ok(!JSON.stringify(r).includes('secret'));assert.ok(!JSON.stringify(r).includes('private-name'));
});
test('summary request scope follows root session identity rather than compaction purpose',async()=>{
 for(const [id,scope] of [['root','parent'],['helper','child']]){
  const activity=createActivityCapture(),rows=[];
  const wrapped=observeModel(model([finish]),{records:rows,maxRequests:1,activity,rootSessionId:'root',context:()=>({purpose:'summary',sessionId:id})});
  await Array.fromAsync((await wrapped.doStream(options)).stream);
  assert.equal(rows[0].role,'compaction');assert.equal(rows[0].scope,scope);
  assert.ok(activity.finish('completed').receipts.every(r=>r.scope===scope));
 }
});

test('records SDK usage once without changing chunks or adding cache tokens to input', async () => {
  const rows = [];
  const wrapped = observeModel(model([finish]), { records: rows, context: () => ({ purpose: 'summary', sessionId: 's', logicalStepId: 'step-1' }), maxRequests: 3 });
  const result = await wrapped.doStream(options);
  assert.deepEqual(await Array.fromAsync(result.stream), [finish]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'compaction');
  assert.equal(rows[0].logicalStepId, 'step-1');
  assert.equal(rows[0].measurementBoundary, 'sdk-attempt');
  assert.equal(rows[0].usage.inputTokens, 100);
  assert.equal(rows[0].usage.reasoningTokens, 5);
  assert.equal(rows[0].usage.costUsd, 0.01);
  assert.equal(rows[0].status, 'completed');
  assert.ok(rows[0].requestShape.systemBytes > 0);
  assert.equal(JSON.stringify(rows).includes('rules'), false);
});

test('records rejected attempts with unknown usage and preserves exception', async () => {
  const rows = [];
  const error = new Error('network reset');
  const wrapped = observeModel({ ...model([]), doStream: async () => { throw error; } }, { records: rows, maxRequests: 3 });
  await assert.rejects(wrapped.doStream(options), e => e === error);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].usage, null);
});

test('records unfinished streams and error chunks, not successful zero usage', async () => {
  for (const parts of [[], [{ type: 'error', error: new Error('bad') }]]) {
    const rows = [];
    const wrapped = observeModel(model(parts), { records: rows, maxRequests: 3 });
    await Array.fromAsync((await wrapped.doStream(options)).stream);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].usage, null);
  }
});

test('global request ceiling prevents another provider call across wrapped children', async () => {
  const rows = [];
  const a = observeModel(model([]), { records: rows, maxRequests: 1 });
  const b = observeModel(model([]), { records: rows, maxRequests: 1 });
  await a.doGenerate(options);
  await assert.rejects(b.doGenerate(options), /request limit/i);
  assert.equal(rows.length, 1);
});

test('admission hook rejects a request before calling the model', async () => {
  const rows = [];
  const wrapped = observeModel(model([]), { records: rows, maxRequests: 2,
    beforeRequest: () => { throw new Error('budget exhausted'); } });
  await assert.rejects(wrapped.doGenerate(options), /budget exhausted/);
  assert.equal(rows.length, 0);
});

test('cancellation reaches underlying stream and records interruption', async () => {
  let canceled = false;
  const rows = [];
  const wrapped = observeModel({ ...model([]), doStream: async () => ({ stream: new ReadableStream({ cancel() { canceled = true; } }) }) }, { records: rows, maxRequests: 1 });
  const { stream } = await wrapped.doStream(options);
  await stream.cancel();
  assert.equal(canceled, true);
  assert.equal(rows[0].status, 'interrupted');
});
