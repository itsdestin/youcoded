// Sign in with OpenRouter (connection-trust design §3.5). Pins the round-trip:
// the browser link carries an S256 challenge over the verifier actually sent at
// exchange, a callback on any path but the round's own is ignored, the key goes
// through acceptKey (check, then save) and never into the status, and Cancel /
// timeout close the listener.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { OpenRouterSignIn, type CallbackHandler, type CallbackResponse } from '../src/main/providers/openrouter-oauth';

function harness(opts: { exchange?: Response | Error; verdict?: 'verified' | 'rejected' | 'unchecked'; openFails?: boolean } = {}) {
  let handler: CallbackHandler | null = null;
  const closed = vi.fn();
  const opened: string[] = [];
  let timerFn: (() => void) | null = null;
  const fetch = vi.fn(async (_url: string, _init?: any) => {
    const r = opts.exchange ?? new Response(JSON.stringify({ key: 'sk-or-v1-from-oauth', user_id: null }), { status: 200 });
    if (r instanceof Error) throw r;
    return r;
  });
  const acceptKey = vi.fn(async (_key: string) => ({ verdict: opts.verdict ?? 'verified' as const, message: opts.verdict === 'rejected' ? 'nope' : 'Connected.' }));
  let n = 0;
  const s = new OpenRouterSignIn({
    openExternal: async (url) => { if (opts.openFails) throw new Error('no browser'); opened.push(url); },
    acceptKey,
    fetch: fetch as any,
    // Deterministic randomness, so the test can recompute the challenge.
    randomBytes: (size) => new Uint8Array(size).fill(++n),
    listen: async (h) => { handler = h; return { port: 51423, close: closed }; },
    setTimeout: (fn) => { timerFn = fn; return 1; },
    clearTimeout: () => {},
  });
  const hit = async (path: string) => {
    const res: CallbackResponse & { status?: number; body?: string } = {
      writeHead(status) { (this as any).status = status; },
      end(body) { (this as any).body = body; },
    };
    handler!({ url: path }, res);
    // The handler finishes the exchange asynchronously.
    await vi.waitFor(() => expect(res.body).toBeDefined());
    return res;
  };
  return { s, opened, fetch, acceptKey, closed, hit, fireTimeout: () => timerFn!() };
}

describe('OpenRouterSignIn', () => {
  it('opens OpenRouter with a loopback callback, S256 challenge and the YouCoded key label', async () => {
    const h = harness();
    await h.s.signIn();
    const u = new URL(h.opened[0]);
    expect(u.origin + u.pathname).toBe('https://openrouter.ai/auth');
    expect(u.searchParams.get('callback_url')).toMatch(/^http:\/\/127\.0\.0\.1:51423\/or-callback\/[0-9a-f]{32}$/);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('key_label')).toBe('YouCoded');
    expect(h.s.status()).toEqual({ state: 'waiting' });
  });

  it('exchanges the code with the matching verifier, checks and saves the key, and signs in', async () => {
    const h = harness();
    await h.s.signIn();
    const u = new URL(h.opened[0]);
    const path = new URL(u.searchParams.get('callback_url')!).pathname;
    const outcome = h.s.waitForSignIn();
    const res = await h.hit(`${path}?code=abc`);
    expect(await outcome).toBe('signed-in');
    const body = JSON.parse((h.fetch.mock.calls[0] as any)[1].body);
    expect(body).toMatchObject({ code: 'abc', code_challenge_method: 'S256' });
    // The challenge the browser saw is S256 over the verifier sent here.
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(u.searchParams.get('code_challenge'));
    expect(h.acceptKey).toHaveBeenCalledWith('sk-or-v1-from-oauth');
    expect(res.status).toBe(200);
    expect(h.s.status()).toEqual({ state: 'idle' });
    expect(JSON.stringify(h.s.status())).not.toContain('sk-or');
    expect(h.closed).toHaveBeenCalled();
  });

  it('a request on any other path is refused and does not end the round', async () => {
    const h = harness();
    await h.s.signIn();
    const res = await h.hit('/or-callback/wrong?code=abc');
    expect(res.status).toBe(404);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.s.status().state).toBe('waiting');
  });

  it('a key OpenRouter then refuses fails the sign-in with a plain line', async () => {
    const h = harness({ verdict: 'rejected' });
    await h.s.signIn();
    const path = new URL(new URL(h.opened[0]).searchParams.get('callback_url')!).pathname;
    await h.hit(`${path}?code=abc`);
    expect(h.s.status()).toMatchObject({ state: 'failed' });
  });

  it('a failed exchange says so without inventing a cause', async () => {
    const h = harness({ exchange: new Response(JSON.stringify({ error: { message: 'Invalid code or code_verifier' } }), { status: 403 }) });
    await h.s.signIn();
    const path = new URL(new URL(h.opened[0]).searchParams.get('callback_url')!).pathname;
    await h.hit(`${path}?code=abc`);
    expect(h.s.status()).toEqual({ state: 'failed', message: "OpenRouter didn't accept the sign-in. Try again." });
    expect(h.acceptKey).not.toHaveBeenCalled();
  });

  it("live OpenRouter's 400 \"Invalid code\" reads the same as the documented 403", async () => {
    const h = harness({ exchange: new Response(JSON.stringify({ error: { message: 'Invalid code', code: 400 } }), { status: 400 }) });
    await h.s.signIn();
    const path = new URL(new URL(h.opened[0]).searchParams.get('callback_url')!).pathname;
    await h.hit(`${path}?code=abc`);
    expect(h.s.status()).toEqual({ state: 'failed', message: "OpenRouter didn't accept the sign-in. Try again." });
  });

  it('Cancel and the timeout each close the listener and resolve the waiter', async () => {
    const a = harness();
    await a.s.signIn();
    const wa = a.s.waitForSignIn();
    await a.s.cancelSignIn();
    expect(await wa).toBe('cancelled');
    expect(a.closed).toHaveBeenCalled();
    expect(a.s.status()).toEqual({ state: 'idle' });

    const b = harness();
    await b.s.signIn();
    const wb = b.s.waitForSignIn();
    b.fireTimeout();
    expect(await wb).toBe('timed-out');
    expect(b.closed).toHaveBeenCalled();
    expect(b.s.status().state).toBe('failed');
  });

  it('a second click while waiting joins the same round', async () => {
    const h = harness();
    await Promise.all([h.s.signIn(), h.s.signIn()]);
    expect(h.opened).toHaveLength(1);
  });

  it('no browser: throws a plain sentence and leaves nothing listening', async () => {
    const h = harness({ openFails: true });
    await expect(h.s.signIn()).rejects.toThrow(/couldn't open your browser/);
    expect(h.closed).toHaveBeenCalled();
  });
});
