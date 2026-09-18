// @vitest-environment jsdom
//
// MascotRig — the SVG rig that draws the buddy: poses, faces, the springs that
// move between them, and the cursor-following pupils.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MascotRig, type RigMotion } from '../src/renderer/components/mascot/MascotRig';
import { POSES } from '../src/renderer/components/mascot/mascot-poses';

describe('rig animation continuity', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('keeps the animated SVG mounted across pose changes', () => {
    const motionRef = { current: { vx: 0, vy: 0, dragging: false } };
    const view = render(<MascotRig svgUrl={null} pose="peek-left" motionRef={motionRef} reducedEffects={false} />);
    const svg = view.container.querySelector('svg');
    expect(svg).not.toBeNull();
    view.rerender(<MascotRig svgUrl={null} pose="idle" motionRef={motionRef} reducedEffects={false} />);
    expect(view.container.querySelector('svg')).toBe(svg);
  });

  it('does not recreate the animated SVG when a docked buddy blinks', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const motionRef = { current: { vx: 0, vy: 0, dragging: false } };
    const view = render(<MascotRig svgUrl={null} pose="peek-left" motionRef={motionRef} reducedEffects={false} />);
    const svg = view.container.querySelector('svg');
    expect(svg).not.toBeNull();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(view.container.querySelector('svg')).toBe(svg);
    expect(view.container.querySelector<SVGGElement>('#rig-face-blink')!.style.display).toBe('');
    act(() => { vi.advanceTimersByTime(120); });
    expect(view.container.querySelector('svg')).toBe(svg);
    expect(view.container.querySelector<SVGGElement>('#rig-face-blink')!.style.display).toBe('none');
  });
});

