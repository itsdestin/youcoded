// Turns a finger drag into a 2048 move. Pure so the thresholds are testable.
import type { Direction } from './twenty-forty-eight';

/** Shortest drag (px) that counts as a swipe — below this it is a tap or a jitter. */
const SWIPE_MIN_PX = 24;

/** The dominant axis wins; a drag too short, or too diagonal to call, is no move. */
export function swipeDirection(dx: number, dy: number): Direction | null {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < SWIPE_MIN_PX) return null;
  // WHY 1.2x: a 45-degree drag is ambiguous; ignoring it beats sliding the wrong way.
  if (ax > ay * 1.2) return dx > 0 ? 'right' : 'left';
  if (ay > ax * 1.2) return dy > 0 ? 'down' : 'up';
  return null;
}
