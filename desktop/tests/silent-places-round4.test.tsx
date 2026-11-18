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

// ── Review fixes ────────────────────────────────────────────────────────────
import { announceFailed } from '../src/renderer/utils/announce';
import { useSaveNotice } from '../src/renderer/hooks/useSaveNotice';

describe('review: a defaults save that answers null is a failure', () => {
  const setup = (save: (u: any) => Promise<unknown>) => renderHook(() => {
    const [d, setD] = useState({ model: 'sonnet' });
    return { d, change: useDefaultsSaver(d, setD, save) };
  });
  it('null (what writeDefaults answers when the write failed) reverts and says so; the merged object is success', async () => {
    const bad = setup(vi.fn().mockResolvedValue(null));
    await act(async () => { await bad.result.current.change({ model: 'opus' }); });
    expect(bad.result.current.d.model).toBe('sonnet');
    expect(t.got).toEqual(["Couldn't save this setting."]);
    t.got.length = 0;
    const good = setup(vi.fn().mockResolvedValue({ model: 'opus' }));
    await act(async () => { await good.result.current.change({ model: 'opus' }); });
    expect(good.result.current.d.model).toBe('opus');
    expect(t.got).toEqual([]);
  });
});

describe('review: "unsupported here" is never a failure notice', () => {
  const unsupported = Object.assign(new Error('remote-unsupported: analytics:get-opt-in'), { code: 'REMOTE_UNSUPPORTED' });
  it('announceFailed stays silent for it and still speaks for a real failure', () => {
    announceFailed('stop this task', unsupported);
    expect(t.got).toEqual([]);
    announceFailed('stop this task', new Error('boom'));
    expect(t.got).toEqual(["Couldn't stop this task."]);
  });
  it('useSaveNotice puts the control back but shows no notice for it', async () => {
    const snap = vi.fn();
    const { result } = renderHook(() => useSaveNotice(true));
    await act(async () => { await result.current.run('k', 'x', () => Promise.reject(unsupported), snap, () => {}); });
    expect(snap).toHaveBeenCalled();
    expect(result.current.notice('k')).toBeNull();
    await act(async () => { await result.current.run('k', 'x', () => Promise.reject(new Error('real')), snap, () => {}); });
    expect(result.current.notice('k')).not.toBeNull();
  });
});

describe('review: newest-wins session meta', () => {
  it('an older failed tag save that arrives after a newer success neither rolls back nor speaks', async () => {
    let failOld!: (v: unknown) => void;
    const setTag = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { failOld = r; }))
      .mockResolvedValueOnce({ ok: true });
    (window as any).claude = { session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', flags: {}, supported: true }), setTag }, on: {} };
    const { result } = renderHook(() => useSessionMeta('s1'));
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.setTag('t1', true));   // first save: will fail late
    act(() => result.current.setTag('t1', false));  // newer save: works
    await waitFor(() => expect(setTag).toHaveBeenCalledTimes(2));
    await act(async () => { failOld({ ok: false, error: 'late' }); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.tags.has('t1')).toBe(false);
    expect(t.got).toEqual([]);
  });
  it('the newest failing save still rolls back and speaks', async () => {
    const setTag = vi.fn().mockResolvedValue({ ok: false, error: 'x' });
    (window as any).claude = { session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', flags: {}, supported: true }), setTag }, on: {} };
    const { result } = renderHook(() => useSessionMeta('s1'));
    await waitFor(() => expect(result.current.supported).toBe(true));
    act(() => result.current.setTag('t1', true));
    await waitFor(() => expect(t.got).toEqual(["Couldn't save this tag change."]));
    expect(result.current.tags.has('t1')).toBe(false);
  });
});

