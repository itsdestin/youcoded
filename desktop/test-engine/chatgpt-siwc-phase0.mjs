// Phase 0 probe for OFFICIAL Sign in with ChatGPT (OpenAI's "SIWC" for
// open-source, locally run apps, launched 2026-09-29). Written from OpenAI's
// public docs (developers.openai.com/siwc/token-sharing-open-source/*), NOT from
// the @siwc/local SDK, whose licence is noncommercial.
//
// WHY: the shipped feature borrows the Codex CLI's client id and the private
// chatgpt.com/backend-api/codex route. Before rebuilding on the official route we
// must know, against a real account, what it can and cannot do for an agent:
//   Q1  does dynamic registration work and what does the callback return?
//   Q2  token lifetime, granted scopes, what the tokens say about the account
//   Q3  which models are listed
//   Q4  a plain streamed reply — and which response headers carry usage info
//   Q5  function tools: a two-step tool turn (the agent can't work without it)
//   Q6  which of the options the app sends today are refused: reasoning effort,
//       encrypted reasoning, prompt_cache_key, max_output_tokens, non-streaming
//   Q7  does a refresh work (and rotate the refresh token)?
//   Q8  does revocation work? (--keep skips it, leaving the grant in place)
//
//   cd desktop && node test-engine/chatgpt-siwc-phase0.mjs [--out <dir>] [--port N] [--keep]
//
// Tokens live only in this process's memory: never written, never printed.
// Throwaway: not imported by the app.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const API = 'https://api.openai.com/v1';
const APP_NAME = 'YouCoded';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = arg('--out') ?? path.join(os.tmpdir(), 'chatgpt-siwc-phase0');
const PORT = Number(arg('--port') ?? 0);
const KEEP = argv.includes('--keep');
fs.mkdirSync(OUT, { recursive: true });

const say = (s) => console.log(`[siwc] ${s}`);
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const decodeJwt = (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return null; } };
// Emails and long opaque strings are shortened so the saved claims carry shape, not identity.
const redact = (v) => {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.includes('@') ? `${v[0]}***@***` : v.length > 12 ? `${v.slice(0, 6)}…(${v.length})` : v;
  if (Array.isArray(v)) return v.map(redact);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
};
const save = (name, body) => { fs.writeFileSync(path.join(OUT, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2)); };
const scrub = (t) => t.replace(/"encrypted_content":"[^"]+"/g, '"encrypted_content":"…"');
const results = {};
const record = (k, v) => { results[k] = v; save('results.json', results); };

