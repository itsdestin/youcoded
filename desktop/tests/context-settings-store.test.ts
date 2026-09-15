import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { ContextSettingsStore } from '../src/main/harness/context-settings-store';

describe('ContextSettingsStore', () => {
  let root: string;
  let home: NativeHome;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-context-')); home = new NativeHome(root); });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
  it('normalizes missing and malformed fields independently', async () => {
    const store = new ContextSettingsStore(home);
    expect(store.read()).toEqual({ openrouter: 'standard', chatgpt: 'standard' });
    for (const context of [null, [], 'long', { openrouter: false }, { chatgpt: 1 }]) {
      await home.writeJson('config.json', { native: { context } });
      expect(store.read()).toEqual({ openrouter: 'standard', chatgpt: 'standard' });
    }
    await home.writeJson('config.json', { native: { context: { openrouter: 'long', chatgpt: 'bad' } } });
    expect(store.read()).toEqual({ openrouter: 'long', chatgpt: 'standard' });
  });
  it('persists across instances and preserves siblings and unrelated config', async () => {
    const initial = { v: 1, other: { x: 2 }, native: { stepGuard: 40, context: { openrouter: 'long', chatgpt: 'standard' } } };
    await home.writeJson('config.json', initial);
    await expect(new ContextSettingsStore(home).update({ chatgpt: 'long' })).resolves.toEqual({ openrouter: 'long', chatgpt: 'long' });
    expect(new ContextSettingsStore(new NativeHome(root)).read()).toEqual({ openrouter: 'long', chatgpt: 'long' });
    expect(home.readJson('config.json')).toEqual({ ...initial, native: { ...initial.native, context: { openrouter: 'long', chatgpt: 'long' } } });
  });
  it('composes concurrent distinct-provider patches under the lock', async () => {
    await Promise.all([new ContextSettingsStore(home).update({ openrouter: 'long' }), new ContextSettingsStore(new NativeHome(root)).update({ chatgpt: 'long' })]);
    expect(new ContextSettingsStore(home).read()).toEqual({ openrouter: 'long', chatgpt: 'long' });
  });
  it('rejects invalid patches before mutation', async () => {
    const mutate = vi.spyOn(home, 'mutateJson');
    for (const patch of [null, [], 'long', undefined, { other: 'long' }, { chatgpt: null }, { openrouter: 'LONG' }, { chatgpt: undefined }]) {
      await expect(new ContextSettingsStore(home).update(patch)).rejects.toThrow();
    }
    expect(mutate).not.toHaveBeenCalled();
  });
  it('propagates read and locked write errors', async () => {
    vi.spyOn(home, 'mutateJson').mockRejectedValue(new Error('lock held'));
    await expect(new ContextSettingsStore(home).update({ chatgpt: 'long' })).rejects.toThrow('lock held');
    vi.spyOn(home, 'readJson').mockImplementation(() => { throw new Error('EACCES'); });
    expect(() => new ContextSettingsStore(home).read()).toThrow('EACCES');
  });
});
