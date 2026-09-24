// @vitest-environment jsdom
// The approval screen is where a person decides what a page may reach, so the
// two things pinned here are the two ways it could quietly lie: an address that
// reads as somebody else's website (design review 1, finding 6), and an Allow
// that failed while the screen said nothing (finding 11 — on a computer with no
// keychain the secrets store refuses by design and NO approval is recorded).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { PageApproval } from '../src/renderer/components/pages/page-connections';
import type { PageApproveResult, PageSummary } from '../src/shared/pages-types';

afterEach(() => { cleanup(); delete (window as { claude?: unknown }).claude; });

const page = (connections: PageSummary['connections']): PageSummary => ({
  id: 'personal:weather', name: 'Weather', description: '', icon: 'page',
  home: { kind: 'personal' }, pinned: false, updatedAt: '', htmlStamp: 1, connections,
});

function withBridge(approve: (id: string, keys: Record<string, string>) => Promise<PageApproveResult>) {
  (window as unknown as { claude: unknown }).claude = { pages: { approve } };
}

describe('the approval screen', () => {
  it('emphasises the website that would receive the request', () => {
    render(<PageApproval page={page([{ id: 'p', kind: 'public', address: 'api.openweathermap.org.evil.example', approved: false }])} onNotNow={() => {}} />);
    // The address is still written out in full, and the part that decides who
    // is reached is the part marked.
    expect(screen.getByText(/Read public information from/)).toHaveTextContent('api.openweathermap.org.evil.example');
    expect(document.querySelector('[data-page-address]')?.getAttribute('data-page-address')).toBe('evil.example');
    // Emphasis is the whole mechanism here, so it is pinned rather than
    // assumed: the site solid, the part in front of it dimmed away.
    expect(screen.getByText('evil.example').className).toContain('font-medium');
    expect(screen.getByText('api.openweathermap.org.').className).toContain('text-fg-dim');
  });

  it('says so when allowing failed, and does not pretend the page opened', async () => {
    const approve = vi.fn(async () => ({ ok: false, message: 'This computer has no keychain, so the key could not be stored.' }) as PageApproveResult);
    withBridge(approve);
    render(<PageApproval page={page([{ id: 'y', kind: 'youcoded', approved: false }])} onNotNow={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Allow and open' }));
    await waitFor(() => expect(screen.getByText('This computer has no keychain, so the key could not be stored.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Allow and open' })).toBeEnabled();

    // Retry is a real second attempt, not a dismissal.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
  });

  it('says nothing failed when allowing worked, and waits for the page instead of re-offering Allow', async () => {
    withBridge(async () => ({ ok: true, pages: [] }));
    render(<PageApproval page={page([{ id: 'y', kind: 'youcoded', approved: false }])} onNotNow={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow and open' }));
    // The host swaps this screen for the page; until it does, the button must
    // not invite a second press.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Allowing…' })).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
