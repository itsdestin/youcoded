// @vitest-environment jsdom
import React from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';

// Pins how a docked buddy treats "something needs attention". Attention (the
// notification pose) and the dock (pushed separately by main) are two inputs,
// and main can leave the dock at 'peeking' while attention is on — the
// notification broadcast lands before main's pop-out, and a buddy dragged onto
// an edge while something already needs you stays tucked in.
//
// 2026-09-11: both poses drew at once ("I can see both the docked pose and the
// notification pose overlapping"). The first fix let attention win, which made
// the buddy impossible to tuck away while a notification was pending. 2026-09-16
// (Destin: "i want it to dock still and drop the notification pose when
// docked"): tucked in wins, and the notification pose shows only while he's out.

const state = vi.hoisted(() => ({ attention: false, poses: [] as string[] }));
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ theme: 'light', activeTheme: null, reducedEffects: false }),
}));
vi.mock('../src/renderer/hooks/useThemeMascot', () => ({ useThemeMascot: () => null }));
vi.mock('../src/renderer/hooks/useAnyAttentionNeeded', () => ({ useAnyAttentionNeeded: () => state.attention }));
// The real rig still renders (the grip mittens need it); this only records the
// pose it was asked to draw, which nothing in the DOM exposes.
vi.mock('../src/renderer/components/mascot/MascotRig', async (importActual) => {
  const actual = await importActual<typeof import('../src/renderer/components/mascot/MascotRig')>();
  const Real = actual.MascotRig;
  return {
    ...actual,
    MascotRig: (props: React.ComponentProps<typeof Real>) => {
      state.poses.push(props.pose);
      return <Real {...props} />;
    },
  };
});
import { BuddyMascot, type MascotDockState } from '../src/renderer/components/buddy/BuddyMascot';

// jsdom has no layout, so getBBox is missing and PeekHands would never draw its
// mittens — which would make "no mittens" pass for the wrong reason. A fake box
// lets the grip render exactly as it does in the app.
const realGetBBox = (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox;
// The mascot learns its dock state the way it does in the app: main pushes
// buddy:mascot-state and the component subscribes through window.claude.buddy.
// This fake keeps the subscription so a test can play main's part (until
// 2026-09-16 tests fed the dock through a prop that only a deleted one-window
// host ever used; this is the path the real buddy takes).
const bridge: { push: ((s: MascotDockState) => void) | null } = { push: null };
const win = window as unknown as { claude?: unknown };
const realClaude = win.claude;
beforeAll(() => {
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox =
    () => ({ x: 0, y: 0, width: 4, height: 4 }) as DOMRect;
  win.claude = {
    buddy: {
      onMascotState: (cb: (s: MascotDockState) => void) => {
        bridge.push = cb;
        return () => { if (bridge.push === cb) bridge.push = null; };
      },
    },
  };
});
afterAll(() => {
  (SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox = realGetBBox;
  win.claude = realClaude;
});
afterEach(() => { cleanup(); state.attention = false; state.poses = []; });

/** Main pushes a dock state to the mounted mascot. */
const dock = (mode: MascotDockState['mode'], edge: string | null) => {
  expect(bridge.push, 'the mascot did not subscribe to buddy:mascot-state').not.toBeNull();
  act(() => { bridge.push!({ mode, edge }); });
};
const sink = (c: HTMLElement) => c.querySelector<HTMLElement>('.mascot-sink')!;
const lastPose = () => state.poses[state.poses.length - 1];
const bouncing = (c: HTMLElement) => c.querySelector('.mascot-bounce') !== null;
// The edge-pinned grip mittens are the only aria-hidden children of the wrapper.
const mittens = (c: HTMLElement) => c.querySelectorAll('.mascot-wrap > [aria-hidden="true"]');

describe('a docked buddy that needs attention', () => {
  it('stays tucked into a side edge and drops the notification pose', async () => {
    state.attention = true;
    const view = render(<BuddyMascot />);
    dock('peeking', 'right');
    expect(sink(view.container).dataset.dockMode).toBe('peeking');
    expect(lastPose()).toBe('peek-right');
    expect(bouncing(view.container)).toBe(false);
    await vi.waitFor(() => expect(mittens(view.container)).toHaveLength(2));
  });

  it('stays tucked into a top or bottom edge too', () => {
    state.attention = true;
    const view = render(<BuddyMascot />);
    dock('peeking', 'bottom');
    expect(sink(view.container).dataset.dockMode).toBe('peeking');
    expect(lastPose()).toBe('peek');
    expect(bouncing(view.container)).toBe(false);
  });

  it('shows the notification pose once main pops him out of the edge', () => {
    state.attention = true;
    const view = render(<BuddyMascot />);
    dock('peeking', 'left');
    expect(lastPose()).toBe('peek-left');
    dock('docked', 'left');
    expect(lastPose()).toBe('shocked');
    expect(bouncing(view.container)).toBe(true);
    expect(mittens(view.container)).toHaveLength(0);
  });

  it('shows the notification pose while hovered out, and drops it on tucking back', () => {
    state.attention = true;
    const view = render(<BuddyMascot />);
    dock('peeking', 'left');
    const wrap = view.container.querySelector('.mascot-wrap')!;
    fireEvent.pointerEnter(wrap);
    expect(sink(view.container).dataset.dockMode).toBe('free');
    expect(lastPose()).toBe('shocked');
    fireEvent.pointerLeave(wrap);
    expect(sink(view.container).dataset.dockMode).toBe('peeking');
    expect(lastPose()).toBe('peek-left');
  });

  it('shows the notification pose when free', () => {
    state.attention = true;
    const view = render(<BuddyMascot />);
    dock('free', null);
    expect(lastPose()).toBe('shocked');
    expect(bouncing(view.container)).toBe(true);
  });
});
