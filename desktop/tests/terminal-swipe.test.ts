import { describe, it, expect } from 'vitest';
import { swipeAction } from '../src/renderer/components/terminal-swipe';

// A swipe in terminal view scrolls whatever actually holds the conversation: xterm's history in
// Claude Code's normal mode, Claude Code's own view (via wheel reports) in its fullscreen mode.
const normal = { alternate: false, mouseTracking: false, cols: 40, rows: 30 };
const fullscreen = { alternate: true, mouseTracking: true, cols: 40, rows: 30 };

describe('swipeAction', () => {
  it('scrolls xterm\'s own history in the normal display mode', () => {
    expect(swipeAction(-3, normal)).toEqual({ kind: 'scroll-history', lines: -3 });
  });

  it('in fullscreen, a finger moving down sends wheel-up reports (older), one per line', () => {
    expect(swipeAction(-2, fullscreen)).toEqual({ kind: 'send', data: '\x1b[<64;20;10M\x1b[<64;20;10M' });
  });

  it('in fullscreen, a finger moving up sends wheel-down reports (newer)', () => {
    expect(swipeAction(1, fullscreen)).toEqual({ kind: 'send', data: '\x1b[<65;20;10M' });
  });

  it('caps a fast fling so it cannot flood the program', () => {
    const a = swipeAction(-500, fullscreen);
    expect(a.kind === 'send' && a.data.split('\x1b').length - 1).toBe(10);
  });

  it('falls back to xterm history on an alternate screen that never asked for the mouse', () => {
    expect(swipeAction(2, { ...fullscreen, mouseTracking: false })).toEqual({ kind: 'scroll-history', lines: 2 });
  });
});
