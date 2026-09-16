import { app, safeStorage } from 'electron';
import { keychainOperation } from './keychain-operation';
import type { KeychainRequest } from './keychain-client';

function start(): void {
  const name = process.env.YOUCODED_KEYCHAIN_NAME;
  const scratch = process.env.YOUCODED_KEYCHAIN_SCRATCH;
  if (!name || !scratch || !process.send || !process.connected) { app.exit(1); return; }
  // WHY before readiness: Electron snapshots the application name into Linux's
  // crypto config during startup. A new profile must still read the SAME key.
  app.setName(name);
  app.setPath('userData', scratch);
  app.setPath('sessionData', scratch);
  // A helper error must not open Electron's default uncaught-error dialog or
  // print credential-bearing input. The parent reports a safe transport error.
  process.on('uncaughtException', () => app.exit(1));
  process.on('unhandledRejection', () => app.exit(1));
  process.on('disconnect', () => app.exit(0));
  const ready = app.whenReady();
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') { app.exit(1); return; }
    const request = message as KeychainRequest;
    if (request.operation !== 'available' && !(
      (request.operation === 'encrypt' || request.operation === 'decrypt') &&
      typeof request.value === 'string' && Buffer.byteLength(request.value) <= 16 * 1024 * 1024
    )) { app.exit(1); return; }
    void ready.then(() => {
      if (!process.connected) return;
      const response = keychainOperation(request, safeStorage);
      process.send!(response, (error: Error | null) => {
        if (error || !response.ok || response.value === false) app.exit(error ? 1 : 0);
      });
    }).catch(() => app.exit(1));
  });
}

start();
