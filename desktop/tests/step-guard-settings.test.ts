import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { StepGuardSettings, normalizeStepGuard } from '../src/main/harness/step-guard-settings';

describe('StepGuardSettings', () => {
  let root: string;
  let home: NativeHome;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-step-guard-'));
    home = new NativeHome(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('accepts only positive safe integers', () => {
    expect(normalizeStepGuard(1)).toBe(1);
    expect(normalizeStepGuard(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [undefined, null, '20', NaN, Infinity, 0, -1, 3.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeStepGuard(value)).toBeNull();
    }
  });

  it('rejects malformed writes without changing the saved preference or config siblings', async () => {
    const initial = { v: 1, engine: { backend: 'cpu' }, native: { other: true, stepGuard: 125 } };
    await home.writeJson('config.json', initial);
    const settings = new StepGuardSettings(home);

    for (const value of [undefined, '20', 3.5, 0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(settings.update(value)).rejects.toThrow('Step guard must be null or a positive safe integer');
      expect(settings.read()).toBe(125);
      expect(home.readJson('config.json')).toEqual(initial);
    }
  });

  it('preserves config siblings and clears only the preference for explicit null', async () => {
    await home.writeJson('config.json', { v: 1, engine: { backend: 'cpu' }, native: { other: true } });
    const settings = new StepGuardSettings(home);
    await expect(settings.update(125)).resolves.toBe(125);
    expect(settings.read()).toBe(125);
    expect(home.readJson('config.json')).toMatchObject({ engine: { backend: 'cpu' }, native: { other: true, stepGuard: 125 } });
    await expect(settings.update(null)).resolves.toBeNull();
    expect(settings.read()).toBeNull();
    expect(home.readJson('config.json')).toMatchObject({ engine: { backend: 'cpu' }, native: { other: true } });
  });

  it('reads malformed config as no preference', async () => {
    await home.writeJson('config.json', { native: { stepGuard: '50' } });
    expect(new StepGuardSettings(home).read()).toBeNull();
  });
});
