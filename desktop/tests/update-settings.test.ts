import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NativeHome } from '../src/main/native-home';
import { UpdateSettings, resolveBetaChannel } from '../src/main/update-settings';

// The beta-channel setting (~/.youcoded/config.json → updates.betaChannel): what an
// install that was never asked does, and how a choice is stored. Which release
// that choice offers is pinned in update-release-status.test.ts.
describe('resolveBetaChannel — what an install that was never asked does', () => {
  it('follows the running build when unset', () => {
    expect(resolveBetaChannel(null, '1.3.0-beta.77')).toBe(true);
    expect(resolveBetaChannel(null, '1.3.0')).toBe(false);
  });

  it('lets an explicit choice win in both directions', () => {
    expect(resolveBetaChannel(false, '1.3.0-beta.77')).toBe(false);
    expect(resolveBetaChannel(true, '1.3.0')).toBe(true);
  });
});

describe('UpdateSettings — persistence', () => {
  // Always awaited, even for the synchronous cases: an earlier version returned
  // fn()'s promise and removed the directory in a synchronous `finally`, so the
  // write it was testing landed in a directory that no longer existed.
  async function withHome(fn: (settings: UpdateSettings, dir: string) => unknown): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-update-settings-'));
    try {
      await fn(new UpdateSettings(new NativeHome(dir)), dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  it('reads as unset before anything is written', async () => {
    await withHome((settings) => {
      expect(settings.read().betaChannel).toBeNull();
      // …so a beta build still checks the beta channel on a fresh install.
      expect(settings.resolve('1.3.0-beta.77')).toBe(true);
      expect(settings.resolve('1.3.0')).toBe(false);
    });
  });

  it('round-trips a choice, and off means off even on a beta build', async () => {
    await withHome(async (settings) => {
      await settings.setBetaChannel(false);
      expect(settings.read().betaChannel).toBe(false);
      expect(settings.resolve('1.3.0-beta.77')).toBe(false);
      await settings.setBetaChannel(true);
      expect(settings.resolve('1.2.4')).toBe(true);
    });
  });

  it('refuses a non-boolean rather than storing it', async () => {
    await withHome(async (settings) => {
      await expect(settings.setBetaChannel('yes')).rejects.toThrow(TypeError);
      expect(settings.read().betaChannel).toBeNull();
    });
  });

  it('leaves the rest of config.json alone', async () => {
    await withHome(async (settings, dir) => {
      const file = path.join(dir, '.youcoded', 'config.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: 1, naming: { mode: 'ai' } }));
      await settings.setBetaChannel(true);
      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(after.naming).toEqual({ mode: 'ai' });
      expect(after.updates).toEqual({ betaChannel: true });
    });
  });

  it('treats a hand-edited value as unset, not as off', async () => {
    await withHome((settings, dir) => {
      const file = path.join(dir, '.youcoded', 'config.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ updates: { betaChannel: 'maybe' } }));
      expect(settings.read().betaChannel).toBeNull();
      expect(settings.resolve('1.3.0-beta.77')).toBe(true);
    });
  });

  // "Install updates automatically" (#183): on unless the user turned it off.
  it('auto-install is on before anything is written, and when the saved value is garbage', async () => {
    await withHome(async (settings, dir) => {
      expect(settings.read().autoInstall).toBe(true);
      expect((await settings.readAsync()).autoInstall).toBe(true);
      const file = path.join(dir, '.youcoded', 'config.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ updates: { autoInstall: 'nope' } }));
      expect(settings.read().autoInstall).toBe(true);
      fs.writeFileSync(file, '{ not json');
      // (a file that cannot be parsed is not a choice either: readAsync rejects and the service keeps its value, review F3)
      await expect(settings.readAsync()).rejects.toBeTruthy();
    });
  });

  it('auto-install round-trips both ways and leaves the beta choice and other keys alone', async () => {
    await withHome(async (settings, dir) => {
      await settings.setBetaChannel(true);
      await settings.setAutoInstall(false);
      expect(settings.read()).toEqual({ betaChannel: true, autoInstall: false });
      expect((await settings.readAsync()).autoInstall).toBe(false);
      await settings.setAutoInstall(true);
      expect(settings.read()).toEqual({ betaChannel: true, autoInstall: true });
      expect(JSON.parse(fs.readFileSync(path.join(dir, '.youcoded', 'config.json'), 'utf8')).updates)
        .toEqual({ betaChannel: true, autoInstall: true });
    });
  });

  it('refuses a non-boolean auto-install rather than storing it', async () => {
    await withHome(async (settings, dir) => {
      await expect(settings.setAutoInstall('yes')).rejects.toThrow(TypeError);
      await expect(settings.setAutoInstall(undefined)).rejects.toThrow(TypeError);
      expect(fs.existsSync(path.join(dir, '.youcoded', 'config.json'))).toBe(false);
      expect(settings.read().autoInstall).toBe(true);
    });
  });
});

// Code review F3: only a MISSING file means "on"; a read that fails must not undo a saved "off".
describe('UpdateSettings.readAsync — a failed read is not a choice', () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-update-settings-async-'));
  it('a missing file reads as the defaults (on)', async () => {
    const dir = home();
    try { expect((await new UpdateSettings(new NativeHome(dir)).readAsync()).autoInstall).toBe(true); }
    finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  });
  it('an unreadable file rejects instead of reading as on', async () => {
    const dir = home();
    try {
      fs.mkdirSync(path.join(dir, '.youcoded', 'config.json'), { recursive: true }); // a directory where the file should be: EISDIR, not ENOENT
      await expect(new UpdateSettings(new NativeHome(dir)).readAsync()).rejects.toBeTruthy();
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  });
  it('a half-written file rejects instead of reading as on', async () => {
    const dir = home();
    try {
      fs.mkdirSync(path.join(dir, '.youcoded'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.youcoded', 'config.json'), '{"updates": {"autoInstall": fa');
      await expect(new UpdateSettings(new NativeHome(dir)).readAsync()).rejects.toBeTruthy();
    } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  });
});
