import { app, safeStorage } from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KeychainClient } from './keychain-client';
import { keychainLaunchOptions } from './keychain-launch';
import { RecoverableSafeStorage, type SecretStorage } from './recoverable-safe-storage';

let storage: SecretStorage | undefined;

/** All SecretsStore instances share one successful helper, not one Electron
 * process per provider. Creating the adapter itself never opens the wallet. */
export function getSecretStorage(): SecretStorage {
  // Outside Electron (unit tests/Node tooling), there is no browser executable
  // to relaunch. macOS and Windows retain the original safeStorage path too.
  if (process.platform !== 'linux' || !process.versions.electron) return safeStorage;
  if (storage) return storage;
  let client: KeychainClient | undefined;
  storage = new RecoverableSafeStorage(safeStorage, process.platform, () => {
    if (client) return client;
    client = new KeychainClient(() => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-keychain-'));
      const cleanup = (): void => {
        // Only this helper's private browser files, never userData or the wallet.
        fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 }, () => undefined);
      };
      try {
        const launch = keychainLaunchOptions({
          packaged: app.isPackaged, appPath: app.getAppPath(), name: app.getName(),
          backend: safeStorage.getSelectedStorageBackend(), scratch, env: process.env,
        });
        const child = spawn(process.execPath, launch.args, {
          env: launch.env, cwd: scratch, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        child.once('close', cleanup);
        return child;
      } catch (error) {
        cleanup();
        throw error;
      }
    });
    app.on('will-quit', () => client?.dispose());
    process.once('exit', () => client?.dispose());
    return client;
  });
  return storage;
}