async function main() {
  // Discovery: the docs say endpoints come from here, so the probe reads them rather than guessing.
  const disc = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  save('discovery.json', disc);
  say(`discovery: authorize=${disc.authorization_endpoint} token=${disc.token_endpoint} revoke=${disc.revocation_endpoint ?? 'NONE'}`);

  // Q1 — PKCE + loopback listener + browser.
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const nonce = b64url(crypto.randomBytes(16));
  const hostId = `urn:uuid:${crypto.randomUUID()}`;

  const { code, clientId, redirectUri } = await new Promise((resolve, reject) => {
    let port;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== '/auth/callback') { res.statusCode = 404; res.end(); return; }
      const keys = [...u.searchParams.keys()];
      const err = u.searchParams.get('error');
      say(`callback: params=[${keys.join(',')}] state=${u.searchParams.get('state') === state ? 'ok' : 'MISMATCH'} error=${err ?? 'none'} ${err ? u.searchParams.get('error_description') ?? '' : ''}`);
      record('callbackParams', keys);
      const gotCode = u.searchParams.get('code');
      const gotClient = u.searchParams.get('client_id');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (u.searchParams.get('state') !== state || !gotCode) {
        res.end('<p>Sign-in did not complete. Return to YouCoded.</p>'); server.close();
        record('callbackError', { error: err, description: u.searchParams.get('error_description') });
        reject(new Error(`callback failed: ${err}`)); return;
      }
      res.end('<p>Test sign-in received. You can close this tab.</p>'); server.close();
      resolve({ code: gotCode, clientId: gotClient, redirectUri: `http://127.0.0.1:${port}/auth/callback` });
    });
    server.on('error', (e) => reject(e));
    server.listen(PORT, '127.0.0.1', () => {
      port = server.address().port;
      const url = new URL(disc.authorization_endpoint);
      for (const [k, v] of Object.entries({
        response_type: 'code', client_id: 'dynamic_agent_client',
        redirect_uri: `http://127.0.0.1:${port}/auth/callback`, scope: SCOPE, resource: RESOURCE,
        state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
        agent_name_hint: APP_NAME, ext_agent_host_id: hostId,
      })) url.searchParams.set(k, v);
      say(`listening on 127.0.0.1:${port} — opening the browser`);
      spawn('xdg-open', [url.toString()], { stdio: 'ignore', detached: true }).unref();
      say(`if no browser opened, paste this URL:\n${url}`);
    });
    setTimeout(() => { server.close(); reject(new Error('timeout: no sign-in in 10 minutes')); }, 600_000).unref();
  });
  record('Q1_registration', { issuedClientIdPrefix: clientId?.split('_')[0] ?? null, clientIdLength: clientId?.length ?? 0, redirectUri });
  say(`Q1: issued client id ${clientId ? `${clientId.slice(0, 8)}…` : 'ABSENT'}`);
  if (!clientId) throw new Error('no client_id on callback');

  // Q2 — exchange.
  const form = (o) => new URLSearchParams(o).toString();
  const tokenPost = (body) => fetch(disc.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form(body) });
  const ex = await tokenPost({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
  const tok = await ex.json();
  say(`Q2: exchange HTTP ${ex.status}`);
  if (!ex.ok) { save('exchange-error.json', tok); throw new Error('exchange failed'); }
  const access = decodeJwt(tok.access_token) ?? {};
  const idc = decodeJwt(tok.id_token) ?? {};
  record('Q2_tokens', {
    fields: Object.keys(tok), expires_in: tok.expires_in, scope: tok.scope, earliest_refresh_at: tok.earliest_refresh_at ?? null,
    grantedPlanUsage: String(tok.scope ?? '').split(/\s+/).includes('chatgpt.tokens.use.direct'),
    accessClaims: redact(access), idClaims: redact(idc), nonceOk: idc.nonce === nonce,
  });
  say(`Q2: expires_in=${tok.expires_in} scope="${tok.scope}"`);
  let accessToken = tok.access_token;
  let refreshToken = tok.refresh_token;

  const authH = () => ({ authorization: `Bearer ${accessToken}` });
  const interestingHeaders = (r) => { const h = {}; r.headers.forEach((v, k) => { if (/ratelimit|rate-limit|usage|limit|plan|retry|x-request-id|openai|codex|reset|window/i.test(k)) h[k] = v; }); return h; };

  // --followup: the questions the first run left open (run 1, 2026-10-05).
  if (argv.includes('--usage-hunt')) {
    await usageHunt({ authH, interestingHeaders });
    // Leave no "YouCoded" connection behind in the account's ChatGPT settings.
    const rv = await fetch(disc.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }) });
    say(`signed out: revoke HTTP ${rv.status}`);
    return;
  }
  if (argv.includes('--followup')) { await followup({ disc, clientId, authH, interestingHeaders, tokenPost, getRefresh: () => refreshToken, form }); return; }

  // Q3 — models.
  const mr = await fetch(`${API}/models`, { headers: { ...authH(), accept: 'application/json' } });
  const mText = await mr.text();
  save(`models.${mr.ok ? 'json' : `http${mr.status}.txt`}`, mText);
  let models = [];
  try { const j = JSON.parse(mText); models = j.models ?? j.data ?? []; } catch {}
  const listed = models.filter((m) => (m.visibility ?? 'list') === 'list').map((m) => m.slug ?? m.id);
  record('Q3_models', { status: mr.status, count: models.length, listed, keysOfFirst: models[0] ? Object.keys(models[0]) : [] });
  say(`Q3: HTTP ${mr.status} listed=${listed.join(', ')}`);
  const MODEL = process.env.SIWC_MODEL ?? listed[0];
  if (!MODEL) throw new Error('no model to call');

  const respond = async (label, body, { stream = true } = {}) => {
    const r = await fetch(`${API}/responses`, {
      method: 'POST',
      headers: { ...authH(), 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' },
      body: JSON.stringify({ model: MODEL, store: false, ...(stream ? { stream: true } : {}), ...body }),
    });
    const text = await r.text();
    const events = [...text.matchAll(/^data: (\{.*\})$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter(Boolean);
    const done = events.filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
    const completed = events.find((e) => e.type === 'response.completed');
    const failed = events.find((e) => e.type === 'response.failed' || e.type === 'error');
    let errBody = null; if (!r.ok) { try { errBody = JSON.parse(text); } catch { errBody = text.slice(0, 500); } }
    const summary = {
      status: r.status, headers: interestingHeaders(r), eventTypes: [...new Set(events.map((e) => e.type))],
      items: done.map((i) => i.type), usage: completed?.response?.usage ?? null,
      failed: failed ? redact(failed) : null, error: errBody,
    };
    record(label, summary);
    save(`${label}.${r.ok ? 'sse.txt' : `http${r.status}.txt`}`, scrub(text));
    say(`${label}: HTTP ${r.status} items=[${summary.items}] ${errBody ? `error=${JSON.stringify(errBody).slice(0, 240)}` : ''}${failed ? ` FAILED-EVENT=${JSON.stringify(failed).slice(0, 240)}` : ''}`);
    return { r, done, completed };
  };

  const ask = (t) => [{ role: 'user', content: [{ type: 'input_text', text: t }] }];

  // Q4 — plain streamed reply, minimal body.
  await respond('Q4_plain', { instructions: 'Reply with the single word: ok', input: ask('ok?') });

  // Q5 — two-step tool turn. Step 2 carries the call + output but no reasoning item,
  // which is the shape the app's history sends today.
  const tool = { type: 'function', name: 'get_time', description: 'Current time', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: true };
  const s1 = await respond('Q5_tool_step1', { instructions: 'Use the get_time tool, then answer.', tools: [tool], input: ask('What time is it?') });
  const call = s1.done.find((i) => i.type === 'function_call');
  if (call) {
    await respond('Q5_tool_step2', {
      instructions: 'Use the get_time tool, then answer.', tools: [tool],
      input: [...ask('What time is it?'),
        { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.call_id, output: '12:00' }],
    });
  } else say('Q5: no function_call in step 1 — tool calling NOT confirmed');

  // Q6 — one option at a time, so a refusal names exactly which one.
  const base = { instructions: 'Reply with the single word: ok', input: ask('ok?') };
  await respond('Q6_reasoning_effort', { ...base, reasoning: { effort: 'low' } });
  await respond('Q6_reasoning_summary', { ...base, reasoning: { effort: 'low', summary: 'auto' } });
  await respond('Q6_include_encrypted', { ...base, include: ['reasoning.encrypted_content'] });
  await respond('Q6_prompt_cache_key', { ...base, prompt_cache_key: 'youcoded-siwc-probe' });
  await respond('Q6_max_output_tokens', { ...base, max_output_tokens: 64 });
  await respond('Q6_parallel_tool_calls', { ...base, tools: [tool], parallel_tool_calls: true });
  await respond('Q6_image_input', { instructions: 'Describe the image in three words.', input: [{ role: 'user', content: [
    { type: 'input_text', text: 'What is this?' },
    // 1×1 red PNG — enough to learn whether image input is accepted at all.
    { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' },
  ] }] });
  await respond('Q6_non_streaming', base, { stream: false });
  // Prompt caching: the same long prefix twice — does the second report cached_tokens?
  const longPrefix = 'You are a careful assistant. '.repeat(400);
  await respond('Q6_cache_first', { instructions: longPrefix, input: ask('Say ok.') });
  await respond('Q6_cache_second', { instructions: longPrefix, input: ask('Say ok.') });

  // Q7 — refresh, and does it rotate the refresh token?
  const rf = await tokenPost({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE });
  const rj = await rf.json().catch(() => ({}));
  record('Q7_refresh', { status: rf.status, fields: Object.keys(rj), expires_in: rj.expires_in, scope: rj.scope ?? null, rotated: !!rj.refresh_token && rj.refresh_token !== refreshToken, error: rf.ok ? null : rj });
  say(`Q7: refresh HTTP ${rf.status} rotated=${!!rj.refresh_token && rj.refresh_token !== refreshToken}`);
  if (rf.ok) { accessToken = rj.access_token; refreshToken = rj.refresh_token ?? refreshToken; }

  // Q8 — revocation (the app's Sign out). --keep leaves the connection in ChatGPT Settings.
  if (!KEEP && disc.revocation_endpoint) {
    const rv = await fetch(disc.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }) });
    const after = await fetch(`${API}/models`, { headers: { ...authH(), accept: 'application/json' } });
    record('Q8_revoke', { status: rv.status, accessTokenStillWorks: after.ok, afterStatus: after.status });
    say(`Q8: revoke HTTP ${rv.status}; access token afterwards HTTP ${after.status}`);
  } else record('Q8_revoke', { skipped: true });

  say(`done — results in ${path.join(OUT, 'results.json')}`);
}

