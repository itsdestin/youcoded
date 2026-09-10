// Pins the WORKBENCH FAKE (dev/workbench/naming-preview.ts), not the app.
// It exists so a design review of the naming UI cannot be misled by a fake
// that quietly succeeds where the real backend would refuse. It is NOT
// coverage of any contract row — the shipping paths are covered by
// session-namer.test.ts and session-naming-ownership.test.ts.
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
    const second = api.rename('a', 'Another');
    const rejection = expect(second).rejects.toThrow('refused');
    release(); await rejection;
    // A refused write must not have published anything.
    expect(published).toEqual(['Manual']);
    // …and the stored title is still the one that DID land.
    const read = api.title('a', 'Opening request');
    release();
    expect(await read).toEqual({ title: 'Manual', manual: true });
  });
  it('rejects empty manual names', async () => {
    await expect(createNamingPreview().rename('a', '  ')).rejects.toThrow();
  });
});
