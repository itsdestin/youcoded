// @vitest-environment jsdom
import React from 'react';
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useTagRegistry, __resetTagRegistryForTests } from './useTagRegistry';

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
});
