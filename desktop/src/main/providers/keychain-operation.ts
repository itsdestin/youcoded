import type { KeychainRequest, KeychainResponse } from './keychain-client';

type Storage = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

/** No files, logging, auth state, or network: the child only performs crypto.
 * Native exception text is not returned because a backend can include input. */
export function keychainOperation(request: KeychainRequest, storage: Storage): KeychainResponse {
  let available: boolean;
  try {
    available = storage.isEncryptionAvailable() && storage.getSelectedStorageBackend() !== 'basic_text';
  } catch {
    available = false;
  }
  if (request.operation === 'available') return { ok: true, value: available };
  if (!available) return { ok: false, code: 'unavailable' };
  try {
    const value = request.operation === 'encrypt'
      ? storage.encryptString(request.value).toString('base64')
      : storage.decryptString(Buffer.from(request.value, 'base64'));
    return { ok: true, value };
  } catch {
    return { ok: false, code: request.operation };
  }
}
