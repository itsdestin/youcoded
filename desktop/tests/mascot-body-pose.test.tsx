// @vitest-environment jsdom
//
// The BODY actually moves.
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
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import { MascotRig, type RigMotion } from '../src/renderer/components/mascot/MascotRig';
import { POSES } from '../src/renderer/components/mascot/mascot-poses';

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
