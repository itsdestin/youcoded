import { describe, it, expect } from 'vitest';
import { createNamingPreview } from '../src/renderer/dev/workbench/naming-preview';

describe('session naming preview fake', () => {
  it('defaults to Basic and keeps manual names when switching Off', async () => {
    const api = createNamingPreview();
    expect((await api.get()).mode).toBe('basic');
    await api.rename('a', 'My title');
    await api.set({ mode: 'off', model: null });
    expect(await api.title('a', 'Opening request')).toEqual({ title: 'My title', manual: true });
  });
  it('only explicit automatic action clears an override, even while Off', async () => {
    const api = createNamingPreview();
    await api.rename('a', 'My title');
    await api.automatic('a');
    expect(await api.title('a', 'Opening request')).toEqual({ title: 'Opening request', manual: false });
  });
  it('waits before publishing and refuses writes without changing titles', async () => {
    let release!: () => void;
    const published: string[] = [];
    let refused = false;
    const api = createNamingPreview((_id, title) => published.push(title), {
      wait: () => new Promise<void>((resolve) => { release = resolve; }),
      refuseWrites: () => refused,
    });
    const save = api.rename('a', 'Manual');
    expect(published).toEqual([]);
    release(); await save;
    expect(published).toEqual(['Manual']);
    refused = true;
    const reset = api.automatic('a');
    const rejection = expect(reset).rejects.toThrow('refused');
    release(); await rejection;
    expect(published).toEqual(['Manual']);
  });
  it('rejects empty manual names', async () => {
    await expect(createNamingPreview().rename('a', '  ')).rejects.toThrow();
  });
});
