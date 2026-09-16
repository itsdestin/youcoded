import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import {
  readEngineConfig, updateEngineConfig, updateEngineSpeed, defaultCacheDir,
  modelSettingsFor, DEFAULT_CONTEXT_SIZE, DEFAULT_MODEL_SETTINGS,
} from '../src/main/engine/engine-config';
import type { EngineBackend } from '../src/shared/engine-types';

// Every backend the app can install, spelled out as an exhaustive Record so
// that ADDING one to EngineBackend and forgetting engine-config's allowlist
// fails to COMPILE here. Without the allowlist entry the save succeeds and
// reads back as null, and the user's chosen backend silently reverts to the
// platform default on the next launch — a bug with no error message anywhere.
const EVERY_BACKEND: Record<EngineBackend, true> = {
  vulkan: true, cpu: true, metal: true, cuda: true, rocm: true,
};

let root: string;
let home: NativeHome;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-config-'));
  home = new NativeHome(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('engine-config', () => {
  it('returns platform defaults when config.json is absent', () => {
    const cfg = readEngineConfig(home);
    expect(cfg.cacheDir).toBe(defaultCacheDir());
    expect(cfg.backend).toBeNull();
    expect(cfg.contextSize).toBe(DEFAULT_CONTEXT_SIZE);
  });

  it('round-trips a partial update without touching other config.json keys', async () => {
    await home.writeJson('config.json', { v: 1, somethingElse: { keep: true } });
    await updateEngineConfig(home, { backend: 'cpu' });
    const cfg = readEngineConfig(home);
    expect(cfg.backend).toBe('cpu');
    expect(cfg.cacheDir).toBe(defaultCacheDir()); // untouched fields stay default
    const raw = home.readJson('config.json') as any;
    expect(raw.somethingElse).toEqual({ keep: true }); // sibling keys survive
  });

  it('round-trips every backend the app can install, ROCm included', async () => {
    for (const backend of Object.keys(EVERY_BACKEND) as EngineBackend[]) {
      await updateEngineConfig(home, { backend });
      expect(readEngineConfig(home).backend).toBe(backend);
    }
  });

  it('ignores malformed engine values (wrong types) and falls back to defaults', async () => {
    await home.writeJson('config.json', { v: 1, engine: { cacheDir: 42, backend: 'quantum', contextSize: -5 } });
    const cfg = readEngineConfig(home);
    expect(cfg.cacheDir).toBe(defaultCacheDir());
    expect(cfg.backend).toBeNull();
    expect(cfg.contextSize).toBe(DEFAULT_CONTEXT_SIZE);
  });
});

// ---------------------------------------------------------------------------
// The engine section grows (2026-09-05 local-engine upgrades §Storage): the two
// speed switches and the per-model settings. THE RULE THIS PINS: a key that is
// absent means today's behaviour — an install that predates the feature, a file
// a person edited, and a fresh one must all run the same way.
// ---------------------------------------------------------------------------
describe('engine.speed', () => {
  it('is both switches ON when nothing has ever been saved (contract R4)', () => {
    expect(readEngineConfig(home).speed).toEqual({ speculative: true, compressCache: true });
  });

  it('a saved switch keeps the OTHER one at its default rather than turning it off too', async () => {
    await updateEngineSpeed(home, { speculative: false });
    expect(readEngineConfig(home).speed).toEqual({ speculative: false, compressCache: true });
    // …and the same the other way round, from the file this time.
    await updateEngineSpeed(home, { compressCache: false });
    expect(readEngineConfig(home).speed).toEqual({ speculative: false, compressCache: false });
  });

  it('a partial write does not replace the whole object on disk', async () => {
    await updateEngineSpeed(home, { speculative: false, compressCache: false });
    await updateEngineSpeed(home, { speculative: true });
    // Read the RAW file, not the defaulting reader: a reader that fills in a
    // missing key would hide the very loss this checks for.
    expect((home.readJson('config.json') as any).engine.speed)
      .toEqual({ speculative: true, compressCache: false });
  });

  it('a switch written as something other than true/false reads as its default', async () => {
    await home.writeJson('config.json', { v: 1, engine: { speed: { speculative: 'yes', compressCache: 0 } } });
    expect(readEngineConfig(home).speed).toEqual({ speculative: true, compressCache: true });
    await home.writeJson('config.json', { v: 1, engine: { speed: 'fast' } });
    expect(readEngineConfig(home).speed).toEqual({ speculative: true, compressCache: true });
  });

  it('leaves the context length and cache dir alone', async () => {
    await updateEngineConfig(home, { contextSize: 65_536, cacheDir: '/models' });
    await updateEngineSpeed(home, { compressCache: false });
    const cfg = readEngineConfig(home);
    expect(cfg.contextSize).toBe(65_536);
    expect(cfg.cacheDir).toBe('/models');
  });
});

describe('engine.models — per-model settings', () => {
  it('is empty when nothing has been configured', () => {
    expect(readEngineConfig(home).models).toEqual({});
  });

  it('round-trips one model\'s full settings', async () => {
    await updateEngineConfig(home, {
      models: {
        'gemma-4-E2B-it-Q8_0': {
          contextLength: 16_384,
          keepLoaded: true,
          gpuLayers: 24,
          extraFlags: '--temp 0.6',
          memoryWarningDismissed: { at: 1_757_000_000_000, contextLength: 16_384 },
        },
      },
    });
    expect(readEngineConfig(home).models['gemma-4-E2B-it-Q8_0']).toEqual({
      contextLength: 16_384,
      keepLoaded: true,
      gpuLayers: 24,
      extraFlags: '--temp 0.6',
      memoryWarningDismissed: { at: 1_757_000_000_000, contextLength: 16_384 },
    });
  });

  it('fills every missing key of a half-written entry with the untouched-model default', async () => {
    await home.writeJson('config.json', { v: 1, engine: { models: { 'half-written': { contextLength: 8_192 } } } });
    // The whole object, not one field: a default that quietly became `true`
    // (keep loaded) or a number (gpu layers) changes how the engine runs.
    expect(readEngineConfig(home).models['half-written']).toEqual({
      contextLength: 8_192,
      keepLoaded: false,
      gpuLayers: 'auto',
      extraFlags: '',
      memoryWarningDismissed: null,
    });
  });

  it('modelSettingsFor answers defaults for a model that has no entry at all', () => {
    expect(modelSettingsFor(readEngineConfig(home).models, 'never-configured')).toEqual(DEFAULT_MODEL_SETTINGS);
    expect(modelSettingsFor(null, 'never-configured')).toEqual(DEFAULT_MODEL_SETTINGS);
    expect(modelSettingsFor({ x: 'nonsense' }, 'x')).toEqual(DEFAULT_MODEL_SETTINGS);
  });

  it('drops values the engine could not run', async () => {
    await home.writeJson('config.json', {
      v: 1,
      engine: {
        models: {
          bad: { contextLength: -5, keepLoaded: 'yes', gpuLayers: 'all', extraFlags: 7 },
        },
      },
    });
    expect(readEngineConfig(home).models.bad).toEqual(DEFAULT_MODEL_SETTINGS);
  });

  it('a dismissal WITHOUT the context length it was made at is no dismissal (R3-4)', async () => {
    await home.writeJson('config.json', {
      v: 1,
      engine: {
        models: {
          // A bare timestamp — the shape this field deliberately is NOT. It
          // cannot answer "is this the same context length as when they said
          // don't warn me?", so it must not count as an answer.
          'bare-timestamp': { memoryWarningDismissed: 1_757_000_000_000 },
          'no-length': { memoryWarningDismissed: { at: 1_757_000_000_000 } },
          'no-time': { memoryWarningDismissed: { contextLength: 32_768 } },
        },
      },
    });
    const models = readEngineConfig(home).models;
    expect(models['bare-timestamp'].memoryWarningDismissed).toBeNull();
    expect(models['no-length'].memoryWarningDismissed).toBeNull();
    expect(models['no-time'].memoryWarningDismissed).toBeNull();
  });

  it('carries pendingApply only when it is really set', async () => {
    await home.writeJson('config.json', {
      v: 1,
      engine: { models: { waiting: { pendingApply: true }, done: { pendingApply: false } } },
    });
    const models = readEngineConfig(home).models;
    expect(models.waiting.pendingApply).toBe(true);
    expect(models.done.pendingApply).toBeUndefined();
  });
});