// ── The body actually moves ─────────────────────────────────────────────────
//
// WHAT THIS IS GUARDING, in plain terms: the buddy is one box with a face on
// it, four little limbs, and — until 2026-09-04 — no way for a pose to move the
// box. `rig-body` was allowed by the type and accepted in a pose, and then
// silently thrown away: `applyPose` skipped it by name and the spring loop only
// ever drove limbs. Every way of falling asleep starts with the body settling,
// so without this the buddy could only ever fall asleep from the elbows down.
//
// The sibling test in mascot-poses.test.ts checks the pose TABLE says the right
// thing. This one checks something reads it — a table nobody applies is exactly
// the kind of test that passes while the feature does nothing.
describe('body pose', () => {
  afterEach(cleanup);

  function mountLive(pose: Parameters<typeof MascotRig>[0]['pose']) {
    const motionRef = { current: { vx: 0, vy: 0, dragging: false } as RigMotion };
    const r = render(<MascotRig svgUrl={null} pose={pose} motionRef={motionRef} reducedEffects={false} />);
    const rerender = (next: Parameters<typeof MascotRig>[0]['pose']) =>
      r.rerender(<MascotRig svgUrl={null} pose={next} motionRef={motionRef} reducedEffects={false} />);
    return { container: r.container, rerender };
  }

  function mount(pose: Parameters<typeof MascotRig>[0]['pose']) {
    const motionRef = { current: { vx: 0, vy: 0, dragging: false } as RigMotion };
    // reducedEffects: springs and idle loops off, so the only thing writing a
    // transform is the pose itself — which is the thing under test.
    const r = render(
      <MascotRig svgUrl={null} pose={pose} motionRef={motionRef} reducedEffects />,
    );
    return r.container;
  }

  const bodyOf = (c: HTMLElement) => c.querySelector<SVGGElement>('#rig-body');
  const rootOf = (c: HTMLElement) => c.querySelector<SVGGElement>('#rig-root');

  describe('a pose that moves the body', () => {
    it('writes the body transform the pose asks for', async () => {
      const c = mount('sleep');
      await waitFor(() => expect(bodyOf(c)).toBeTruthy());
      const want = POSES.sleep.parts['rig-body']!;
      await waitFor(() => {
        const t = bodyOf(c)!.style.transform;
        expect(t).toContain(`translate(0px, ${want.ty}px)`);
        expect(t).toContain(`scale(${want.scale})`);
      });
    });

    it('leaves the body alone for a pose that does not ask', async () => {
      // Every pose that shipped before this existed must be byte-for-byte
      // unchanged: no rotation, no shift, no shrink, full brightness.
      const c = mount('idle');
      await waitFor(() => expect(bodyOf(c)).toBeTruthy());
      await waitFor(() => {
        expect(bodyOf(c)!.style.transform).toBe('translate(0px, 0px) rotate(0deg) scale(1)');
      });
    });

    it('holds the eyes shut for the whole sleep, not for a blink', async () => {
      const c = mount('sleep');
      await waitFor(() => expect(c.querySelector('#rig-face-shutdown')).toBeTruthy());
      await waitFor(() => {
        expect(c.querySelector<SVGGElement>('#rig-face-shutdown')!.style.display).toBe('');
        expect(c.querySelector<SVGGElement>('#rig-face-welcome')!.style.display).toBe('none');
      });
    });
  });

  describe('a pose change animates instead of teleporting', () => {
    // THE DEFECT, in plain terms: React rebuilds the mascot's host element when
    // the pose changes, and the code used to throw away every spring at that
    // moment and rebuild each one ALREADY SITTING AT its new target. So no pose
    // change in the whole app ever animated — the limbs arrived instantly while
    // the body eased underneath them. Destin, 2026-09-05: "the animation to
    // transition between states can be improved."
    //
    // The assertion is deliberately "not there YET" rather than a frame count:
    // the springs are physics on a timer, and a test that counts frames is a test
    // about vitest's clock. What matters is that the instant the pose changes,
    // the limb has NOT already arrived.
    const tyOf = (c: HTMLElement) => {
      const t = c.querySelector<SVGGElement>('#rig-arm-left')!.style.transform;
      return Number(/translate\([^,]+,\s*(-?[\d.]+)px/.exec(t)?.[1] ?? NaN);
    };

    const transformOf = (c: HTMLElement) =>
      c.querySelector<SVGGElement>('#rig-arm-left')!.style.transform;

    // The clock is DRIVEN, not waited on. The first version of this waited for the
    // idle loop to write a transform different from the one it started with — but
    // the arm starts parked at its idle target, so the only thing that can change
    // that string is the idle sway, and a sway that rounds to the same two decimals
    // never changes it. It passed here and hung for the full 4s timeout on CI's
    // Linux and Windows runners. Advancing the timers ourselves removes the
    // question: the loop has ticked because we ticked it.
    const settle = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

    it('does not put the limb at its destination on the frame the pose changes', async () => {
      vi.useFakeTimers();
      try {
        const { container, rerender } = mountLive('idle');
        await settle(300);
        expect(container.querySelector('#rig-arm-left')).toBeTruthy();

        const before = tyOf(container);
        const after = POSES['sleep'].parts['rig-arm-left']!.ty!;
        expect(before).not.toBe(after);   // the two poses must actually differ, or this proves nothing

        act(() => { rerender('sleep'); });
        // Whatever it is, it is not the destination — it is still where the springs
        // were holding it. Before the fix this read `after` exactly.
        expect(tyOf(container)).not.toBe(after);

        // …and it does arrive, so "not there yet" can never be satisfied by a limb
        // that simply never moves.
        await settle(2000);
        expect(tyOf(container)).toBeCloseTo(after, 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('and gets there in the end', async () => {
      vi.useFakeTimers();
      try {
        const { container, rerender } = mountLive('idle');
        await settle(300);
        act(() => { rerender('sleep'); });
        await settle(2000);
        expect(tyOf(container)).toBeCloseTo(POSES['sleep'].parts['rig-arm-left']!.ty!, 1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// ── A rig that predates a face ──────────────────────────────────────────────
//
// A theme drawn before these faces existed must never end up with NO FACE.
//
// WHAT THIS IS GUARDING, in plain terms: `happy` and `shut-down` are new
// (2026-09-05), and the four community characters — Halftone Dimension, Kuromi
// Dreamer, Strawberry Kitty, Golden Sunbreak — have not been redrawn yet. The
// mascot shows a face by hiding all of them and un-hiding the one that matches,
// so asking for a face a rig does not have hid EVERY face: a blank head on
// somebody's installed theme, arriving in an app update they did not ask for.
// The buddy is also on the permission screen, the moved screen, in Settings and
// in the mini-game, so it would not be a small blank head either.

// A rig from before the new faces: the contract's originals, nothing more.
const OLD_RIG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -5 30 30"><g id="rig-root">
  <g id="rig-arm-left" data-pivot="2.5 9"><rect x="1" y="9" width="3" height="4"/></g>
  <g id="rig-arm-right" data-pivot="21.5 9"><rect x="20" y="9" width="3" height="4"/></g>
  <g id="rig-body">
    <g id="rig-face-idle"><rect x="8" y="9" width="8" height="2"/></g>
    <g id="rig-face-welcome" style="display:none"><rect x="8" y="9" width="8" height="2"/></g>
    <g id="rig-face-blink" style="display:none"><rect x="8" y="9" width="8" height="1"/></g>
  </g>
</g></svg>`;

describe('a rig that predates a face', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ text: () => Promise.resolve(OLD_RIG) })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  function mount(pose: Parameters<typeof MascotRig>[0]['pose']) {
    const motionRef = { current: { vx: 0, vy: 0, dragging: false } as RigMotion };
    return render(
      <MascotRig svgUrl="theme-asset://old-rig.svg" pose={pose} motionRef={motionRef} reducedEffects />,
    ).container;
  }

  const shown = (c: HTMLElement) =>
    [...c.querySelectorAll<SVGGElement>('[id^="rig-face-"]')]
      .filter((el) => el.style.display !== 'none')
      .map((el) => el.id);

  it('still shows a face when the pose asks for one it has never had', async () => {
    const c = mount('sleep');   // wants `shutdown`, which this rig has no group for
    await waitFor(() => expect(c.querySelector('#rig-face-welcome')).toBeTruthy());
    await waitFor(() => expect(shown(c)).toHaveLength(1));
  });

  it('falls back to the NEAREST face it has, not just any face', async () => {
    // Sleeping is closed eyes, and `blink` is the closed-eye face every rig in
    // the contract already ships. Landing on `welcome` would leave him wide
    // awake with his arms tucked under him.
    const c = mount('sleep');
    await waitFor(() => expect(c.querySelector('#rig-face-blink')).toBeTruthy());
    await waitFor(() => expect(shown(c)).toEqual(['rig-face-blink']));
  });

  it('leaves a face the rig DOES have exactly as it was', async () => {
    const c = mount('curious');   // no curious group either; nearest is welcome
    await waitFor(() => expect(c.querySelector('#rig-face-welcome')).toBeTruthy());
    await waitFor(() => expect(shown(c)).toEqual(['rig-face-welcome']));
  });
});

// ── Cursor-following pupils ─────────────────────────────────────────────────
// Only the curious face follows the cursor, so only a curious pose may hold a
// window pointermove listener. Every mascot used to register one for life and
// bail inside it.
describe('MascotRig cursor tracking', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  type PoseName = Parameters<typeof MascotRig>[0]['pose'];
  const curious = (Object.keys(POSES) as PoseName[]).find((p) => POSES[p].face === 'curious')!;
  const notCurious = (Object.keys(POSES) as PoseName[]).find((p) => POSES[p].face !== 'curious')!;

  function pointermoveListeners(): number {
    const add = vi.mocked(window.addEventListener).mock.calls.filter((c) => c[0] === 'pointermove').length;
    const remove = vi.mocked(window.removeEventListener).mock.calls.filter((c) => c[0] === 'pointermove').length;
    return add - remove;
  }

  it('listens for pointermove only while the pose has the curious face', () => {
    vi.spyOn(window, 'addEventListener');
    vi.spyOn(window, 'removeEventListener');
    const motionRef = { current: { vx: 0, vy: 0, dragging: false } as RigMotion };
    const draw = (pose: PoseName) => <MascotRig svgUrl={null} pose={pose} motionRef={motionRef} reducedEffects={false} />;

    const r = render(draw(notCurious));
    expect(pointermoveListeners()).toBe(0);

    r.rerender(draw(curious));
    expect(pointermoveListeners()).toBe(1);

    r.rerender(draw(notCurious));
    expect(pointermoveListeners()).toBe(0);

    r.rerender(draw(curious));
    expect(pointermoveListeners()).toBe(1);
    r.unmount();
    expect(pointermoveListeners()).toBe(0);
  });
});
