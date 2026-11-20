import { describe, it, expect } from 'vitest';
// WHY mocked: the real logger appends to ~/.claude/desktop.log, which a test must never touch.
vi.mock('./logger', () => ({ log: vi.fn() }));
import { vi } from 'vitest';
import { checkNamingModel } from './naming-model-check';

const choice = { providerId: 'p', modelId: 'm' };
const load = (list: Array<{ id: string; providerId: string }>) => async () => list;
describe('a model that is not in the list', () => {
  it('is refused, and one that is in it is accepted', async () => {
    expect(await checkNamingModel(load([{ id: 'x', providerId: 'p' }]), choice)).toMatch(/isn’t in the model list/);
    expect(await checkNamingModel(load([{ id: 'm', providerId: 'p' }]), choice)).toBeNull();
  });
});

describe('checkNamingModel', () => {
  it('a list that throws while loading refuses the pick (it used to pass unchecked)', async () => {
    expect(await checkNamingModel(() => Promise.reject(new Error('offline')), choice)).toBe('Couldn’t check the model list right now. Try again in a moment.');
  });
  it('a list that loads decides normally', async () => {
    expect(await checkNamingModel(async () => [{ id: 'm', providerId: 'p' }], choice)).toBeNull();
  });
});
