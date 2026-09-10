// @vitest-environment jsdom
// tooltip-primitive.test.tsx — the decisions behind the app's own hover hint,
// pinned so a later session cannot quietly undo one of them.
//
// Every number and shape here is an ANSWER from the questions deck
// `app-themed-tooltips-questions` (2026-09-10), not a default:
//
//   Q-3 long-press   a hint must be reachable with no pointer at all, because
//                    the Android app runs this same renderer and Destin drives
//                    this machine by touchscreen.
//   Q-4 match-today  the deck kept the OS's full second over the under-half-
//                    second I recommended; trying it live, Destin corrected his
//                    own answer to "a smidge faster" (800 ms) and asked for a
//                    short wait plus a fade between neighbours instead of the
//                    instant hand-off. Do not shorten either further.
//
// The no-extra-DOM guard is not from the deck: it is what makes Q-2's cost
// estimate hold. The 2026-09-01 investigation priced this work on every swap
// turning an attribute into a WRAPPER, which can perturb flex/grid in dense
// rows like the status bar. Cloning the child instead is why the status bar
// cannot shift, and a future rewrite that reintroduces a wrapper would silently
// reintroduce that whole risk.
//
// jsdom has no layout, so nothing here proves what a browser PAINTS — position
// and clamping belong to anchor-position.ts and were checked in the real app.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { Tooltip } from '../src/renderer/components/ui/Tooltip';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const shown = (t: string) => screen.queryByText(t) !== null;

/**
 * Date must be faked alongside the timers, and every test must start on a clock
 * strictly LATER than the one before it.
 *
 * The warm window is module-level (it belongs to the app, not to one hint) and
 * is compared against `Date.now()`. Faking only the timers leaves `Date.now()`
 * real, so warmth from an earlier test never expires; faking Date but restarting
 * each test at the real wall clock is worse, because a test that advanced the
 * clock by a second leaves the NEXT test starting a second in its past. Stepping
 * an hour per test makes the order of the file irrelevant.
 */
let clock = Date.now();
const useTimers = () => {
  clock += 3_600_000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: clock });
};

/** A real pointer. jsdom's fireEvent does not set pointerType on its own, and
 *  the whole hover/press split turns on it. */
const mouse = { pointerType: 'mouse' } as const;
const finger = { pointerType: 'touch' } as const;

describe('Q-4 — the hint waits as long as the OS bubble did', () => {
  it('shows nothing until the pointer has rested the full wait', () => {
    useTimers();
    render(<Tooltip text="Settings"><button>x</button></Tooltip>);
    fireEvent.pointerEnter(screen.getByRole('button'), mouse);

    act(() => { vi.advanceTimersByTime(799); });
    expect(shown('Settings')).toBe(false);

    act(() => { vi.advanceTimersByTime(1); });
    expect(shown('Settings')).toBe(true);
  });

  it('leaving before the second is up shows nothing at all', () => {
    useTimers();
    render(<Tooltip text="Settings"><button>x</button></Tooltip>);
    const b = screen.getByRole('button');
    fireEvent.pointerEnter(b, mouse);
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerLeave(b, mouse);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(shown('Settings')).toBe(false);
  });

  it('a neighbour opens on a short wait, not instantly, once the row is warm', () => {
    useTimers();
    render(
      <>
        <Tooltip text="Minimize"><button>a</button></Tooltip>
        <Tooltip text="Maximize"><button>b</button></Tooltip>
      </>,
    );
    const [a, b] = screen.getAllByRole('button');

    fireEvent.pointerEnter(a, mouse);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(shown('Minimize')).toBe(true);

    fireEvent.pointerLeave(a, mouse);
    fireEvent.pointerEnter(b, mouse);
    // Not instant — an instant hand-off teleports the bubble along the row, one
    // hard cut per chip, which is what Destin rejected on the live deck.
    expect(shown('Maximize')).toBe(false);
    act(() => { vi.advanceTimersByTime(130); });
    expect(shown('Maximize')).toBe(true);
  });

  it('a pointer that never opened one does not warm the next', () => {
    useTimers();
    render(
      <>
        <Tooltip text="Minimize"><button>a</button></Tooltip>
        <Tooltip text="Maximize"><button>b</button></Tooltip>
      </>,
    );
    const [a, b] = screen.getAllByRole('button');
    // The warm window is app-wide and outlives one component, so let any
    // warmth left by an earlier hint expire before measuring.
    act(() => { vi.advanceTimersByTime(1000); });

    fireEvent.pointerEnter(a, mouse);
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerLeave(a, mouse);
    fireEvent.pointerEnter(b, mouse);
    act(() => { vi.advanceTimersByTime(130); });
    expect(shown('Maximize')).toBe(false);
  });

  it('warmth expires, so a hint hovered much later waits its full second again', () => {
    useTimers();
    render(
      <>
        <Tooltip text="Minimize"><button>a</button></Tooltip>
        <Tooltip text="Maximize"><button>b</button></Tooltip>
      </>,
    );
    const [a, b] = screen.getAllByRole('button');
    fireEvent.pointerEnter(a, mouse);
    act(() => { vi.advanceTimersByTime(1000); });
    fireEvent.pointerLeave(a, mouse);

    // Long enough after the row was last touched that this is a fresh ask.
    act(() => { vi.advanceTimersByTime(1000); });
    fireEvent.pointerEnter(b, mouse);
    act(() => { vi.advanceTimersByTime(130); });
    expect(shown('Maximize'), 'warmth expired, so the short neighbour wait must not apply').toBe(false);
    act(() => { vi.advanceTimersByTime(800); });
    expect(shown('Maximize')).toBe(true);
  });
});

