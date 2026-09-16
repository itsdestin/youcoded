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
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
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

  // The arrival is keyed on the transcript having SETTLED, not on the click:
  // reading one off disk takes real time, and keyed on the click the spring
  // played out over a loading line while the bubbles landed after it.
  it('waits for the transcript before it animates the sheet in', async () => {
    setViewport(false);
    mockClaude([row()]);
    let release: (v: unknown) => void = () => {};
    (window as any).claude.chatsearch.read = vi.fn(() => new Promise((r) => {
      release = () => r({ ok: true, messages: [{ role: 'user', content: 'why did the ask time out', timestamp: 1, seq: 0 }], hasMore: false });
    }));
    const { container } = open();
    fireEvent.click(await screen.findByText('Permission ask timeout'));
    // Still reading: nothing is wearing the arrival yet.
    await waitFor(() => expect((window as any).claude.chatsearch.read).toHaveBeenCalled());
    expect(container.querySelector('.switch-arrival')).toBeNull();

    release(null);
    await waitFor(() => expect(container.querySelector('.switch-arrival')).not.toBeNull());
    // …and the bubbles are already there when it starts, which is the point.
    expect(container.querySelector('.switch-arrival')!.textContent).toContain('why did the ask time out');
  });

  // Destin, 2026-09-11: "when scrolling up through a conversation preview in
  // resume browser, the top card should slide up and hide. it should slide
  // back down when i scroll down". jsdom lays nothing out, so the scroller's
  // position and height are driven by hand.
  const pickAndGrabScroller = async () => {
    const { container } = open();
    fireEvent.click(await screen.findByText('Permission ask timeout'));
    await waitFor(() => expect(container.querySelector('.preview-header-slide')).not.toBeNull());
    const strip = container.querySelector('.preview-header-slide')!;
    const scroller = container.querySelector('[data-preview-id] .overflow-y-auto') as HTMLElement;
    const pos = { top: 1000, height: 3000 };
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => pos.top });
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => pos.height });
    const scrollTo = (top: number, height = pos.height) => { pos.top = top; pos.height = height; fireEvent.scroll(scroller); };
    scrollTo(1000); // the first scroll only takes a bearing
    return { strip, scrollTo };
  };

  it('tucks the header card away while you scroll up, and brings it back as you scroll down', async () => {
    setViewport(false);
    mockClaude([row()]);
    const { strip, scrollTo } = await pickAndGrabScroller();
    expect(strip).not.toHaveAttribute('data-tucked');
    scrollTo(900);
    expect(strip).toHaveAttribute('data-tucked');
    scrollTo(903); // a nudge under the threshold moves nothing
    expect(strip).toHaveAttribute('data-tucked');
    scrollTo(1000);
    expect(strip).not.toHaveAttribute('data-tucked');
  });

  it('keeps the card tucked when Load older pushes the conversation down without anyone scrolling', async () => {
    setViewport(false);
    mockClaude([row()]);
    const { strip, scrollTo } = await pickAndGrabScroller();
    scrollTo(0);
    expect(strip).toHaveAttribute('data-tucked');
    // Older messages land above: taller content, position pushed down to match.
    scrollTo(2000, 5000);
    expect(strip).toHaveAttribute('data-tucked');
  });

  it('brings a tucked card back when keyboard focus lands on it', async () => {
    setViewport(false);
    mockClaude([row()]);
    const { strip, scrollTo } = await pickAndGrabScroller();
    scrollTo(0);
    expect(strip).toHaveAttribute('data-tucked');
    act(() => { (strip.querySelector('button') as HTMLButtonElement).focus(); });
    expect(strip).not.toHaveAttribute('data-tucked');
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
