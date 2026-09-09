// @vitest-environment jsdom
//
// What the buddy's window sends while you drag him.
//
// WHAT IS BEING GUARDED, in plain terms: the page that draws the buddy is told
// two things about the user's finger — where it is INSIDE the buddy's own
// window, and where it is ON THE SCREEN. Only the first is true on a Wayland
// Linux desktop; the second is computed from a window position the page is
// never told about, which is frozen at 0,0 (probe Round 8). Sending the second
// one made the buddy bounce between two points every frame ("flickers all over
// the screen", Destin 2026-09-04). This file pins that ONLY window-local
// numbers leave the renderer — the screen ones can be nonsense and the drag is
// unaffected.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ activeTheme: null, reducedEffects: true }),
}));
vi.mock('../src/renderer/hooks/useThemeMascot', () => ({ useThemeMascot: () => null }));
vi.mock('../src/renderer/hooks/useAnyAttentionNeeded', () => ({ useAnyAttentionNeeded: () => false }));
vi.mock('../src/renderer/components/mascot/MascotRig', () => ({
  MascotRig: () => (
    <svg data-testid="rig">
      <path data-testid="default-rig-paint" fill="var(--rig-accent, #f0a828)" />
      <path data-testid="authored-rig-paint" fill="#2d6a4f" />
    </svg>
  ),
}));

import { BuddyMascot } from '../src/renderer/components/buddy/BuddyMascot';

type Move = { localDx: number; localDy: number };
let sent: Move[] = [];
let rafQueue: FrameRequestCallback[] = [];

/** Run whatever the component scheduled for the next frame. */
const nextFrame = () => { const q = rafQueue; rafQueue = []; for (const fn of q) fn(0); };

beforeEach(() => {
  sent = [];
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { rafQueue.push(fn); return rafQueue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => { rafQueue = []; });
  (window as unknown as { claude: unknown }).claude = {
    buddy: {
      moveMascot: (m: Move) => { sent.push(m); },
      dragEnded: vi.fn(),
      toggleChat: vi.fn(),
      onMascotState: () => () => {},
    },
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mascotEl() {
  const { container } = render(<BuddyMascot />);
  const el = container.querySelector('.mascot-wrap') as HTMLElement;
  // jsdom has no pointer capture; the component guards it, but be explicit.
  el.setPointerCapture = () => {};
  el.releasePointerCapture = () => {};
  return el;
}

/**
 * One drag frame. `client` is where the finger is inside the buddy's window —
 * the honest number. `screen` is what the page would report as a screen
 * position, which each test sets to whatever it likes to prove it is unused.
 */
function move(el: HTMLElement, client: { x: number; y: number }, screenAt: { x: number; y: number }) {
  fireEvent.pointerMove(el, { pointerId: 1, clientX: client.x, clientY: client.y, screenX: screenAt.x, screenY: screenAt.y });
  nextFrame();
}

describe('the buddy rig tint', () => {
  it('maps theme tokens on the shared mascot wrapper so rig and peek hands inherit them', () => {
    const el = mascotEl();

    expect(el.style.getPropertyValue('--rig-accent')).toBe('var(--accent)');
    expect(el.style.getPropertyValue('--rig-on-accent')).toBe('var(--on-accent)');
    expect(el.style.getPropertyValue('--rig-line')).toBe('var(--fg)');
    // Default rig fallbacks inherit the wrapper variable; authored fills stay literal.
    expect(el.querySelector('[data-testid="default-rig-paint"]')?.getAttribute('fill')).toBe('var(--rig-accent, #f0a828)');
    expect(el.querySelector('[data-testid="authored-rig-paint"]')?.getAttribute('fill')).toBe('#2d6a4f');
  });
});

describe('the drag payload', () => {
  it('is how far the finger has moved from the pixel it grabbed, inside the window', () => {
    const el = mascotEl();
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 40, clientY: 40, screenX: 440, screenY: 340 });
    move(el, { x: 60, y: 55 }, { x: 460, y: 355 });
    expect(sent).toEqual([{ localDx: 20, localDy: 15 }]);
  });

  it('ignores the screen position completely, however wrong it is', () => {
    // The Wayland case: the page believes its window never moves, so the screen
    // numbers it reports walk backwards while the finger walks forwards.
    const el = mascotEl();
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 40, clientY: 40, screenX: 0, screenY: 0 });
    move(el, { x: 70, y: 70 }, { x: -900, y: -900 });
    move(el, { x: 90, y: 90 }, { x: 12345, y: 12345 });
    expect(sent).toEqual([{ localDx: 30, localDy: 30 }, { localDx: 50, localDy: 50 }]);
  });

  it('sends one move per frame, the latest, however fast the pointer fires', () => {
    const el = mascotEl();
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 40, clientY: 40, screenX: 0, screenY: 0 });
    for (const x of [50, 60, 70, 80]) {
      fireEvent.pointerMove(el, { pointerId: 1, clientX: x, clientY: 40, screenX: 0, screenY: 0 });
    }
    nextFrame();
    expect(sent).toEqual([{ localDx: 40, localDy: 0 }]);
  });

  it('still knows a drag from a click when the window is following the finger', () => {
    // Once the window tracks the cursor, the finger stops moving RELATIVE to
    // the window — so the raw in-window numbers stop changing even though the
    // hand is still travelling. The component adds back what it has asked main
    // to move; without that it would read every long drag as a click and open
    // the chat on release instead.
    const el = mascotEl();
    const toggleChat = vi.fn();
    (window as unknown as { claude: { buddy: { toggleChat: unknown } } }).claude.buddy.toggleChat = toggleChat;
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 40, clientY: 40, screenX: 0, screenY: 0 });
    // Frame 1 breaks the click threshold; from here the window keeps up, so the
    // finger sits a constant 12px past the grab point for the rest of the drag.
    for (let i = 0; i < 10; i++) move(el, { x: 52, y: 40 }, { x: 0, y: 0 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 52, clientY: 40, screenX: 0, screenY: 0 });
    expect(toggleChat).not.toHaveBeenCalled();
    expect(sent.length).toBeGreaterThan(5);
  });
});
