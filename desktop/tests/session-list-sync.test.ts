// @vitest-environment jsdom
// What a reconnecting screen does with the computer's list of live conversations (one-core sync-fix3).
import { describe, it, expect } from 'vitest';
import { endedSessionIds, withAnnouncedName } from '../src/renderer/state/session-list-sync';

const pills = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'pending-handoff:x', name: 'X' }, { id: 'moved', name: 'M' }];
const keep = (id: string) => id.startsWith('pending-handoff:') || id === 'moved';

describe('pills for conversations that ended while the phone was away', () => {
  it('lists the ones the computer no longer has, and leaves the rest', () => {
    expect(endedSessionIds(pills, [{ id: 'a' }], keep)).toEqual(['b']);
  });
  it('never drops a pending hand-off tab or a conversation another device took over (its gate needs the pill)', () => {
    expect(endedSessionIds(pills, [], keep)).toEqual(['a', 'b']);
  });
  it('treats a reply that is not a list as "no answer", never as "everything ended"', () => {
    expect(endedSessionIds(pills, undefined, keep)).toEqual([]);
    expect(endedSessionIds(pills, { ok: false }, keep)).toEqual([]);
  });
  it('an empty list from the computer ends every ordinary pill (the computer really has none)', () => {
    expect(endedSessionIds([{ id: 'a' }], [], keep)).toEqual(['a']);
  });
});

describe('a replayed announcement of a conversation the screen already has', () => {
  it('carries the new name onto the existing pill', () => {
    const next = withAnnouncedName(pills, { id: 'a', name: 'Renamed' });
    expect(next.find((s) => s.id === 'a')!.name).toBe('Renamed');
    expect(next.find((s) => s.id === 'b')!.name).toBe('B');
  });
  it('returns the same list (no re-render) when the name is the same, absent, or the pill is unknown', () => {
    expect(withAnnouncedName(pills, { id: 'a', name: 'A' })).toBe(pills);
    expect(withAnnouncedName(pills, { id: 'a' })).toBe(pills);
    expect(withAnnouncedName(pills, { id: 'zzz', name: 'N' })).toBe(pills);
  });
});

// The hook itself, mounted (sync-fix3 review).
import { renderHook, act } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { useDropEndedSessionsOnReconnect } from '../src/renderer/state/session-list-sync';
import { REMOTE_RECONNECTED_EVENT } from '../src/renderer/remote-events';

describe('useDropEndedSessionsOnReconnect', () => {
  let list: ReturnType<typeof vi.fn>;
  beforeEach(() => { list = vi.fn(); (window as any).claude = { session: { list } }; });
  const mount = (ids: string[], moved: string[] = []) => {
    const sessionsRef = { current: ids.map((id) => ({ id })) };
    const remove = vi.fn();
    renderHook(() => useDropEndedSessionsOnReconnect(sessionsRef, { current: new Map(moved.map((m) => [m, 1])) }, remove));
    return { sessionsRef, remove };
  };
  const reconnect = async () => { await act(async () => { window.dispatchEvent(new Event(REMOTE_RECONNECTED_EVENT)); await Promise.resolve(); await Promise.resolve(); }); };

  it('drops the pills the computer no longer lists, and keeps hand-off tabs and moved-gate pills', async () => {
    list.mockResolvedValue([{ id: 'a' }]);
    const { remove } = mount(['a', 'b', 'pending-handoff:x', 'm'], ['m']);
    await reconnect();
    expect(remove.mock.calls).toEqual([['b']]);
  });
  it('a failed or non-list reply changes nothing', async () => {
    list.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ ok: false });
    const { remove } = mount(['a']);
    await reconnect(); await reconnect();
    expect(remove).not.toHaveBeenCalled();
  });
  it('a pill that appeared while the computer was still building its answer survives', async () => {
    let answer!: (v: unknown) => void;
    list.mockReturnValue(new Promise((r) => { answer = r; }));
    const { sessionsRef, remove } = mount(['a', 'b']);
    await reconnect();
    sessionsRef.current = [...sessionsRef.current, { id: 'new' }];   // session:created arrives before the reply
    await act(async () => { answer([{ id: 'a' }]); await Promise.resolve(); await Promise.resolve(); });
    expect(remove.mock.calls).toEqual([['b']]);                       // 'new' is alive and is not in the reply: not dropped
  });
});

// App's wiring (App.tsx cannot be mounted, so the call site is pinned by reading it).
describe('App wires the late-join pill rules', () => {
  it('passes its own session list, moved list and local remover to the hook, and uses the announced name', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/App.tsx'), 'utf8');
    expect(src).toContain('useDropEndedSessionsOnReconnect(sessionsRef, movedSessionsRef, (id) => goneRef.current(id))');
    expect(src).toContain('return withAnnouncedName(prev, info)');
  });
});
