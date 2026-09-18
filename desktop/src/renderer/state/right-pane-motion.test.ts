// The right-hand pane's open / close / switch table. See right-pane-motion.ts for
// the one idea; every case here is a way it fails SILENTLY in the app — room
// reserved forever, a pane gone that should be on screen, contents wiped mid-exit.
import { describe, it, expect } from 'vitest';
import {
  paneMotionReducer as step, PANE_IDLE, paneIsPresent, paneReserveWidth, paneContentWidth,
  type PaneMotion, type PaneMotionEvent,
} from './right-pane-motion';

const run = (...events: PaneMotionEvent[]): PaneMotion => events.reduce(step, PANE_IDLE);
const want = (kind: 'drawer' | 'game' | null): PaneMotionEvent => ({ type: 'want', kind });
const DRAWER = 'var(--drawer-width, 480px)';
const GAME = 'var(--game-pane-width, 420px)';

describe('open and close', () => {
  it('opens at once: the room is reserved FIRST and the pane glides into it', () => {
    const m = run(want('drawer'));
    expect(m).toEqual({ shown: 'drawer', closing: false, from: null });
    expect(paneReserveWidth(m)).toBe(DRAWER);
  });

  it('a close keeps the pane RENDERED and its room RESERVED until the view says it has left', () => {
    const m = run(want('drawer'), want(null));
    expect(m).toEqual({ shown: 'drawer', closing: true, from: null });
    expect(paneIsPresent(m)).toBe(true);           // the frame's cut-out must not move yet
    expect(paneReserveWidth(m)).toBe(DRAWER);      // and the chat must not widen yet
    expect(run(want('drawer'), want(null), { type: 'exited' })).toEqual(PANE_IDLE);
  });

  it('INTERRUPTED: reopening mid-close keeps the same pane and clears closing, so the view reverses', () => {
    const m = run(want('game'), want(null), want('game'));
    expect(m).toEqual({ shown: 'game', closing: false, from: null });
  });

  it('a late "exited" from a close that was since interrupted removes nothing', () => {
    const m = run(want('game'), want(null), want('game'), { type: 'exited' });
    expect(m.shown).toBe('game');
  });

  it('closing twice, or closing nothing, changes nothing', () => {
    const once = run(want('drawer'), want(null));
    expect(step(once, want(null))).toBe(once);
    expect(step(PANE_IDLE, want(null))).toBe(PANE_IDLE);
  });
});

describe('switching between the two differently sized panes', () => {
  it('shows the NEW pane at once and reserves the WIDER of the two until the glide ends', () => {
    const m = run(want('drawer'), want('game'));
    expect(m).toEqual({ shown: 'game', closing: false, from: 'drawer' });
    expect(paneReserveWidth(m)).toBe(`max(${DRAWER}, ${GAME})`);
    // Its CONTENT is laid out at its own width from the first frame — never at
    // the reservation, or the board would lay out wide and snap narrow at the end.
    expect(paneContentWidth(m.shown!)).toBe(GAME);
  });

  it('settling releases the extra room — the chat re-wraps once, at the end', () => {
    const m = run(want('drawer'), want('game'), { type: 'settled' });
    expect(m).toEqual({ shown: 'game', closing: false, from: null });
    expect(paneReserveWidth(m)).toBe(GAME);
  });

  it('INTERRUPTED: switching back mid-glide leaves from the pane that is on screen now', () => {
    const m = run(want('drawer'), want('game'), want('drawer'));
    expect(m).toEqual({ shown: 'drawer', closing: false, from: 'game' });
  });

  it('a close mid-switch abandons the switch and closes what is on screen', () => {
    const m = run(want('drawer'), want('game'), want(null));
    expect(m).toEqual({ shown: 'game', closing: true, from: null });
  });

  it('switching while the other pane is still closing opens the new one over it', () => {
    const m = run(want('drawer'), want(null), want('game'));
    expect(m).toEqual({ shown: 'game', closing: false, from: 'drawer' });
  });

  it('asking for the pane already shown is a no-op, and a stray "settled" is too', () => {
    const open = run(want('game'));
    expect(step(open, want('game'))).toBe(open);
    expect(step(open, { type: 'settled' })).toBe(open);
  });
});

describe('nothing can stay reserved forever', () => {
  it('every reachable state returns to idle by close -> exited', () => {
    const states = [
      run(want('drawer')), run(want('game')), run(want('drawer'), want('game')),
      run(want('drawer'), want(null)), run(want('drawer'), want('game'), want(null)),
    ];
    for (const s of states) expect(step(step(s, want(null)), { type: 'exited' })).toEqual(PANE_IDLE);
  });
});
