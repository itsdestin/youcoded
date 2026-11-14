// The off switch: default OFF, on only by an explicit per-profile file or (dev/test only) an environment variable.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { isMeshOn, meshSwitch, MESH_SWITCH_FILE } from '../../src/main/mesh/config';
import { listFiles, tmp } from './helpers';

const write = (dir: string, body: string): void => fs.writeFileSync(path.join(dir, MESH_SWITCH_FILE), body);

describe('mesh off switch', () => {
  it('is OFF by default: empty profile, empty environment', async () => {
    const d = tmp();
    expect(await meshSwitch({ userData: d, env: {} })).toEqual({ on: false, testMode: false });
    expect(await isMeshOn({ userData: d, env: {} })).toBe(false);
  });
  it('reading the switch never creates or changes a file', async () => {
    const d = tmp();
    await meshSwitch({ userData: d, env: {} });
    await meshSwitch({ userData: path.join(d, 'does-not-exist'), env: {} });
    expect(listFiles(d)).toEqual([]);
    expect(fs.existsSync(path.join(d, 'does-not-exist'))).toBe(false);
  });
  it('the profile file turns it on, only when it says exactly {"enabled": true}', async () => {
    const d = tmp();
    write(d, '{"enabled": true}');
    expect((await meshSwitch({ userData: d, env: {} })).on).toBe(true);
    for (const bad of ['{"enabled": "yes"}', '{"enabled": 1}', '{"enabled": false}', '{}', 'null', 'not json', '']) {
      write(d, bad);
      expect((await meshSwitch({ userData: d, env: {} })).on, bad).toBe(false);
    }
  });
  it('the environment variable turns it on in a dev/test (unpackaged) process only, and only for the value "1"', async () => {
    const d = tmp();
    expect((await meshSwitch({ userData: d, env: { YOUCODED_MESH: '1' } })).on).toBe(true);
    for (const v of ['0', 'true', 'yes', '']) expect((await meshSwitch({ userData: d, env: { YOUCODED_MESH: v } })).on, v).toBe(false);
  });
  it('a PACKAGED build ignores the environment variable but honours the profile file', async () => {
    const d = tmp();
    expect((await meshSwitch({ userData: d, env: { YOUCODED_MESH: '1', YOUCODED_MESH_TEST: '1' }, packaged: true })).on).toBe(false);
    write(d, '{"enabled": true}');
    expect(await meshSwitch({ userData: d, env: { YOUCODED_MESH_TEST: '1' }, packaged: true })).toEqual({ on: true, testMode: false });
  });
  it('test mode needs the mesh on AND YOUCODED_MESH_TEST=1 (and never in a packaged build)', async () => {
    const d = tmp();
    expect(await meshSwitch({ userData: d, env: { YOUCODED_MESH_TEST: '1' } })).toEqual({ on: false, testMode: false });
    expect(await meshSwitch({ userData: d, env: { YOUCODED_MESH: '1' } })).toEqual({ on: true, testMode: false });
    expect(await meshSwitch({ userData: d, env: { YOUCODED_MESH: '1', YOUCODED_MESH_TEST: '1' } })).toEqual({ on: true, testMode: true });
  });
  it('an empty userData path is off', async () => {
    expect((await meshSwitch({ userData: '', env: { YOUCODED_MESH: '1' } })).on).toBe(false);
  });
});
