import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { EventEmitter } from 'events';

vi.mock('../src/main/logger', () => ({ log: vi.fn() }));

// A fake pty worker: the test plays the CLI by emitting its messages.
const spawned: Array<EventEmitter & { send: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; stderr: EventEmitter; args: string[] }> = [];
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  return {
    ...real,
    spawn: vi.fn((_cmd: string, args: string[]) => {
      const w = Object.assign(new EventEmitter(), { send: vi.fn(), kill: vi.fn(), stderr: new EventEmitter(), args });
      spawned.push(w);
      return w;
    }),
  };
});

import { resolvePtyWorkerPath, startOAuthLogin } from '../src/main/prerequisite-installer';
import { openClaudeLogin, LOGIN_LINK_WAIT_MS } from '../src/main/claude-sign-in';

// The 1.3.4 bug: "Sign in again" started the login helper from inside app.asar, which system Node
// cannot read, because the unpacked-copy switch depended on a flag that caller never passed.
describe('the login helper is found without anyone saying "installed app"', () => {
  const asarDir = path.join('/opt', 'YouCoded', 'resources', 'app.asar', 'dist', 'main');
  const unpacked = path.join('/opt', 'YouCoded', 'resources', 'app.asar.unpacked', 'dist', 'main', 'pty-worker.js');

  it('uses the readable unpacked copy when the installed app has one', () => {
    expect(resolvePtyWorkerPath(asarDir, (p) => p === unpacked)).toBe(unpacked);
  });

  it('keeps the plain path in a dev build or on Android (no asar)', () => {
    const dev = path.join('/home', 'x', 'desktop', 'dist', 'main');
    expect(resolvePtyWorkerPath(dev, () => true)).toBe(path.join(dev, 'pty-worker.js'));
  });

  it('keeps the plain path when the unpacked copy is missing', () => {
    expect(resolvePtyWorkerPath(asarDir, () => false)).toBe(path.join(asarDir, 'pty-worker.js'));
  });
});

describe('waiting for the login link', () => {
  beforeEach(() => { spawned.length = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ends as soon as the link is printed, not after a fixed pause', async () => {
    const login = startOAuthLogin();
    const wait = login.waitForUrl(LOGIN_LINK_WAIT_MS);
    // A slow start: the link arrives after 4 s — the old fixed 1.5 s wait failed here.
    await vi.advanceTimersByTimeAsync(4000);
    spawned[0].emit('message', { type: 'data', data: 'Open \x1b[1mhttps://claude.com/cai/oauth/authorize?code=1\x1b[0m\r\n' });
    await expect(wait).resolves.toBe('https://claude.com/cai/oauth/authorize?code=1');
  });

  it('ends at once with no link when the helper process dies', async () => {
    const login = startOAuthLogin();
    const wait = login.waitForUrl(LOGIN_LINK_WAIT_MS);
    spawned[0].emit('exit', 1);
    await expect(wait).resolves.toBeNull();
  });

  it('gives up after the cap', async () => {
    const login = startOAuthLogin();
    const wait = login.waitForUrl(LOGIN_LINK_WAIT_MS);
    await vi.advanceTimersByTimeAsync(LOGIN_LINK_WAIT_MS);
    await expect(wait).resolves.toBeNull();
  });
});

describe('openClaudeLogin (shared by first launch and Sign in again)', () => {
  it('returns the running login once its link exists', async () => {
    const login = { url: 'https://claude.ai/x', kill: vi.fn(), waitForUrl: vi.fn(async () => 'https://claude.ai/x') };
    expect(await openClaudeLogin(() => login)).toBe(login);
    expect(login.waitForUrl).toHaveBeenCalledWith(LOGIN_LINK_WAIT_MS);
    expect(login.kill).not.toHaveBeenCalled();
  });

  it('ends the process and returns null when no link came', async () => {
    const login = { url: null, kill: vi.fn(), waitForUrl: vi.fn(async () => null) };
    expect(await openClaudeLogin(() => login)).toBeNull();
    expect(login.kill).toHaveBeenCalled();
  });
});
