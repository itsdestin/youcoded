// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HandoffFreshnessInline } from '../src/renderer/components/HandoffFreshnessInline';

afterEach(cleanup);

const callbacks = () => ({ onRetry: vi.fn(), onContinue: vi.fn() });

describe('HandoffFreshnessInline', () => {
  it('keeps the saved conversation visible and shows only waiting text above the composer', () => {
    const actions = callbacks();
    render(<><div>Saved conversation message</div><HandoffFreshnessInline phase="waiting" {...actions} /><textarea aria-label="Message your assistant" /></>);
    expect(screen.getByText('Saved conversation message')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Still syncing recent messages, this may take a moment.');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Conversation preview')).toBeNull();
    expect(screen.getByRole('status').compareDocumentPosition(screen.getByRole('textbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers retry or explicit continuation when the check is incomplete', () => {
    const actions = callbacks();
    render(<HandoffFreshnessInline phase="incomplete" {...actions} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This conversation may have newer messages on your other computer.');
    const textRow = screen.getByText('This conversation may have newer messages on your other computer.').parentElement!;
    const continueButton = screen.getByRole('button', { name: 'Continue with these messages' });
    const retryButton = screen.getByRole('button', { name: 'Try again' });
    expect(textRow.contains(continueButton)).toBe(true);
    expect(textRow.contains(retryButton)).toBe(true);
    expect(continueButton.nextElementSibling).toBe(retryButton);
    expect(textRow.className).toContain('flex-wrap');
    expect(continueButton.parentElement?.className).toContain('flex-nowrap');
    expect(alert.closest('.handoff-freshness-toast')?.className).toContain('inset-x-3');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(actions.onRetry).toHaveBeenCalledOnce();
    expect(actions.onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with these messages' }));
    expect(actions.onContinue).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Leave it' })).toBeNull();
  });

  it('renders no warning after confirmation', () => {
    const actions = callbacks();
    const { container } = render(<HandoffFreshnessInline phase="confirmed" {...actions} />);
    expect(container.textContent).toBe('');
  });
});
