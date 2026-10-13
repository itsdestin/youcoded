// Which conversations a phone watches: the one on screen plus the few it looked at last (one-core R5-3).
import { describe, it, expect } from 'vitest';
import { createWatchSet, WATCH_LIMIT } from '../src/renderer/state/watch-set';

describe('the phone\'s watch set', () => {
  it('watches three conversations: the current one and the two before it', () => {
    expect(WATCH_LIMIT).toBe(3);
  });

  it('starts watching a conversation the first time it is touched and says so', () => {
    const set = createWatchSet();
    expect(set.touch('a')).toEqual({ added: true, evicted: [] });
    expect(set.touch('a')).toEqual({ added: false, evicted: [] });
    expect(set.has('a')).toBe(true);
  });

  it('drops the one looked at longest ago when a fourth is opened, and tells the caller to unwatch it', () => {
    const set = createWatchSet();
    set.touch('a'); set.touch('b'); set.touch('c');
    expect(set.touch('d')).toEqual({ added: true, evicted: ['a'] });
    expect(set.ids()).toEqual(['d', 'c', 'b']);
  });

  it('going back to a recent conversation keeps it and drops a different one next time', () => {
    const set = createWatchSet();
    set.touch('a'); set.touch('b'); set.touch('c');
    set.touch('a');                                  // looked at again: now the most recent
    expect(set.touch('d').evicted).toEqual(['b']);   // so b, not a, is the oldest
    expect(set.ids()).toEqual(['d', 'a', 'c']);
  });

  it('forgets an ended conversation without asking anyone to unwatch it', () => {
    const set = createWatchSet();
    set.touch('a'); set.touch('b');
    set.forget('a');
    expect(set.ids()).toEqual(['b']);
    expect(set.touch('c')).toEqual({ added: true, evicted: [] });
  });

  it('is empty after a clear', () => {
    const set = createWatchSet();
    set.touch('a');
    set.clear();
    expect(set.ids()).toEqual([]);
  });
});
