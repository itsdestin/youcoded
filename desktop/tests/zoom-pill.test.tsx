// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ZoomPill } from '../src/renderer/components/ui/ZoomPill';

afterEach(cleanup);

const base = {
  percent: 100,
  canZoomIn: true,
  canZoomOut: true,
  onZoomIn: vi.fn(),
  onZoomOut: vi.fn(),
  onReset: vi.fn(),
};

describe('ZoomPill', () => {
  it('gives every control an accessible name', () => {
    render(<ZoomPill {...base} loupe={{ on: false, onToggle: vi.fn() }} />);
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /magnif/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /fit/i })).toBeTruthy();
  });

  it('states WHY a control is disabled, never just greys it out', () => {
    render(
      <ZoomPill
        {...base}
        canZoomOut={false}
        canZoomIn={false}
        zoomInDisabledReason="This page can’t be drawn any larger"
      />,
    );
    const out = screen.getByRole('button', { name: /zoom out/i });
    const inn = screen.getByRole('button', { name: /zoom in/i });
    expect(out.hasAttribute('disabled')).toBe(true);
    expect(inn.hasAttribute('disabled')).toBe(true);
    expect(out.getAttribute('data-hint')).toMatch(/already fitted/i);
    expect(inn.getAttribute('data-hint')).toMatch(/can’t be drawn any larger/i);
  });

  it('falls back to a generic reason when the caller gives none', () => {
    render(<ZoomPill {...base} canZoomIn={false} />);
    expect(screen.getByRole('button', { name: /zoom in/i }).getAttribute('data-hint'))
      .toMatch(/largest size/i);
  });

  it('omits the magnifier entirely when no loupe is offered', () => {
    render(<ZoomPill {...base} loupe={null} />);
    expect(screen.queryByRole('button', { name: /magnif/i })).toBeNull();
  });

  it('reports loupe state with aria-pressed', () => {
    const onToggle = vi.fn();
    render(<ZoomPill {...base} loupe={{ on: true, onToggle }} />);
    const btn = screen.getByRole('button', { name: /magnif/i });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalled();
  });

  it('the percentage is the reset control', () => {
    const onReset = vi.fn();
    render(<ZoomPill {...base} percent={240} onReset={onReset} />);
    const label = screen.getByRole('button', { name: /fit/i });
    expect(label.textContent).toContain('240');
    fireEvent.click(label);
    expect(onReset).toHaveBeenCalled();
  });
});
