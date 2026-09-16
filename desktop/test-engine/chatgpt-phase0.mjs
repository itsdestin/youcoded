// Phase 0 probe for Sign in with ChatGPT (design: youcoded-dev
// docs/active/specs/2026-09-05-chatgpt-signin-backend-design.md §0).
//
// Run under the ELECTRON binary, not node, so the sign-in is exercised in the
// same process environment the app's main process has (sandbox, shell.openExternal,
// the bundled Node's fetch and http):
//
//   cd desktop && npx electron test-engine/chatgpt-phase0.mjs [--out <dir>]
//
// What it does, in order, printing a line per step:
//   1. binds 127.0.0.1:1455 and opens the browser on OpenAI's authorize URL (PKCE)
//   2. takes the callback, exchanges the code, decodes the token claims (REDACTED)
//   3. GETs /wham/usage, /codex/models (with OUR version and a Codex one), /wham/accounts/check
//      and /wham/profiles/me, writing each raw body to <out>/ (no secrets in those bodies)
//   4. makes one tiny /codex/responses call and records every x-codex-* / ratelimit
//      response header, plus the first SSE event names
//   5. runs a two-step tool turn whose follow-up carries the function_call WITHOUT the
//      encrypted reasoning item (the harness's history shape) — does the endpoint accept it?
//
// It never writes a token to disk and never prints one. Tokens live in this
// process's memory and die with it. Throwaway: not imported by the app.
import { app, shell } from 'electron';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE = 'https://auth.openai.com';
const REDIRECT = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';
const BACKEND = 'https://chatgpt.com/backend-api';

const APP_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : path.join(os.tmpdir(), 'chatgpt-phase0');
fs.mkdirSync(OUT, { recursive: true });

const say = (s) => console.log(`[phase0] ${s}`);
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeJwt = (t) => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')); } catch { return null; } };
const redact = (v) => {
  if (v == null) return v;
  if (typeof v === 'string') {
    if (v.includes('@')) return v[0] + '***@***';
    return v.length > 8 ? `${v.slice(0, 4)}…(${v.length} chars)` : v;
  }
  if (Array.isArray(v)) return v.map(redact);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
  return v;
};
const save = (name, body) => { const p = path.join(OUT, name); fs.writeFileSync(p, body); say(`wrote ${p}`); };

