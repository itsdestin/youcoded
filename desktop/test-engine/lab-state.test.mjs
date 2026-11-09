import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSettle, finalAnswer, assertSupportedPlatform, configureKeyedProvider, failureDetail, gatewayFetch, runErrorDetail } from './lab-state.mjs';
test('gateway transport routes only Anthropic API calls and preserves request settings', async () => {
  const calls = [];
  const fetch = gatewayFetch(async (...args) => { calls.push(args); return 'ok'; }, 'http://172.17.0.1:18765');
  await fetch('https://api.anthropic.com/v1/messages?beta=true', { method: 'POST', body: 'body', headers: { 'x-api-key': 'opaque-token' } });
  assert.equal(calls[0][0], 'http://172.17.0.1:18765/v1/messages?beta=true');
  assert.equal(calls[0][1].body, 'body');
  assert.equal(calls[0][1].redirect, 'error');
  await fetch('https://example.com/file');
  assert.equal(calls[1][0], 'https://example.com/file');
  assert.throws(() => gatewayFetch(() => {}, 'https://user:pass@example.com'), /gateway/i);
});

test('direct providers are registered before their keys are saved in a clean profile', async () => {
  const entries = new Map();
  const registry = {
    async upsert(row) { entries.set(row.id, row); },
    async setKey(id, key) { assert.ok(entries.has(id), 'provider must exist'); entries.get(id).testKey = key; },
  };
  await configureKeyedProvider(registry, 'anthropic', 'canary');
  assert.equal(entries.get('anthropic').type, 'anthropic');
  assert.equal(entries.get('anthropic').enabled, true);
  assert.equal(entries.get('anthropic').testKey, 'canary');
});
test('OpenRouter uses an explicit gate base URL without changing its production provider type',async()=>{
 let entry;
 await configureKeyedProvider({upsert:async row=>{entry=row;},setKey:async()=>{}},'openrouter','opaque','http://localhost:18766');
 assert.equal(entry.type,'openrouter');assert.equal(entry.baseUrl,'http://localhost:18766/v1');
 await assert.rejects(configureKeyedProvider({upsert:async()=>{},setKey:async()=>{}},'openrouter','opaque','http://user:pass@host'),/gateway/i);
});

test('failed terminal session error outranks unrelated stderr and preserves evidence', () => {
  const events=[{sessionId:'root',type:'session-error',data:{text:'Actual terminal error'}},
    {sessionId:'root',type:'session-error',data:{text:'Child error',agentId:'child'}}];
  const record={status:'failed',events};const before=structuredClone(record);
  assert.equal(runErrorDetail(record,'SDK warning'), 'Actual terminal error');
  assert.deepEqual(record,before);
});
test('failure summary falls back without an event error and bounds text',()=>{
  assert.equal(runErrorDetail({status:'failed',events:[],error:'Worker failed'},'warning'),'Worker failed');
  assert.equal(runErrorDetail({status:'failed',events:[]},'warning'),'warning');
  assert.equal(runErrorDetail({status:'failed',events:[]},''),'Worker exited without a diagnostic');
  assert.equal(runErrorDetail({status:'failed',events:[{type:'session-error',data:{text:'x'.repeat(10000)}}]},'warning').length,8000);
});
test('successful run with stderr warning is not a failure',()=>{
  assert.equal(runErrorDetail({status:'completed',events:[]},'SDK warning'),undefined);
});

test('empty stderr cannot erase the worker error', () => {
  assert.equal(failureDetail('Provider not configured', ''), 'Provider not configured');
  assert.match(failureDetail('Worker cause', 'stderr detail'), /Worker cause.*stderr detail/s);
});
const text = (partId, text) => ({ sessionId: 'root', type: 'assistant-text', data: { partId, text } });
test('completed background report is pending until actual delivery confirmation', () => {
  const state = { terminal: true, idle: true, shells: [], delegations: [{ status: 'completed', background: true, delivered: false }] };
  assert.equal(canSettle(state), false);
  state.delegations[0].delivered = true;
  assert.equal(canSettle(state), true);
  state.delegations = [{ status: 'running', background: true }];
  assert.equal(canSettle(state), false);
});
test('foreground failed record does not wait for a separate delivery that does not exist', () => {
  assert.equal(canSettle({ terminal: true, idle: true, shells: [], delegations: [{ status:'failed', background:false, delivered:false }] }), true);
});
test('final answer excludes prior turns, tool preambles, child text and retracted parts', () => {
  const events = [text('old', 'Old answer.'), { sessionId:'root', type:'user-message', data:{text:'Follow up'} },
    text('intro', 'Checking.'), { sessionId:'root', type:'tool-use', data:{} },
    text('retry', 'Abandoned'), { sessionId:'root', type:'assistant-thinking', data:{dropPart:{partIds:['retry']}} },
    text('retry', 'Final '), text('retry', 'answer.'), { ...text('child','Not the parent'), data:{text:'Not the parent', agentId:'child'} }];
  assert.equal(finalAnswer(events, 'root'), 'Final answer.');
});
test('Windows is explicitly refused until process-tree termination is implemented', () => {
  assert.throws(() => assertSupportedPlatform('win32'), /Windows/);
  assert.doesNotThrow(() => assertSupportedPlatform('linux'));
});