describe('Q-3 — a finger can reach the hint', () => {
  it('press and hold opens it', () => {
    useTimers();
    render(<Tooltip text="Session Files"><button>x</button></Tooltip>);
    fireEvent.pointerDown(screen.getByRole('button'), finger);
    act(() => { vi.advanceTimersByTime(450); });
    expect(shown('Session Files')).toBe(true);
  });

  it('a press that travels is a scroll, and opens nothing', () => {
    useTimers();
    render(<Tooltip text="Session Files"><button>x</button></Tooltip>);
    const b = screen.getByRole('button');
    fireEvent.pointerDown(b, { ...finger, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(b, { ...finger, clientX: 0, clientY: 40 });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(shown('Session Files')).toBe(false);
  });

  it('the replayed mouse events a tap produces do not open it', () => {
    useTimers();
    render(<Tooltip text="Session Files"><button>x</button></Tooltip>);
    const b = screen.getByRole('button');
    // After a touch the browser replays the whole mouse sequence. Opening on
    // those would make a plain tap flash a hint the user never asked for.
    fireEvent.pointerEnter(b, finger);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(shown('Session Files')).toBe(false);
  });
});

describe('the swap cannot move anything on screen', () => {
  it('adds no element of its own around an ordinary control', () => {
    const { container } = render(
      <div>
        <Tooltip text="Settings"><button className="gear">x</button></Tooltip>
      </div>,
    );
    const row = container.firstElementChild!;
    expect(row.childElementCount).toBe(1);
    expect(row.firstElementChild!.tagName).toBe('BUTTON');
    expect(row.firstElementChild!.className).toBe('gear');
  });

  it('wraps only a DISABLED control, which fires no pointer events of its own', () => {
    const { container } = render(
      <div>
        <Tooltip text="At least one theme must stay in the cycle">
          <button disabled>x</button>
        </Tooltip>
      </div>,
    );
    expect(container.firstElementChild!.firstElementChild!.tagName).toBe('SPAN');
  });
});

describe('the hint still reaches a screen reader', () => {
  it('names a control that has no words of its own', () => {
    render(<Tooltip text="Minimize"><button><svg /></button></Tooltip>);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Minimize');
  });

  it('only DESCRIBES a control that already reads as something', () => {
    render(<Tooltip text="Click to cycle theme"><button>Midnight</button></Tooltip>);
    const b = screen.getByRole('button');
    expect(b.getAttribute('aria-label')).toBe(null);
  });

  it('leaves an existing name alone', () => {
    render(<Tooltip text="Projects"><button aria-label="Open Projects"><svg /></button></Tooltip>);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Open Projects');
  });
});

describe('a hint with nothing to say says nothing', () => {
  it('renders no bubble for empty text', () => {
    useTimers();
    const { container } = render(<Tooltip text=""><button>x</button></Tooltip>);
    fireEvent.pointerEnter(screen.getByRole('button'), mouse);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(container.ownerDocument.querySelector('[role="tooltip"]')).toBe(null);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(null);
  });
});
