// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SystemMarker from '../src/renderer/components/SystemMarker';

const marker = { id: 'compact', timestamp: 100, variant: 'compact' as const,
  label: 'Compacted · freed 111,000 tokens', summary: 'The original conversation summary.' };

describe('SystemMarker', () => {
  it('keeps long summary controls wrappable at phone width and preserves expansion semantics', () => {
    render(<SystemMarker marker={marker} />);
    const button = screen.getByRole('button', { name: /view summary/ });
    // Browser geometry regression: this combination was observed red then green
    // at 390px; jsdom cannot measure layout, so pin the responsive behavior here.
    expect(button).toHaveClass('max-sm:min-w-0', 'max-sm:flex-wrap', 'max-sm:whitespace-normal');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(marker.summary)).toBeVisible();
    fireEvent.click(button);
    expect(screen.queryByText(marker.summary)).toBeNull();
  });

  it('does not display a fabricated time when the source timestamp is unknown', () => {
    render(<SystemMarker marker={{ ...marker, timestamp: 0 }} />);
    expect(screen.getByRole('button', { name: /view summary/ }).textContent).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('keeps an ordinary notice readable without inventing a summary action', () => {
    render(<SystemMarker marker={{ ...marker, variant: 'info', label: 'Compaction may have failed', summary: undefined }} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Compaction may have failed/)).toHaveClass('max-sm:whitespace-normal');
  });
});