// F1  can the plan's usage still be read? (the app's 5h/weekly bars come from /wham/usage today)
// F2  does prompt caching ever kick in? Run 1 sent the same 2.4k-token prompt twice with no
//     prompt_cache_key and got cached_tokens 0 both times. Here: a longer prefix, WITH a key,
//     three times a few seconds apart, and every response header name recorded.
// F3  after revocation, is the refresh token really dead (what does a dead refresh say)?
async function followup({ disc, clientId, authH, interestingHeaders, tokenPost, getRefresh, form }) {
  for (const [name, u] of [['F1_wham_usage', 'https://chatgpt.com/backend-api/wham/usage'], ['F1_v1_usage_guess', `${API}/usage`]]) {
    const r = await fetch(u, { headers: { ...authH(), accept: 'application/json' } });
    const t = await r.text();
    record(name, { status: r.status, body: t.slice(0, 400) });
    say(`${name}: HTTP ${r.status} ${t.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  const mr = await (await fetch(`${API}/models`, { headers: { ...authH(), accept: 'application/json' } })).json();
  const model = process.env.SIWC_MODEL ?? mr.models.find((m) => m.visibility === 'list').slug;
  const prefix = Array.from({ length: 600 }, (_, i) => `Rule ${i}: answer carefully and briefly.`).join('\n');
  // Run 2 got cached 0/3 without the affinity header; the shipped app sends
  // `session-id` + `x-client-request-id` (chatgpt-model.ts) — --affinity sends the same.
  const sid = crypto.randomUUID();
  const affinity = argv.includes('--affinity') ? { 'session-id': sid, 'x-client-request-id': sid } : {};
  record('F2_affinity', Object.keys(affinity));
  for (let i = 1; i <= 3; i++) {
    const r = await fetch(`${API}/responses`, {
      method: 'POST', headers: { ...authH(), ...affinity, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ model, store: false, stream: true, prompt_cache_key: sid, instructions: prefix, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Say ok.' }] }] }),
    });
    const t = await r.text();
    const comp = [...t.matchAll(/^data: (\{.*\})$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).find((e) => e?.type === 'response.completed');
    const names = []; r.headers.forEach((_, k) => names.push(k));
    const u = comp?.response?.usage;
    record(`F2_cache_${i}`, { model, status: r.status, input: u?.input_tokens, cached: u?.input_tokens_details?.cached_tokens, headerNames: names, interesting: Object.keys(interestingHeaders(r)) });
    say(`F2 #${i} (${model}): HTTP ${r.status} input=${u?.input_tokens} cached=${u?.input_tokens_details?.cached_tokens}`);
    await new Promise((res) => setTimeout(res, 4000));
  }
  const rv = await fetch(disc.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ token: getRefresh(), token_type_hint: 'refresh_token', client_id: clientId }) });
  const rf = await tokenPost({ grant_type: 'refresh_token', client_id: clientId, refresh_token: getRefresh(), resource: RESOURCE });
  const rj = await rf.json().catch(() => ({}));
  record('F3_refresh_after_revoke', { revokeStatus: rv.status, refreshStatus: rf.status, error: rj.error ?? null, error_description: rj.error_description ?? null, code: rj.code ?? rj.error?.code ?? null });
  say(`F3: revoke HTTP ${rv.status}; refresh afterwards HTTP ${rf.status} ${JSON.stringify(rj).slice(0, 200)}`);
  say(`done — results in ${path.join(OUT, 'results.json')}`);
}

