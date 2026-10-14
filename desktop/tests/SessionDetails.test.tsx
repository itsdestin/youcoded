// @vitest-environment jsdom
// desktop/tests/SessionDetails.test.tsx
//
// Session details' "In your lists" card (close-session-2#CS2-2 "lists", #CS2-5 "follow" +
// "also add the complete toggle here"): Pin to top and Mark complete sit together under their
// own label — not in an unlabelled card that read as part of "Tags" — and Mark complete is
// offered on every Session details surface, not only the close prompt.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SessionDetails } from '../src/renderer/components/tags/SessionDetails';
import type { TagRegistryApi } from '../src/renderer/hooks/useTagRegistry';

afterEach(cleanup);

const registry: TagRegistryApi = {
  tags: [], byId: new Map(), loading: false, error: null,
  reload: () => {}, create: async () => null, update: async () => {}, remove: async () => {},
};

function mount(over: { pinned?: boolean; done?: boolean } = {}) {
  const onPin = vi.fn(), onComplete = vi.fn();
  render(<SessionDetails name="fix chat scroll stick" note="" onNote={() => {}} registry={registry}
    appliedIds={new Set()} onToggleTag={() => {}}
    pin={{ pinned: !!over.pinned, onPin }} complete={{ done: !!over.done, onComplete }} />);
  return { onPin, onComplete };
}

describe('Session details — "In your lists"', () => {
  it('holds Pin to top and Mark complete in one card under its own label, outside Tags', () => {
    mount();
    const card = screen.getByText('In your lists').parentElement!;
    expect(card).toContainElement(screen.getByRole('switch', { name: 'Pin to top' }));
    expect(card).toContainElement(screen.getByRole('switch', { name: 'Mark complete' }));
    expect(screen.getByText('Tags').parentElement).not.toContainElement(screen.getByRole('switch', { name: 'Mark complete' }));
  });

  it('Mark complete shows its state and reports a change; both switches carry their hints', () => {
    const { onComplete, onPin } = mount({ done: true });
    const sw = screen.getByRole('switch', { name: 'Mark complete' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(onComplete).toHaveBeenCalledWith(false);
    expect(onPin).not.toHaveBeenCalled();
    // Destin's wording for both popups (close-session-3#CS3-3; Pin to top says "resumable" since final-review#Q-3).
    expect(screen.getByText('Hides this session from your resumable sessions list')).toBeInTheDocument();
    expect(screen.getByText('Keeps this session at the top of your resumable sessions list')).toBeInTheDocument();
  });
});
