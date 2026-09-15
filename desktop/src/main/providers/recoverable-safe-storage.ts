import type { KeychainClient } from './keychain-client';

export interface SecretStorage {
  isEncryptionAvailable(): boolean | Promise<boolean>;
  encryptString(value: string): Buffer | Promise<Buffer>;
  decryptString(value: Buffer): string | Promise<string>;
}

type NativeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

/** Preserve Electron's normal path; only Linux's cached failure needs a fresh
 * process. The helper still uses safeStorage, not a second encryption format. */
export class RecoverableSafeStorage implements SecretStorage {
  constructor(
    private readonly native: NativeStorage,
    private readonly platform: NodeJS.Platform,
    private readonly helper: () => Pick<KeychainClient, 'request'>,
  ) {}

  private needsHelper(): boolean {
    return this.platform === 'linux' && !this.native.isEncryptionAvailable();
  }

  async isEncryptionAvailable(): Promise<boolean> {
    if (!this.needsHelper()) return this.native.isEncryptionAvailable();
    return await this.helper().request({ operation: 'available' }) === true;
  }

  async encryptString(value: string): Promise<Buffer> {
    if (!this.needsHelper()) return this.native.encryptString(value);
    const encoded = await this.helper().request({ operation: 'encrypt', value });
    return Buffer.from(encoded as string, 'base64');
  }

  async decryptString(value: Buffer): Promise<string> {
    if (!this.needsHelper()) return this.native.decryptString(value);
    return await this.helper().request({ operation: 'decrypt', value: value.toString('base64') }) as string;
  }
}
