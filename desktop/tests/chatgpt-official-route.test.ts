// The OFFICIAL route of Sign in with ChatGPT — OpenAI's own sign-in for
// open-source apps — built in but off (YOUCODED_CHATGPT_ROUTE=official).
// Every wire fact pinned here was measured against a real account on
// 2026-10-05: youcoded-dev docs/archive/investigations/2026-10-05-chatgpt-official-siwc-phase0.md.
//
// Same harness idea as chatgpt-auth.test.ts: a REAL http listener for the
// callback, a routed fake fetch standing in for OpenAI, the real SecretsStore
// against the electron mock's reversible safeStorage, a tmp userData dir.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { getSecretStorage } from '../src/main/providers/secret-storage';
import {
  ChatGptAuth,
  CHATGPT_ACCOUNT_FILE,
  CHATGPT_REGISTRATION_FILE,
  type ChatGptAuthDeps,
  type ListenFn,
} from '../src/main/providers/chatgpt-auth';
import {
  CHATGPT_OFFICIAL_AUTHORIZE_URL,
  CHATGPT_OFFICIAL_MODELS_URL,
  CHATGPT_OFFICIAL_REVOKE_URL,
  CHATGPT_OFFICIAL_TOKEN_URL,
  CHATGPT_SIGN_IN_AGAIN_MESSAGE,
  CHATGPT_USAGE_URL,
  classifyErrorBody,
} from '../src/main/providers/chatgpt-oauth';
import { CHATGPT_APP_LIMIT_MESSAGE, isChatGptAppLimitMessage, isChatGptLimitMessage } from '../src/shared/chatgpt-types';