async function main() {
  await app.whenReady();
  say(`electron ${process.versions.electron} node ${process.versions.node} sandbox=${process.sandboxed ?? 'n/a'}`);

  // 1. PKCE + listener + browser
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = crypto.randomBytes(16).toString('hex');
  const url = new URL(`${AUTH_BASE}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT, scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state,
    // pi sends these two; harmless if ignored.
    id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true',
  })) url.searchParams.set(k, v);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost:1455');
      if (u.pathname !== '/auth/callback') { res.statusCode = 404; res.end('not the callback'); return; }
      const gotState = u.searchParams.get('state');
      const gotCode = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      say(`callback: received state=${gotState === state ? 'ok' : 'MISMATCH'} code=${gotCode ? 'present' : 'absent'} error=${err ?? 'none'} ${err ? u.searchParams.get('error_description') : ''}`);
      if (gotState !== state || !gotCode) { res.statusCode = 400; res.end('Sign-in failed. You can close this tab.'); server.close(); reject(new Error('callback failed')); return; }
      res.setHeader('content-type', 'text/html'); res.end('<p>Phase 0: you can close this tab and return to the terminal.</p>');
      server.close(); resolve(gotCode);
    });
    server.on('error', (e) => { say(`listener error: ${e.code} ${e.message}`); reject(e); });
    server.listen(1455, '127.0.0.1', () => {
      say('listener: bound 127.0.0.1:1455');
      // PHASE0_NO_BROWSER=1 skips the browser so the listener leg can be checked
      // alone (curl the callback with a bad state and expect MISMATCH).
      if (process.env.PHASE0_NO_BROWSER === '1') say('browser: skipped (PHASE0_NO_BROWSER=1)');
      else shell.openExternal(url.toString()).then(() => say('browser: openExternal resolved'), (e) => say(`browser: openExternal FAILED ${e.message}`));
      say(`if no browser opened, paste this URL yourself:\n${url.toString()}`);
    });
    const timer = setTimeout(() => { say('timeout: no callback in 10 minutes'); server.close(); reject(new Error('timeout')); }, 600_000);
    server.on('close', () => clearTimeout(timer));
  });

  // 2. exchange
  const tokRes = await fetch(`${AUTH_BASE}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: REDIRECT }),
  });
  say(`token exchange: HTTP ${tokRes.status}`);
  const tok = await tokRes.json();
  if (!tokRes.ok) { save('token-error.json', JSON.stringify(tok, null, 2)); throw new Error('exchange failed'); }
  say(`token fields: ${Object.keys(tok).join(', ')} expires_in=${tok.expires_in}`);
  const access = decodeJwt(tok.access_token) ?? {};
  const idc = decodeJwt(tok.id_token ?? '') ?? {};
  say(`access claims (redacted): ${JSON.stringify(redact(access))}`);
  say(`id claims (redacted): ${JSON.stringify(redact(idc))}`);
  const auth = access['https://api.openai.com/auth'] ?? {};
  const accountId = auth.chatgpt_account_id;
  say(`account: id=${accountId ? 'present' : 'ABSENT'} plan_type=${auth.chatgpt_plan_type ?? 'ABSENT'} email=${idc.email ? 'present' : 'ABSENT'}`);
  save('claims.redacted.json', JSON.stringify({ access: redact(access), id: redact(idc) }, null, 2));

  const H = { authorization: `Bearer ${tok.access_token}`, 'chatgpt-account-id': accountId ?? '', accept: 'application/json', originator: 'youcoded-phase0' };

  // 3. the three GETs
  for (const [name, u] of [
    ['usage', `${BACKEND}/wham/usage`],
    // P0-3: the manifest with OUR version string and with a Codex-CLI-shaped one — if
    // the manifest gates rows on the caller's version, the app's own string is
    // what R3 is graded against, so both bodies are kept.
    // Review R2-5: under `npx electron <script>` app.getVersion() is ELECTRON's number,
    // so the app's own version is read straight from desktop/package.json.
    ['models-app-version', `${BACKEND}/codex/models?client_version=${encodeURIComponent(APP_VERSION)}`],
    ['models-codex-version', `${BACKEND}/codex/models?client_version=${encodeURIComponent(process.env.CLIENT_VERSION ?? '0.130.0')}`],
    ['accounts-check', `${BACKEND}/wham/accounts/check`],
    ['profile', `${BACKEND}/wham/profiles/me`],
  ]) {
    try {
      const r = await fetch(u, { headers: H });
      const text = await r.text();
      say(`${name}: GET ${u} → HTTP ${r.status} content-type=${r.headers.get('content-type')} bytes=${text.length}`);
      save(`${name}.${r.ok ? 'json' : `http${r.status}.txt`}`, text);
    } catch (e) { say(`${name}: FAILED ${e.message}`); }
  }

  // 4. one tiny responses call, headers only
  try {
    const r = await fetch(`${BACKEND}/codex/responses`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json', 'OpenAI-Beta': 'responses=experimental', accept: 'text/event-stream' },
      body: JSON.stringify({
        model: process.env.PHASE0_MODEL ?? 'gpt-5.5', store: false, stream: true,
        instructions: 'Reply with the single word: ok', input: [{ role: 'user', content: [{ type: 'input_text', text: 'ok?' }] }],
        include: ['reasoning.encrypted_content'], prompt_cache_key: 'phase0',
      }),
    });
    const hdrs = {};
    r.headers.forEach((v, k) => { if (/codex|ratelimit|rate-limit|retry|plan|window|usage/i.test(k)) hdrs[k] = v; });
    say(`responses: HTTP ${r.status} interesting headers: ${JSON.stringify(hdrs)}`);
    const allKeys = []; r.headers.forEach((_, k) => allKeys.push(k));
    save('responses-headers.json', JSON.stringify({ status: r.status, interesting: hdrs, allHeaderNames: allKeys }, null, 2));
    const text = await r.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    say(`responses: ${events.length} SSE events; first: ${events.slice(0, 6).join(', ')}`);
    if (!r.ok) save(`responses.http${r.status}.txt`, text);
    else save('responses.sse.txt', text.replace(/"encrypted_content":"[^"]+"/g, '"encrypted_content":"…"'));
  } catch (e) { say(`responses: FAILED ${e.message}`); }

  // P0-5 (review R2-2): is a NON-streaming call refused? The native auto-title feeder
  // uses generateText, which sends no `stream: true`.
  try {
    const r = await fetch(`${BACKEND}/codex/responses`, {
      method: 'POST', headers: { ...H, 'content-type': 'application/json', 'OpenAI-Beta': 'responses=experimental' },
      // The SDK's generateText body carries NO `stream` key at all (review R3-7) — send that exact shape.
      body: JSON.stringify({ model: process.env.PHASE0_MODEL ?? 'gpt-5.5', store: false, instructions: 'Reply with the single word: ok', input: [{ role: 'user', content: [{ type: 'input_text', text: 'ok?' }] }] }),
    });
    const text = await r.text();
    say(`non-streaming: HTTP ${r.status} bytes=${text.length}`);
    save(`responses-nonstream.${r.ok ? 'json' : `http${r.status}.txt`}`, text.replace(/"encrypted_content":"[^"]+"/g, '"encrypted_content":"…"'));
  } catch (e) { say(`non-streaming: FAILED ${e.message}`); }

  // P0-4 (review R1-2): does a tool turn work when the follow-up carries the
  // function_call but NOT the encrypted reasoning item beside it? The harness keeps
  // text + tool calls in history, not reasoning, so this is the shape it sends.
  try {
    const tool = { type: 'function', name: 'get_time', description: 'Current time', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: true };
    const base = { model: process.env.PHASE0_MODEL ?? 'gpt-5.5', store: false, stream: true, instructions: 'Use the get_time tool, then answer.', tools: [tool], include: ['reasoning.encrypted_content'], prompt_cache_key: 'phase0-tools' };
    const hdr = { ...H, 'content-type': 'application/json', 'OpenAI-Beta': 'responses=experimental', accept: 'text/event-stream' };
    const step1 = await fetch(`${BACKEND}/codex/responses`, { method: 'POST', headers: hdr, body: JSON.stringify({ ...base, input: [{ role: 'user', content: [{ type: 'input_text', text: 'What time is it?' }] }] }) });
    const t1 = await step1.text();
    say(`tools step1: HTTP ${step1.status}`);
    // The completed function_call item, from the SSE stream's output_item.done events.
    const done = [...t1.matchAll(/^data: (\{.*\})$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
      .filter((e) => e && e.type === 'response.output_item.done').map((e) => e.item);
    const call = done.find((i) => i.type === 'function_call');
    const reasoning = done.find((i) => i.type === 'reasoning');
    say(`tools step1: items=${done.map((i) => i.type).join(',')} function_call=${call ? 'present' : 'ABSENT'} reasoning=${reasoning ? 'present' : 'absent'}`);
    if (call) {
      const followUp = [
        { role: 'user', content: [{ type: 'input_text', text: 'What time is it?' }] },
        { type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments },   // NO reasoning item
        { type: 'function_call_output', call_id: call.call_id, output: '12:00' },
      ];
      const step2 = await fetch(`${BACKEND}/codex/responses`, { method: 'POST', headers: hdr, body: JSON.stringify({ ...base, input: followUp }) });
      const t2 = await step2.text();
      const ev2 = [...t2.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
      say(`tools step2 (no reasoning item): HTTP ${step2.status} events=${ev2.length} first: ${ev2.slice(0, 5).join(', ')}`);
      save(`tools-step2.${step2.ok ? 'sse.txt' : `http${step2.status}.txt`}`, t2.replace(/"encrypted_content":"[^"]+"/g, '"encrypted_content":"…"'));
      if (reasoning) {
        // And WITH the reasoning item, so the two answers sit side by side.
        const step3 = await fetch(`${BACKEND}/codex/responses`, { method: 'POST', headers: hdr, body: JSON.stringify({ ...base, input: [followUp[0], reasoning, followUp[1], followUp[2]] }) });
        say(`tools step2 (with reasoning item): HTTP ${step3.status}`);
        if (!step3.ok) save(`tools-step2-with-reasoning.http${step3.status}.txt`, await step3.text());
      }
    }
    save('tools-step1.sse.txt', t1.replace(/"encrypted_content":"[^"]+"/g, '"encrypted_content":"…"'));
  } catch (e) { say(`tools: FAILED ${e.message}`); }

  say(`done — findings in ${OUT}`);
  app.exit(0);
}

main().catch((e) => { say(`FAILED: ${e?.stack ?? e}`); app.exit(1); });
