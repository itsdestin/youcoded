// @vitest-environment jsdom
//
// The cursor-following pupils (simplification audit W23): only the curious face
// follows the cursor, so only a curious pose may hold a window pointermove
// listener. Every mascot used to register one for life and bail inside it.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MascotRig, type RigMotion } from '../src/renderer/components/mascot/MascotRig';
import { POSES } from '../src/renderer/components/mascot/mascot-poses';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

type PoseName = Parameters<typeof MascotRig>[0]['pose'];
const curious = (Object.keys(POSES) as PoseName[]).find((p) => POSES[p].face === 'curious')!;
const notCurious = (Object.keys(POSES) as PoseName[]).find((p) => POSES[p].face !== 'curious')!;

function pointermoveListeners(): number {
  const add = vi.mocked(window.addEventListener).mock.calls.filter((c) => c[0] === 'pointermove').length;
  const remove = vi.mocked(window.removeEventListener).mock.calls.filter((c) => c[0] === 'pointermove').length;
  return add - remove;
}

describe('MascotRig cursor tracking', () => {
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
