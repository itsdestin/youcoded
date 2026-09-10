// @vitest-environment jsdom
// The two-pane Resume browser (design rounds 2026-09-10, decks in
// docs/active/design/2026-09-10-resume-preview-panel/).
//
// The sibling files resume-browser-organize / -cc-model-prefill pin the
// SINGLE-COLUMN layout, where a card still expands its resume controls in
// place. This one pins the wide layout, where that click fills the preview
// panel instead — the behaviour those two would otherwise have silently
// stopped covering when the panel shipped.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ResumeBrowser from '../src/renderer/components/ResumeBrowser';

// Wide: jsdom has no matchMedia, and the hook already treats its absence as
// wide — stubbed anyway so the intent is on the page rather than inherited
// from a gap in the environment.
const setViewport = (narrow: boolean) => {
  (window as any).matchMedia = (q: string) => ({
    matches: narrow && q === '(max-width: 639.98px)',
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
};

beforeAll(() => {
  // jsdom implements neither; ConversationTranscript jumps to the newest
  // message on load (see tests/conversation-transcript.test.tsx for precedent).
  Element.prototype.scrollIntoView = vi.fn();
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});
afterEach(() => { cleanup(); delete (window as any).__PLATFORM__; });

const row = (o: Record<string, unknown> = {}) => ({
  sessionId: 'a3f2aaaa-1111-4111-8111-111111111111',
  name: 'Permission ask timeout',
  projectSlug: 'proj',
  projectPath: '/tmp/youcoded',
  lastModified: Date.now(),
  size: 200,
  provider: 'claude',
  ...o,
});

function mockClaude(sessions: any[]) {
  (window as any).claude = {
    session: {
      browse: vi.fn().mockResolvedValue(sessions),
      setFlag: vi.fn().mockResolvedValue({ ok: true }),
      setTag: vi.fn().mockResolvedValue({ ok: true }),
      setNote: vi.fn().mockResolvedValue({ ok: true }),
      getMeta: vi.fn().mockResolvedValue({ tags: [], note: '' }),
    },
    tags: { list: vi.fn().mockResolvedValue([]) },
    providers: { catalog: vi.fn().mockResolvedValue([]), list: vi.fn().mockResolvedValue([]) },
    chatsearch: {
      read: vi.fn().mockResolvedValue({
        ok: true,
        messages: [{ role: 'user', content: 'why did the ask time out', timestamp: 1, seq: 0 }],
        hasMore: false,
      }),
    },
    on: {},
  };
}

const open = () => render(<ResumeBrowser open={true} onClose={() => {}} onResume={() => {}} defaultModel="sonnet" />);

describe('Resume browser — the preview panel', () => {
  it('fills the panel with the conversation instead of expanding the card', async () => {
    setViewport(false);
    mockClaude([row()]);
    open();
    // Nothing is previewed until a row is clicked (R2: "blank" — the panel
    // never opens the most recent conversation by itself).
    expect(screen.queryByText(/why did the ask time out/)).not.toBeInTheDocument();
    expect((window as any).claude.chatsearch.read).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByText('Permission ask timeout'));
    await waitFor(() => expect(screen.getByText(/why did the ask time out/)).toBeInTheDocument());
    // The card in the LIST does not grow its own resume controls any more —
    // they live in the card at the foot of the panel, which is the only
    // Resume Session button on screen.
    expect(screen.getAllByRole('button', { name: 'Resume Session' })).toHaveLength(1);
  });

  it('reads the conversation ONCE per row, not on every keystroke in the search box', async () => {
    setViewport(false);
    mockClaude([row()]);
    open();
    fireEvent.click(await screen.findByText('Permission ask timeout'));
    await waitFor(() => expect((window as any).claude.chatsearch.read).toHaveBeenCalledTimes(1));

    const search = screen.getByPlaceholderText('Search sessions...');
    fireEvent.change(search, { target: { value: 'p' } });
    fireEvent.change(search, { target: { value: 'pe' } });
    fireEvent.change(search, { target: { value: 'per' } });
    expect((window as any).claude.chatsearch.read).toHaveBeenCalledTimes(1);
  });

  it('stays single-column on a narrow viewport', async () => {
    setViewport(true);
    mockClaude([row()]);
    open();
    fireEvent.click(await screen.findByText('Permission ask timeout'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume Session' })).toBeInTheDocument());
    expect((window as any).claude.chatsearch.read).not.toHaveBeenCalled();
  });

  // Resume needs the project folder; reading does not. A conversation synced in
  // from another device is exactly what a preview is for, so it previews — and
  // says why there is no Resume button instead of offering a broken one.
  it('previews a conversation whose project folder is not on this device', async () => {
    setViewport(false);
    mockClaude([row({ missingProject: true, projectPath: '', projectSlug: '' })]);
    open();
    fireEvent.click(await screen.findByText('Permission ask timeout'));
    await waitFor(() => expect(screen.getByText(/why did the ask time out/)).toBeInTheDocument());
    expect(screen.getByText(/has to be resumed where its folder lives/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume Session' })).not.toBeInTheDocument();
  });

  // The transcript itself has not arrived, so there is nothing to show.
  it('leaves a not-yet-synced conversation inert', async () => {
    setViewport(false);
    mockClaude([row({ notSyncedYet: true })]);
    open();
    fireEvent.click(await screen.findByText('Permission ask timeout'));
    expect((window as any).claude.chatsearch.read).not.toHaveBeenCalled();
  });

  // chatsearch:read answers not-implemented-on-mobile (SessionService.kt), so
  // the panel could only ever show an error there. A tablet is wide enough to
  // pass the width test, which is the case this covers.
  it('stays single-column on Android even when the viewport is wide', async () => {
    setViewport(false);
    (window as any).__PLATFORM__ = 'android';
    mockClaude([row()]);
    open();
    fireEvent.click(await screen.findByText('Permission ask timeout'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume Session' })).toBeInTheDocument());
    expect((window as any).claude.chatsearch.read).not.toHaveBeenCalled();
  });
});
