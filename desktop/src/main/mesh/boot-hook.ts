// The ONE entry the app's boot paths call (main.ts and headless-boot.ts): `startMeshIfEnabled(...)`.
//
// WHY A SEPARATE FILE: main.ts, headless-boot.ts and remote-shim.ts have line budgets (tests/line-budgets.test.ts), so the
// wiring lives here and each boot path adds a single guarded call. This file imports only config.ts (a tiny file that
// reads one optional file) until the switch says yes; the service, crypto and socket code load lazily after that.
//
// When the switch is OFF this returns null having done nothing but read `<userData>/mesh-switch.json` (and found nothing):
// no folder, no file, no socket, no timer.
import os from 'os';
import { meshSwitch } from './config';
import type { SafeStorageLike } from './keystore';
import { log } from '../logger';

export interface MeshBootInput {
  userData: string;
  safeStorage: SafeStorageLike;
  packaged: boolean;
  /** Platform word for the roster entry (the phone's backend passes 'android'; default is this OS). */
  platform?: string;
}
export interface MeshHandle { stop(): Promise<void> }

export async function startMeshIfEnabled(i: MeshBootInput): Promise<MeshHandle | null> {
  const sw = await meshSwitch({ userData: i.userData, packaged: i.packaged });
  if (!sw.on) return null;
  const event = (e: string, f: Record<string, string | number | boolean> = {}): void => log('INFO', 'Mesh', e, f);
  try {
    // Loaded only now: keeps everything mesh-related out of the process when the mesh is off.
    const { insecureTestSealer, safeStorageSealer, MeshKeyStoreRefused } = await import('./keystore');
    const { MeshService } = await import('./service');
    let sealer;
    try {
      // Test mode may use the insecure plaintext file (the rig's homes are throwaway); everything else needs a real OS
      // secret store and REFUSES otherwise (design 5.1; round-15 P-3 default: refuse, never plaintext).
      sealer = sw.testMode && process.env.YOUCODED_MESH_KEYSTORE !== 'os' ? insecureTestSealer({ testMode: true }) : safeStorageSealer(i.safeStorage);
    } catch (e) {
      if (e instanceof MeshKeyStoreRefused) { event('refused', { reason: e.code }); return null; }
      throw e;
    }
    const svc = new MeshService({
      userData: i.userData, sealer, testMode: sw.testMode, deviceName: process.env.YOUCODED_DEVICE_NAME || os.hostname(), platform: i.platform ?? process.platform, log: event,
      relayUrl: sw.testMode ? process.env.YOUCODED_MESH_RELAY_URL : undefined,
      relayBaseDelayMs: sw.testMode && process.env.YOUCODED_MESH_RELAY_BACKOFF_MS ? Number(process.env.YOUCODED_MESH_RELAY_BACKOFF_MS) : undefined,
    });
    await svc.start();
    let control: { close(): Promise<void> } | null = null;
    const token = process.env.YOUCODED_MESH_TEST_TOKEN;
    if (sw.testMode && token && token.length >= 32) control = await (await import('./test-control')).startTestControl(svc, token);
    return { stop: async () => { await control?.close(); await svc.stop(); } };
  } catch {
    // A failing mesh must never take the app down with it; nothing from the error is logged (it could echo bytes).
    event('start-failed');
    return null;
  }
}
