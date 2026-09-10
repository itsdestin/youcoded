// The naming preference has to answer honestly on a fresh install, refuse
// nonsense, and never disturb the settings that share config.json with it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeHome } from '../src/main/native-home';
import { NamingSettings, DEFAULT_NAMING } from '../src/main/naming-settings';

let root = '';
let settings: NamingSettings;
let home: NativeHome;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'naming-settings-'));
  home = new NativeHome(root);
  settings = new NamingSettings(home);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('NamingSettings', () => {
  it('a fresh install reads as Basic with no chosen model', () => {
    expect(settings.read()).toEqual(DEFAULT_NAMING);
    expect(settings.read()).toEqual({ mode: 'basic', model: null });
  });

  it('round-trips each mode', async () => {
    for (const mode of ['off', 'basic', 'ai'] as const) {
      await settings.update({ mode, model: null });
      expect(settings.read().mode).toBe(mode);
    }
  });

  it('stores a chosen model and clears it again', async () => {
    await settings.update({ mode: 'ai', model: { providerId: 'p1', modelId: 'm1' } });
    expect(settings.read()).toEqual({ mode: 'ai', model: { providerId: 'p1', modelId: 'm1' } });
    await settings.update({ mode: 'ai', model: null });
    expect(settings.read().model).toBeNull();
  });

  it('refuses an unknown mode instead of writing it', async () => {
    await expect(settings.update({ mode: 'sometimes' })).rejects.toThrow(/off, basic or ai/);
    expect(settings.read()).toEqual(DEFAULT_NAMING);
  });

  it('treats a half-shaped model as "conversation model", never a guessed provider', async () => {
    await settings.update({ mode: 'ai', model: { providerId: 'p1' } });
    expect(settings.read().model).toBeNull();
  });

  it('leaves the other settings in config.json alone', async () => {
    await home.mutateJson('config.json', () => ({ v: 1, native: { stepGuard: 40 }, engine: { speed: 'fast' } }));
    await settings.update({ mode: 'ai', model: null });
    const config = home.readJson('config.json') as any;
    expect(config.native).toEqual({ stepGuard: 40 });
    expect(config.engine).toEqual({ speed: 'fast' });
    expect(config.naming).toEqual({ mode: 'ai' });
  });

  it('a hand-broken preference reads as the default, not as Off', () => {
    // Off would silently stop naming for a user who never chose it.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ v: 1, naming: { mode: 'AI', model: 3 } }));
    expect(settings.read()).toEqual({ mode: 'basic', model: null });
  });
});
