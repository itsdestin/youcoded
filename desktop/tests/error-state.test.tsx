// @vitest-environment jsdom
// Pins the widened <ErrorState> (audit E-10, unit A task A6).
//
// WHY this test exists: ErrorState used to be a discriminated union — `recoverable`
// carried message + onRetry, `general` carried title + explainer + onReportBug +
// onDiagnose — so an app-side fault that is BOTH worth retrying and worth reporting
// could not be expressed. Widening it risks two regressions, and both are pinned here:
//
//   1. The five existing general-mode sites must not shift. They render Report bug
//      (secondary) then Diagnose with the assistant (primary), in that order.
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
import { Callout } from '../src/renderer/components/ui/Callout';

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
    expect(names).toEqual(['Report bug', 'Diagnose with the assistant']);
    // Diagnose stays the FILLED action and Report bug the outline one. Assert the
    // actual variant classes, not merely that they differ: "they differ" also holds
    // when the emphasis is swapped, which is exactly the regression this guards.
    expect(screen.getByRole('button', { name: 'Diagnose with the assistant' }).className)
      .toContain('bg-accent');
    expect(screen.getByRole('button', { name: 'Report bug' }).className)
      .toMatch(/(^| )border-edge-strong( |$)/); // outlined (secondary) button — round 2, 2026-09-28
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
    // Destin, batch 1 deck (E-1c): "switch retry/bug positions" — Retry, the primary, sits
    // last, at the right-hand end of the row.
    expect(names).toEqual(['Report bug', 'Retry']);
    expect(screen.getByRole('button', { name: 'Retry' }).className).toContain('bg-accent');
    expect(screen.getByRole('button', { name: 'Report bug' }).className).toMatch(/(^| )border-edge-strong( |$)/); // outlined (secondary) button — round 2, 2026-09-28
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Report bug' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onReportBug).toHaveBeenCalledTimes(1);
  });

  it('orders three actions the same way every time, with Retry last', () => {
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
      .toEqual(['Report bug', 'Diagnose with the assistant', 'Retry']);
  });

  it('renders only the actions it was given', () => {
    render(<ErrorState title="Gone" explainer="No idea." onReportBug={() => {}} />);
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Report bug']);
  });
});

describe('ErrorState — where the buttons sit (G-28)', () => {
  it('puts its actions on the right, never at the bottom left', () => {
    // Destin, 2026-09-10: "buttons should either be full modal width or on the
    // righthand side." A filled button at the bottom left reads as stray.
    const { container } = render(
      <ErrorState title="Setup didn’t finish" explainer="No network." onRetry={() => {}} onReportBug={() => {}} />,
    );
    const row = container.querySelector('button')!.parentElement!;
    expect(row.className).toContain('justify-end');
  });

  it('keeps a one-line error’s action inline with its text', () => {
    // The other permitted placement: the action belongs to that line, on its right —
    // the buttons' row sits beside the words in the same line of the notice box.
    const { container } = render(<ErrorState message="Could not read the file." onRetry={() => {}} />);
    const row = container.querySelector('button')!.parentElement!;
    expect(row.className).toContain('ml-auto'); // pushed to the right-hand end
    expect(row.parentElement!.textContent).toContain('Could not read the file.');
    expect(row.parentElement!.className).toContain('flex'); // same line as the words
  });
});

describe('ErrorState — it IS the notice box (error-notices-1)', () => {
  // WHY this guard (2026-10-12): ErrorState was a neutral grey box with a red dot
  // ("Option C") while the design guide made every error the one red-tinted notice
  // box. The two drifted for weeks because nothing tied them together: new screens
  // followed the component, not the guide. These pins compare ErrorState with the
  // shared notice box itself, so the two cannot drift again — change the box and
  // every error follows; hand-draw a box here and this fails.
  const outer = (el: React.ReactElement) => {
    const { container, unmount } = render(el);
    const box = container.firstElementChild as HTMLElement;
    const out = { tag: box.tagName, className: box.className };
    unmount();
    return out;
  };

  it('a one-line error draws the danger notice box, buttons inside it', () => {
    const err = outer(<ErrorState message="Could not read the file." onRetry={() => {}} />);
    const box = outer(<Callout tone="danger" actions={<button>x</button>}>y</Callout>);
    expect(err).toEqual(box);
  });

  it('an inline error draws the slim one-line notice box', () => {
    const err = outer(<ErrorState variant="inline" message="Could not read the file." onRetry={() => {}} />);
    const box = outer(<Callout tone="danger" compact actions={<button>x</button>}>y</Callout>);
    expect(err).toEqual(box);
  });

  it('a general error draws the notice box with its buttons on their own line', () => {
    const err = outer(<ErrorState title="Gone" explainer="No idea." onReportBug={() => {}} />);
    const box = outer(<Callout tone="danger" title="t" actionsPlacement="below" actions={<button>x</button>}>y</Callout>);
    expect(err).toEqual(box);
  });

  it('keeps announcing itself, and paints nothing red but the box', () => {
    const { container } = render(<ErrorState title="Gone" explainer="No idea." onReportBug={() => {}} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.getAttribute('role')).toBe('alert');
    // No dot, no red words: the guide allows colour in the box's tint and border only.
    expect(container.querySelector('[class*="bg-destructive"]:not([role="alert"])')).toBeNull();
    expect(container.querySelector('[class*="text-destructive"]')).toBeNull();
  });

  it('puts the caller’s spacing on the box itself', () => {
    const { container } = render(<ErrorState className="mt-2" message="x" onRetry={() => {}} />);
    expect((container.firstElementChild as HTMLElement).className).toContain('mt-2');
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
