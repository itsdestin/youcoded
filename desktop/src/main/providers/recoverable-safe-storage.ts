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
  /** Electron 36+: initialises the ASYNC encryptor without blocking. Optional: the headless stand-in lacks it. */
  isAsyncEncryptionAvailable?(): Promise<boolean>;
};

/** How long the warm-up waits for the wallet to open before falling back to the old (blocking) path.
 *  A locked wallet showing an unlock prompt must not hold secret operations hostage forever. */
const ASYNC_OPEN_TIMEOUT_MS = 10_000;

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
    this.warming ??= this.warmUp().catch(() => { /* best effort: without it we behave as before */ })
      .then(() => this.openWalletAsync());
    await this.warming;
  }

  /** WHY (hitch audit 2026-11-27): waking the wallet daemons (warmUp) was not enough — desktop.log still showed
   *  "keychain-available" at 3.8-7.8 s on launches after it shipped, all of it inside the SYNCHRONOUS native probe
   *  (saved stall profiles: needsHelper), i.e. every window frozen. The slow part is the wallet itself opening, not
   *  the daemon starting. Electron's async encryptor opens the same wallet without blocking, so by the time the
   *  synchronous probe runs the daemon already holds it open. Additive only: nothing is encrypted or decrypted
   *  through the async encryptor, so the on-disk ciphertext format is unchanged. Unverified on a cold wallet in
   *  the lab (cannot be reproduced without stopping the owner's wallet); desktop.log's keychain-available timing
   *  after release is the check. */
  private async openWalletAsync(): Promise<void> {
    if (typeof this.native.isAsyncEncryptionAvailable !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ASYNC_OPEN_TIMEOUT_MS); timer.unref?.(); });
    try {
      await Promise.race([this.native.isAsyncEncryptionAvailable().then(() => undefined, () => undefined), timeout]);
    } finally { if (timer) clearTimeout(timer); }
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
