import { describe, it, expect, vi } from 'vitest';
import { ClaudeSignIn, NO_LOGIN_LINK_MESSAGE } from '../src/main/claude-sign-in';

vi.mock('../src/main/logger', () => ({ log: vi.fn() }));

// Card #236: "Sign in" on the chat card / Settings runs the same `claude auth login` first launch uses.
const END_OLD = '2026-11-16T08:29:49.037Z';
const END_NEW = '2026-12-17T08:29:49.037Z';

function rig(opts: { url?: string | null; statuses: Array<any> }) {
  let exit: (c: number | null) => void = () => {};
  const url = opts.url === undefined ? 'https://claude.ai/login?x=1' : opts.url;
  const login = { url, kill: vi.fn(), waitForUrl: vi.fn(async () => url), onExit: (cb: (c: number | null) => void) => { exit = cb; } };
  const queue = [...opts.statuses];
  let last = queue[queue.length - 1];
  const account = {
    status: vi.fn(async () => (queue.length ? (last = queue.shift()) : last)),
    invalidate: vi.fn(),
    clearAuthFailure: vi.fn(),
  };
  let clock = 0;
  const returnToApp = vi.fn();
  const flow = new ClaudeSignIn({
    start: () => login as any, sleep: async (ms) => { clock += ms; }, now: () => clock, returnToApp,
  });
  return { flow, login, account, returnToApp, exit: (c: number | null) => exit(c) };
}
const expired = (end: string) => ({ state: 'signed-in', apiKey: false, expiresAt: end, expired: true });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('Claude sign-in again', () => {
  it('answers true once the login link exists and does NOT finish while the same expired login still reads signed in', async () => {
    const t = rig({ statuses: [expired(END_OLD)] }); // before, then the poll keeps seeing the old login
    expect(await t.flow.signIn(t.account as any)).toBe(true);
    await settle();
    expect(t.login.kill).toHaveBeenCalledTimes(1); // ended only by the 10-minute cap, never by "signed in"
    expect(t.account.clearAuthFailure).not.toHaveBeenCalled();
  });

  it('finishes when the login gets a new end time: forgets the refusal, returns to the app, ends the process', async () => {
    const t = rig({ statuses: [expired(END_OLD), expired(END_OLD), { state: 'signed-in', apiKey: false, expiresAt: END_NEW }] });
    await t.flow.signIn(t.account as any);
    await vi.waitFor(() => expect(t.account.clearAuthFailure).toHaveBeenCalledTimes(1));
    expect(t.returnToApp).toHaveBeenCalledTimes(1);
    expect(t.login.kill).toHaveBeenCalled();
  });

  it('throws the screen sentence and ends the process when no login link appears', async () => {
    const t = rig({ url: null, statuses: [{ state: 'signed-out' }] });
    await expect(t.flow.signIn(t.account as any)).rejects.toThrow(NO_LOGIN_LINK_MESSAGE);
    expect(t.login.kill).toHaveBeenCalled();
  });

  it('cancel ends an open sign-in and resolves true', async () => {
    const t = rig({ statuses: [expired(END_OLD)] });
    await t.flow.signIn(t.account as any);
    expect(t.flow.cancel()).toBe(true);
    expect(t.login.kill).toHaveBeenCalled();
    expect(t.account.clearAuthFailure).not.toHaveBeenCalled();
  });
});

// Reviewer round (sign-in fix): the link wait can now last up to 15 s, so what happens DURING it matters.
function slowRig() {
  let deliver: (u: string | null) => void = () => {};
  const login = {
    url: null as string | null, kill: vi.fn(() => deliver(null)), onExit: vi.fn(),
    waitForUrl: vi.fn(() => new Promise<string | null>((r) => { deliver = (u) => { login.url = u; r(u); }; })),
  };
  const account = { status: vi.fn(async () => ({ state: 'signed-out' })), invalidate: vi.fn(), clearAuthFailure: vi.fn() };
  const start = vi.fn(() => login as any);
  const flow = new ClaudeSignIn({ start, sleep: () => new Promise(() => {}), now: () => 0, returnToApp: vi.fn() });
  return { flow, login, account, start, link: (u: string) => deliver(u) };
}

describe('Claude sign-in again — while the link is still coming', () => {
  it('a slow link (seconds, not 1.5 s) still succeeds', async () => {
    const t = slowRig();
    const p = t.flow.signIn(t.account as any);
    await vi.waitFor(() => expect(t.start).toHaveBeenCalled());
    t.link('https://claude.ai/login?slow=1');
    await expect(p).resolves.toBe(true);
    expect(t.login.kill).not.toHaveBeenCalled();
  });

  it('Cancel during the wait ends the login process at once', async () => {
    const t = slowRig();
    const p = t.flow.signIn(t.account as any);
    await vi.waitFor(() => expect(t.start).toHaveBeenCalled());
    t.flow.cancel();
    expect(t.login.kill).toHaveBeenCalled(); // before any link arrived
    await expect(p).resolves.toBe(true);
  });

  it('a second press — even before the account was read — joins instead of starting a second login', async () => {
    const t = slowRig();
    const p1 = t.flow.signIn(t.account as any);
    const p2 = t.flow.signIn(t.account as any); // same tick: the account read has not finished yet
    await expect(p2).resolves.toBe(true);
    await vi.waitFor(() => expect(t.start).toHaveBeenCalled());
    const p3 = t.flow.signIn(t.account as any); // during the link wait
    await expect(p3).resolves.toBe(true);
    t.link('https://claude.ai/login?x=2');
    await p1;
    expect(t.start).toHaveBeenCalledTimes(1);
  });

  it('a start() that throws does not leave sign-in stuck: the next press tries again', async () => {
    const t = slowRig();
    t.start.mockImplementationOnce(() => { throw new Error('spawn exploded'); });
    await expect(t.flow.signIn(t.account as any)).rejects.toThrow(NO_LOGIN_LINK_MESSAGE);
    const p = t.flow.signIn(t.account as any);
    await vi.waitFor(() => expect(t.start).toHaveBeenCalledTimes(2));
    t.link('https://claude.ai/login?again=1');
    await expect(p).resolves.toBe(true);
  });
});
