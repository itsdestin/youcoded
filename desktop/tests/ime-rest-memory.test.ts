// The keyboard's announced-versus-real height (state/ime-rest-memory.ts): Samsung's keyboard on a Z Flip7 announced
// 284 when it started to slide and came to rest at 255, so the message box overshot and fell back. The page learns
// the pair and aims right the next time, and a wrong memory can never leave the box under the keyboard.
import { describe, it, expect } from 'vitest';
import { createImeRestMemory } from '../src/renderer/state/ime-rest-memory';

function store() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('keyboard rest-height memory', () => {
  it('aims at the announced height when nothing is known', () => {
    const mem = createImeRestMemory(store());
    expect(mem.announce(255)).toBe(255);
    expect(mem.rest(255)).toBe(255);
  });

  it('after one overshoot, the next open aims at the real height straight away', () => {
    const mem = createImeRestMemory(store());
    expect(mem.announce(284)).toBe(284); // first time: cannot know
    mem.announce(255);                   // Android corrects its announcement during the slide
    expect(mem.rest(255)).toBe(255);
    mem.announce(0);                     // closed
    expect(mem.announce(284)).toBe(255); // learned
  });

  it('remembers across app restarts', () => {
    const s = store();
    const a = createImeRestMemory(s);
    a.announce(284); a.rest(255); a.announce(0);
    expect(createImeRestMemory(s).announce(284)).toBe(255);
  });

  it('a wrong memory is corrected by the resting height and then forgotten', () => {
    const mem = createImeRestMemory(store());
    mem.announce(284); mem.rest(255); mem.announce(0);
    expect(mem.announce(284)).toBe(255);
    // This time the keyboard really is 284 tall (another layout): the rest height lifts the box to it.
    expect(mem.rest(284)).toBe(284);
    mem.announce(0);
    expect(mem.announce(284)).toBe(284);
  });

  it('works with no storage at all', () => {
    const mem = createImeRestMemory(null);
    mem.announce(284); mem.rest(255); mem.announce(0);
    expect(mem.announce(284)).toBe(255);
  });
});
