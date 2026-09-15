import { describe, expect, it, vi } from 'vitest';
import { keychainOperation } from '../src/main/providers/keychain-operation';

function storage() {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'kwallet6'),
    encryptString: vi.fn((v: string) => Buffer.from(`encrypted:${v}`)),
    decryptString: vi.fn((v: Buffer) => v.toString().slice(10)),
  };
}

describe('keychain helper operations', () => {
  it('round trips existing safeStorage ciphertext using only private messages', () => {
    const s = storage();
    const encrypted = keychainOperation({ operation: 'encrypt', value: 'token' }, s);
    expect(encrypted).toEqual({ ok: true, value: Buffer.from('encrypted:token').toString('base64') });
    expect(keychainOperation({ operation: 'decrypt', value: Buffer.from('encrypted:token').toString('base64') }, s)).toEqual({ ok: true, value: 'token' });
  });

  it('refuses basic_text even if Electron claims encryption is available', () => {
    const s = storage();
    s.getSelectedStorageBackend.mockReturnValue('basic_text');
    expect(keychainOperation({ operation: 'available' }, s)).toEqual({ ok: true, value: false });
    expect(keychainOperation({ operation: 'encrypt', value: 'token' }, s)).toEqual({ ok: false, code: 'unavailable' });
    expect(s.encryptString).not.toHaveBeenCalled();
  });

  it('returns unavailable without attempting decryption when the wallet is inaccessible', () => {
    const s = storage();
    s.isEncryptionAvailable.mockReturnValue(false);
    expect(keychainOperation({ operation: 'decrypt', value: 'cipher' }, s)).toEqual({ ok: false, code: 'unavailable' });
    expect(s.decryptString).not.toHaveBeenCalled();
  });

  it('does not expose thrown secret-bearing error details', () => {
    const s = storage();
    s.decryptString.mockImplementation(() => { throw new Error('secret-token'); });
    expect(keychainOperation({ operation: 'decrypt', value: 'cipher' }, s)).toEqual({ ok: false, code: 'decrypt' });
  });
});
