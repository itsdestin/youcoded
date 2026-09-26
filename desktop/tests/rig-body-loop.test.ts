// The mascot's idle body loops moved from CSS keyframes into MascotRig's 30 fps
// update (2026-09-26: smooth CSS loops drew at the panel's full 180 Hz). These
// pin that the motion itself did not change: same keyframe values at the same
// moments, the same ease-in-out, the same periods and origins.
import { describe, it, expect } from 'vitest';
import { bodyLoopAt, easeInOut } from '../src/renderer/components/mascot/rig-body-loop';

const ty = (t: string) => Number(/translateY\(([-\d.]+)%\)/.exec(t)![1]);
const rot = (t: string) => Number(/rotate\(([-\d.]+)deg\)/.exec(t)![1]);
const sc = (t: string) => /scale\(([-\d.]+), ([-\d.]+)\)/.exec(t)!.slice(1).map(Number);

describe('easeInOut is CSS ease-in-out', () => {
  it('passes through its ends and its midpoint, and is symmetric', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 5);
    for (const x of [0.1, 0.25, 0.4]) expect(easeInOut(x) + easeInOut(1 - x)).toBeCloseTo(1, 5);
    // cubic-bezier(0.42,0,0.58,1) at x = 0.25 is ≈ 0.129 (a slow start, not linear 0.25)
    expect(easeInOut(0.25)).toBeCloseTo(0.1291, 3);
  });
});

describe('bodyLoopAt reproduces the old mascot.css keyframes', () => {
  it('breathe: rest at 0 and 4 s, −1.6% (× amp) at 2 s', () => {
    expect(ty(bodyLoopAt('breathe', 0).transform)).toBeCloseTo(0, 3);
    expect(ty(bodyLoopAt('breathe', 2000).transform)).toBeCloseTo(-1.6, 3);
    expect(ty(bodyLoopAt('breathe', 2000, 1.5).transform)).toBeCloseTo(-2.4, 3);
    expect(ty(bodyLoopAt('breathe', 4000).transform)).toBeCloseTo(0, 3);
    expect(bodyLoopAt('breathe', 0).origin).toBe('');
  });
  it('hyper breathes on a 1.8 s period', () => {
    expect(ty(bodyLoopAt('breathe', 900, 1, 1800).transform)).toBeCloseTo(-1.6, 3);
  });
  it('bounce: its four keyframes at 28%, 55% and 72% of 1.15 s, about 50% 85%', () => {
    const at = (p: number) => bodyLoopAt('bounce', p * 1150).transform;
    expect(ty(at(0.28))).toBeCloseTo(-3, 2); expect(sc(at(0.28))).toEqual([0.985, 1.02]);
    expect(ty(at(0.55))).toBeCloseTo(0, 2); expect(sc(at(0.55))).toEqual([1.015, 0.985]);
    expect(ty(at(0.72))).toBeCloseTo(-0.9, 2);
    expect(bodyLoopAt('bounce', 0).origin).toBe('50% 85%');
  });
  it('float, sleep and dizzy peak at half period with the old values and origins', () => {
    expect(ty(bodyLoopAt('float', 2900).transform)).toBeCloseTo(-2.8, 3);
    expect(rot(bodyLoopAt('float', 2900).transform)).toBeCloseTo(1.2, 3);
    expect(rot(bodyLoopAt('float', 0).transform)).toBeCloseTo(-1.2, 3);
    expect(bodyLoopAt('float', 0).origin).toBe('50% 60%');
    expect(ty(bodyLoopAt('sleep', 3250).transform)).toBeCloseTo(-2.2, 3);
    expect(sc(bodyLoopAt('sleep', 3250).transform)).toEqual([1.012, 0.988]);
    expect(rot(bodyLoopAt('dizzy', 750).transform)).toBeCloseTo(2.6, 3);
    expect(bodyLoopAt('dizzy', 0).origin).toBe('50% 85%');
  });
  it('eases between keyframes rather than moving linearly', () => {
    // A quarter of the way into breathe's first half: eased ≈ 12.9% of the way, not 25%.
    expect(ty(bodyLoopAt('breathe', 500).transform)).toBeCloseTo(-1.6 * 0.1291, 2);
  });
});
