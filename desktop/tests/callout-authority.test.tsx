// @vitest-environment jsdom
// desktop/tests/callout-authority.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Callout } from '../src/renderer/components/ui/Callout';

// Guard for K4 — the callout, THE notice box.
//
// Superseded rule (2026-09-25, decisions.md P-2/P-4): a callout used to be
// strictly passive, with no action slot, and a notice with a button had to be a
// K5 status strip. Destin ruled the opposite — every warning/error/info notice
// is this one tinted box, and a notice's own buttons (Try again, Show details,
// Resume…) go INSIDE it, at the right. What this guard now pins is that rule:
// the buttons inside the box, after the text. Its colours and spacing are judged on the
// screenshot review (never pin styling, 2026-11-01); new hand-made tinted boxes are caught by
// the ast-grep rule no-hand-rolled-callout-tint.

afterEach(cleanup);

describe('Callout', () => {
  // Destin, gt-r1#E-2/#E-3: sentence, then Details, then the buttons — in every shape.
  it('puts its buttons below the Details fold, whichever shape it is', () => {
    for (const shape of [{}, { compact: true }, { actionsPlacement: 'below' as const }]) {
      cleanup();
      render(<Callout tone="danger" details="ENOSPC" actions={<button>Try again</button>} {...shape}>body</Callout>);
      const fold = screen.getByText('Details');
      const button = screen.getByRole('button', { name: 'Try again' });
      expect(fold.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING, JSON.stringify(shape)).toBeTruthy();
    }
  });

  it('collapsible: the title is the one visible line and the body opens under it', () => {
    render(<Callout tone="warning" collapsible title="2 conversations not syncing">body</Callout>);
    const summary = screen.getByText('2 conversations not syncing').closest('summary') as HTMLElement;
    expect(summary).not.toBeNull();
    // The arrow is the summary's LAST child — on the right, not the left.
    expect(summary.lastElementChild?.tagName.toLowerCase()).toBe('svg');
    const details = summary.parentElement as HTMLDetailsElement;
    expect(details.tagName).toBe('DETAILS');
    expect(details.open).toBe(false);
  });

  it("a notice's buttons sit INSIDE the box, after the text (at the right)", () => {
    const { container } = render(
      <Callout tone="danger" title="Couldn't sync" actions={<><button>Show details</button><button>Try again</button></>}>
        body
      </Callout>,
    );
    const box = container.firstElementChild as HTMLElement; // the callout's own outer box
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(box.contains(retry), 'the action is inside the tinted box').toBe(true);
    // Text first, buttons after it in the same row — i.e. on the right.
    expect(screen.getByText('body').compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('an optional title sits above the body', () => {
    render(<Callout tone="warning" title="Before scanning:">Download Tailscale first.</Callout>);
    const title = screen.getByText('Before scanning:');
    const body = screen.getByText('Download Tailscale first.');
    expect(title.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
