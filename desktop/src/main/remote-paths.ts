import path from 'path';
import os from 'os';

/**
 * Where remote access keeps its files.
 *
 * WHY this module exists: `remote-config.ts` scoped its file by profile so a dev instance
 * could not clobber the built app, but `remote-server.ts` hardcoded the pairing store with no
 * profile — so dev runs wrote the real app's paired devices. One helper, used by both.
 *
 * WHY the profile is an argument and not read here: a module-level `process.env` read is
 * evaluated once per process, so two profiles could never exist in one test run.
 */
export function remoteProfile(env: NodeJS.ProcessEnv = process.env): string {
  return env.YOUCODED_PROFILE ?? '';
}

function scoped(home: string, base: string, ext: string, profile: string): string {
  return path.join(home, '.claude', profile ? `${base}.${profile}.${ext}` : `${base}.${ext}`);
}

export function remoteConfigPath(profile = remoteProfile(), home = os.homedir()): string {
  return scoped(home, 'youcoded-remote', 'json', profile);
}

/**
 * Paired devices. A NEW filename, deliberately: the old `.remote-tokens.json` holds opaque
 * secrets in the clear with no device identity, several per device. Batch 1 retires it rather
 * than migrating it, so the two names must not collide.
 */
export function remoteDeviceStorePath(profile = remoteProfile(), home = os.homedir()): string {
  return scoped(home, '.remote-devices', 'json', profile);
}
