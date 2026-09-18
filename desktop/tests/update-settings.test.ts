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
});
