// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';

const myThumb = vi.fn();
const thumb = vi.fn();
const comment = vi.fn();
const refresh = vi.fn();
const applyThumbs = vi.fn();

vi.mock('../src/renderer/state/account-context', () => ({ useAccount: () => ({ signedIn: true, user: { id: 'github:1', login: 'me', avatar_url: '' } }) }));
vi.mock('../src/renderer/state/marketplace-stats-context', () => ({
  useMarketplaceStats: () => ({
    plugins: { p1: { installs: 3, review_count: 0, rating: 0, thumbs_up: 9, thumbs_down: 1 } },
    themes: {},
    refresh,
    applyThumbs,
    loading: false,
  }),
}));
// NOT a blank stub: a blank stub can never catch a thread that fails to re-read.
// Record the props so the tests can assert refreshKey actually moved.
const commentListProps: Array<{ refreshKey?: number; held?: Array<{ id: string; text: string }> }> = [];
vi.mock('../src/renderer/components/marketplace/CommentList', () => ({
  default: (p: { refreshKey?: number; held?: Array<{ id: string; text: string }> }) => { commentListProps.push(p); return <div data-testid="comments" />; },
}));
vi.mock('../src/renderer/components/marketplace/SignInPromptModal', () => ({ default: () => null }));

// Node 22 defines its own `localStorage` global (undefined without
// --localstorage-file), which shadows jsdom's — same Map-backed stub as
// handle-prompt.test.tsx so the held-comment record has somewhere to live.
{
  const m = new Map<string, string>();
  const stub = {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
  if ((globalThis as any).window) (globalThis as any).window.localStorage = stub;
}

import FeedbackSection, { thumbsLabel, ThumbsSummary } from '../src/renderer/components/marketplace/FeedbackSection';

beforeEach(() => {
  commentListProps.length = 0;
  localStorage.clear();
  myThumb.mockReset().mockResolvedValue({ ok: true, value: { vote: null, thumbs_up: 9, thumbs_down: 1 } });
  thumb.mockReset().mockResolvedValue({ ok: true, value: { vote: 'up', thumbs_up: 10, thumbs_down: 1 } });
  comment.mockReset().mockResolvedValue({ ok: true, value: { id: 'c1', hidden: false } });
  refresh.mockReset();
  applyThumbs.mockReset();
  (window as unknown as { claude: unknown }).claude = { marketplaceApi: { thumb, myThumb, comment } };
});
afterEach(cleanup);

describe('FeedbackSection', () => {
  it('votes through window.claude.marketplaceApi.thumb, not a token-less HTTP client', async () => {
    render(<FeedbackSection pluginId="p1" installed />);
    // Substring matcher: the label is "Helpful 90% 10 votes" and getByText
    // compares a node's WHOLE normalized text.
    expect(screen.getByText(/90%/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /helpful/i }));
    await waitFor(() => expect(thumb).toHaveBeenCalledWith({ plugin_id: 'p1', value: 'up' }));
  });

  it('moves the count from the write, and never re-fetches /stats', async () => {
    render(<FeedbackSection pluginId="p1" installed />);
    expect(screen.getByText(/10 votes/)).toBeTruthy();      // 9 up + 1 down
    fireEvent.click(screen.getByRole('button', { name: /helpful/i }));
    // 10→11 on the spot, from the response. A /stats round-trip could not do
    // this: that response is Cache-Control max-age=300.
    await waitFor(() => expect(screen.getByText(/11 votes/)).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows the vote you already cast, instead of forgetting it', async () => {
    myThumb.mockResolvedValueOnce({ ok: true, value: { vote: 'down', thumbs_up: 9, thumbs_down: 1 } });
    render(<FeedbackSection pluginId="p1" installed />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /not for me/i }).getAttribute('aria-pressed')).toBe('true'),
    );
  });

  it('puts the thumb back and says so when the vote fails', async () => {
    thumb.mockResolvedValueOnce({ ok: false, status: 403, error: 'must install plugin before voting' });
    render(<FeedbackSection pluginId="p1" installed />);
    const btn = screen.getByRole('button', { name: /helpful/i });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/only people who have used it can vote/i)).toBeTruthy());
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('reports a network throw too, rather than leaving the thumb lit', async () => {
    thumb.mockRejectedValueOnce(new Error('offline'));
    render(<FeedbackSection pluginId="p1" installed />);
    const btn = screen.getByRole('button', { name: /helpful/i });
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText(/couldn.t save your vote/i)).toBeTruthy());
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('ignores a second click while the first is still saving', async () => {
    let release!: (v: unknown) => void;
    thumb.mockReturnValueOnce(new Promise((r) => { release = r; }));
    render(<FeedbackSection pluginId="p1" installed />);
    const up = screen.getByRole('button', { name: /helpful/i }) as HTMLButtonElement;
    fireEvent.click(up);
    await waitFor(() => expect(up.disabled).toBe(true));
    fireEvent.click(up);
    fireEvent.click(screen.getByRole('button', { name: /not for me/i }));
    expect(thumb).toHaveBeenCalledTimes(1);
    release({ ok: true, value: { vote: 'up', thumbs_up: 10, thumbs_down: 1 } });
  });

  it('shows a count, not a percentage, until there are enough votes', () => {
    expect(thumbsLabel(1, 0)).toBe('1 person found this helpful');
    expect(thumbsLabel(2, 1)).toBe('2 of 3 people found this helpful');
    expect(thumbsLabel(4, 0)).toBe('4 people found this helpful');
    // At or above the threshold the approved G-19 markup renders instead, so the
    // helper deliberately says nothing rather than competing with it.
    expect(thumbsLabel(9, 1)).toBeNull();
    expect(thumbsLabel(0, 0)).toBeNull();
  });

  it('never renders "1 votes" or "100%" off a single vote', () => {
    cleanup();
    vi.resetModules();
    render(<FeedbackSection pluginId="unknown-plugin" installed />);
    expect(screen.queryByText(/1 votes/)).toBeNull();
    expect(screen.queryByText(/100%/)).toBeNull();
  });

  it('posts a comment and makes the thread re-read', async () => {
    render(<FeedbackSection pluginId="p1" installed />);
    fireEvent.change(screen.getByLabelText('Write a comment'), { target: { value: 'Does it work offline?' } });
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));
    await waitFor(() => expect(comment).toHaveBeenCalledWith({ plugin_id: 'p1', text: 'Does it work offline?' }));
    // Read commentListProps INSIDE the waitFor. This used to snapshot the array
    // into `keys` first and then wait on the snapshot, which can never change —
    // so the wait was really "was the re-render already in by the time we got
    // here", and under eight concurrent full suites (2026-09-02) it was not:
    // both ends of a one-element array, `expected +0 not to be +0`.
    const firstKey = commentListProps[0]?.refreshKey;
    await waitFor(() => expect(commentListProps.at(-1)?.refreshKey).not.toBe(firstKey));
  });

  it('says a held comment is held, instead of letting it vanish', async () => {
    comment.mockResolvedValueOnce({ ok: true, value: { id: 'c2', hidden: true } });
    render(<FeedbackSection pluginId="p1" installed />);
    fireEvent.change(screen.getByLabelText('Write a comment'), { target: { value: 'spicy' } });
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));
    // A hidden comment is never returned by the public list, so without this the
    // user posts, the box clears, and nothing appears — indistinguishable from a bug.
    await waitFor(() => expect(screen.getByText(/held for review/i)).toBeTruthy());
  });

  it('keeps a held comment in the thread, and still has it after the page is reopened', async () => {
    comment.mockResolvedValueOnce({ ok: true, value: { id: 'c2', hidden: true } });
    const first = render(<FeedbackSection pluginId="p1" installed />);
    fireEvent.change(screen.getByLabelText('Write a comment'), { target: { value: 'spicy' } });
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));
    // The thread is handed the held comment, so it appears in place — the
    // toast is not the last the author sees of it.
    await waitFor(() => expect(commentListProps.at(-1)?.held?.map((c) => c.text)).toEqual(['spicy']));
    first.unmount();
    commentListProps.length = 0;

    // A fresh mount (reopening the page, relaunching the app) reads it back
    // from this device's record — the public list will never return it.
    render(<FeedbackSection pluginId="p1" installed />);
    await waitFor(() => expect(commentListProps.at(-1)?.held?.map((c) => c.id)).toEqual(['c2']));
    // …but only for THIS plugin.
    cleanup();
    commentListProps.length = 0;
    render(<FeedbackSection pluginId="p2" installed />);
    await waitFor(() => expect(commentListProps.length).toBeGreaterThan(0));
    expect(commentListProps.at(-1)?.held ?? []).toEqual([]);
  });

  it('says so when posting a comment fails, and keeps the draft', async () => {
    comment.mockResolvedValueOnce({ ok: false, status: 429, error: 'too many comments per hour' });
    render(<FeedbackSection pluginId="p1" installed />);
    const box = screen.getByLabelText('Write a comment') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /post comment/i }));
    await waitFor(() => expect(screen.getByText(/couldn.t post your comment/i)).toBeTruthy());
    // Keeping the text is the difference between "try again" and "retype it".
    expect(box.value).toBe('hello');
  });

  it('never shows a lit thumb beside "No votes yet"', async () => {
    // The reopen bug: the vote was loaded fresh from the server while the count
    // came from the /stats snapshot taken at app start, which predates the vote.
    // Stats here reports a plugin with NO votes; the server read says otherwise
    // and must win.
    myThumb.mockResolvedValueOnce({ ok: true, value: { vote: 'up', thumbs_up: 1, thumbs_down: 0 } });
    render(<FeedbackSection pluginId="unknown-plugin" installed />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /helpful/i }).getAttribute('aria-pressed')).toBe('true'),
    );
    expect(screen.queryByText(/no votes yet/i)).toBeNull();
    expect(screen.getByText(/1 person found this helpful/i)).toBeTruthy();
  });

  it('pushes the new totals into the shared stats, so the CARD updates too', async () => {
    // Cards read plugins[id] from the stats context. Without this the detail
    // page and its own card disagree after a vote — header 0%, card 100% —
    // and refresh() cannot reconcile them (/stats is max-age=300).
    thumb.mockResolvedValueOnce({ ok: true, value: { vote: 'down', thumbs_up: 0, thumbs_down: 1 } });
    render(<FeedbackSection pluginId="p1" installed />);
    fireEvent.click(screen.getByRole('button', { name: /not for me/i }));
    await waitFor(() => expect(applyThumbs).toHaveBeenCalledWith('p1', 0, 1));
  });

  it('renders no Report control on a comment (no backend for it in v1)', () => {
    render(<FeedbackSection pluginId="p1" installed />);
    expect(screen.queryByRole('button', { name: /report/i })).toBeNull();
  });

  it('disables voting until installed, and says why in VISIBLE text (no touch hover)', () => {
    render(<FeedbackSection pluginId="p1" installed={false} />);
    const btn = screen.getByRole('button', { name: /helpful/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // Rendered text, not a title attribute — Android runs this same bundle and
    // has no hover, and disabled buttons suppress title in several engines.
    expect(screen.getByText(/install it first/i)).toBeTruthy();
  });

  it('does not ask the server for a vote when signed out of nothing to ask about', async () => {
    render(<FeedbackSection pluginId="p1" installed={false} />);
    // Not installed means no vote can exist; asking anyway costs a round-trip
    // per plugin page open.
    await waitFor(() => expect(myThumb).not.toHaveBeenCalled());
  });
});

describe('ThumbsSummary (the card)', () => {
  it('shows a COUNT, not a percentage, below the threshold', () => {
    // One like rendered "100%", which reads as "everyone loved this" rather
    // than "one person clicked" — and it is the number on every card.
    const { container } = render(<ThumbsSummary up={1} down={0} />);
    expect(container.textContent).toContain('1');
    expect(container.textContent).not.toContain('%');
  });

  it('still shows a percentage once there are enough votes', () => {
    const { container } = render(<ThumbsSummary up={9} down={1} />);
    expect(container.textContent).toContain('90%');
  });

  it('renders nothing at all when nobody has voted', () => {
    const { container } = render(<ThumbsSummary up={0} down={0} />);
    expect(container.textContent).toBe('');
  });

  it('explains the low-count form in its tooltip, in words', () => {
    const { container } = render(<ThumbsSummary up={2} down={1} />);
    expect(container.querySelector('[data-thumbs]')?.getAttribute('data-hint'))
      .toBe('2 of 3 people who installed this found it helpful');
  });

  it('drops the separate total in the low-count form — the number IS the count', () => {
    const { container } = render(<ThumbsSummary up={3} down={0} showTotal />);
    expect(container.textContent).toBe('3');
  });
});
