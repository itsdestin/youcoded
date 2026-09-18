// Connection trust (docs/active/specs/2026-08-31-openrouter-connection-trust-design.md).
// Pins the fix for "Settings said Connected while every turn was refused": the
// OpenRouter Test asks OpenRouter about the KEY (GET /key, which refuses a bad
// one) instead of the public model list (which answers any key and none), the
// answer is remembered per key, and a refused chat turn updates it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import { OpenRouterHealth, openRouterTurnFetch, ProviderAccountError } from '../src/main/providers/openrouter-health';
import { describeProviderError } from '../src/main/harness/harness-session';
import { classifyProviderError } from '../src/main/providers/provider-error-code';
import { CHATGPT_SIGN_IN_EXPIRED_MESSAGE } from '../src/main/providers/chatgpt-oauth';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const keyInfo = (extra: Record<string, unknown> = {}) =>
  json(200, { data: { is_management_key: false, is_provisioning_key: false, expires_at: null, ...extra } });

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-orhealth-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe('OpenRouterHealth.check', () => {
  const run = async (res: Response | Error, prior?: { expiresAt: string }) => {
    const fetch = vi.fn(async () => { if (res instanceof Error) throw res; return res; });
    const h = new OpenRouterHealth({ dir: root, fetch: fetch as any, now: () => Date.parse('2026-09-18T00:00:00Z') });
    if (prior) h.record('ref1', 'sk-or-k', { verdict: 'verified', expiresAt: prior.expiresAt, checkedAt: 0 });
    const r = await h.check('https://openrouter.ai/api/v1', 'sk-or-k', 'ref1');
    return { r, h, fetch };
  };

  it('asks /key with the key as a bearer, never the public /models list', async () => {
    const { fetch } = await run(keyInfo());
    expect((fetch.mock.calls[0] as any)[0]).toBe('https://openrouter.ai/api/v1/key');
    expect((fetch.mock.calls[0] as any)[1].headers.Authorization).toBe('Bearer sk-or-k');
  });

  it('200 is verified, and keeps the expiry date OpenRouter reports', async () => {
    const { r, h } = await run(keyInfo({ expires_at: '2026-12-01T00:00:00Z' }));
    expect(r).toMatchObject({ ok: true, verdict: 'verified' });
    expect(h.get('ref1')).toMatchObject({ verdict: 'verified', expiresAt: '2026-12-01T00:00:00Z' });
  });

  it('401 is a rejected key; with a recorded expiry already past it is worded expired', async () => {
    expect((await run(json(401, { error: { message: 'User not found.' } }))).r).toMatchObject({ ok: false, verdict: 'rejected' });
    expect((await run(json(401, {}))).h.get('ref1')?.reason).toBe('openrouter-key-rejected');
    expect((await run(json(401, {}), { expiresAt: '2026-09-17T00:00:00Z' })).h.get('ref1')?.reason).toBe('openrouter-key-expired');
  });

  it('management and provisioning keys are each refused as the wrong kind of key', async () => {
    expect((await run(keyInfo({ is_management_key: true }))).r.verdict).toBe('rejected');
    const { h } = await run(keyInfo({ is_provisioning_key: true }));
    expect(h.get('ref1')?.reason).toBe('openrouter-wrong-key-type');
  });

  it('403 from /key is a refused key', async () => {
    expect((await run(json(403, {}))).h.get('ref1')?.reason).toBe('openrouter-forbidden');
  });

  it('network failure, a 5xx, or a proxy with no /key is unchecked — never rejected', async () => {
    for (const res of [new Error('offline'), json(502, {}), new Response('not found', { status: 404 }), json(200, { hello: 1 })]) {
      expect((await run(res)).r).toMatchObject({ ok: false, verdict: 'unchecked' });
    }
  });

  it('an unreachable check never overwrites a real earlier answer', async () => {
    const h = new OpenRouterHealth({ dir: root, fetch: (async () => { throw new Error('offline'); }) as any });
    h.record('ref1', 'sk-or-k', { verdict: 'verified', checkedAt: 1 });
    await h.check('https://x/api/v1', 'sk-or-k', 'ref1');
    expect(h.get('ref1')?.verdict).toBe('verified');
  });

  it('survives a restart: a new instance reads the saved verdict', async () => {
    const { h } = await run(json(401, {}));
    expect(h.get('ref1')?.verdict).toBe('rejected');
    expect(new OpenRouterHealth({ dir: root }).get('ref1')?.verdict).toBe('rejected');
  });

  it('a checked candidate is adopted by the save that follows; a different key clears the record', async () => {
    const h = new OpenRouterHealth({ dir: root, fetch: (async () => keyInfo()) as any });
    h.record('ref1', 'old', { verdict: 'rejected', reason: 'openrouter-key-rejected', checkedAt: 1 });
    await h.check('https://x/api/v1', 'new-good'); // candidate: nothing stored yet
    expect(h.get('ref1')?.verdict).toBe('rejected');
    h.adoptOrClear('ref1', 'new-good');
    expect(h.get('ref1')?.verdict).toBe('verified');
    h.adoptOrClear('ref1', 'never-checked');
    expect(h.get('ref1')).toBeUndefined();
  });
});

