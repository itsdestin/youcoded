// The iPhone app and YouCoded Mesh are built on separate branches. WHY this file: when the two meet, two Mesh lines that
// still say "Android" stop the Mesh from ever starting on an iPhone, silently (it logs "refused" and carries on). A trial on
// 2026-11-27 (iPhone-mode backend on Node 18 with the JIT off, paired with a computer backend through the local relay) passed
// only after both were changed. Until the Mesh code is present these checks have nothing to look at and are skipped.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const MAIN = path.resolve(__dirname, '..', 'src', 'main');
const meshPresent = fs.existsSync(path.join(MAIN, 'mesh', 'boot-hook.ts'));

describe.skipIf(!meshPresent)('the Mesh can start on an iPhone', () => {
  it('the phone backend tells the Mesh which phone it is, not always "android"', () => {
    const boot = fs.readFileSync(path.join(MAIN, 'headless', 'headless-boot.ts'), 'utf8');
    // Wanted: `platform: hostOs() ?? 'android'` in the startMeshIfEnabled call.
    expect(boot).not.toMatch(/startMeshIfEnabled\(\{[^}]*platform: 'android'/);
  });

  it("the iPhone's Keychain counts as a real secret store (the Swift app sends keyStore: 'ios_keychain')", async () => {
    const shim = (await import('../src/main/headless/electron-headless')) as unknown as { holdSecretStoreBackend(w?: string): void; hostSecretStoreBackend(): string };
    shim.holdSecretStoreBackend('ios_keychain');
    expect(shim.hostSecretStoreBackend()).toBe('ios_keychain');
    shim.holdSecretStoreBackend(undefined); // silence still means "unknown", which the Mesh refuses
    expect(shim.hostSecretStoreBackend()).toBe('unknown');
  });
});
