// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MascotRig } from '../src/renderer/components/mascot/MascotRig';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('rig animation continuity', () => {
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
