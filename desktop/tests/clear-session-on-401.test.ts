import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/main/logger', () => ({ log: vi.fn(), rotateLog: vi.fn() }));

import { makeClearSessionOn401, setSessionLostListener } from '../src/main/handler-utils';
import { bindAccountDeps } from '../src/main/ipc/account';
import { findChannel } from '../src/main/ipc/channel-table';
import { MarketplaceApiError } from '../src/renderer/state/marketplace-api-client';
import { log } from '../src/main/logger';
import type { MarketplaceAuthStore } from '../src/main/marketplace-auth-store';

/**
 * The 401 decorator is what signs the account out when the server stops
 * recognising a session. Clearing the token is correct — leaving it would
 * strand the user "signed in" with every call failing. Doing it SILENTLY was
 * the bug: presence drops with the session, friends see the user offline
 * forever, and nothing anywhere recorded that it happened.
 */
function fakeStore(token: string | null) {
  return {
    token,
    getToken() { return this.token; },
    signOut() { this.token = null; },
  };
}

const asStore = (s: ReturnType<typeof fakeStore>) => s as unknown as MarketplaceAuthStore;

describe('makeClearSessionOn401', () => {
  beforeEach(() => vi.mocked(log).mockClear());

  it('clears the session on a 401 and says so, naming the surface and the SERVER\'s reason', () => {
    const store = fakeStore('tok');
    const clear = makeClearSessionOn401(asStore(store), 'social');

    const result = clear({ ok: false, status: 401, message: 'invalid token' });

    expect(store.token).toBeNull();
    expect(result).toEqual({ ok: false, status: 401, message: 'invalid token' });
    expect(log).toHaveBeenCalledTimes(1);
    const [level, component, , extra] = vi.mocked(log).mock.calls[0];
    expect(level).toBe('WARN');
    expect(component).toBe('Auth');
    // The surface tells you WHICH subsystem 401'd without labelling all 19
    // call sites; the message is the server's own, never a guess of ours
    // (docs/error-message-standards.md).
    expect(extra).toMatchObject({ surface: 'social', serverMessage: 'invalid token' });
  });

  it('logs ONCE for a burst, because signOut is idempotent', () => {
    // Several in-flight calls can 401 together. That is one sign-out event, not
    // four, and the log should read that way.
    const store = fakeStore('tok');
    const clear = makeClearSessionOn401(asStore(store), 'marketplace');

    for (let i = 0; i < 4; i++) clear({ ok: false, status: 401, message: 'expired' });

    expect(store.token).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('leaves every other status alone and stays quiet', () => {
    // 403 is the install gate, 404 not-found, 429 caps, 0 a network/parse
    // failure. None of them mean "the server forgot who you are".
    const store = fakeStore('tok');
    const clear = makeClearSessionOn401(asStore(store), 'arcade');

    for (const status of [0, 403, 404, 429, 500]) {
      clear({ ok: false, status, message: 'nope' });
    }

    expect(store.token).toBe('tok');
    expect(log).not.toHaveBeenCalled();
  });

  it('caps the logged server message — it is an untrusted response BODY', () => {
    // marketplace-api-client falls back to the raw response text when a 401
    // body is not JSON, so a proxy or captive portal answering with an HTML
    // page puts that whole page in `message`. The log keeps only its last 500
    // lines; one unbounded entry evicts everything useful around it.
    const store = fakeStore('tok');
    const clear = makeClearSessionOn401(asStore(store), 'social');

    clear({ ok: false, status: 401, message: '<html>' + 'x'.repeat(50_000) + '</html>' });

    const extra = vi.mocked(log).mock.calls[0][3] as { serverMessage: string };
    expect(extra.serverMessage.length).toBe(200);
    expect(extra.serverMessage.startsWith('<html>')).toBe(true);
  });

  it('passes a success through untouched', () => {
    const store = fakeStore('tok');
    const clear = makeClearSessionOn401(asStore(store), 'social');
    expect(clear({ ok: true, value: 42 })).toEqual({ ok: true, value: 42 });
    expect(store.token).toBe('tok');
    expect(log).not.toHaveBeenCalled();
  });
});

// The notice (card #216): the same moment that is logged must also reach the screen — once per sign-out
// event, for every path that signs the account out because the server said 401, and never for a chosen sign-out.
describe('the "signed out by itself" notice', () => {
  const lost = vi.fn();
  beforeEach(() => { lost.mockClear(); vi.mocked(log).mockClear(); setSessionLostListener(lost); });

  it('fires once for a burst of 401s from the call decorator', () => {
    const store = fakeStore('tok');
    const clear = makeClearSessionOn401(asStore(store), 'social');
    for (let i = 0; i < 4; i++) clear({ ok: false, status: 401, message: 'expired' });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(lost).toHaveBeenCalledWith({ surface: 'social' });
  });

  it('does not fire when there was no session to lose, or for other statuses', () => {
    const clear = makeClearSessionOn401(asStore(fakeStore(null)), 'social');
    clear({ ok: false, status: 401, message: 'x' });
    makeClearSessionOn401(asStore(fakeStore('tok')), 'social')({ ok: false, status: 500, message: 'x' });
    expect(lost).not.toHaveBeenCalled();
  });

  // The three account handlers that used to clear the session silently (no log, no notice).
  const asDeps = (store: ReturnType<typeof fakeStore>, client: Record<string, unknown>) =>
    bindAccountDeps({ store: store as unknown as MarketplaceAuthStore, client: client as never, installedSkillSource: null });
  const ownerCtx = { door: 'desktop', broadcast: vi.fn() } as never;
  const reject401 = () => { throw new MarketplaceApiError(401, 'invalid token'); };
  const cases: Array<[string, string, string]> = [
    ['account:user', 'authMe', 'account:user'],
    ['account:refresh', 'authMe', 'account:refresh'],
    ['account:export', 'exportData', 'account:export'],
  ];
  for (const [channel, method, surface] of cases) {
    it(`${channel}: logs and raises the notice once when it finds the session dead`, async () => {
      const store = { ...fakeStore('tok'), getUser() { return null; } };
      asDeps(store as never, { [method]: async () => reject401() });
      const def = findChannel(channel)!;
      await def.handler({} as never, ownerCtx);
      await def.handler({} as never, ownerCtx); // a second call after the sign-out finds no session
      expect(store.token).toBeNull();
      expect(lost).toHaveBeenCalledTimes(1);
      expect(lost).toHaveBeenCalledWith({ surface });
      expect(log).toHaveBeenCalledTimes(1);
      expect(vi.mocked(log).mock.calls[0][3]).toMatchObject({ surface, serverMessage: 'invalid token' });
    });
  }

  it('a sign-out the person chose raises no notice', async () => {
    const store = fakeStore('tok');
    asDeps(store, { logout: async () => ({}) });
    await findChannel('account:sign-out')!.handler(undefined as never, ownerCtx);
    expect(store.token).toBeNull();
    expect(lost).not.toHaveBeenCalled();
  });
});
