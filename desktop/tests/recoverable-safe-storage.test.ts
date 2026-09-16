import { describe, expect, it, vi } from 'vitest';
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
