// @vitest-environment jsdom
// This repo defaults vitest to the 'node' environment per-file — jsdom is
// opt-in via this docblock (must be line 1), or `document`/`window` don't exist.
//
// WHY no title/close assertions live here: the pane used to draw its own
// title/close header (the "two X's" bug — SessionDrawer already draws a top
// bar with a close button, and the pane drew a second one directly beneath
// it). It no longer takes `onClose` props or renders a close control — the
// drawer's top bar owns both now, same slot a file's name/close use. Those
// assertions live at the drawer level: tests/session-drawer-preview-header.test.tsx.
// This suite covers what's still the pane's own job: loading/paging/error
// states and the read-only/lane caption line.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import SessionPreviewPane from '../src/renderer/components/SessionPreviewPane';
import { COPY } from '../src/shared/chatsearch-refs';

// jsdom does not implement scrollIntoView; the ConversationTranscript this
// pane renders calls it to jump to the newest message. Every real browser has
// it — this is a test-environment gap (see tests/ui-primitives.test.tsx).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const msg = (seq: number) => ({ role: seq % 2 ? 'assistant' : 'user', content: `m${seq}`, timestamp: seq, seq, droppedToolCalls: 0 });
// A title most tests don't care about — the pane takes it as a required prop
// now (Fix: SessionDrawer resolves it once and threads it down; the pane no
// longer re-resolves the same id itself).
const TITLE = 'A conversation';
beforeEach(() => { (window as any).claude = { chatsearch: { read: vi.fn() } }; });
// This suite has no globals-mode auto-cleanup (vitest.config.ts doesn't set
// test.globals), and several tests below reuse the same seq numbers (e.g.
// msg(58)/msg(59) for both the happy-path and load-older-failure cases) —
// without an explicit unmount between tests, a later test's queries can match
// a still-mounted DOM tree from an earlier one.
afterEach(cleanup);

