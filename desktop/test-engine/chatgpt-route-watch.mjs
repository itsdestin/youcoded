// Is the Codex route still open? A daily check, with no account and no secret.
//
// WHY: Sign in with ChatGPT runs on the Codex CLI's client id and the private
// chatgpt.com/backend-api/codex endpoint. OpenAI can close either without warning.
// Destin chose (2026-10-05) to keep that route while it works and to ship OpenAI's
// official route built in but switched off, so the day this goes red is the day to
// flip it (YOUCODED_CHATGPT_ROUTE / ChatGptAuth's `route` default in main.ts).
//
// What it can see without signing in, measured 2026-10-05:
//   1. the token endpoint still RECOGNISES the Codex client id: a made-up refresh
//      token gets `token_expired`, whereas an unknown client gets `invalid_client`;
//   2. the Codex models and responses addresses still EXIST: 401 (needs sign-in),
//      whereas an address that is gone answers 403 with Cloudflare's page;
//   3. the official route's endpoints are still where the app expects them.
// What it CANNOT see: OpenAI refusing signed-in requests from apps that are not
// Codex. That needs a real sign-in, so it is not checked here.
//
//   node test-engine/chatgpt-route-watch.mjs        exit 0 open · 1 changed · 2 could not tell
//
// Sends nothing that is anyone's: no token, no account, no message to a model.

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const checks = [];
const record = (name, verdict, detail) => { checks.push({ name, verdict, detail }); console.log(`[${verdict}] ${name}: ${detail}`); };

async function readJson(r) {
  const text = await r.text();
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
}

async function tokenEndpoint() {
  const name = 'OpenAI still accepts the Codex client id';
  const r = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CODEX_CLIENT_ID, refresh_token: 'route-watch-not-a-token' }),
  });
  const { json, text } = await readJson(r);
  const code = json?.error?.code ?? json?.error ?? null;
  if (code === 'invalid_client') return record(name, 'CHANGED', `HTTP ${r.status} invalid_client — the Codex client id is no longer recognised`);
  if (code === 'token_expired' || code === 'invalid_grant') return record(name, 'ok', `HTTP ${r.status} ${code}`);
  record(name, 'unclear', `HTTP ${r.status} ${String(code ?? text.slice(0, 120)).replace(/\s+/g, ' ')}`);
}

async function codexAddress(name, url, init) {
  const r = await fetch(url, init);
  const { json, text } = await readJson(r);
  if (r.status === 401) return record(name, 'ok', 'HTTP 401 (exists, needs a sign-in)');
  if (r.status === 404 || r.status === 410) return record(name, 'CHANGED', `HTTP ${r.status} — the address is gone`);
  // A missing address and a bot wall both come back as Cloudflare's 403 page,
  // so a 403 alone is not proof either way.
  record(name, 'unclear', `HTTP ${r.status} ${json ? JSON.stringify(json).slice(0, 120) : text.slice(0, 80).replace(/\s+/g, ' ')}`);
}

async function officialEndpoints() {
  const name = "OpenAI's official sign-in is where the app expects it";
  const r = await fetch('https://auth.openai.com/.well-known/openid-configuration');
  const { json } = await readJson(r);
  const want = {
    authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
    token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
    revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
  };
  if (!json) return record(name, 'unclear', `HTTP ${r.status}, not JSON`);
  const moved = Object.entries(want).filter(([k, v]) => json[k] !== v).map(([k]) => `${k} is now ${json[k] ?? 'absent'}`);
  record(name, moved.length ? 'CHANGED' : 'ok', moved.length ? moved.join('; ') : 'authorize, token and revoke unchanged');
}

async function main() {
  for (const step of [
    tokenEndpoint,
    () => codexAddress('The Codex model list still exists', 'https://chatgpt.com/backend-api/codex/models?client_version=1.3.0', { headers: { accept: 'application/json' } }),
    () => codexAddress('The Codex message address still exists', 'https://chatgpt.com/backend-api/codex/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    officialEndpoints,
  ]) {
    try { await step(); } catch (e) { record('a check', 'unclear', `could not reach OpenAI: ${e.message}`); }
  }
  const changed = checks.filter((c) => c.verdict === 'CHANGED');
  const unclear = checks.filter((c) => c.verdict === 'unclear');
  const summary = [
    '## ChatGPT sign-in watch',
    '',
    changed.length
      ? '**Something changed.** If the Codex route has closed, switch YouCoded to the official route (`route` default in desktop/src/main/main.ts).'
      : unclear.length ? 'Nothing changed that this check can prove, but some answers were unclear.' : 'The Codex route still looks open.',
    '',
    '| Check | Result | Detail |', '|---|---|---|',
    ...checks.map((c) => `| ${c.name} | ${c.verdict} | ${c.detail.replace(/\|/g, '/')} |`),
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  }
  process.exit(changed.length ? 1 : unclear.length ? 2 : 0);
}

main();
