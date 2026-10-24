import { afterEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { log } from '../src/main/logger';
vi.mock('../src/main/logger', () => ({ log: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
import { RecoverableSafeStorage } from '../src/main/providers/recoverable-safe-storage';

function setup(platform: NodeJS.Platform = 'linux') {
  const native = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`cipher:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().slice(7)),
  };
  const helper = { request: vi.fn(async (_request: unknown): Promise<string | boolean> => true) };
  const fallback = vi.fn(() => helper);
  return { native, helper, fallback, storage: new RecoverableSafeStorage(native, platform, fallback) };
}

describe('recoverable safeStorage', () => {
  it('reports slow native keychain work without recording plaintext or ciphertext', async () => {
    const h = setup();
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(27010);
    await expect(h.storage.decryptString(Buffer.from('cipher:private-token'))).resolves.toBe('private-token');
    expect(log).toHaveBeenCalledWith('INFO', 'SessionSetup', 'slow setup stage', {
      stage: 'keychain-decrypt', durationMs: 27000, outcome: 'ok',
    });
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain('private-token');
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain('cipher:');
  });
  it('uses native safeStorage normally, without starting a helper', async () => {
    const h = setup();
    expect(await h.storage.isEncryptionAvailable()).toBe(true);
    const encrypted = await h.storage.encryptString('private');
    expect(await h.storage.decryptString(encrypted)).toBe('private');
    expect(h.fallback).not.toHaveBeenCalled();
  });

  it('recovers when native Linux availability remains permanently false', async () => {
    const h = setup();
    h.native.isEncryptionAvailable.mockReturnValue(false);
    h.helper.request.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce('existing-token');
    expect(await h.storage.isEncryptionAvailable()).toBe(false);
    expect(await h.storage.isEncryptionAvailable()).toBe(true);
    expect(await h.storage.decryptString(Buffer.from('existing-cipher'))).toBe('existing-token');
    expect(h.helper.request).toHaveBeenLastCalledWith({ operation: 'decrypt', value: Buffer.from('existing-cipher').toString('base64') });
    expect(h.native.decryptString).not.toHaveBeenCalled();
  });

  it('writes helper ciphertext without changing the disk encoding', async () => {
    const h = setup();
    h.native.isEncryptionAvailable.mockReturnValue(false);
    h.helper.request.mockResolvedValue(Buffer.from('v11-cipher').toString('base64'));
    expect(await h.storage.encryptString('private')).toEqual(Buffer.from('v11-cipher'));
    expect(h.helper.request).toHaveBeenCalledWith({ operation: 'encrypt', value: 'private' });
  });

  it.each(['win32', 'darwin'] as const)('does not start a Linux helper on %s', async (platform) => {
    const h = setup(platform);
    h.native.isEncryptionAvailable.mockReturnValue(false);
    expect(await h.storage.isEncryptionAvailable()).toBe(false);
    expect(h.fallback).not.toHaveBeenCalled();
  });
});

// WHY (task 93, 2026-10-24): Electron's synchronous keychain probe froze the whole app for 4 s (8 s once) at launch whenever the
// KDE wallet daemons were not running yet, because the probe itself had to wait for them to start. Waking them first, off the
// main thread, means the probe finds them already running.
describe('keychain warm-up before the first native probe', () => {
  it('waits for the warm-up before touching native safeStorage, and only once', async () => {
    const order: string[] = [];
    const native = {
      isEncryptionAvailable: vi.fn(() => { order.push('native'); return true; }),
      encryptString: vi.fn((v: string) => Buffer.from(v)),
      decryptString: vi.fn((v: Buffer) => v.toString()),
    };
    let release!: () => void;
    const warmUp = vi.fn(() => new Promise<void>((r) => { release = () => { order.push('warm'); r(); }; }));
    const storage = new RecoverableSafeStorage(native, 'linux', () => ({ request: vi.fn() }), warmUp);
    const pending = storage.isEncryptionAvailable();
    await Promise.resolve();
    expect(native.isEncryptionAvailable).not.toHaveBeenCalled();
    release();
    await pending;
    await storage.isEncryptionAvailable();
    expect(order[0]).toBe('warm');
    expect(warmUp).toHaveBeenCalledTimes(1);
  });
  it('carries on if the warm-up fails, and never runs it off Linux', async () => {
    const native = { isEncryptionAvailable: vi.fn(() => true), encryptString: vi.fn(), decryptString: vi.fn() };
    const bad = vi.fn(async () => { throw new Error('no busctl'); });
    expect(await new RecoverableSafeStorage(native as any, 'linux', () => ({ request: vi.fn() }), bad).isEncryptionAvailable()).toBe(true);
    const skipped = vi.fn(async () => undefined);
    await new RecoverableSafeStorage(native as any, 'win32', () => ({ request: vi.fn() }), skipped).isEncryptionAvailable();
    expect(skipped).not.toHaveBeenCalled();
  });
});
