// @vitest-environment jsdom
import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTagRegistry, refreshTagRegistry, __resetTagRegistryForTests } from './useTagRegistry';

function Probe({ id }: { id: string }) { const r = useTagRegistry(); return <i data-id={id}>{r.tags.length}</i>; }

describe('useTagRegistry is one shared store', () => {
  beforeEach(() => { __resetTagRegistryForTests(); });

  it('three consumers cause ONE tags.list read', async () => {
    const list = vi.fn().mockResolvedValue([{ id: 't1', label: 'A', color: 'blue' }]);
    (window as any).claude = { tags: { list }, on: {} };
    render(<><Probe id="a" /><Probe id="b" /><Probe id="c" /></>);
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('a consumer mounted after the load renders the tags on its FIRST render', async () => {
    (window as any).claude = { tags: { list: vi.fn().mockResolvedValue([{ id: 't1', label: 'A', color: 'blue' }]) }, on: {} };
    render(<Probe id="a" />);
    await act(async () => {});
    const seen: number[] = [];
    function Late() { const r = useTagRegistry(); seen.push(r.tags.length); return null; }
    render(<Late />);
    expect(seen[0]).toBe(1);
  });

  it('a tags:changed push re-reads once, however many consumers', async () => {
    let push: () => void = () => {};
    const list = vi.fn().mockResolvedValue([]);
    (window as any).claude = { tags: { list }, on: { tagsChanged: (cb: () => void) => { push = cb; return () => {}; } } };
    render(<><Probe id="a" /><Probe id="b" /></>);
    await act(async () => {});
    await act(async () => { push(); });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a later consumer re-reads after a failed first read, and the tags appear', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('registry not started'))
      .mockResolvedValue([{ id: 't1', label: 'A', color: 'blue' }]);
    (window as any).claude = { tags: { list }, on: {} };
    const errors: (string | null)[] = [];
    function Err() { const r = useTagRegistry(); errors.push(r.error); return <b>{r.tags.length}</b>; }
    const { container } = render(<Err />);
    await act(async () => {});
    expect(errors[errors.length - 1]).toBeTruthy();
    render(<Probe id="late" />);
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    expect(errors[errors.length - 1]).toBeNull();
    expect(container.querySelector('b')!.textContent).toBe('1');
  });

  it('a surface refresh that returns a renamed tag updates what consumers show', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([{ id: 't1', label: 'Old', color: 'blue' }])
      .mockResolvedValue([{ id: 't1', label: 'New', color: 'blue' }]);
    (window as any).claude = { tags: { list }, on: {} };
    function Label() { const r = useTagRegistry(); return <u>{r.byId.get('t1')?.label ?? ''}</u>; }
    const { container } = render(<Label />);
    await act(async () => {});
    expect(container.querySelector('u')!.textContent).toBe('Old');
    await act(async () => { refreshTagRegistry(); });
    expect(container.querySelector('u')!.textContent).toBe('New');
  });

  it('a refresh that returns the same tags redraws no consumer', async () => {
    // Fresh but equal objects each time, as IPC delivers them.
    const list = vi.fn().mockImplementation(async () => [{ id: 't1', label: 'A', color: 'blue' }]);
    (window as any).claude = { tags: { list }, on: {} };
    let renders = 0;
    let latest: unknown = null;
    function Counter() { const r = useTagRegistry(); renders++; latest = r.tags; return null; }
    render(<Counter />);
    await act(async () => {});
    const before = renders;
    const held = latest;
    await act(async () => { refreshTagRegistry(); });
    expect(list).toHaveBeenCalledTimes(2);
    expect(renders).toBe(before);
    expect(latest).toBe(held);
  });

  it('an older answer that arrives after a newer one is ignored', async () => {
    let push: () => void = () => {};
    const resolvers: ((v: unknown) => void)[] = [];
    const list = vi.fn()
      .mockResolvedValueOnce([{ id: 't1', label: 'First', color: 'blue' }])
      .mockImplementation(() => new Promise((res) => { resolvers.push(res); }));
    (window as any).claude = { tags: { list }, on: { tagsChanged: (cb: () => void) => { push = cb; return () => {}; } } };
    function Label() { const r = useTagRegistry(); return <u>{r.byId.get('t1')?.label ?? ''}</u>; }
    const { container } = render(<Label />);
    await act(async () => {});
    await act(async () => { push(); push(); }); // two overlapping re-reads
    expect(resolvers).toHaveLength(2);
    await act(async () => { resolvers[1]([{ id: 't1', label: 'Newer', color: 'blue' }]); });
    await act(async () => { resolvers[0]([{ id: 't1', label: 'Older', color: 'blue' }]); });
    expect(container.querySelector('u')!.textContent).toBe('Newer');
  });

  it('an answer that arrives after a reset does not reach the fresh store', async () => {
    let resolve: (v: unknown) => void = () => {};
    (window as any).claude = { tags: { list: vi.fn().mockImplementation(() => new Promise((res) => { resolve = res; })) }, on: {} };
    const { unmount } = render(<Probe id="a" />);
    unmount();
    __resetTagRegistryForTests();
    // The old read answers while the fresh store has no reader of its own yet.
    await act(async () => { resolve([{ id: 't1', label: 'Stale', color: 'blue' }]); });
    (window as any).claude = { tags: { list: vi.fn().mockImplementation(() => new Promise(() => {})) }, on: {} };
    const { container } = render(<Probe id="b" />);
    expect(container.querySelector('i')!.textContent).toBe('0');
  });
});
