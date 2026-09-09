// ChatGptAuth — the stateful half of Sign in with ChatGPT. Pins design §8's
// row for tests/chatgpt-auth.test.ts: every arrow of the §3 state machine
// with injected I/O — a REAL http listener on an ephemeral port (the callback
// branches are exercised over real HTTP), a routed fake `fetch` standing in
// for OpenAI, a hand-rolled clock/timer set, the real SecretsStore against the
// electron mock's reversible safeStorage, and a tmp userData dir.
//
// Design: docs/active/specs/2026-09-05-chatgpt-signin-backend-design.md
// (workspace repo) §2, §3, §4.1, §4.3–4.6, §8.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import { safeStorage } from 'electron';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { mutateFileUnderLock } from '../src/main/artifacts/cas-write';
import {
  ChatGptAuth,
  CHATGPT_ACCOUNT_FILE,
  CHATGPT_PORT_IN_USE_MESSAGE,
  CHATGPT_KEYCHAIN_UNAVAILABLE_MESSAGE,
  CHATGPT_LOCK_HELD_MESSAGE,
  CALLBACK_PAGE_DONE,
  CALLBACK_PAGE_FAILED,
  CALLBACK_PAGE_TIMED_OUT,
  DEFAULT_SIGN_IN_TIMEOUT_MS,
  LINGER_MS,
  USAGE_POLL_MS,
  USAGE_DEBOUNCE_MS,
  type ChatGptAuthDeps,
  type ListenFn,
  type TimerFns,
  type TimerHandle,
} from '../src/main/providers/chatgpt-auth';
import {
  CHATGPT_TOKEN_URL,
  CHATGPT_USAGE_URL,
  CHATGPT_CODEX_BASE_URL,
  CHATGPT_SIGN_IN_EXPIRED_MESSAGE,
  CHATGPT_SIGN_IN_REQUIRED_MESSAGE,
  chatGptModelsUrl,
} from '../src/main/providers/chatgpt-oauth';
import { chatGptLimitMessage } from '../src/shared/chatgpt-types';
import { ChatGptRequestDiagnostics, withChatGptRequest, bindChatGptRequest } from '../src/main/providers/chatgpt-request-diagnostics';
import { chatGptMiddleware } from '../src/main/providers/chatgpt-model';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel, streamText } from 'ai';

// The lock primitive is real everywhere except the one test that pins the
// retry-then-throw, which makes it report "lock held" five times.
vi.mock('../src/main/artifacts/cas-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/artifacts/cas-write')>();
  return { ...actual, mutateFileUnderLock: vi.fn(actual.mutateFileUnderLock) };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-09-05T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const APP_VERSION = '1.2.4';
const CODEX_RESPONSES_URL = `${CHATGPT_CODEX_BASE_URL}/responses`;

// A marker that lands in every fake token's signature part, so "no token in
// the file / the logs / an error" is one string search.
const TOKEN_MARKER = 'SIGMARKERxyz';

