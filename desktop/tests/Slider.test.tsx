// @vitest-environment jsdom
// The shared slider: a round handle at the end of a fill whose end wraps it.
// WHY (Destin, submit-ticket-5#ST5-5): one slider look everywhere — Appearance's glass
// sliders and Sound's volume used the browser's thin default range.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Slider } from '../src/renderer/components/ui';

describe('Slider', () => {
  it('is a real slider: named, valued, and it reports numbers', () => {
    const onChange = vi.fn();
    render(<Slider aria-label="Volume" aria-valuetext="50%" min={0} max={1} step={0.05} value={0.5} onChange={onChange} />);
    const s = screen.getByRole('slider', { name: 'Volume' });
    expect(s.getAttribute('aria-valuetext')).toBe('50%');
    fireEvent.change(s, { target: { value: '0.75' } });
    expect(onChange).toHaveBeenCalledWith(0.75);
  });

  it('ends the fill half a track past the handle centre, so the fill wraps the handle', () => {
    const { container } = render(<Slider aria-label="Blur" min={0} max={100} value={25} onChange={() => {}} />);
    const [, fill] = [...container.querySelectorAll('[aria-hidden="true"]')] as HTMLElement[];
    const handle = container.querySelector('input + [aria-hidden="true"]') as HTMLElement;
    expect(fill.style.width).toBe('calc(20px + 0.25 * (100% - 20px))');
    expect(handle.style.left).toBe('calc(3px + 0.25 * (100% - 20px))');
    expect(handle.className).toMatch(/rounded-full/);
    expect(fill.className).toMatch(/rounded-full/);
  });
});
