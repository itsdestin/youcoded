// @vitest-environment jsdom
// DocumentTabs: a tab that cannot close for a moment says why, instead of a silent ✕.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DocumentTabs } from '../src/renderer/components/ui/DocumentTabs';

describe('DocumentTabs', () => {
  it('closes a tab from its ✕', () => {
    const onClose = vi.fn();
    render(<DocumentTabs label="Open" tabs={[{ id: 'a', label: 'Plan' }]} activeId="a" onSelect={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Plan' }));
    expect(onClose).toHaveBeenCalledWith('a');
  });

  it('a tab with a close note shows it and does not close', () => {
    const onClose = vi.fn();
    render(<DocumentTabs label="Open" tabs={[{ id: 'a', label: 'Plan', closeNote: 'Saving a copy…' }]} activeId="a" onSelect={() => {}} onClose={onClose} />);
    const x = screen.getByRole('button', { name: 'Close Plan: Saving a copy…' });
    expect(x).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(x);
    expect(onClose).not.toHaveBeenCalled();
  });
});
