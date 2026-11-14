// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { APP_NOTICE_EVENT } from '../src/renderer/utils/announce';
import { useDefaultsSaver } from '../src/renderer/hooks/useDefaultsSaver';
import { useSessionMeta } from '../src/renderer/hooks/useSessionMeta';
import { useTagRegistry, __resetTagRegistryForTests } from '../src/renderer/hooks/useTagRegistry';

// Card #134 round 4: each new "Couldn't …" notice has a real-failure test and a no-false-alarm test.
// No sleeps: every test awaits the promise the code under test returns, or waits on the toast itself.
const toasts = () => { const got: string[] = []; const on = (e: Event) => got.push((e as CustomEvent).detail.message); window.addEventListener(APP_NOTICE_EVENT, on); return { got, off: () => window.removeEventListener(APP_NOTICE_EVENT, on) }; };
let t: ReturnType<typeof toasts>;
beforeEach(() => { t = toasts(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { t.off(); delete (window as any).claude; vi.restoreAllMocks(); });

describe('useDefaultsSaver (new-session defaults, Android tier page)', () => {
  const setup = (save: (u: any) => Promise<unknown>) => renderHook(() => {
    const [d, setD] = useState({ model: 'sonnet', skip: false });
    return { d, change: useDefaultsSaver(d, setD, save) };
  });

  it('a rejected save puts the last saved value back and says so once', async () => {
    const { result } = setup(vi.fn().mockRejectedValue(new Error('disk full')));
    await act(async () => { await result.current.change({ model: 'opus' }); });
    expect(result.current.d.model).toBe('sonnet');
    expect(t.got).toEqual(["Couldn't save this setting."]);
  });

  it('an answer of { ok:false } counts as a failure too', async () => {
    const { result } = setup(vi.fn().mockResolvedValue({ ok: false }));
    await act(async () => { await result.current.change({ skip: true }); });
    expect(result.current.d.skip).toBe(false);
    expect(t.got).toHaveLength(1);
  });

  it('a save that works keeps the new value and says nothing', async () => {
    const { result } = setup(vi.fn().mockResolvedValue(undefined));
    await act(async () => { await result.current.change({ model: 'opus' }); });
    expect(result.current.d.model).toBe('opus');
    expect(t.got).toEqual([]);
  });

  it('an older failure that a newer save of the same setting overwrote is not a false alarm', async () => {
    let failFirst!: (e: Error) => void;
    const save = vi.fn()
      .mockImplementationOnce(() => new Promise((_, rej) => { failFirst = rej; }))
      .mockResolvedValueOnce(undefined);
    const { result } = setup(save);
    let first!: Promise<void>; let second!: Promise<void>;
    act(() => { first = result.current.change({ model: 'haiku' }); second = result.current.change({ model: 'opus' }); });
    await act(async () => { await second; failFirst(new Error('late')); await first; });
    expect(result.current.d.model).toBe('opus');
    expect(t.got).toEqual([]);
  });
});

describe('a refused tag / note / flag save (useSessionMeta)', () => {
  const meta = (over: Record<string, unknown>) => {
    (window as any).claude = { session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', flags: {}, supported: true }), ...over }, on: {} };
  };
  it('says so after rolling back when the host answers ok:false', async () => {
    meta({ setTag: vi.fn().mockResolvedValue({ ok: false, error: 'store locked' }) });
    const { result } = renderHook(() => useSessionMeta('s1'));
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.setTag('t1', true));
    await waitFor(() => expect(t.got).toEqual(["Couldn't save this tag change."]));
    expect(result.current.tags.has('t1')).toBe(false);
  });
  it('stays quiet when the host is simply unsupported (the controls already say why) and when the save worked', async () => {
    meta({ setTag: vi.fn().mockResolvedValue({ ok: false, unsupported: true }), setNote: vi.fn().mockResolvedValue({ ok: true }) });
    const { result } = renderHook(() => useSessionMeta('s1'));
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.setNote('hello'));
    act(() => result.current.setTag('t1', true));
    await waitFor(() => expect(result.current.supported).toBe(false)); // the unsupported answer has landed
    expect(t.got).toEqual([]);
  });
  it('says nothing for an answer that arrives after the view closed', async () => {
    let answer!: (v: unknown) => void;
    meta({ setNote: vi.fn(() => new Promise((r) => { answer = r; })) });
    const { result, unmount } = renderHook(() => useSessionMeta('s1'));
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.setNote('x'));
    unmount();
    answer({ ok: false });
    await Promise.resolve(); await Promise.resolve();
    expect(t.got).toEqual([]);
  });
});

describe('tag manager saves (useTagRegistry)', () => {
  beforeEach(() => { __resetTagRegistryForTests(); });
  const tagsApi = (over: Record<string, unknown>) => { (window as any).claude = { tags: { list: vi.fn().mockResolvedValue([]), ...over }, on: {} }; };
  it('create / update / delete that the host refuses each say so', async () => {
    tagsApi({ create: vi.fn().mockResolvedValue({ ok: false, error: 'x' }), update: vi.fn().mockResolvedValue({ ok: false }), delete: vi.fn().mockResolvedValue({ ok: false }) });
    const { result } = renderHook(() => useTagRegistry());
    await act(async () => { await result.current.create('a', 'tag-gray' as any); await result.current.update('1', { label: 'b' }); await result.current.remove('1'); });
    expect(t.got).toEqual(["Couldn't create the tag.", "Couldn't save the tag.", "Couldn't delete the tag."]);
  });
  it('saves that work say nothing', async () => {
    tagsApi({ create: vi.fn().mockResolvedValue({ ok: true, tag: { id: '1' } }), update: vi.fn().mockResolvedValue({ ok: true }), delete: vi.fn().mockResolvedValue({ ok: true }) });
    const { result } = renderHook(() => useTagRegistry());
    await act(async () => { await result.current.create('a', 'tag-gray' as any); await result.current.update('1', { label: 'b' }); await result.current.remove('1'); });
    expect(t.got).toEqual([]);
  });
});
