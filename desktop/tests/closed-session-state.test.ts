// R-4 phase 3: the screen forgets a closed chat's "viewed" mark and its pending model switch — in BOTH places App.tsx drops a chat.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { withoutSession, pendingModelAfterClose } from '../src/renderer/state/closed-session-state';

describe('withoutSession', () => {
  it('50 chats viewed then closed leave an empty set', () => {
    let viewed = new Set<string>();
    for (let i = 0; i < 50; i++) viewed = new Set(viewed).add(`c${i}`);
    for (let i = 0; i < 50; i++) viewed = withoutSession(viewed, `c${i}`);
    expect(viewed.size).toBe(0);
  });
  it('keeps the same object when the chat was never in it (no needless redraw)', () => {
    const s = new Set(['a']); expect(withoutSession(s, 'zzz')).toBe(s);
  });
});

describe('pendingModelAfterClose', () => {
  it('ends the switch when the open chat closes', () => expect(pendingModelAfterClose('opus', 'a', 'a')).toBeNull());
  it('leaves a switch in progress alone when a different chat closes', () => expect(pendingModelAfterClose('opus', 'b', 'a')).toBe('opus'));
  it('nothing pending stays nothing', () => expect(pendingModelAfterClose(null, 'a', 'a')).toBeNull());
});

describe('App.tsx uses them on both close paths', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/App.tsx'), 'utf8');
  it('the session:destroyed handler and removeSessionLocally each drop viewed + pending', () => {
    expect(src.split('setViewedSessions((prev) => withoutSession(prev, id))').length - 1).toBe(2);
    expect(src.split('pendingModelAfterClose(prev, id, openSessionIdRef.current)').length - 1).toBe(2);
  });
});