const MARKER = 'SIGMARKERofficial';
const CLIENT = 'oaiapp_TestClientId0000000000000';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.${MARKER}`;
}
/** The official access token: its account claims are opaque (measured). */
const accessJwt = (n: number) => jwt({ sub: 'user-sub-1', aud: 'https://api.openai.com/v1', client_id: CLIENT, n,
  'https://api.openai.com/auth': { per_user_salt: 'x', encrypted_auth_metadata: 'opaque' } });
const idJwt = (nonce: string | undefined, aud = CLIENT) => jwt({ sub: 'user-sub-1', aud: [aud], email: 'd@example.com', nonce });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MODELS_BODY = { models: [
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1, context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }], input_modalities: ['text', 'image'] },
  { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
] };

interface Call { url: string; init: RequestInit }
let dir: string;
let calls: Call[];
let opened: string[];
let auths: ChatGptAuth[];
let tokenScope: string;
let idNonce: 'echo' | 'wrong';
let refreshN: number;
let revokeStatus: number;

/** The nonce the last authorize URL carried — what a real id token echoes. */
function lastNonce(): string { return new URL(opened[opened.length - 1]).searchParams.get('nonce')!; }

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  calls.push({ url, init: init ?? {} });
  if (url === CHATGPT_OFFICIAL_TOKEN_URL) {
    const p = new URLSearchParams(String(init?.body));
    if (p.get('grant_type') === 'authorization_code') {
      return json(200, { access_token: accessJwt(0), refresh_token: `rt-0-${MARKER}`, id_token: idJwt(idNonce === 'echo' ? lastNonce() : 'not-this-round'),
        expires_in: 3600, scope: tokenScope, token_type: 'Bearer' });
    }
    refreshN += 1;
    return json(200, { access_token: accessJwt(refreshN), refresh_token: `rt-${refreshN}-${MARKER}`, expires_in: 3600, token_type: 'Bearer' });
  }
  if (url === CHATGPT_OFFICIAL_MODELS_URL) return json(200, MODELS_BODY);
  if (url === CHATGPT_OFFICIAL_REVOKE_URL) return new Response('', { status: revokeStatus });
  if (url.startsWith('https://api.openai.com/v1/responses')) return json(200, { ok: true });
  throw new Error(`unexpected fetch: ${url}`);
}

/** A real listener on a free port — the official route asks for port 0 and
 *  reads back what it got, exactly as it does in the app. */
const listen: ListenFn = (port, host, handler) => new Promise((resolve, reject) => {
  const s = http.createServer((req, res) => handler(req, res));
  s.once('error', reject);
  s.listen(port, host, () => resolve(s));
});

function build(overrides: Partial<ChatGptAuthDeps> = {}): ChatGptAuth {
  const a = new ChatGptAuth({
    userDataDir: dir,
    secrets: new SecretsStore(dir, getSecretStorage()),
    appVersion: '1.3.0',
    route: 'official',
    openExternal: async (u) => { opened.push(u); },
    fetch: fakeFetch as typeof fetch,
    listen,
    isEncryptionAvailable: () => true,
    log: () => {},
    ...overrides,
  });
  auths.push(a);
  return a;
}

/** Drive one browser round to its callback: open, then "OpenAI redirects back". */
async function signIn(auth: ChatGptAuth, callbackExtra: Record<string, string | null> = {}): Promise<{ outcome: unknown; status: number }> {
  await auth.signIn();
  const authorize = new URL(opened[opened.length - 1]);
  const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
  const q = new URLSearchParams({ code: 'the-code', scope: tokenScope, state: authorize.searchParams.get('state')!, client_id: CLIENT });
  for (const [k, v] of Object.entries(callbackExtra)) { if (v === null) q.delete(k); else q.set(k, v); }
  const r = await fetch(`${redirect.origin}${redirect.pathname}?${q}`);
  await r.text();
  return { outcome: await auth.waitForSignIn(), status: r.status };
}

const accountFile = () => JSON.parse(fs.readFileSync(path.join(dir, CHATGPT_ACCOUNT_FILE), 'utf8'));
const registration = () => JSON.parse(fs.readFileSync(path.join(dir, CHATGPT_REGISTRATION_FILE), 'utf8'));
const FULL_SCOPE = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-chatgpt-official-'));
  calls = []; opened = []; auths = [];
  tokenScope = FULL_SCOPE; idNonce = 'echo'; refreshN = 0; revokeStatus = 200;
});
afterEach(async () => {
  for (const a of auths) await a.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('official route — the sign-in round', () => {
  it('registers on the fly: dynamic client id, the app name, a loopback redirect on 127.0.0.1, resource and nonce', async () => {
    const auth = build();
    const { outcome } = await signIn(auth);
    expect(outcome).toBe('signed-in');
    const u = new URL(opened[0]);
    expect(`${u.origin}${u.pathname}`).toBe(CHATGPT_OFFICIAL_AUTHORIZE_URL);
    expect(u.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(u.searchParams.get('agent_name_hint')).toBe('YouCoded');
    expect(u.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    expect(u.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
    expect(u.searchParams.get('nonce')).toBeTruthy();
    expect(u.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  });

  it('exchanges with the ISSUED client id, the same redirect URI and the resource, and records the route', async () => {
    const auth = build();
    await signIn(auth);
    const exchange = calls.find((c) => c.url === CHATGPT_OFFICIAL_TOKEN_URL)!;
    const body = new URLSearchParams(String(exchange.init.body));
    expect(body.get('client_id')).toBe(CLIENT);
    expect(body.get('resource')).toBe('https://api.openai.com/v1');
    expect(body.get('redirect_uri')).toBe(new URL(opened[0]).searchParams.get('redirect_uri'));
    const file = accountFile();
    expect(file).toMatchObject({ route: 'official', clientId: CLIENT, accountId: 'user-sub-1', email: 'd@example.com', plan: '' });
    expect(JSON.stringify(file)).not.toContain(MARKER);
    expect(auth.status()).toEqual({ state: 'signed-in', email: 'd@example.com', plan: '', usage: null, route: 'official' });
  });

  it('keeps the registration across a sign-out, so the next sign-in reuses it instead of adding another "YouCoded"', async () => {
    const auth = build();
    await signIn(auth);
    const first = registration();
    expect(first).toMatchObject({ clientId: CLIENT });
    expect(first.port).toBe(Number(new URL(new URL(opened[0]).searchParams.get('redirect_uri')!).port));
    await auth.signOut();
    await signIn(auth);
    const second = new URL(opened[1]);
    expect(second.searchParams.get('client_id')).toBe(CLIENT);
    expect(second.searchParams.has('agent_name_hint')).toBe(false);
    expect(second.searchParams.get('ext_agent_host_id')).toBe(first.hostId);
    expect(second.searchParams.get('redirect_uri')).toBe(new URL(opened[0]).searchParams.get('redirect_uri'));
  });

  it('does not record a sign-in that refused YouCoded the plan, and says so', async () => {
    tokenScope = 'email offline_access openid profile resource.invoke';
    const auth = build();
    const { outcome } = await signIn(auth);
    expect(outcome).toEqual({ error: expect.stringContaining("didn't allow YouCoded to use your ChatGPT plan") });
    expect(auth.status().state).toBe('signed-out');
    expect(fs.existsSync(path.join(dir, CHATGPT_ACCOUNT_FILE))).toBe(false);
  });

  it('refuses a callback with no issued client id', async () => {
    const auth = build();
    const { outcome, status } = await signIn(auth, { client_id: null });
    expect(status).toBe(400);
    expect(outcome).toEqual({ error: expect.any(String) });
    expect(calls.some((c) => c.url === CHATGPT_OFFICIAL_TOKEN_URL)).toBe(false);
  });

  it('refuses an id token that answers a different round (nonce)', async () => {
    idNonce = 'wrong';
    const auth = build();
    const { outcome } = await signIn(auth);
    expect(outcome).toEqual({ error: expect.any(String) });
    expect(auth.status().state).toBe('signed-out');
  });
});

describe('official route — using the plan', () => {
  it('sends only the bearer — no Codex account header — and never polls usage', async () => {
    const auth = build();
    await signIn(auth);
    await auth.fetch()('https://api.openai.com/v1/responses', { method: 'POST', body: '{}', headers: { authorization: 'Bearer chatgpt' } });
    const sent = calls.find((c) => c.url.startsWith('https://api.openai.com/v1/responses'))!;
    const headers = new Headers(sent.init.headers);
    expect(headers.get('authorization')).toMatch(/^Bearer .+SIGMARKERofficial$/);
    expect(headers.has('chatgpt-account-id')).toBe(false);
    await auth.refreshUsage();
    expect(calls.some((c) => c.url === CHATGPT_USAGE_URL)).toBe(false);
  });

  it('reads the model list from the official address, listed rows only', async () => {
    const auth = build();
    await signIn(auth);
    await auth.refreshModels();
    const models = await auth.models();
    expect(calls.some((c) => c.url === CHATGPT_OFFICIAL_MODELS_URL)).toBe(true);
    expect(models.map((m) => m.id)).toEqual(['gpt-6-astra']);
  });

  it('refreshes with the issued client id and the resource, and keeps the ROTATED refresh token', async () => {
    let now = Date.parse('2026-10-05T12:00:00Z');
    const auth = build({ now: () => now });
    await signIn(auth);
    now += 59 * 60 * 1000; // inside the 5-minute margin of a 1-hour token
    await auth.accessToken();
    const refresh = calls.filter((c) => c.url === CHATGPT_OFFICIAL_TOKEN_URL)[1];
    const body = new URLSearchParams(String(refresh.init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(CLIENT);
    expect(body.get('resource')).toBe('https://api.openai.com/v1');
    expect(body.get('refresh_token')).toBe(`rt-0-${MARKER}`);
    now += 59 * 60 * 1000;
    await auth.accessToken();
    const second = new URLSearchParams(String(calls.filter((c) => c.url === CHATGPT_OFFICIAL_TOKEN_URL)[2].init.body));
    expect(second.get('refresh_token')).toBe(`rt-1-${MARKER}`);
  });
});

describe('official route — sign-out disconnects at OpenAI too', () => {
  it('revokes the refresh token with the issued client id', async () => {
    const auth = build();
    await signIn(auth);
    await auth.signOut();
    const revoke = calls.find((c) => c.url === CHATGPT_OFFICIAL_REVOKE_URL)!;
    const body = new URLSearchParams(String(revoke.init.body));
    expect(body.get('token')).toBe(`rt-0-${MARKER}`);
    expect(body.get('token_type_hint')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(CLIENT);
    expect(auth.status().state).toBe('signed-out');
  });

  it('a refused revoke still signs the user out', async () => {
    revokeStatus = 500;
    const auth = build();
    await signIn(auth);
    await expect(auth.signOut()).resolves.toBe(true);
    expect(auth.status().state).toBe('signed-out');
    expect(fs.existsSync(path.join(dir, CHATGPT_ACCOUNT_FILE))).toBe(false);
  });
});

describe('switching routes asks for one fresh sign-in (questions deck Q-2)', () => {
  it('an official sign-in reads as "sign in again" when the app is on the Codex route, and is not touched', async () => {
    const official = build();
    await signIn(official);
    await official.dispose();
    const before = fs.readFileSync(path.join(dir, CHATGPT_ACCOUNT_FILE), 'utf8');
    calls = [];
    const codex = build({ route: 'codex' });
    expect(codex.status()).toEqual({ state: 'signed-out', reauth: true });
    expect(codex.isSignedIn()).toBe(false);
    expect(() => codex.signedInAccount()).toThrow(CHATGPT_SIGN_IN_AGAIN_MESSAGE);
    await codex.refreshUsage();
    expect(calls).toEqual([]);
    expect(fs.readFileSync(path.join(dir, CHATGPT_ACCOUNT_FILE), 'utf8')).toBe(before);
  });

  it('a Codex sign-in (a row with no route) reads as "sign in again" on the official route', async () => {
    const secrets = new SecretsStore(dir, getSecretStorage());
    const ref = await secrets.set(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 864e6 }));
    fs.writeFileSync(path.join(dir, CHATGPT_ACCOUNT_FILE), JSON.stringify({ v: 1, secretRef: ref, accountId: 'acct-1', email: 'd@example.com', plan: 'plus' }));
    const auth = build();
    expect(auth.status()).toEqual({ state: 'signed-out', reauth: true });
    expect(() => auth.signedInAccount()).toThrow(CHATGPT_SIGN_IN_AGAIN_MESSAGE);
  });
});

describe('the official limit', () => {
  it('becomes its own sentence — no window, no reset time (OpenAI says not to guess either)', () => {
    const c = classifyErrorBody({ status: 429, body: JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }), now: Date.now() });
    expect(c).toEqual({ kind: 'limit', message: CHATGPT_APP_LIMIT_MESSAGE, windowLabel: '', resetsAt: '' });
    expect(isChatGptAppLimitMessage(CHATGPT_APP_LIMIT_MESSAGE)).toBe(true);
    // The Codex route's plan-limit card must not claim this one: it names a reset time.
    expect(isChatGptLimitMessage(CHATGPT_APP_LIMIT_MESSAGE)).toBe(false);
  });

  it('an ineligible plan is a blocked account with OpenAI\'s own words', () => {
    const c = classifyErrorBody({ status: 403, body: JSON.stringify({ error: { code: 'subscription_sharing_user_not_eligible', message: 'Your plan does not include this.' } }), now: Date.now() });
    expect(c).toEqual({ kind: 'blocked', reason: 'Your plan does not include this.' });
  });
});
