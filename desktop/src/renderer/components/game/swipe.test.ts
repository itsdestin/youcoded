import { describe, it, expect } from 'vitest';
import { swipeDirection } from './swipe';

describe('swipeDirection', () => {
  it('reads the dominant axis', () => {
    expect(swipeDirection(60, 5)).toBe('right');
    expect(swipeDirection(-60, 10)).toBe('left');
    expect(swipeDirection(4, 70)).toBe('down');
    expect(swipeDirection(-3, -70)).toBe('up');
  });
  it('ignores taps and diagonals', () => {
    expect(swipeDirection(8, 6)).toBeNull();
    expect(swipeDirection(50, 50)).toBeNull();
  });
});
