import type { KeychainClient } from './keychain-client';
import { timeSessionSetup } from '../session-setup-timing';

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
    // Linux only: wakes the wallet daemons without blocking, BEFORE the first synchronous native probe (see keychain-warmup.ts).
    private readonly warmUp?: () => Promise<void>,
  ) {}

  private warming: Promise<void> | null = null;

  private async warm(): Promise<void> {
    if (this.platform !== 'linux' || !this.warmUp) return;
    // One shared attempt, so concurrent first calls all wait on the same wake-up instead of each starting their own.
    this.warming ??= this.warmUp().catch(() => { /* best effort: without it we behave as before */ });
    await this.warming;
  }

  private needsHelper(): boolean {
    return this.platform === 'linux' && !this.native.isEncryptionAvailable();
  }

  async isEncryptionAvailable(): Promise<boolean> {
    return timeSessionSetup('keychain-available', async () => {
      await this.warm();
      if (!this.needsHelper()) return this.native.isEncryptionAvailable();
      return await this.helper().request({ operation: 'available' }) === true;
    });
  }

  async encryptString(value: string): Promise<Buffer> {
    return timeSessionSetup('keychain-encrypt', async () => {
      await this.warm();
      if (!this.needsHelper()) return this.native.encryptString(value);
      const encoded = await this.helper().request({ operation: 'encrypt', value });
      return Buffer.from(encoded as string, 'base64');
    });
  }

  async decryptString(value: Buffer): Promise<string> {
    // WHY: async syntax does not move native crypto off-thread. Attribute a
    // slow keychain call without recording its input/output or changing storage.
    return timeSessionSetup('keychain-decrypt', async () => {
      await this.warm();
      if (!this.needsHelper()) return this.native.decryptString(value);
      return await this.helper().request({ operation: 'decrypt', value: value.toString('base64') }) as string;
    });
  }
}