// --usage-hunt (2026-10-05, Destin: "there's gotta be a way to find/pull this information").
// The docs say apps cannot read plan usage; /wham/usage refused this token. Three more places:
// U1  candidate GET addresses on both hosts
// U2  the same HTTP reply asked for in the Codex client's dress (originator / beta headers) —
//     the Codex route put x-codex-primary-* on every reply; does any header set unlock them here?
// U3  the Responses WebSocket (the manifest says prefer_websockets: true). Codex receives a
//     `codex.rate_limits` event over it; every event type and the upgrade headers are recorded.
async function usageHunt({ authH, interestingHeaders }) {
  const { default: WebSocket } = await import('ws');
  for (const u of [
    `${API}/me`, `${API}/usage`, `${API}/rate_limits`, `${API}/chatgpt/usage`, `${API}/subscription_sharing/usage`,
    `${API}/organization/usage`, 'https://chatgpt.com/backend-api/wham/usage', 'https://chatgpt.com/backend-api/codex/usage',
    'https://chatgpt.com/backend-api/me', 'https://auth.openai.com/userinfo',
  ]) {
    try {
      const r = await fetch(u, { headers: { ...authH(), accept: 'application/json' } });
      const t = await r.text();
      record(`U1 ${u}`, { status: r.status, body: t.slice(0, 300) });
      say(`U1 ${u}: HTTP ${r.status} ${t.slice(0, 140).replace(/\s+/g, ' ')}`);
    } catch (e) { say(`U1 ${u}: ${e.message}`); }
  }
  const mr = await (await fetch(`${API}/models`, { headers: { ...authH(), accept: 'application/json' } })).json();
  const model = mr.models.find((m) => m.visibility === 'list').slug;
  const body = { model, store: false, stream: true, instructions: 'Reply with the single word: ok', input: [{ role: 'user', content: [{ type: 'input_text', text: 'ok?' }] }] };
  for (const [label, extra] of [
    ['plain', {}],
    ['codex-originator', { originator: 'codex_cli_rs', version: '0.140.0' }],
    ['beta-experimental', { 'OpenAI-Beta': 'responses=experimental' }],
  ]) {
    const r = await fetch(`${API}/responses`, { method: 'POST', headers: { ...authH(), ...extra, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) });
    const t = await r.text();
    const names = []; r.headers.forEach((_, k) => names.push(k));
    const types = [...new Set([...t.matchAll(/"type":"([a-z_.]+)"/g)].map((m) => m[1]).filter((x) => !x.startsWith('response.output') && !x.startsWith('response.content')))];
    record(`U2 ${label}`, { status: r.status, headerNames: names, interesting: interestingHeaders(r), eventTypes: types });
    say(`U2 ${label}: HTTP ${r.status} headers=${names.filter((n) => /codex|limit|usage|plan/i.test(n)).join(',')} events=${types.join(',')}`);
  }
  for (const [label, extra] of [['ws-plain', {}], ['ws-beta', { 'OpenAI-Beta': 'responses_websockets=2026-02-06' }]]) {
    await new Promise((resolve) => {
      const events = []; let upgrade = null;
      const ws = new WebSocket('wss://api.openai.com/v1/responses', { headers: { ...authH(), ...extra } });
      const done = (why) => { try { ws.close(); } catch {} record(`U3 ${label}`, { why, upgrade, events }); say(`U3 ${label}: ${why}; events=${events.map((e) => e.type).join(',')}`); resolve(); };
      ws.on('upgrade', (res) => { upgrade = Object.fromEntries(Object.entries(res.headers).filter(([k]) => /codex|limit|usage|plan|x-/i.test(k))); });
      ws.on('unexpected-response', (_req, res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => done(`HTTP ${res.statusCode} ${b.slice(0, 200)}`)); });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'response.create', ...body, stream: undefined })));
      ws.on('message', (data) => {
        let e; try { e = JSON.parse(String(data)); } catch { return; }
        // Keep whole any event that is not ordinary text streaming — that is where usage would be.
        events.push(/^response\.(output|content)/.test(e.type) ? { type: e.type } : { type: e.type, body: redact(e) });
        if (e.type === 'response.completed' || e.type === 'response.failed' || e.type === 'error') setTimeout(() => done('finished'), 1500);
      });
      ws.on('error', (e) => done(`error ${e.message}`));
      setTimeout(() => done('timeout'), 30000);
    });
  }
  say(`done — results in ${path.join(OUT, 'results.json')}`);
}

main().catch((e) => { say(`FAILED: ${e?.message ?? e}`); record('fatal', String(e?.message ?? e)); process.exit(1); });
