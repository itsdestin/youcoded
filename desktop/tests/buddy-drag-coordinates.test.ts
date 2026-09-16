import { describe, it, expect, vi } from 'vitest';
import { BuddyWindowManager, type BuddyWindowManagerDeps } from '../src/main/buddy-window-manager';
import { parseCaption, type BuddyRole } from '../src/shared/buddy-caption';
import { MASCOT_SIZE, CHAT_SIZE, BAR_SIZE } from '../src/main/buddy-bar-geometry';

/**
 * Dragging the buddy, in the coordinates the renderer can actually see.
 *
 * WHAT IS BEING PROTECTED, in plain terms. To drag the buddy the app has to
 * know where the user's finger is. A web page can ask for that two ways:
 * where the finger is INSIDE this window, or where it is ON THE SCREEN. The
 * second one is a lie on a Wayland Linux desktop — the page is told its window
 * sits at 0,0 forever, no matter where the desktop has actually put it (probe
 * Round 8: three real moves to 500,300 / 900,600 / 200,150, and the page read
 * 0 every time).
 *
 * So the app used to be told the finger had moved backwards by exactly the
 * distance the window had just travelled forwards. Every frame undid the one
 * before it and the buddy bounced between two points as fast as the pointer
 * fired — "the buddy flickers all over the screen when dragging" (Destin,
 * 2026-09-04). This suite drives a real drag through a model of the desktop
 * and pins that it tracks the finger instead.
 */

const DISPLAY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1080 },
};

vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => DISPLAY, getDisplayMatching: () => DISPLAY },
  BrowserWindow: class {},
}));

const SIZE: Record<BuddyRole, { width: number; height: number }> = {
  mascot: MASCOT_SIZE, chat: CHAT_SIZE, bar: BAR_SIZE,
};

/**
 * A buddy window plus the piece of desktop that moves it.
 *
 * `caption: true` models Wayland-with-the-helper — setPosition does NOTHING
 * (which is what really happens, silently) and renaming the window is what
 * moves it. `caption: false` models Windows/macOS/X11, where setPosition works.
 * Either way `at` is the window's TRUE position, which is the thing the
 * renderer is not allowed to know.
 */
function fakeWin(role: BuddyRole, x: number, y: number, caption: boolean) {
  const at = { x, y };
  return {
    at,
    setPosition: vi.fn((nx: number, ny: number) => { if (!caption) { at.x = nx; at.y = ny; } }),
    setTitle: vi.fn((t: string) => {
      if (!caption) return;
      const p = parseCaption(t);           // the helper, running inside KWin
      if (p) { at.x = p.x; at.y = p.y; }
    }),
    getBounds: vi.fn(() => ({ ...at, ...SIZE[role] })),
    getPosition: vi.fn(() => [at.x, at.y]),
    isDestroyed: () => false,
    isVisible: () => false,
    show: vi.fn(), showInactive: vi.fn(), hide: vi.fn(), focus: vi.fn(),
    moveTop: vi.fn(), destroy: vi.fn(), setIgnoreMouseEvents: vi.fn(), on: vi.fn(),
    webContents: { send: vi.fn(), on: vi.fn(), once: vi.fn(), id: 7 },
  };
}

function harness(caption: boolean, start: { x: number; y: number }) {
  const wins: Partial<Record<BuddyRole, ReturnType<typeof fakeWin>>> = {};
  const deps: BuddyWindowManagerDeps = {
    createBuddyWindow: (variant, o) => {
      const w = fakeWin(variant, o.x, o.y, caption);
      wins[variant] = w;
      return w as unknown as Electron.BrowserWindow;
    },
    getPersistedPosition: () => start,
    setPersistedPosition: vi.fn(),
    getPersistedDock: () => null,
    setPersistedDock: vi.fn(),
    registry: { subscribe: vi.fn(), unsubscribe: vi.fn() } as never,
    mainWindow: () => null,
    onStatusChanged: vi.fn(),
    captionChannelLive: caption ? () => true : undefined,
  };
  const manager = new BuddyWindowManager(deps);
  manager.show();
  return { manager, mascot: () => wins.mascot!.at };
}

/**
 * One drag, driven the way the desktop really drives it.
 *
 * The finger walks a straight line. On every frame we work out what the WINDOW
 * would report — the finger's position minus wherever the window currently is,
 * because that is the only coordinate a window ever gets honestly — and hand
 * the app how far that has strayed from the pixel the finger grabbed.
 */
function drag(h: ReturnType<typeof harness>, grab: { x: number; y: number }, path: Array<{ x: number; y: number }>) {
  const seen: Array<{ x: number; y: number }> = [];
  for (const finger of path) {
    const here = h.mascot();
    h.manager.moveMascotFromPointer(finger.x - here.x - grab.x, finger.y - here.y - grab.y);
    seen.push({ ...h.mascot() });
  }
  return seen;
}

const START = { x: 400, y: 300 };
const GRAB = { x: 40, y: 40 };
// 20 frames of a slow, straight drag down and to the right.
const PATH = Array.from({ length: 20 }, (_, i) => ({
  x: START.x + GRAB.x + i * 7,
  y: START.y + GRAB.y + i * 5,
}));

describe.each([
  ['Wayland, moved by the helper', true],
  ['Windows / macOS / X11, moved by the OS', false],
])('a drag on %s', (_label, caption) => {
  it('puts the buddy exactly under the finger on every single frame', () => {
    const h = harness(caption, START);
    const seen = drag(h, GRAB, PATH);
    expect(seen).toEqual(PATH.map((f) => ({ x: f.x - GRAB.x, y: f.y - GRAB.y })));
  });

  it('never moves backwards while the finger moves forwards', () => {
    // The flicker, stated as a property. A window that bounces between two
    // points fails this on frame 2, whatever the endpoints happen to be.
    const h = harness(caption, START);
    const seen = drag(h, GRAB, PATH);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].x).toBeGreaterThan(seen[i - 1].x);
      expect(seen[i].y).toBeGreaterThan(seen[i - 1].y);
    }
  });

  it('holds still when the finger holds still', () => {
    const h = harness(caption, START);
    const still = Array.from({ length: 8 }, () => ({ x: START.x + GRAB.x, y: START.y + GRAB.y }));
    const seen = drag(h, GRAB, still);
    expect(new Set(seen.map((p) => `${p.x},${p.y}`)).size).toBe(1);
  });
});

describe('moveMascotFromPointer', () => {
  it('refuses a cursor offset that is not a number, and does not move him', () => {
    // main.ts forwards the renderer's payload unvalidated, and a NaN here would
    // be added to a real position and park him in the corner permanently.
    const h = harness(true, START);
    h.manager.moveMascotFromPointer(Number.NaN, 10);
    h.manager.moveMascotFromPointer(10, Number.POSITIVE_INFINITY);
    expect(h.mascot()).toEqual(START);
  });
});
