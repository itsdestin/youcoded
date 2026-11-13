// @vitest-environment jsdom
// WHY (error inventory 2026-09-10, Marketplace row 14): when the community totals could not be read
// the detail page said "No votes yet" - false. It now says it could not load, with Try again.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

const refresh = vi.fn();
vi.mock('../src/renderer/state/account-context', () => ({ useAccount: () => ({ signedIn: true, user: { id: 'github:1', login: 'me', avatar_url: '' } }) }));
vi.mock('../src/renderer/state/marketplace-stats-context', () => ({
  useMarketplaceStats: () => ({ plugins: {}, themes: {}, refresh, applyThumbs: vi.fn(), loading: false, error: 'stats service down' }),
}));
vi.mock('../src/renderer/components/marketplace/CommentList', () => ({ default: () => <div /> }));
vi.mock('../src/renderer/components/marketplace/SignInPromptModal', () => ({ default: () => null }));

import FeedbackSection from '../src/renderer/components/marketplace/FeedbackSection';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('vote line when the totals could not be read', () => {
  it('does not claim "No votes yet"; says it could not load, and Try again asks again', () => {
    (window as any).claude = { marketplaceApi: { myThumb: vi.fn().mockResolvedValue({ ok: true, value: null }) } };
    render(<FeedbackSection pluginId="p1" installed />);
    expect(screen.queryByText('No votes yet')).toBeNull();
    expect(screen.getByText(/Couldn.t load the votes: stats service down/)).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
