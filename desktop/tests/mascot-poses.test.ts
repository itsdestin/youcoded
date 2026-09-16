import { describe, it, expect } from 'vitest';
import {
  parsePivot, defaultPivot, POSES, stepSpring, isSettled, dragTargets,
  LIMB_IDS,
} from '../src/renderer/components/mascot/mascot-poses';

describe('parsePivot', () => {
  it('parses "x y" and "x,y"', () => {
    expect(parsePivot('18 38')).toEqual({ x: 18, y: 38 });
    expect(parsePivot('18,38')).toEqual({ x: 18, y: 38 });
    expect(parsePivot(' 18.5  38 ')).toEqual({ x: 18.5, y: 38 });
  });
  it('rejects malformed input', () => {
    expect(parsePivot(null)).toBeNull();
    expect(parsePivot('')).toBeNull();
    expect(parsePivot('18')).toBeNull();
    expect(parsePivot('a b')).toBeNull();
  });
});

describe('defaultPivot', () => {
  const bbox = { x: 10, y: 20, width: 8, height: 20 };
  it('limbs pivot at top-center (shoulder/hip — limbs hang down)', () => {
    expect(defaultPivot('rig-arm-left', bbox)).toEqual({ x: 14, y: 20 });
    expect(defaultPivot('rig-leg-right', bbox)).toEqual({ x: 14, y: 20 });
  });
});

describe('POSES', () => {
  it('every pose names only known part ids and a valid face', () => {
    // 'blink' joined the list on 2026-09-04, and it is the only addition a pose
    // may make: the blink SCHEDULER owns a momentary blink, but a pose owns a
    // SUSTAINED closed eye, which is what sleeping is. Every rig already ships
    // a rig-face-blink group, so this costs no theme any new artwork.
    for (const pose of Object.values(POSES)) {
      expect(['idle', 'welcome', 'curious', 'shocked', 'dizzy', 'blink', 'happy', 'shutdown']).toContain(pose.face);
      for (const id of Object.keys(pose.parts)) {
        expect([...LIMB_IDS, 'rig-tail', 'rig-body']).toContain(id);
      }
    }
  });

  // THE BODY CAN MOVE (2026-09-04). Before this, `rig-body` was allowed by the
  // type, accepted in a pose, and then silently DROPPED — applyPose skipped it
  // by name and the spring loop only ever drove limbs. So the promo film's own
  // power-down could not be reproduced by the shipped app on any theme. Sleeping
  // is the first behaviour that needs it, and a pose that declares a body
  // transform nothing applies is worse than one that declares none.
  it('a sleep pose settles the BODY, not just the limbs', () => {
    const sleeps = Object.entries(POSES).filter(([name]) => name.startsWith('sleep'));
    expect(sleeps.length).toBeGreaterThan(0);
    for (const [name, pose] of sleeps) {
      const body = pose.parts['rig-body'];
      expect(body, `${name} must move the body`).toBeTruthy();
      // Downward. Up is flying away, not falling asleep.
      expect(body!.ty!, `${name} settles downward`).toBeGreaterThan(0);
      expect(['shutdown', 'blink'], `${name} closes his eyes`).toContain(pose.face);
    }
  });
  // SIGN-CONVENTION PINS (2026-07-16 workbench): limbs hang down from their
  // pivot, positive = clockwise. These caught a real bug — the original plan
  // sketch had the wave crossing the face.
  it('welcome raises the right arm OUTWARD (negative rotation)', () => {
    expect(POSES.welcome.parts['rig-arm-right']!.rotate!).toBeLessThan(0);
  });
  it('shocked flails both arms OUTWARD (left positive, right negative)', () => {
    expect(POSES.shocked.parts['rig-arm-left']!.rotate!).toBeGreaterThan(0);
    expect(POSES.shocked.parts['rig-arm-right']!.rotate!).toBeLessThan(0);
  });
  it('bottom-peek curls both arms INWARD to grip the edge', () => {
    expect(POSES.peek.parts['rig-arm-left']!.rotate!).toBeLessThan(0);
    expect(POSES.peek.parts['rig-arm-right']!.rotate!).toBeGreaterThan(0);
  });
});

describe('stepSpring', () => {
  it('converges to the target and settles', () => {
    let s = { value: 0, velocity: 0 };
    for (let i = 0; i < 300; i++) s = stepSpring(s, 20, 16);
    expect(s.value).toBeCloseTo(20, 0);
    expect(isSettled(s, 20)).toBe(true);
  });
  it('overshoots on the way (underdamped wobble)', () => {
    let s = { value: 0, velocity: 0 };
    let maxV = 0;
    for (let i = 0; i < 300; i++) { s = stepSpring(s, 20, 16); maxV = Math.max(maxV, s.value); }
    expect(maxV).toBeGreaterThan(20); // the wobble is the feature
  });
  it('clamps huge dt so a paused rAF cannot explode the spring', () => {
    let s = { value: 0, velocity: 0 };
    s = stepSpring(s, 20, 5000);
    expect(Number.isFinite(s.value)).toBe(true);
    expect(Math.abs(s.value)).toBeLessThan(100);
  });
});

describe('dragTargets', () => {
  it('limbs trail behind horizontal motion (drag right → clockwise-positive lag)', () => {
    // Hanging limbs pivot at the top: when the body moves right the tips lag
    // back-LEFT of the pivot, which is a CLOCKWISE (positive) rotation.
    // Pinned after the 2026-07-16 dev test — the original sign read backwards.
    const t = dragTargets(10, 0);
    expect(t['rig-arm-left']).toBeGreaterThan(0);
    expect(t['rig-leg-left']).toBeGreaterThan(0);
  });
  it('is clamped', () => {
    const t = dragTargets(10000, 10000);
    for (const v of Object.values(t)) expect(Math.abs(v)).toBeLessThanOrEqual(65);
  });
  it('zero velocity → zero targets', () => {
    const t = dragTargets(0, 0);
    for (const v of Object.values(t)) expect(v).toBe(0);
  });
});
