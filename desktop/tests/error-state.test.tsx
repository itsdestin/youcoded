// @vitest-environment jsdom
// Pins the widened <ErrorState> (audit E-10, unit A task A6).
//
// WHY this test exists: ErrorState used to be a discriminated union — `recoverable`
// carried message + onRetry, `general` carried title + explainer + onReportBug +
// onDiagnose — so an app-side fault that is BOTH worth retrying and worth reporting
// could not be expressed. Widening it risks two regressions, and both are pinned here:
//
//   1. The five existing general-mode sites must not shift. They render Report bug
//      (secondary) then Diagnose with Claude (primary), in that order.
//   2. The type must still refuse a dead-end error (no action) and a silent one
//      (no text). Those two are @ts-expect-error pins rather than runtime assertions,
//      because a runtime test only catches the dead end someone remembered to write —
//      the type fires on code nobody tested. `tsconfig.tests.json` includes tests/,
//      and scripts/verify.sh type-checks it, so a pin that stops being an error fails
//      the build.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ErrorState } from '../src/renderer/components/ui/states';

afterEach(cleanup);

describe('ErrorState — the shapes that already ship', () => {
  it('renders a specific message with Retry as the primary action', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Could not read the file." onRetry={onRetry} />);
    expect(screen.getByText('Could not read the file.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps the general pair in its shipped order and emphasis', () => {
    render(
      <ErrorState
        mode="general"
        title="Something went wrong"
        explainer="We could not tell what caused this."
        onReportBug={() => {}}
        onDiagnose={() => {}}
      />,
    );
    const names = screen.getAllByRole('button').map(b => b.textContent);
    expect(names).toEqual(['Report bug', 'Diagnose with Claude']);
    // Diagnose stays the FILLED action and Report bug the outline one. Assert the
    // actual variant classes, not merely that they differ: "they differ" also holds
    // when the emphasis is swapped, which is exactly the regression this guards.
    expect(screen.getByRole('button', { name: 'Diagnose with Claude' }).className)
      .toContain('bg-accent');
    expect(screen.getByRole('button', { name: 'Report bug' }).className)
      .toContain('border-edge-dim');
  });
});

describe('ErrorState — what the widening adds', () => {
  it('lets one error offer both a retry and a report', () => {
    const onRetry = vi.fn();
    const onReportBug = vi.fn();
    render(
      <ErrorState
        title="Saving failed"
        explainer="The change was not written."
        onRetry={onRetry}
        onReportBug={onReportBug}
      />,
    );
    const names = screen.getAllByRole('button').map(b => b.textContent);
    expect(names).toEqual(['Retry', 'Report bug']);
    expect(screen.getByRole('button', { name: 'Retry' }).className).toContain('bg-accent');
    expect(screen.getByRole('button', { name: 'Report bug' }).className).toContain('border-edge-dim');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Report bug' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onReportBug).toHaveBeenCalledTimes(1);
  });

  it('orders three actions the same way every time, with Retry leading', () => {
    render(
      <ErrorState
        title="Sync failed"
        explainer="We could not tell what caused this."
        onRetry={() => {}}
        onReportBug={() => {}}
        onDiagnose={() => {}}
      />,
    );
    expect(screen.getAllByRole('button').map(b => b.textContent))
      .toEqual(['Retry', 'Report bug', 'Diagnose with Claude']);
  });

  it('renders only the actions it was given', () => {
    render(<ErrorState title="Gone" explainer="No idea." onReportBug={() => {}} />);
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Report bug']);
  });
});

describe('ErrorState — the refusals', () => {
  it('refuses an error with no action, and an error with no text', () => {
    // These two never render; they exist so `tsc` fails if the type loosens.
    // An error with no action is a dead end the user cannot act on, and an error
    // with no text says nothing — both are what docs/error-message-standards.md
    // exists to prevent.
    const deadEnd = () => (
      // @ts-expect-error an error with no action is a dead end
      <ErrorState message="Fetch failed" />
    );
    const silent = () => (
      // @ts-expect-error an error with no text says nothing
      <ErrorState onRetry={() => {}} />
    );
    const bothTexts = () => (
      // @ts-expect-error a specific message and a general title are different errors
      <ErrorState message="Fetch failed" title="Something went wrong" explainer="x" onRetry={() => {}} />
    );
    expect([deadEnd, silent, bothTexts]).toHaveLength(3);
  });
});
