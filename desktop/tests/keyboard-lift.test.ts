// How far the messages slide while the Android keyboard glides (state/keyboard-lift.ts, card #213).
import { describe, it, expect } from 'vitest';
import { keyboardContentLift } from '../src/renderer/state/keyboard-lift';

describe('keyboardContentLift', () => {
  it('a short chat does not slide at all (the "Started with" banner stays put)', () => {
    // An empty session: 300 px of content in a 740 px scroller; the keyboard rises 255 px.
    const start = { contentHeight: 300, visibleHeight: 740, scrollTop: 0 };
    for (const lift of [40, 128, 255]) expect(keyboardContentLift(start, lift)).toBe(0);
  });

  it('a long chat at the bottom slides the whole way, so the newest message rides up with the message box', () => {
    const start = { contentHeight: 3000, visibleHeight: 740, scrollTop: 2260 };
    expect(keyboardContentLift(start, 255)).toBe(255);
    expect(keyboardContentLift(start, 100)).toBe(100);
  });

  it('a chat that only starts to overflow slides just the part that will scroll', () => {
    const start = { contentHeight: 600, visibleHeight: 740, scrollTop: 0 };
    // Shortened by 255 → 485 visible, 115 px will scroll.
    expect(keyboardContentLift(start, 255)).toBe(115);
    expect(keyboardContentLift(start, 100)).toBe(0);
  });

  it('closing the keyboard slides back down by what the re-pin will scroll back', () => {
    // Keyboard up: scroller 485 visible, at the bottom of 3000.
    const start = { contentHeight: 3000, visibleHeight: 485, scrollTop: 2515 };
    expect(keyboardContentLift(start, -255)).toBe(-255);
  });
});
