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
