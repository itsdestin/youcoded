// @vitest-environment jsdom
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
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MascotRig, type RigMotion } from '../src/renderer/components/mascot/MascotRig';

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

describe('a rig that predates a face', () => {
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
