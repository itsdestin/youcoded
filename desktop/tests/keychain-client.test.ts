import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeychainClient } from '../src/main/providers/keychain-client';

class FakeChild extends EventEmitter {
  connected = true;
  send = vi.fn();
  kill = vi.fn(() => { this.connected = false; return true; });
}

describe('restartable keychain client', () => {
  afterEach(() => vi.useRealTimers());

  it('retires an unavailable helper and retries in a fresh process', async () => {
    const children: FakeChild[] = [];
    const start = vi.fn(() => { const child = new FakeChild(); children.push(child); return child; });
    const client = new KeychainClient(start);
    const first = client.request({ operation: 'available' });
    children[0].emit('message', { ok: true, value: false });
    await expect(first).resolves.toBe(false);
    expect(children[0].kill).toHaveBeenCalledOnce();
    const retry = client.request({ operation: 'available' });
    expect(start).toHaveBeenCalledTimes(2);
    children[1].emit('message', { ok: true, value: true });
    await expect(retry).resolves.toBe(true);
    client.dispose();
  });

  it('reuses a successful helper and serializes simultaneous requests', async () => {
    const child = new FakeChild();
    const start = vi.fn(() => child);
    const client = new KeychainClient(start);
    const a = client.request({ operation: 'decrypt', value: 'cipher-a' });
    const b = client.request({ operation: 'decrypt', value: 'cipher-b' });
    expect(child.send).toHaveBeenCalledTimes(1);
    child.emit('message', { ok: true, value: 'plain-a' });
    await expect(a).resolves.toBe('plain-a');
    expect(child.send).toHaveBeenCalledTimes(2);
    child.emit('message', { ok: true, value: 'plain-b' });
    await expect(b).resolves.toBe('plain-b');
    expect(start).toHaveBeenCalledOnce();
    client.dispose();
  });

  it.each(['exit', 'disconnect', 'error'])('settles a %s and can retry without exposing request data', async (event) => {
    const children: FakeChild[] = [];
    const client = new KeychainClient(() => { const c = new FakeChild(); children.push(c); return c; });
    const first = client.request({ operation: 'encrypt', value: 'private-token' });
    const rejected = expect(first).rejects.toThrow(/keychain helper/i);
    children[0].emit(event, event === 'error' ? new Error('private-token') : 1);
    await rejected;
    const retry = client.request({ operation: 'available' });
    children[1].emit('message', { ok: true, value: true });
    await expect(retry).resolves.toBe(true);
    client.dispose();
  });

  it('force-stops a timed-out helper even when graceful shutdown cannot run', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(); // kill intentionally emits no exit/close
    const client = new KeychainClient(() => child, 100);
    const request = client.request({ operation: 'available' });
    const rejected = expect(request).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    client.dispose();
  });

  it('times out an unresponsive helper and permits a fresh retry', async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const client = new KeychainClient(() => { const c = new FakeChild(); children.push(c); return c; }, 100);
    const pending = client.request({ operation: 'available' });
    const rejected = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(children[0].kill).toHaveBeenCalledOnce();
    const retry = client.request({ operation: 'available' });
    children[1].emit('message', { ok: true, value: true });
    await expect(retry).resolves.toBe(true);
    client.dispose();
  });

  it('an unavailable check does not launch a helper for every concurrent waiter', async () => {
    const child = new FakeChild();
    const start = vi.fn(() => child);
    const client = new KeychainClient(start);
    const a = client.request({ operation: 'available' });
    const b = client.request({ operation: 'available' });
    child.emit('message', { ok: true, value: false });
    expect(start).toHaveBeenCalledOnce();
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(false);
    client.dispose();
  });

  it('dispose settles the active and queued requests and refuses new ones', async () => {
    const child = new FakeChild();
    const client = new KeychainClient(() => child);
    const a = client.request({ operation: 'available' });
    const b = client.request({ operation: 'available' });
    const rejectedA = expect(a).rejects.toThrow(/closed/i);
    const rejectedB = expect(b).rejects.toThrow(/closed/i);
    client.dispose();
    await Promise.all([rejectedA, rejectedB]);
    await expect(client.request({ operation: 'available' })).rejects.toThrow(/closed/i);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