function jwt(payload: Record<string, unknown>, marker = TOKEN_MARKER): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.${marker}`;
}
function accessJwt(opts: { plan?: string; email?: string; accountId?: string; marker?: string } = {}): string {
  return jwt({
    'https://api.openai.com/auth': { chatgpt_account_id: opts.accountId ?? 'acct-1', chatgpt_plan_type: opts.plan ?? 'plus' },
    'https://api.openai.com/profile': { email: opts.email ?? 'd@example.com' },
  }, opts.marker);
}
function idJwt(email = 'd@example.com'): string {
  return jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } });
}

/** A manual clock and timer set — real I/O keeps flowing, only OUR timers
 *  are under test control. Counts what the design pins: how many timers are
 *  pending, and whether every one was unref'd. */
class FakeClock implements TimerFns {
  now = T0;
  private seq = 0;
  readonly entries = new Map<number, { at: number; fn: () => void; every?: number; unrefed: boolean }>();
  private handle(id: number): TimerHandle & { id: number } {
    return { id, unref: () => { const e = this.entries.get(id); if (e) e.unrefed = true; } };
  }
  setTimeout(fn: () => void, ms: number) { const id = ++this.seq; this.entries.set(id, { at: this.now + ms, fn, unrefed: false }); return this.handle(id); }
  clearTimeout(t: TimerHandle) { this.entries.delete((t as { id: number }).id); }
  setInterval(fn: () => void, ms: number) { const id = ++this.seq; this.entries.set(id, { at: this.now + ms, fn, every: ms, unrefed: false }); return this.handle(id); }
  clearInterval(t: TimerHandle) { this.entries.delete((t as { id: number }).id); }
  timeouts() { return [...this.entries.values()].filter((e) => e.every === undefined); }
  intervals() { return [...this.entries.values()].filter((e) => e.every !== undefined); }
  allUnrefed() { return [...this.entries.values()].every((e) => e.unrefed); }
  /** Advance the clock, firing due timers in order; lets promise chains settle after each. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      for (const [id, e] of this.entries) if (e.at <= target && (nextId === null || e.at < this.entries.get(nextId)!.at)) nextId = id;
      if (nextId === null) break;
      const e = this.entries.get(nextId)!;
      this.now = Math.max(this.now, e.at);
      if (e.every !== undefined) e.at += e.every; else this.entries.delete(nextId);
      e.fn();
      await settle();
    }
    this.now = target;
  }
}

/** Let fire-and-forget promise chains (and their file writes) run out. */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
interface FakeFetch { fn: typeof fetch; calls: Array<{ url: string; init: RequestInit }>; routes: Array<[string | RegExp, Route]> }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A `fetch` routed by URL. Routes are consulted last-added-first so a test
 *  can override a default. */
function makeFetch(routes: Array<[string | RegExp, Route]> = []): FakeFetch {
  const ff: FakeFetch = { routes: [...routes], calls: [], fn: undefined as unknown as typeof fetch };
  ff.fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    ff.calls.push({ url, init: init ?? {} });
    for (let i = ff.routes.length - 1; i >= 0; i--) {
      const [m, route] = ff.routes[i];
      if (typeof m === 'string' ? url === m || url.startsWith(m) : m.test(url)) return route(url, init ?? {});
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return ff;
}

/** The token endpoint as OpenAI answers it: a code → a pair, a refresh → a
 *  new pair. Each grant gets a distinct marker so a test can tell which
 *  token a request carried. */
function tokenRoute(opts: { plan?: string; exchangeStatus?: number; refreshStatus?: number; refreshGate?: Promise<unknown>; exchangeGate?: Promise<unknown> } = {}): [string, Route] {
  let n = 0;
  return [CHATGPT_TOKEN_URL, async (_url, init) => {
    const params = new URLSearchParams(String(init.body));
    n += 1;
    if (params.get('grant_type') === 'authorization_code') {
      if (opts.exchangeGate) await opts.exchangeGate;
      if (opts.exchangeStatus) return json(opts.exchangeStatus, { error: 'invalid_grant', error_description: 'code already used' });
      return json(200, {
        access_token: accessJwt({ plan: opts.plan, marker: `${TOKEN_MARKER}-x${n}` }),
        refresh_token: `rt-x${n}-${TOKEN_MARKER}`,
        id_token: idJwt(),
        expires_in: 864000,
      });
    }
    if (opts.refreshGate) await opts.refreshGate;
    if (opts.refreshStatus) return json(opts.refreshStatus, { error: 'invalid_grant', error_description: 'refresh token revoked' });
    return json(200, {
      access_token: accessJwt({ plan: opts.plan, marker: `${TOKEN_MARKER}-r${n}` }),
      refresh_token: `rt-r${n}-${TOKEN_MARKER}`,
      expires_in: 864000,
    });
  }];
}

const USAGE_BODY = (plan = 'plus', now = T0) => ({
  plan_type: plan,
  rate_limit: {
    limit_reached: false,
    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: Math.round((now + HOUR) / 1000) },
    secondary_window: { used_percent: 30, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: Math.round((now + DAY) / 1000) },
  },
});
const MODELS_BODY = {
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 1, context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
  ],
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

/** The injected listener: a REAL http server, bound to the test's own port
 *  instead of 1455, so the four callback branches run over real HTTP and the
 *  EADDRINUSE / lingering-server behaviour is the genuine article. */
const listenOn = (port: number): ListenFn => (_port, host, handler) =>
  new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => handler(req, res));
    s.once('error', reject);
    s.listen(port, host, () => resolve(s));
  });

async function hit(port: number, pathAndQuery: string, method = 'GET'): Promise<{ status: number; text: string }> {
  const r = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, { method });
  return { status: r.status, text: await r.text() };
}

interface Harness {
  dir: string;
  file: string;
  secrets: SecretsStore;
  clock: FakeClock;
  fetch: FakeFetch;
  opened: string[];
  logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }>;
  port: number;
  auth: ChatGptAuth;
  build(overrides?: Partial<ChatGptAuthDeps>): ChatGptAuth;
  seedSignedIn(opts?: SeedOpts): Promise<string>;
  stateFromOpened(): string;
  secretsFile(): Record<string, string>;
}
interface SeedOpts {
  expiresInMs?: number;
  plan?: string;
  usage?: Record<string, unknown>;
  models?: { rows: unknown[]; at: string };
  blocked?: { reason: string; at: string };
  marker?: string;
  /** Write the account file but NOT the secret — a userData copied from another machine. */
  withoutSecret?: boolean;
}

let h: Harness;
let liveAuths: ChatGptAuth[] = [];

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-chatgpt-auth-'));
  const clock = new FakeClock();
  const fetchFake = makeFetch([
    tokenRoute(),
    [CHATGPT_USAGE_URL, () => json(200, USAGE_BODY('plus', clock.now))],
    [chatGptModelsUrl(APP_VERSION), () => json(200, MODELS_BODY)],
  ]);
  const port = await freePort();
  h = {
    dir,
    file: path.join(dir, CHATGPT_ACCOUNT_FILE),
    secrets: new SecretsStore(dir),
    clock,
    fetch: fetchFake,
    opened: [],
    logs: [],
    port,
    auth: undefined as unknown as ChatGptAuth,
    build(overrides = {}) {
      // Bind to THIS harness: `h` is reassigned per test, and an auth's late
      // fire-and-forget work must not log into the next test's ledger.
      const me = h;
      const auth = new ChatGptAuth({
        userDataDir: dir,
        secrets: me.secrets,
        appVersion: APP_VERSION,
        openExternal: async (url) => { me.opened.push(url); },
        fetch: me.fetch.fn,
        listen: listenOn(port),
        isEncryptionAvailable: () => true,
        now: () => clock.now,
        timers: clock,
        randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + me.opened.length) & 0xff),
        log: (level, message, meta) => { me.logs.push({ level, message, meta }); },
        ...overrides,
      });
      liveAuths.push(auth);
      me.auth = auth;
      return auth;
    },
    async seedSignedIn(opts = {}) {
      const blob = {
        access_token: accessJwt({ plan: opts.plan, marker: opts.marker ?? `${TOKEN_MARKER}-seed` }),
        refresh_token: `rt-seed-${TOKEN_MARKER}`,
        id_token: idJwt(),
        expires_at: clock.now + (opts.expiresInMs ?? 10 * DAY),
      };
      const ref = opts.withoutSecret ? 'ref-from-another-machine' : await h.secrets.set(JSON.stringify(blob));
      fs.writeFileSync(h.file, JSON.stringify({
        v: 1, secretRef: ref, accountId: 'acct-1', email: 'd@example.com', plan: opts.plan ?? 'plus',
        ...(opts.usage ? { usage: opts.usage } : {}),
        ...(opts.models ? { models: opts.models } : {}),
        ...(opts.blocked ? { blocked: opts.blocked } : {}),
      }));
      return ref;
    },
    stateFromOpened() {
      return new URL(h.opened[h.opened.length - 1]).searchParams.get('state')!;
    },
    secretsFile() {
      try { return JSON.parse(fs.readFileSync(path.join(dir, 'native-secrets.json'), 'utf8')); } catch { return {}; }
    },
  };
});

afterEach(async () => {
  for (const a of liveAuths) await a.dispose();
  liveAuths = [];
  vi.restoreAllMocks();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

/** Run a whole successful round: signIn → callback with the right state. */
async function completeSignIn(auth: ChatGptAuth, opts?: { timeoutMs?: number }): Promise<{ status: number; text: string }> {
  await auth.signIn(opts);
  const r = await hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&code=code-1`);
  await settle();
  return r;
}

const exchangeCalls = () => h.fetch.calls.filter((c) => c.url === CHATGPT_TOKEN_URL && String(c.init.body).includes('grant_type=authorization_code'));
const refreshCalls = () => h.fetch.calls.filter((c) => c.url === CHATGPT_TOKEN_URL && String(c.init.body).includes('grant_type=refresh_token'));
const usageCalls = () => h.fetch.calls.filter((c) => c.url === CHATGPT_USAGE_URL);
const modelsCalls = () => h.fetch.calls.filter((c) => c.url === chatGptModelsUrl(APP_VERSION));

// ---------------------------------------------------------------------------
// The sign-in round (§3)
// ---------------------------------------------------------------------------

