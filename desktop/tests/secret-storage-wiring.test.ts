import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import { KeychainClient } from '../src/main/providers/keychain-client';
import { RecoverableSafeStorage, type SecretStorage } from '../src/main/providers/recoverable-safe-storage';
import { keychainLaunchOptions } from '../src/main/providers/keychain-launch';

it('wires all stores to one private helper and cleans up only its scratch files', async () => {
  const native = { isEncryptionAvailable: () => false, getSelectedStorageBackend: () => 'kwallet6' };
  const children: Array<EventEmitter & { send: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }> = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { send: vi.fn(), kill: vi.fn() });
    children.push(child);
    return child;
  });
  const rm = vi.fn();
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getAppPath: () => '/real/app.asar', getName: () => 'youcoded' });
  const proc = Object.assign(new EventEmitter(), { platform: 'linux', versions: { electron: '41.10.7' }, execPath: '/real/youcoded', env: {} });
  const exports: { getSecretStorage?: () => SecretStorage } = {};
  const source = fs.readFileSync(path.resolve(__dirname, '../src/main/providers/secret-storage.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInNewContext(compiled, { process: proc, exports, require: (name: string) => {
    switch (name) {
      case 'electron': return { app, safeStorage: native };
      case 'node:child_process': return { spawn };
      case 'node:fs': return { mkdtempSync: () => '/tmp/owned-keychain', rm };
      case 'node:os': return { tmpdir: () => '/tmp' };
      case 'node:path': return path;
      case './keychain-client': return { KeychainClient };
      case './keychain-launch': return { keychainLaunchOptions };
      case './recoverable-safe-storage': return { RecoverableSafeStorage };
      default: throw new Error(`Unexpected dependency ${name}`);
    }
  } });
  const a = exports.getSecretStorage!();
  expect(exports.getSecretStorage!()).toBe(a);
  expect(spawn).not.toHaveBeenCalled();
  const pending = a.isEncryptionAvailable();
  expect(spawn).toHaveBeenCalledWith('/real/youcoded', expect.arrayContaining(['--password-store=kwallet6']), expect.objectContaining({ cwd: '/tmp/owned-keychain', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  children[0].emit('message', { ok: true, value: true });
  await expect(pending).resolves.toBe(true);
  app.emit('will-quit');
  expect(children[0].kill).toHaveBeenCalledOnce();
  children[0].emit('close', 0);
  expect(rm).toHaveBeenCalledWith('/tmp/owned-keychain', expect.objectContaining({ recursive: true }), expect.any(Function));
});