// Round 4 second review: a refused save rolls back to what the server last CONFIRMED, not to the previous unconfirmed screen value.
describe('session meta rolls back to the last confirmed value', () => {
  const open = async (api: Record<string, unknown>) => {
    (window as any).claude = { session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', flags: {}, supported: true }), ...api }, on: {} };
    const hook = renderHook(() => useSessionMeta('s1'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });   // let the first read land
    return hook;
  };
  const deferred = () => { let resolve!: (v: unknown) => void; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

  it('tag: on then off, first fails late, second fails -> shows OFF (what the server holds), not ON', async () => {
    const a = deferred(); const b = deferred();
    const setTag = vi.fn().mockReturnValueOnce(a.p).mockReturnValueOnce(b.p);
    const { result } = await open({ setTag });
    act(() => result.current.setTag('t1', true));
    act(() => result.current.setTag('t1', false));
    await act(async () => { a.resolve({ ok: false, error: 'x' }); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { b.resolve({ ok: false, error: 'x' }); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.tags.has('t1')).toBe(false);
  });
  it('tag: first succeeds (on), second (off) fails -> returns to ON', async () => {
    const setTag = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'x' });
    const { result } = await open({ setTag });
    await act(async () => { result.current.setTag('t1', true); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { result.current.setTag('t1', false); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.tags.has('t1')).toBe(true);
  });
  it('flag: both fail -> back to the confirmed (unset); first ok then second fails -> first value', async () => {
    const a = deferred(); const b = deferred();
    const setFlag = vi.fn().mockReturnValueOnce(a.p).mockReturnValueOnce(b.p);
    const { result } = await open({ setFlag });
    act(() => result.current.setFlag('priority' as any, true));
    act(() => result.current.setFlag('priority' as any, false));
    await act(async () => { a.resolve({ ok: false }); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { b.resolve({ ok: false }); await Promise.resolve(); await Promise.resolve(); });
    expect(!!result.current.flags['priority' as keyof typeof result.current.flags]).toBe(false);

    const setFlag2 = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
    const second = await open({ setFlag: setFlag2 });
    await act(async () => { second.result.current.setFlag('priority' as any, true); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { second.result.current.setFlag('priority' as any, false); await Promise.resolve(); await Promise.resolve(); });
    expect(second.result.current.flags['priority' as keyof typeof second.result.current.flags]).toBe(true);
  });
  it('note: both fail -> back to the confirmed text; first ok then second fails -> first text', async () => {
    const a = deferred(); const b = deferred();
    const setNote = vi.fn().mockReturnValueOnce(a.p).mockReturnValueOnce(b.p);
    const { result } = await open({ setNote });
    act(() => result.current.setNote('one'));
    act(() => result.current.setNote('two'));
    await act(async () => { a.resolve({ ok: false }); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { b.resolve({ ok: false }); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.note).toBe('');

    const setNote2 = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
    const second = await open({ setNote: setNote2 });
    await act(async () => { second.result.current.setNote('one'); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { second.result.current.setNote('two'); await Promise.resolve(); await Promise.resolve(); });
    expect(second.result.current.note).toBe('one');
  });
});

// Review of 12b302b16: only the newest save confirms, and an answer for a conversation we left changes nothing.
describe('session meta acknowledgements are checked for staleness', () => {
  const deferred = () => { let resolve!: (v: unknown) => void; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const open = async (api: Record<string, unknown>, id = { v: 's1' }) => {
    (window as any).claude = { session: { getMeta: vi.fn().mockResolvedValue({ tags: [], note: '', flags: {}, supported: true }), ...api }, on: {} };
    const hook = renderHook(({ sid }) => useSessionMeta(sid), { initialProps: { sid: id.v } });
    await act(async () => { await flush(); });
    return hook;
  };

  it('tag/note/flag: an older ok arriving after a newer ok leaves the NEWER value confirmed (a later failure returns to it)', async () => {
    const a = deferred(); const b = deferred();
    const setTag = vi.fn().mockReturnValueOnce(a.p).mockReturnValueOnce(b.p).mockResolvedValueOnce({ ok: false });
    const setNote = vi.fn().mockReturnValueOnce(a.p).mockReturnValueOnce(b.p).mockResolvedValueOnce({ ok: false });
    const setFlag = vi.fn().mockReturnValueOnce(a.p).mockReturnValueOnce(b.p).mockResolvedValueOnce({ ok: false });
    const { result } = await open({ setTag, setNote, setFlag });
    act(() => { result.current.setTag('t', true); result.current.setNote('one'); result.current.setFlag('priority' as any, true); });
    act(() => { result.current.setTag('t', false); result.current.setNote('two'); result.current.setFlag('priority' as any, false); });
    // newer ok first, then the older ok last
    await act(async () => { b.resolve({ ok: true }); await flush(); });
    await act(async () => { a.resolve({ ok: true }); await flush(); });
    // a third save fails: it must return to the NEWER confirmed value (off / 'two' / off), not the older (on / 'one' / on)
    await act(async () => { result.current.setTag('t', true); result.current.setNote('three'); result.current.setFlag('priority' as any, true); await flush(); });
    expect(result.current.tags.has('t')).toBe(false);
    expect(result.current.note).toBe('two');
    expect(!!(result.current.flags as any).priority).toBe(false);
  });

  it('an answer that lands after switching conversations changes nothing in the new one', async () => {
    const a = deferred();
    const setTag = vi.fn().mockReturnValueOnce(a.p).mockResolvedValueOnce({ ok: false });
    const { result, rerender } = await open({ setTag });
    act(() => result.current.setTag('t', true));            // save made in s1, answer still pending
    rerender({ sid: 's2' });
    await act(async () => { await flush(); });
    await act(async () => { a.resolve({ ok: true }); await flush(); });   // s1's ok arrives while s2 is on screen
    // in s2 the tag was never set; a refused save there must roll back to "off", not to s1's "on"
    await act(async () => { result.current.setTag('t', true); await flush(); });
    expect(result.current.tags.has('t')).toBe(false);
    expect(t.got).toHaveLength(1);   // only s2's own refusal speaks
  });
});