describe('ChatGptAuth: the sign-in round', () => {
  it('signIn opens the authorize URL, reads as waiting, and a good callback signs in — nothing token-shaped touches the account file', async () => {
    const auth = h.build();
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect(await auth.signIn()).toBe(true);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toContain('https://auth.openai.com/oauth/authorize?');
    expect(auth.status()).toEqual({ state: 'waiting' });
    expect(auth.isSignedIn()).toBe(false);
    const wait = auth.waitForSignIn();

    const r = await completeSignIn(auth);
    expect(r.status).toBe(200);
    expect(r.text).toContain(CALLBACK_PAGE_DONE);
    expect(await wait).toBe('signed-in');

    // The exchange carried the code and the verifier as a form body.
    const ex = exchangeCalls();
    expect(ex).toHaveLength(1);
    const body = new URLSearchParams(String(ex[0].init.body));
    expect(body.get('code')).toBe('code-1');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');

    const status = auth.status();
    expect(status.state).toBe('signed-in');
    expect(status).toMatchObject({ email: 'd@example.com' });
    expect(auth.isSignedIn()).toBe(true);
    expect(auth.signedInAccount()).toEqual({ accountId: 'acct-1', email: 'd@example.com', plan: 'plus', authGeneration: 1 });

    // Token hygiene: the account file holds a ref, never the token; the
    // secrets file holds only ciphertext; no log line carries it.
    const fileText = fs.readFileSync(h.file, 'utf8');
    expect(fileText).not.toContain(TOKEN_MARKER);
    expect(fileText).toContain('"secretRef"');
    expect(fs.readFileSync(path.join(h.dir, 'native-secrets.json'), 'utf8')).not.toContain(TOKEN_MARKER);
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN_MARKER);
    // The listener is gone.
    expect(await portOpen(h.port)).toBe(false);
  });

  it('after the callback the poll starts, usage and models are kicked, and `plan` follows the poll', async () => {
    h.fetch.routes.push([CHATGPT_USAGE_URL, () => json(200, USAGE_BODY('pro', h.clock.now))]);
    const auth = h.build();
    expect(h.clock.intervals()).toHaveLength(0);
    await completeSignIn(auth);
    await vi.waitFor(() => expect(usageCalls().length).toBeGreaterThanOrEqual(1));
    await vi.waitFor(() => expect(modelsCalls()).toHaveLength(1));
    expect(h.clock.intervals()).toHaveLength(1);
    expect(h.clock.intervals()[0].every).toBe(USAGE_POLL_MS);
    expect(h.clock.allUnrefed()).toBe(true);
    // The token claimed 'plus'; the poll said 'pro'; the poll wins. The
    // poll's write is a real disk round trip, so wait on the result.
    await vi.waitFor(() => expect(auth.status()).toMatchObject({ state: 'signed-in', plan: 'pro' }));
    expect(h.logs.filter((l) => /usage poll/.test(l.message))).toEqual([]);
    const usage = auth.usageForStatus();
    expect(usage?.five_hour?.utilization).toBe(12);
    expect(usage?.seven_day?.utilization).toBe(30);
    // The usage and models requests carried the bearer and the account id.
    const u = usageCalls()[0].init.headers as Record<string, string>;
    expect(u.authorization).toMatch(/^Bearer /);
    expect(u['chatgpt-account-id']).toBe('acct-1');
    expect(await auth.models()).toEqual([expect.objectContaining({ id: 'gpt-5.5', providerId: 'chatgpt', label: 'GPT-5.5' })]);
  });

  it('a callback with the wrong state is a 400 that never exchanges and leaves the state waiting', async () => {
    const auth = h.build();
    await auth.signIn();
    const r = await hit(h.port, '/auth/callback?state=not-ours&code=stolen');
    expect(r.status).toBe(400);
    expect(exchangeCalls()).toHaveLength(0);
    expect(auth.status()).toEqual({ state: 'waiting' });
    const missing = await hit(h.port, '/auth/callback?code=stolen');
    expect(missing.status).toBe(400);
    expect(auth.status()).toEqual({ state: 'waiting' });
    // The right state still completes the same round afterwards.
    const ok = await hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&code=code-1`);
    expect(ok.status).toBe(200);
    await settle();
    expect(auth.status()).toMatchObject({ state: 'signed-in' });
  });

  it('anything but GET /auth/callback is a 404 with no state change', async () => {
    const auth = h.build();
    await auth.signIn();
    expect((await hit(h.port, '/')).status).toBe(404);
    expect((await hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&code=c`, 'POST')).status).toBe(404);
    expect(auth.status()).toEqual({ state: 'waiting' });
    expect(exchangeCalls()).toHaveLength(0);
  });

  it("OpenAI's error_description reaches the log and waitForSignIn, never the HTML; the state is signed-out", async () => {
    const auth = h.build();
    await auth.signIn();
    const wait = auth.waitForSignIn();
    const injected = '<img src=x onerror=alert(1)>ATTACKER-TEXT';
    const r = await hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&error=access_denied&error_description=${encodeURIComponent(injected)}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain(CALLBACK_PAGE_FAILED);
    expect(r.text).not.toContain('ATTACKER-TEXT');
    expect(r.text).not.toContain('onerror');
    expect(await wait).toEqual({ error: injected });
    expect(h.logs.some((l) => JSON.stringify(l.meta).includes('ATTACKER-TEXT'))).toBe(true);
    await settle();
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect(exchangeCalls()).toHaveLength(0);
    expect(await portOpen(h.port)).toBe(false);
  });

  it('cancelSignIn closes the listener, clears the timer and resolves waitForSignIn cancelled', async () => {
    const auth = h.build();
    await auth.signIn();
    const wait = auth.waitForSignIn();
    expect(h.clock.timeouts()).toHaveLength(1);
    expect(await portOpen(h.port)).toBe(true);
    expect(await auth.cancelSignIn()).toBe(true);
    expect(await wait).toBe('cancelled');
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect(await portOpen(h.port)).toBe(false);
    expect(h.clock.timeouts()).toHaveLength(0);
    expect(fs.existsSync(h.file)).toBe(false);
  });

  it('signOut during waiting resolves waitForSignIn cancelled and closes the listener', async () => {
    const auth = h.build();
    await auth.signIn();
    const wait = auth.waitForSignIn();
    expect(await auth.signOut()).toBe(true);
    expect(await wait).toBe('cancelled');
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect(await portOpen(h.port)).toBe(false);
  });

  it('a second signIn while waiting re-opens the same URL, adds no timer and bumps nothing', async () => {
    const auth = h.build();
    await auth.signIn({ timeoutMs: 5_000 });
    const firstState = h.stateFromOpened();
    const timersBefore = h.clock.timeouts().map((t) => t.at);
    expect(await auth.signIn({ timeoutMs: 99_000 })).toBe(true);
    expect(h.opened).toHaveLength(2);
    expect(h.opened[1]).toBe(h.opened[0]);
    expect(h.clock.timeouts().map((t) => t.at)).toEqual(timersBefore);
    // Same round: the FIRST state still completes it (a bumped generation
    // would have discarded the write).
    const r = await hit(h.port, `/auth/callback?state=${firstState}&code=code-1`);
    expect(r.status).toBe(200);
    await settle();
    expect(auth.status()).toMatchObject({ state: 'signed-in' });
  });

  it('the round times out at exactly the passed duration; the listener lingers one minute with a fixed page, then closes', async () => {
    const auth = h.build();
    await auth.signIn({ timeoutMs: 5_000 });
    const wait = auth.waitForSignIn();
    await h.clock.advance(4_999);
    expect(auth.status()).toEqual({ state: 'waiting' });
    await h.clock.advance(1);
    expect(await wait).toBe('timed-out');
    expect(auth.status()).toEqual({ state: 'signed-out' });

    // The late callback — even a valid one — gets the timed-out sentence and
    // changes nothing; so does any other path.
    const late = await hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&code=late`);
    expect(late.status).toBe(200);
    expect(late.text).toContain(CALLBACK_PAGE_TIMED_OUT);
    expect((await hit(h.port, '/anything')).text).toContain(CALLBACK_PAGE_TIMED_OUT);
    expect(exchangeCalls()).toHaveLength(0);
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect(fs.existsSync(h.file)).toBe(false);

    await h.clock.advance(LINGER_MS - 1);
    expect(await portOpen(h.port)).toBe(true);
    await h.clock.advance(1);
    await settle();
    expect(await portOpen(h.port)).toBe(false);
  });

  it('a signIn 5 s after a timeout succeeds on the same port: the lingering server is closed before binding', async () => {
    const auth = h.build();
    await auth.signIn({ timeoutMs: 1_000 });
    await h.clock.advance(1_000);
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect((await hit(h.port, '/x')).text).toContain(CALLBACK_PAGE_TIMED_OUT);
    await h.clock.advance(5_000);
    // Same fixed port: had the lingering server not been closed, this would
    // be EADDRINUSE and throw the port sentence.
    expect(await auth.signIn()).toBe(true);
    expect(auth.status()).toEqual({ state: 'waiting' });
    // Only the new round's timer remains — the linger timer was cleared.
    expect(h.clock.timeouts()).toHaveLength(1);
    expect(h.clock.timeouts()[0].at).toBe(h.clock.now + DEFAULT_SIGN_IN_TIMEOUT_MS);
    expect((await hit(h.port, '/x')).status).toBe(404);
    const r = await hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&code=code-2`);
    expect(r.text).toContain(CALLBACK_PAGE_DONE);
    await settle();
    expect(auth.status()).toMatchObject({ state: 'signed-in' });
  });

  it('timer-after-success is a no-op', async () => {
    const auth = h.build();
    await completeSignIn(auth, { timeoutMs: 1_000 });
    expect(auth.status()).toMatchObject({ state: 'signed-in' });
    await h.clock.advance(60_000);
    expect(auth.status()).toMatchObject({ state: 'signed-in', email: 'd@example.com' });
    expect(fs.existsSync(h.file)).toBe(true);
  });

  it('status() is waiting while the exchange is pending', async () => {
    const gate = deferred<void>();
    h.fetch.routes.push(tokenRoute({ exchangeGate: gate.promise }));
    const auth = h.build();
    await auth.signIn();
    const pending = hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&code=code-1`);
    await vi.waitFor(() => expect(exchangeCalls()).toHaveLength(1));
    expect(auth.status()).toEqual({ state: 'waiting' });
    // The round timer defers to the exchange: firing it now does not end the round.
    await h.clock.advance(DEFAULT_SIGN_IN_TIMEOUT_MS);
    expect(auth.status()).toEqual({ state: 'waiting' });
    gate.resolve();
    expect((await pending).text).toContain(CALLBACK_PAGE_DONE);
    await settle();
    expect(auth.status()).toMatchObject({ state: 'signed-in' });
  });

  it('cancel during the exchange leaves no account file and no secret', async () => {
    const gate = deferred<void>();
    h.fetch.routes.push(tokenRoute({ exchangeGate: gate.promise }));
    const auth = h.build();
    const setSpy = vi.spyOn(h.secrets, 'set');
    await auth.signIn();
    const pending = hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&code=code-1`).catch(() => ({ status: 0, text: '' }));
    await vi.waitFor(() => expect(exchangeCalls()).toHaveLength(1));
    await auth.cancelSignIn();
    gate.resolve();
    await pending;
    // Wait on the exchange's own verdict, not on a number of ticks: the
    // discarded path announces itself, and only then is "no file" meaningful.
    await vi.waitFor(() => expect(h.logs.some((l) => /cancelled during the code exchange/.test(l.message))).toBe(true));
    expect(setSpy).not.toHaveBeenCalled();
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect(fs.existsSync(h.file)).toBe(false);
    expect(Object.keys(h.secretsFile())).toHaveLength(0);
    expect(h.clock.intervals()).toHaveLength(0);
  });

  it('a cancel that lands while the secret is being written removes that secret again and writes no file', async () => {
    const auth = h.build();
    const realSet = h.secrets.set.bind(h.secrets);
    const deleteSpy = vi.spyOn(h.secrets, 'delete');
    vi.spyOn(h.secrets, 'set').mockImplementation(async (plaintext, ref, o) => {
      const out = await realSet(plaintext, ref, o);
      await auth.cancelSignIn(); // the user hits Cancel exactly as the keychain write lands
      return out;
    });
    await auth.signIn();
    await hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&code=code-1`).catch(() => undefined);
    await vi.waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.logs.some((l) => /cancelled while the account was being saved/.test(l.message))).toBe(true));
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect(fs.existsSync(h.file)).toBe(false);
    expect(Object.keys(h.secretsFile())).toHaveLength(0);
  });

  it('a port held by another program throws the exact sentence before any browser opens', async () => {
    const squatter = http.createServer();
    await new Promise<void>((r) => squatter.listen(h.port, '127.0.0.1', () => r()));
    try {
      const auth = h.build();
      await expect(auth.signIn()).rejects.toThrow(CHATGPT_PORT_IN_USE_MESSAGE);
      expect(h.opened).toHaveLength(0);
      expect(auth.status()).toEqual({ state: 'signed-out' });
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it("an unavailable keychain throws the SecretsStore's own sentence before any browser or port", async () => {
    let bound = 0;
    const auth = h.build({
      isEncryptionAvailable: () => false,
      listen: (...args) => { bound += 1; return listenOn(h.port)(...args); },
    });
    await expect(auth.signIn()).rejects.toThrow(CHATGPT_KEYCHAIN_UNAVAILABLE_MESSAGE);
    expect(h.opened).toHaveLength(0);
    expect(bound).toBe(0);
    // The sentence IS the store's: with the keychain gone, SecretsStore.set
    // throws the same text byte for byte.
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
    await expect(h.secrets.set('x')).rejects.toThrow(CHATGPT_KEYCHAIN_UNAVAILABLE_MESSAGE);
  });

  it('a store that throws after the exchange puts the store message on the page and in waitForSignIn', async () => {
    const auth = h.build();
    vi.spyOn(h.secrets, 'set').mockRejectedValue(new Error('keychain vanished mid-flow'));
    await auth.signIn();
    const wait = auth.waitForSignIn();
    const r = await hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&code=code-1`);
    expect(r.text).toContain('YouCoded could not save the sign-in: keychain vanished mid-flow');
    expect(await wait).toEqual({ error: 'YouCoded could not save the sign-in: keychain vanished mid-flow' });
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect(fs.existsSync(h.file)).toBe(false);
  });

  it('a refused exchange ends the round signed-out with the fixed page; the description goes to waitForSignIn only', async () => {
    h.fetch.routes.push(tokenRoute({ exchangeStatus: 400 }));
    const auth = h.build();
    await auth.signIn();
    const wait = auth.waitForSignIn();
    const r = await hit(h.port, `/auth/callback?state=${h.stateFromOpened()}&code=code-1`);
    expect(r.text).toContain(CALLBACK_PAGE_FAILED);
    expect(r.text).not.toContain('code already used');
    expect(await wait).toEqual({ error: expect.stringContaining('code already used') });
    expect(auth.status()).toEqual({ state: 'signed-out' });
  });
});

