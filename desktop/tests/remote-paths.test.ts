import { describe, expect, it } from 'vitest';
import { remoteConfigPath, remoteDeviceStorePath, remoteProfile } from '../src/main/remote-paths';

const HOME = '/tmp/fake-home';

describe('remote file paths', () => {
  it('scopes both files by profile, so a dev instance cannot write the built app store', () => {
    // WHY this is the point of the module: remote-server.ts used to hardcode the token path
    // with no profile while remote-config.ts scoped its own, so dev runs shared real pairings.
    expect(remoteConfigPath('', HOME)).toBe('/tmp/fake-home/.claude/youcoded-remote.json');
    expect(remoteDeviceStorePath('', HOME)).toBe('/tmp/fake-home/.claude/.remote-devices.json');
    expect(remoteConfigPath('dev', HOME)).toBe('/tmp/fake-home/.claude/youcoded-remote.dev.json');
    expect(remoteDeviceStorePath('dev', HOME)).toBe('/tmp/fake-home/.claude/.remote-devices.dev.json');
  });

  it('gives two profiles different files in the same process', () => {
    // A module-level process.env read could not do this: it is evaluated once per process.
    expect(remoteDeviceStorePath('dev', HOME)).not.toBe(remoteDeviceStorePath('dev2', HOME));
    expect(remoteConfigPath('dev', HOME)).not.toBe(remoteConfigPath('dev2', HOME));
  });

  it('never reuses the retired token filename', () => {
    // The old store kept several clear-text secrets per device with no identity; batch 1
    // retires it, so a collision would resurrect it as if it were the new format.
    for (const p of [remoteDeviceStorePath('', HOME), remoteDeviceStorePath('dev', HOME)]) {
      expect(p).not.toContain('remote-tokens');
    }
  });

  it('reads the profile from the environment it is given, not the real one', () => {
    expect(remoteProfile({ YOUCODED_PROFILE: 'dev2' } as NodeJS.ProcessEnv)).toBe('dev2');
    expect(remoteProfile({} as NodeJS.ProcessEnv)).toBe('');
  });
});