describe('SessionPreviewPane', () => {
  it('loads the newest slice and offers Load older while hasMore', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(58), msg(59)], hasMore: true });
    render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText('m59')).toBeTruthy();
    expect((window as any).claude.chatsearch.read).toHaveBeenCalledWith({ provider: 'claude', id: 'abc', tail: 40 });
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(56), msg(57)], hasMore: false });
    fireEvent.click(screen.getByRole('button', { name: COPY.loadOlder }));
    await waitFor(() => expect(screen.getByText('m56')).toBeTruthy());
    expect((window as any).claude.chatsearch.read).toHaveBeenLastCalledWith({ provider: 'claude', id: 'abc', tail: 40, before: 58 });
    expect(screen.queryByRole('button', { name: COPY.loadOlder })).toBeNull();
    expect(screen.getByText(new RegExp(COPY.startOfConversation))).toBeTruthy();
  });

  // Case (a) — docs/error-message-standards.md: the backend gave a real
  // reason, so it's shown verbatim, paired with Retry, and nothing is
  // invented on top of it.
  it('surfaces the real error verbatim with a Retry, and never renders an empty list as an empty conversation', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false, error: 'EACCES: permission denied, open /x.jsonl' });
    render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText(/EACCES: permission denied/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    // Case (b)'s two-action card must NOT also be showing.
    expect(screen.queryByRole('button', { name: 'Report bug' })).toBeNull();
  });

  // Case (b) — docs/error-message-standards.md: chatsearch:read answered
  // { ok: false } with no `error` field. The old code filled that gap with a
  // hardcoded guess ('Unknown error reading the transcript'), asserting a
  // cause ("the read failed") nobody verified — the guard this pins is
  // tests/status-strip-authority.test.tsx's "no user-facing error falls back
  // to a hardcoded cause". The honest answer is the general two-action card:
  // no invented message, Report bug / Diagnose with the assistant instead.
  it('a failure with no error string shows the general card, not a fabricated cause', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false });
    render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText(COPY.errReadUnknownTitle)).toBeTruthy();
    expect(screen.getByText(COPY.errReadUnknownExplainer)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Report bug' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Diagnose with the assistant' })).toBeTruthy();
    // No invented cause anywhere on the card, and no Retry (that affordance
    // belongs to case (a) only).
    expect(screen.queryByText('Unknown error reading the transcript')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('labels the lane for humans', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(1)], hasMore: false });
    render(<SessionPreviewPane provider="native" id="abc" title={TITLE} />);
    expect(await screen.findByText(/YouCoded assistant/)).toBeTruthy();
    expect(screen.queryByText(/\bnative\b/)).toBeNull();
  });

  // Fix 1 pin: the drawer can be reused for a second conversation before the
  // first one's read resolves (the swap-without-unmount case documented on
  // SessionPreviewPane's genRef). A late response from the FIRST request must
  // never overwrite the SECOND conversation's messages.
  it('a late response for a superseded conversation never overwrites the one now on screen', async () => {
    let resolveFirst!: (v: any) => void;
    const firstRead = new Promise((res) => { resolveFirst = res; });
    (window as any).claude.chatsearch.read.mockImplementationOnce(() => firstRead);
    const { rerender } = render(<SessionPreviewPane provider="claude" id="first" title="First" />);

    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(10)], hasMore: false });
    rerender(<SessionPreviewPane provider="claude" id="second" title="Second" />);
    // Positive control: the SECOND conversation's message is the one that renders.
    expect(await screen.findByText('m10')).toBeTruthy();

    // Now the stale FIRST request resolves. It must be dropped, not rendered.
    resolveFirst({ ok: true, messages: [msg(99)], hasMore: false });
    await waitFor(() => expect(screen.queryByText('m99')).toBeNull());
    expect(screen.getByText('m10')).toBeTruthy();
  });

  // Fix 2, half A: the FIRST load has nothing behind it yet, so its failure is
  // correctly a full-pane error. (Already covered above by "surfaces the real
  // error…" — restated here as the explicit positive control for half B.)
  it('a first-load failure shows the full-pane error with the real message and no messages', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false, error: 'ENOENT: no such file, open /y.jsonl' });
    render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText(/ENOENT: no such file/)).toBeTruthy();
    expect(screen.queryByText(/^m\d+$/)).toBeNull();
  });

  // Fix 2, half B: a failed "Load older" must be non-destructive — the
  // messages already on screen stay, and the failure surfaces near the
  // paging control instead of replacing the pane.
  it('a failed Load older keeps the loaded messages on screen and surfaces the error near the control', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(58), msg(59)], hasMore: true });
    render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText('m59')).toBeTruthy();

    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false, error: 'ETIMEDOUT reading older page' });
    fireEvent.click(screen.getByRole('button', { name: COPY.loadOlder }));
    expect(await screen.findByText(/ETIMEDOUT reading older page/)).toBeTruthy();
    // Non-destructive: both original messages are still rendered alongside the error.
    expect(screen.getByText('m58')).toBeTruthy();
    expect(screen.getByText('m59')).toBeTruthy();

    // Retry retries the SAME backwards page (messages[0] is still seq 58 — it
    // was never overwritten), not the newest slice.
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(56), msg(57)], hasMore: false });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('m56')).toBeTruthy());
    expect(screen.getByText('m57')).toBeTruthy();
    expect(screen.getByText('m59')).toBeTruthy();
    expect(screen.getByText(new RegExp(COPY.startOfConversation))).toBeTruthy();
  });

  // Same case (b) honesty as the full-pane case above, but for the "Load
  // older" page specifically — the empty-string sentinel must not collapse
  // into "no error happened" (see olderError's WHY comment in the pane).
  it('a failed Load older with no error string shows the general card, not the "Load older" button reappearing silently', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(58), msg(59)], hasMore: true });
    render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText('m59')).toBeTruthy();

    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false });
    fireEvent.click(screen.getByRole('button', { name: COPY.loadOlder }));
    expect(await screen.findByText(COPY.errReadUnknownTitle)).toBeTruthy();
    // The failure must not silently look like success — the paging button
    // must not have quietly come back.
    expect(screen.queryByRole('button', { name: COPY.loadOlder })).toBeNull();
  });

  // A3: SessionDrawer resolves the previewed id once for its own header
  // (Resume eligibility, tags) and threads that title down as a prop — the
  // pane just stamps it, alongside the id it already has, into
  // ConversationTranscript's data attributes, which is what the right-click
  // "Ask about this" scaffold reads (build-menu.ts).
  it('stamps the title prop and id onto the transcript, for the right-click scaffold to read', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(1)], hasMore: false });
    const { container } = render(<SessionPreviewPane provider="claude" id="abc" title="Debugging sync" />);
    await screen.findByText('m1');
    expect(container.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id')).toBe('abc');
    expect(container.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-title')).toBe('Debugging sync');
  });

  // Positive control for the above: an empty title (untitled conversation)
  // still stamps the id and an empty title attribute — never undefined/stale
  // — same convention chatsearch:resolve used ('' means untitled).
  it('stamps an empty title as-is for an untitled conversation', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: true, messages: [msg(1)], hasMore: false });
    const { container } = render(<SessionPreviewPane provider="claude" id="abc" title="" />);
    await screen.findByText('m1');
    expect(container.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id')).toBe('abc');
    expect(container.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-title')).toBe('');
  });
});