// ---------------------------------------------------------------------------
// Reading the account (§2, §3)
// ---------------------------------------------------------------------------

describe('ChatGptAuth: the account on disk', () => {
  it('a copied userData (file present, secret absent) reads signed-out and starts no poll', async () => {
    await h.seedSignedIn({ withoutSecret: true });
    const auth = h.build();
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect(auth.isSignedIn()).toBe(false);
    expect(() => auth.signedInAccount()).toThrow(CHATGPT_SIGN_IN_REQUIRED_MESSAGE);
    await expect(auth.accessToken()).rejects.toThrow(CHATGPT_SIGN_IN_REQUIRED_MESSAGE);
    expect(h.clock.intervals()).toHaveLength(0);
  });

  it('a signed-in file starts the unref’d poll on construction and polls at once, then every five minutes', async () => {
    await h.seedSignedIn();
    const auth = h.build();
    expect(auth.status()).toMatchObject({ state: 'signed-in', email: 'd@example.com', plan: 'plus' });
    expect(h.clock.intervals()).toHaveLength(1);
    expect(h.clock.allUnrefed()).toBe(true);
    await h.clock.advance(0);
    await vi.waitFor(() => expect(usageCalls()).toHaveLength(1));
    await h.clock.advance(USAGE_POLL_MS);
    await vi.waitFor(() => expect(usageCalls()).toHaveLength(2));
    await vi.waitFor(() => expect(auth.usageForStatus()?.five_hour?.utilization).toBe(12));
    expect(h.logs.filter((l) => /usage poll/.test(l.message))).toEqual([]);
  });

  // Review T4 F1: the kill switch has to make the feature INERT. Before this,
  // `YOUCODED_CHATGPT=0` still polled OpenAI at launch and every five minutes
  // for a signed-in user — and because that poll refreshes the token, a
  // rejection ran clearAccount() and DELETED the saved sign-in. Turning the
  // feature off must never sign anyone out.
  it('pollUsage:false (the kill switch) starts no timer and makes no request, but still reads the account', async () => {
    await h.seedSignedIn();
    const auth = h.build({ pollUsage: false });
    // The launch-time setup check still needs the account to be readable.
    expect(auth.status()).toMatchObject({ state: 'signed-in', email: 'd@example.com' });
    expect(auth.isSignedIn()).toBe(true);
    expect(h.clock.intervals()).toHaveLength(0);
    expect(h.clock.timeouts()).toHaveLength(0);
    await h.clock.advance(USAGE_POLL_MS * 3);
    expect(usageCalls()).toHaveLength(0);
    // Nothing reached the network at all — no usage, and so no token refresh,
    // which is the leg that could have deleted the secret.
    expect(h.fetch.calls).toHaveLength(0);
    expect(fs.existsSync(h.file)).toBe(true);
  });

  it('a blocked file reads blocked with the verbatim reason, is not signed in, and starts no poll', async () => {
    await h.seedSignedIn({ blocked: { reason: 'Your workspace admin has disabled Codex.', at: new Date(T0).toISOString() } });
    const auth = h.build();
    expect(auth.status()).toEqual({ state: 'blocked', email: 'd@example.com', reason: 'Your workspace admin has disabled Codex.' });
    expect(auth.isSignedIn()).toBe(false);
    expect(() => auth.signedInAccount()).toThrow('Your workspace admin has disabled Codex.');
    expect(h.clock.intervals()).toHaveLength(0);
  });

  it('sign-out deletes the secret BEFORE the file, stops the poll, and drops the caches', async () => {
    const ref = await h.seedSignedIn();
    const auth = h.build();
    const order: string[] = [];
    const realDelete = h.secrets.delete.bind(h.secrets);
    vi.spyOn(h.secrets, 'delete').mockImplementation(async (r, o) => {
      order.push(`delete-secret(file-still-there=${fs.existsSync(h.file)})`);
      return realDelete(r, o);
    });
    expect(await auth.signOut()).toBe(true);
    expect(order).toEqual(['delete-secret(file-still-there=true)']);
    expect(h.secrets.has(ref)).toBe(false);
    expect(fs.existsSync(h.file)).toBe(false);
    expect(auth.status()).toEqual({ state: 'signed-out' });
    expect(auth.usageForStatus()).toBeNull();
    expect(await auth.models()).toEqual([]);
    expect(h.clock.intervals()).toHaveLength(0);
  });

  it('usageForStatus prunes windows whose reset has passed — five_hour, seven_day AND other', async () => {
    const past = new Date(T0 - 1000).toISOString();
    const future = new Date(T0 + HOUR).toISOString();
    await h.seedSignedIn({
      usage: {
        five_hour: { utilization: 90, resets_at: past },
        seven_day: { utilization: 40, resets_at: future },
        other: [
          { utilization: 100, resets_at: past, minutes: 43200 },
          { utilization: 5, resets_at: future, minutes: 43200 },
        ],
        at: past,
      },
    });
    const auth = h.build();
    expect(auth.usageForStatus()).toEqual({
      seven_day: { utilization: 40, resets_at: future },
      other: [{ utilization: 5, resets_at: future, minutes: 43200 }],
    });
    expect(auth.status()).toMatchObject({ state: 'signed-in', usage: { seven_day: { utilization: 40 } } });
    // Everything expired → null, not {}.
    h.clock.now = T0 + 2 * HOUR;
    expect(auth.usageForStatus()).toBeNull();
  });

  it('mutate retries the lock five times, then throws a user-showable error', async () => {
    await h.seedSignedIn();
    const auth = h.build();
    h.fetch.routes.push([CODEX_RESPONSES_URL, () => json(403, { error: { message: 'No Codex access.' } })]);
    const lock = vi.mocked(mutateFileUnderLock);
    lock.mockClear();
    lock.mockResolvedValue(false);
    try {
      await expect(auth.fetch()(CODEX_RESPONSES_URL, { method: 'POST', body: '{}' })).rejects.toThrow(CHATGPT_LOCK_HELD_MESSAGE);
      expect(lock).toHaveBeenCalledTimes(5);
    } finally {
      const actual = await vi.importActual<typeof import('../src/main/artifacts/cas-write')>('../src/main/artifacts/cas-write');
      lock.mockImplementation(actual.mutateFileUnderLock);
    }
  });
});

