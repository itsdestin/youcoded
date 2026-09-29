// register-ipc.ts — test entry to registerIpcHandlers now that the runtime is built outside it.
//
// WHY (2026-09-29 one-core R1): registerIpcHandlers used to construct the native runtime
// itself, so tests called it with the same positional arguments and got a runtime for free.
// main.ts now builds the runtime once (createRuntime) and passes it in the slot where
// `chatgptAuth` used to be (argument 11). This wrapper keeps every existing call shape: pass
// the same arguments as before, and it builds the runtime exactly as main.ts does — using the
// test's own (mocked) Electron `app`, and the real Electron-backed Platform over that mock, so
// the wiring under test is unchanged.
import os from 'os';
import { app } from 'electron';
import { createRuntime } from '../../src/main/create-runtime';
import { createElectronPlatform } from '../../src/main/electron-platform';

export function registerWithRuntime(register: (...args: any[]) => any, ...args: any[]): any {
  const padded = [...args];
  while (padded.length < 12) padded.push(undefined);
  const [, sessionManager] = padded;
  const runtime = createRuntime({
    userDataDir: (app as any)?.getPath?.('userData') ?? os.tmpdir(),
    appVersion: (app as any)?.getVersion?.() ?? '0.0.0-test',
    platform: createElectronPlatform(),
    chatgptAuth: padded[10] ?? null, // argument 11 was chatgptAuth; it is the runtime's input now
    sessionManager,
  });
  padded[10] = runtime;
  return register(...padded);
}
