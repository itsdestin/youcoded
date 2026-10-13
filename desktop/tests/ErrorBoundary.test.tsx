// @vitest-environment jsdom
// WHY: a render crash has an unknown cause, so the crash screen must be the "we don't know why"
// error (docs/error-message-standards.md shape 2): plain words, Report bug and Diagnose beside
// Try again, and the raw JavaScript message only under Details — never as the sentence.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from '../src/renderer/components/ErrorBoundary';

vi.mock('../src/renderer/components/development/BugReportPopup', () => ({
  BugReportPopup: ({ open, context }: { open: boolean; context?: { error?: string; diagnose?: boolean } }) =>
    open ? <div data-testid="report">{context?.diagnose ? 'diagnose' : 'report'}:{context?.error}</div> : null,
}));

function Boom(): React.ReactElement {
  throw new Error('Cannot read properties of undefined (reading x)');
}

describe('ErrorBoundary crash screen', () => {
  it('says what happened in plain words and keeps the raw message under Details', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary name="Chat"><Boom /></ErrorBoundary>);
    expect(screen.getByText('Chat stopped working')).toBeInTheDocument();
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText(/Cannot read properties/)).toBeInTheDocument();
  });

  it('offers Try again, Report bug and Diagnose, handing the real message to the report', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary name="Chat"><Boom /></ErrorBoundary>);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Diagnose/ }));
    expect(screen.getByTestId('report')).toHaveTextContent('diagnose:Cannot read properties');
  });
});