// ---------------------------------------------------------------------------
// Tokens (§3 accessToken)
// ---------------------------------------------------------------------------

describe('ChatGptAuth: accessToken', () => {
  it('returns the stored token without a network call while more than 5 minutes remain', async () => {
    await h.seedSignedIn({ expiresInMs: 6 * 60 * 1000 });
    const auth = h.build();
    const token = await auth.accessToken();
    expect(token).toContain(`${TOKEN_MARKER}-seed`);
    expect(refreshCalls()).toHaveLength(0);
  });

  it('refreshes under ONE in-flight promise when under 5 minutes remain, and writes the new pair back', async () => {
    const ref = await h.seedSignedIn({ expiresInMs: 4 * 60 * 1000 });
    const auth = h.build();
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect(refreshCalls()).toHaveLength(1);
    const body = new URLSearchParams(String(refreshCalls()[0].init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe(`rt-seed-${TOKEN_MARKER}`);
    expect(a).toBe(b);
    expect(a).toContain(`${TOKEN_MARKER}-r`);
    const stored = JSON.parse((await h.secrets.get(ref))!);
    expect(stored.access_token).toBe(a);
    expect(stored.refresh_token).toMatch(/^rt-r/);
    expect(stored.expires_at).toBe(h.clock.now + 864000 * 1000);
    // A later call uses the renewed token with no second refresh.
    expect(await auth.accessToken()).toBe(a);
    expect(refreshCalls()).toHaveLength(1);
  });

  it('a refresh refused with 401 (or 400) signs the account out and throws the expired sentence', async () => {
    for (const status of [401, 400]) {
      h.fetch.routes.push(tokenRoute({ refreshStatus: status }));
      const ref = await h.seedSignedIn({ expiresInMs: 1000 });
      const auth = h.build();
      await expect(auth.accessToken()).rejects.toThrow(CHATGPT_SIGN_IN_EXPIRED_MESSAGE);
      expect(h.secrets.has(ref)).toBe(false);
      expect(fs.existsSync(h.file)).toBe(false);
      expect(auth.status()).toEqual({ state: 'signed-out' });
      expect(h.clock.intervals()).toHaveLength(0);
      await auth.dispose();
    }
  });

  it('a network failure during refresh rethrows the real reason and leaves the account as it was', async () => {
    h.fetch.routes.push([CHATGPT_TOKEN_URL, () => { throw new TypeError('fetch failed: ENOTFOUND auth.openai.com'); }]);
    const ref = await h.seedSignedIn({ expiresInMs: 1000 });
    const auth = h.build();
    await expect(auth.accessToken()).rejects.toThrow('ENOTFOUND auth.openai.com');
    expect(h.secrets.has(ref)).toBe(true);
    expect(auth.status()).toMatchObject({ state: 'signed-in' });
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN_MARKER);
  });

  it('refresh-after-signOut leaves no secret: the fresh pair is discarded', async () => {
    const gate = deferred<void>();
    h.fetch.routes.push(tokenRoute({ refreshGate: gate.promise }));
    await h.seedSignedIn({ expiresInMs: 1000 });
    const auth = h.build();
    const pending = auth.accessToken();
    await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1));
    await auth.signOut();
    gate.resolve();
    await expect(pending).rejects.toThrow(CHATGPT_SIGN_IN_REQUIRED_MESSAGE);
    await settle();
    expect(Object.keys(h.secretsFile())).toHaveLength(0);
    expect(fs.existsSync(h.file)).toBe(false);
    expect(auth.status()).toEqual({ state: 'signed-out' });
  });
});