describe('openRouterTurnFetch (a refused chat turn)', () => {
  const base = (res: Response) => (async () => res) as any;

  it('401 marks the key rejected and ends the turn with a plain, typed error', async () => {
    const onRejected = vi.fn(() => 'openrouter-key-rejected' as const);
    const f = openRouterTurnFetch(base(json(401, { error: { message: 'User not found.' } })), onRejected);
    const err = await f('https://x').catch((e) => e);
    expect(onRejected).toHaveBeenCalledOnce();
    expect(err).toBeInstanceOf(ProviderAccountError);
    expect(err).toMatchObject({ errorCode: 'openrouter-key-rejected', message: "OpenRouter didn't accept your API key." });
    // No status fields: the SDK/withRetry must not retry it and the sentence
    // must not grow a "(provider error 401)" suffix.
    expect(err.statusCode ?? err.status ?? err.code).toBeUndefined();
    expect(describeProviderError(err)).toBe("OpenRouter didn't accept your API key.");
  });

  it('402 and 403 are about this request — they never mark the key rejected', async () => {
    const onRejected = vi.fn(() => 'openrouter-key-rejected' as const);
    const credit = await openRouterTurnFetch(base(json(402, {})), onRejected)('u').catch((e) => e);
    const refused = await openRouterTurnFetch(base(json(403, { error: { message: 'Your input was flagged.' } })), onRejected)('u').catch((e) => e);
    expect(onRejected).not.toHaveBeenCalled();
    expect(credit.errorCode).toBe('openrouter-credit-short');
    expect(credit.message).not.toMatch(/out of credit/i);
    expect(refused).toMatchObject({ errorCode: 'openrouter-request-refused' });
    expect(refused.message).toContain('Your input was flagged.');
  });

  it('passes every other response through untouched', async () => {
    const ok = json(200, { ok: 1 });
    expect(await openRouterTurnFetch(base(ok), () => 'openrouter-key-rejected')('u')).toBe(ok);
  });
});

describe('classifyProviderError', () => {
  it('reads a typed code, through the retry wrapper too', () => {
    const e = new ProviderAccountError('x', 'openrouter-credit-short');
    expect(classifyProviderError(e)).toBe('openrouter-credit-short');
    expect(classifyProviderError({ lastError: e })).toBe('openrouter-credit-short');
  });
  it('recognises the ChatGPT sign-in sentences and leaves everything else alone', () => {
    expect(classifyProviderError(new Error(CHATGPT_SIGN_IN_EXPIRED_MESSAGE))).toBe('chatgpt-signin-expired');
    expect(classifyProviderError(new Error('502 Bad Gateway'))).toBeUndefined();
  });
});

describe('ProviderRegistry + OpenRouterHealth', () => {
  let reg: ProviderRegistry; let health: OpenRouterHealth; let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    fetchMock = vi.fn(async () => keyInfo());
    health = new OpenRouterHealth({ dir: root, fetch: fetchMock as any });
    reg = new ProviderRegistry(new NativeHome(root), new SecretsStore(root), null, null, health);
    await reg.init();
  });
  const row = async () => (await reg.list()).find((p) => p.id === 'openrouter')!;

  it('Test checks the saved key and the card row carries the verdict', async () => {
    await reg.setKey('openrouter', 'sk-or-dead');
    fetchMock.mockResolvedValueOnce(json(401, {}));
    expect(await reg.testConnection('openrouter')).toMatchObject({ ok: false, verdict: 'rejected' });
    expect((await row()).health).toMatchObject({ verdict: 'rejected', reason: 'openrouter-key-rejected' });
    // A refused key must change the words, never lock the user out.
    expect((await row()).ready).toBe(true);
  });

  it('a candidate key is checked without being stored, and adopted when it is saved', async () => {
    const r = await reg.testConnection('openrouter', 'sk-or-new');
    expect(r).toMatchObject({ ok: true, verdict: 'verified' });
    expect((fetchMock.mock.calls[0] as any)[1].headers.Authorization).toBe('Bearer sk-or-new');
    expect((await row()).hasKey).toBe(false);
    await reg.setKey('openrouter', 'sk-or-new');
    expect((await row()).health?.verdict).toBe('verified');
  });

  it('upsert never persists a health field sent back from the screen', async () => {
    await reg.setKey('openrouter', 'k');
    await reg.upsert({ ...(await row()), health: { verdict: 'verified', checkedAt: 1 } } as any);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.youcoded', 'providers.json'), 'utf8'));
    expect(JSON.stringify(onDisk)).not.toContain('health');
  });

  it('the background refresh asks nothing when OpenRouter has no key', async () => {
    await reg.refreshOpenRouter();
    expect(fetchMock).not.toHaveBeenCalled();
    await reg.setKey('openrouter', 'k');
    await reg.refreshOpenRouter();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
