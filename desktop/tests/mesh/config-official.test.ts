// Finding 9: test mode and the insecure key file must be impossible in any RELEASE build on every boot path, headless (the phone's) included.
// A release is stamped OFFICIAL_BUILD = true by both release workflows (scripts/stamp-official-build.mjs, desktop-release.yml and android-release.yml);
// config.ts and keystore.ts read that build-time constant, not `isPackaged` (headless is never packaged) and not the environment.
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/official-build', () => ({ OFFICIAL_BUILD: true }));
import { meshSwitch, MESH_SWITCH_FILE } from '../../src/main/mesh/config';
import { insecureTestSealer } from '../../src/main/mesh/keystore';
import { tmp } from './helpers';

describe('a stamped (official) build, unpackaged boot path as on the phone', () => {
  it('ignores YOUCODED_MESH and YOUCODED_MESH_TEST even when packaged is false', async () => {
    const d = tmp();
    expect(await meshSwitch({ userData: d, env: { YOUCODED_MESH: '1', YOUCODED_MESH_TEST: '1' }, packaged: false })).toEqual({ on: false, testMode: false });
  });
  it('honours the profile file but never grants test mode', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, MESH_SWITCH_FILE), '{"enabled": true}');
    expect(await meshSwitch({ userData: d, env: { YOUCODED_MESH_TEST: '1' }, packaged: false })).toEqual({ on: true, testMode: false });
  });
  it('the insecure plain-text sealer refuses even when told it is test mode', () => {
    expect(() => insecureTestSealer({ testMode: true })).toThrow();
  });
});