// ---------------------------------------------------------------------------
// The credential-owning fetch (§4.1, §4.5, §4.6)
// ---------------------------------------------------------------------------

describe('ChatGptAuth: fetch()', () => {
  const capture = (status = 200, body: unknown = { ok: true }, headers: Record<string, string> = {}) =>
    [CODEX_RESPONSES_URL, () => json(status, body, headers)] as [string, Route];
  const sentHeaders = (i: number) => h.fetch.calls.filter((c) => c.url === CODEX_RESPONSES_URL)[i].init.headers as Headers;

  it('sets exactly one authorization value equal to the token; the placeholder is gone; a second call carries a second token', async () => {
    const ref = await h.seedSignedIn();
    const auth = h.build();
    h.fetch.routes.push(capture());
    const f = auth.fetch();
    const first = await auth.accessToken();
    await f(CODEX_RESPONSES_URL, { method: 'POST', headers: { authorization: 'Bearer chatgpt', 'chatgpt-account-id': 'acct-1' }, body: '{"a":1}' });
    const hdr = sentHeaders(0);
    expect(hdr).toBeInstanceOf(Headers);
    expect(hdr.get('authorization')).toBe(`Bearer ${first}`);
    expect(hdr.get('authorization')).not.toContain(',');
    expect(hdr.get('chatgpt-account-id')).toBe('acct-1');
    expect(JSON.stringify([...hdr.entries()])).not.toContain('Bearer chatgpt');

    // The stored token changes between two calls (as a refresh would do it).
    const blob = JSON.parse((await h.secrets.get(ref))!);
    blob.access_token = accessJwt({ marker: `${TOKEN_MARKER}-second` });
    await h.secrets.set(JSON.stringify(blob), ref);
    await f(CODEX_RESPONSES_URL, { method: 'POST', headers: { authorization: 'Bearer chatgpt' }, body: '{}' });
    expect(sentHeaders(1).get('authorization')).toBe(`Bearer ${blob.access_token}`);
    expect(sentHeaders(1).get('authorization')).not.toBe(`Bearer ${first}`);
  });

  it('a fetch bound to an earlier account generation refuses before network', async () => {
    await h.seedSignedIn();
    const auth = h.build();
    h.fetch.routes.push(capture());
    const live = auth.signedInAccount();
    const expected = { ...live, accountId: 'account-a', authGeneration: live.authGeneration - 1 };
    await expect(auth.fetch(expected)(CODEX_RESPONSES_URL, {
      method: 'POST', headers: { authorization: 'Bearer chatgpt', 'chatgpt-account-id': expected.accountId }, body: '{}',
    })).rejects.toThrow(/account changed|Sign in with ChatGPT/);
    expect(h.fetch.calls.filter(call => call.url === CODEX_RESPONSES_URL)).toHaveLength(0);
  });

  it('diagnoses actual 401 sends under one logical step without touching bytes', async () => {
    await h.seedSignedIn();
    const auth = h.build({ pollUsage: false });
    const rows: any[] = [];
    const d = new ChatGptRequestDiagnostics({ directory: h.dir, write: async row => { rows.push(row); } });
    let n = 0;
    h.fetch.routes.push([CODEX_RESPONSES_URL, () => json(++n === 1 ? 401 : 200, {})]);
    const body = '{"model":"gpt-5","input":[{"content":"PRIVATE_BODY"}]}';
    await withChatGptRequest('session', 'chat', () => bindChatGptRequest(d, 'session', async context => {
      await auth.fetch()(CODEX_RESPONSES_URL, { method: 'POST', body });
      d.finish(context.attemptId, 'success');
    }));
    await d.flush();
    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).toBe('failed');
    expect(rows[1]).toMatchObject({ resendParentId: rows[0].attemptId, logicalStepId: rows[0].logicalStepId, change: 'identical', outcome: 'success' });
    expect(h.fetch.calls.filter(c => c.url === CODEX_RESPONSES_URL).map(c => c.init.body)).toEqual([body, body]);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_BODY');
  });

  it('observes raw missing-vs-zero usage through the actual SDK and auth boundary', async () => {
    await h.seedSignedIn();
    const auth = h.build({ pollUsage: false });
    const rows: any[] = [];
    const d = new ChatGptRequestDiagnostics({ directory: h.dir, write: async row => { rows.push(row); } });
    let n = 0;
    h.fetch.routes.push([CODEX_RESPONSES_URL, () => {
      const usage = { input_tokens: 100, output_tokens: 1, total_tokens: 101, ...(n++ ? { input_tokens_details: { cached_tokens: 0 } } : {}) };
      const events = [
        { type: 'response.created', response: { id: 'r', model: 'gpt-5', created_at: 1 } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'ok' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] } },
        { type: 'response.completed', response: { id: 'r', status: 'completed', usage } },
      ];
      return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }]);
    const provider = createOpenAI({ apiKey: 'placeholder', baseURL: CHATGPT_CODEX_BASE_URL, fetch: auth.fetch() });
    const model = wrapLanguageModel({ model: provider.responses('gpt-5'), middleware: chatGptMiddleware('session', d) });
    for (let i = 0; i < 2; i++) {
      const result = withChatGptRequest('session', 'chat', () => streamText({ model, prompt: 'PRIVATE_INPUT' }));
      await result.consumeStream();
    }
    await d.flush();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ purpose: 'chat', outcome: 'success', inputTokens: 100, cacheDetailPresent: false, cachedInputTokens: null });
    expect(rows[1]).toMatchObject({ change: 'identical', cacheDetailPresent: true, cachedInputTokens: 0 });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_INPUT');
  });

  it('a 401 refreshes once and re-sends the SAME body with the new bearer', async () => {
    await h.seedSignedIn();
    const auth = h.build();
    let n = 0;
    h.fetch.routes.push([CODEX_RESPONSES_URL, () => (++n === 1 ? json(401, { error: { message: 'expired' } }) : json(200, { ok: true }))]);
    const body = JSON.stringify({ model: 'gpt-5.5', input: 'hi', stream: true });
    const res = await auth.fetch()(CODEX_RESPONSES_URL, { method: 'POST', headers: { authorization: 'Bearer chatgpt' }, body });
    expect(res.status).toBe(200);
    const urls = h.fetch.calls.map((c) => c.url);
    expect(urls).toEqual([CODEX_RESPONSES_URL, CHATGPT_TOKEN_URL, CODEX_RESPONSES_URL]);
    expect(refreshCalls()).toHaveLength(1);
    const codex = h.fetch.calls.filter((c) => c.url === CODEX_RESPONSES_URL);
    expect(codex[0].init.body).toBe(body);
    expect(codex[1].init.body).toBe(body);
    expect(sentHeaders(0).get('authorization')).toContain(`${TOKEN_MARKER}-seed`);
    expect(sentHeaders(1).get('authorization')).toContain(`${TOKEN_MARKER}-r`);
    expect(auth.status()).toMatchObject({ state: 'signed-in' });
  });

  it('a second 401 signs out and throws the expired sentence', async () => {
    const ref = await h.seedSignedIn();
    const auth = h.build();
    h.fetch.routes.push(capture(401, { error: { message: 'nope' } }));
    await expect(auth.fetch()(CODEX_RESPONSES_URL, { method: 'POST', body: '{}' })).rejects.toThrow(CHATGPT_SIGN_IN_EXPIRED_MESSAGE);
    expect(refreshCalls()).toHaveLength(1);
    expect(h.secrets.has(ref)).toBe(false);
    expect(fs.existsSync(h.file)).toBe(false);
    expect(auth.status()).toEqual({ state: 'signed-out' });
  });

  it('a 403 marks the account blocked with OpenAI’s reason verbatim and stops the poll', async () => {
    await h.seedSignedIn();
    const auth = h.build();
    expect(h.clock.intervals()).toHaveLength(1);
    const reason = 'Codex is not available on your workspace. Ask an admin to enable it.';
    h.fetch.routes.push(capture(403, { error: { message: reason, code: 'forbidden' } }));
    const err = await auth.fetch()(CODEX_RESPONSES_URL, { method: 'POST', body: '{}' }).catch((e: Error) => e) as Error;
    expect(err.message).toBe(reason);
    expect(err).not.toHaveProperty('statusCode');
    expect(err).not.toHaveProperty('status');
    expect(err).not.toHaveProperty('code');
    expect(auth.status()).toEqual({ state: 'blocked', email: 'd@example.com', reason });
    expect(auth.isSignedIn()).toBe(false);
    expect(() => auth.signedInAccount()).toThrow(reason);
    expect(h.clock.intervals()).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(h.file, 'utf8')).blocked.reason).toBe(reason);
    // Sign out from blocked is the same as from signed-in.
    await auth.signOut();
    expect(auth.status()).toEqual({ state: 'signed-out' });
  });

  it('a 429 plan limit throws the limit sentence and sets that window to 100 % at the reset', async () => {
    await h.seedSignedIn();
    const auth = h.build();
    const resetsAtMs = T0 + 90 * 60 * 1000;
    h.fetch.routes.push(capture(429, { error: { code: 'usage_limit_reached', message: 'You have hit your usage limit.', resets_at: Math.round(resetsAtMs / 1000) } }));
    const expected = chatGptLimitMessage('5-hour', new Date(resetsAtMs).toISOString());
    const err = await auth.fetch()(CODEX_RESPONSES_URL, { method: 'POST', body: '{}' }).catch((e: Error) => e) as Error;
    expect(err.message).toBe(expected);
    expect(err).not.toHaveProperty('statusCode');
    expect(auth.usageForStatus()).toEqual({ five_hour: { utilization: 100, resets_at: new Date(resetsAtMs).toISOString() } });
    expect(auth.status()).toMatchObject({ state: 'signed-in' });
  });

  it('a 429 plan limit names the snapshot window whose reset matches — the free plan’s 30-day window lands in `other`', async () => {
    const reset = new Date(T0 + 20 * DAY).toISOString();
    await h.seedSignedIn({ usage: { other: [{ utilization: 97, resets_at: reset, minutes: 43200 }], at: new Date(T0).toISOString() } });
    const auth = h.build();
    h.fetch.routes.push(capture(429, { error: { code: 'usage_limit_reached', resets_at: Math.round(Date.parse(reset) / 1000) } }));
    const err = await auth.fetch()(CODEX_RESPONSES_URL, { method: 'POST', body: '{}' }).catch((e: Error) => e) as Error;
    expect(err.message).toBe(chatGptLimitMessage('30-day', reset));
    expect(auth.usageForStatus()).toEqual({ other: [{ utilization: 100, resets_at: reset, minutes: 43200 }] });
  });

  it('a burst 429 comes back as the untouched response with a readable body', async () => {
    await h.seedSignedIn();
    const auth = h.build();
    h.fetch.routes.push(capture(429, { error: { type: 'rate_limit_error', message: 'Slow down, 20 requests per minute.' } }, { 'retry-after': '3' }));
    const res = await auth.fetch()(CODEX_RESPONSES_URL, { method: 'POST', body: '{}' });
    expect(res.status).toBe(429);
    expect(res.bodyUsed).toBe(false);
    expect((await res.json()).error.message).toBe('Slow down, 20 requests per minute.');
    expect(auth.status()).toMatchObject({ state: 'signed-in' });
  });

  it('x-codex-* headers on any reply update the cache, and the poll is debounced to once a minute', async () => {
    await h.seedSignedIn();
    const auth = h.build();
    const resetAt = Math.round((T0 + 2 * HOUR) / 1000);
    h.fetch.routes.push(capture(200, { ok: true }, {
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': String(resetAt),
      'x-codex-secondary-used-percent': '7',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-after-seconds': '86400',
      'x-codex-plan-type': 'pro',
    }));
    // The construction-time poll ran "now" (one usage call).
    await h.clock.advance(0);
    await vi.waitFor(() => expect(usageCalls()).toHaveLength(1));
    // Three replies in a burst: cache updated from the headers, one debounced poll a minute later.
    const f = auth.fetch();
    for (let i = 0; i < 3; i++) await f(CODEX_RESPONSES_URL, { method: 'POST', body: '{}' });
    expect(auth.usageForStatus()).toEqual({
      five_hour: { utilization: 42, resets_at: new Date(resetAt * 1000).toISOString() },
      seven_day: { utilization: 7, resets_at: new Date(T0 + DAY).toISOString() },
    });
    expect(auth.status()).toMatchObject({ plan: 'pro' });
    expect(usageCalls()).toHaveLength(1);
    await h.clock.advance(USAGE_DEBOUNCE_MS - 1);
    expect(usageCalls()).toHaveLength(1);
    await h.clock.advance(1);
    await vi.waitFor(() => expect(usageCalls()).toHaveLength(2));
    expect(h.clock.allUnrefed()).toBe(true);
  });

  it('signed out, the fetch throws the sign-in-required sentence and sends nothing', async () => {
    const auth = h.build();
    await expect(auth.fetch()(CODEX_RESPONSES_URL, { method: 'POST', body: '{}' })).rejects.toThrow(CHATGPT_SIGN_IN_REQUIRED_MESSAGE);
    expect(h.fetch.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Models (§4.3)
// ---------------------------------------------------------------------------

describe('ChatGptAuth: models()', () => {
  const cachedRows = [{ id: 'gpt-cached', providerId: 'chatgpt', label: 'Cached', supportsTools: true }];

  it('returns the cached rows without awaiting the network and kicks a background refresh when the stamp is stale', async () => {
    const never = deferred<Response>();
    h.fetch.routes.push([chatGptModelsUrl(APP_VERSION), () => never.promise]);
    await h.seedSignedIn({ models: { rows: cachedRows, at: new Date(T0 - 2 * HOUR).toISOString() } });
    const auth = h.build();
    const rows = await Promise.race([auth.models(), new Promise<'hung'>((r) => setTimeout(() => r('hung'), 500))]);
    expect(rows).toEqual(cachedRows);
    await vi.waitFor(() => expect(modelsCalls()).toHaveLength(1));
    const m = modelsCalls()[0].init.headers as Record<string, string>;
    expect(m['chatgpt-account-id']).toBe('acct-1');
    expect(m.authorization).toMatch(/^Bearer /);
    // Still cache-first while that refresh hangs; no second request.
    expect(await auth.models()).toEqual(cachedRows);
    expect(modelsCalls()).toHaveLength(1);
    never.resolve(json(200, MODELS_BODY));
    await vi.waitFor(() => expect(auth.models()).resolves.toEqual([expect.objectContaining({ id: 'gpt-5.5' })]));
  });

  it('a fresh stamp means no network at all; no cache and signed out means []', async () => {
    await h.seedSignedIn({ models: { rows: cachedRows, at: new Date(T0 - 10 * 60 * 1000).toISOString() } });
    const auth = h.build();
    expect(await auth.models()).toEqual(cachedRows);
    await settle();
    expect(modelsCalls()).toHaveLength(0);
    const signedOut = h.build({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'yc-chatgpt-empty-')) });
    expect(await signedOut.models()).toEqual([]);
    expect(modelsCalls()).toHaveLength(0);
  });

  it('a 401/403 on the manifest is silent: the cached rows stand and the account is untouched', async () => {
    h.fetch.routes.push([chatGptModelsUrl(APP_VERSION), () => json(403, { error: { message: 'no' } })]);
    await h.seedSignedIn({ models: { rows: cachedRows, at: new Date(T0 - 2 * HOUR).toISOString() } });
    const auth = h.build();
    await auth.refreshModels();
    expect(await auth.models()).toEqual(cachedRows);
    expect(auth.status()).toMatchObject({ state: 'signed-in' });
    expect(h.logs.some((l) => l.level === 'warn' && /manifest refused/.test(l.message))).toBe(true);
  });
});
