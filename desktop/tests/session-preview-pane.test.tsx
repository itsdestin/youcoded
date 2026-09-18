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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import SessionPreviewPane from '../src/renderer/components/SessionPreviewPane';
import { COPY, previewSessionKey } from '../src/shared/chatsearch-refs';
import type { TranscriptEvent } from '../src/shared/types';
import { FOLD_IDLE_MS } from '../src/renderer/hooks/use-entry-folding';

// jsdom has no IntersectionObserver, and scrolling up to the top is what loads
// an older page. This stand-in records what is observed so a test can say
// "the reader reached the top" — the one signal the pane pages on.
//
// WHY it tracks `observed` elements (2026-09-18, task 6): the pane now always
// builds a SECOND IntersectionObserver too — the fold hook's, unconditionally
// enabled since no find bar ever reaches a preview pane. It shares this same
// global stub. `reachTop()` used to fire its synthetic, target-less
// `isIntersecting: true` entry at every live observer; fed to the fold hook's
// callback (which reads `entry.target`) that throws. Track what each fake
// observer is actually watching so callers can single out the one instance
// that observed the history sentinel — the one signal this file means.
let observers: { cb: IntersectionObserverCallback; disconnected: boolean; observed: Element[] }[] = [];
class FakeIO {
  private rec: { cb: IntersectionObserverCallback; disconnected: boolean; observed: Element[] };
  constructor(cb: IntersectionObserverCallback) { this.rec = { cb, disconnected: false, observed: [] }; observers.push(this.rec); }
  observe(el: Element) { this.rec.observed.push(el); }
  unobserve(el: Element) { this.rec.observed = this.rec.observed.filter((o) => o !== el); }
  disconnect() { this.rec.disconnected = true; }
  takeRecords() { return []; }
}
function sentinelObservers() {
  const sentinel = document.querySelector('[data-history-sentinel]');
  if (!sentinel) return [];
  return observers.filter((o) => !o.disconnected && o.observed.includes(sentinel));
}
async function reachTop() {
  // Wait for the pane to start watching the sentinel (an effect after the
  // render the caller already saw), rather than assuming it has.
  await waitFor(() => expect(sentinelObservers().length).toBeGreaterThan(0));
  const live = sentinelObservers();
  act(() => { for (const o of live) o.cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); });
}

// One user turn per `n`: the user's words and the assistant's reply. Real
// transcript events, as chatsearch:read now returns them.
function turn(id: string, n: number): TranscriptEvent[] {
  const sessionId = previewSessionKey(id);
  return [
    { type: 'user-message', sessionId, uuid: `u${n}`, timestamp: n, data: { text: `ask${n}` } },
    { type: 'assistant-text', sessionId, uuid: `a${n}`, timestamp: n, data: { text: `reply${n}` } },
    { type: 'turn-complete', sessionId, uuid: `c${n}`, timestamp: n, data: {} },
  ] as TranscriptEvent[];
}
const page = (id: string, ns: number[], before: number | null) => ({
  ok: true, events: ns.flatMap((n) => turn(id, n)),
  cursor: before === null ? null : { path: '/x.jsonl', offset: before, sizeAtRead: 1 },
  hasMore: before !== null,
});

// A title most tests don't care about — the pane takes it as a required prop.
const TITLE = 'A conversation';
beforeEach(() => {
  observers = [];
  (globalThis as any).IntersectionObserver = FakeIO;
  (window as any).claude = { chatsearch: { read: vi.fn() } };
});
afterEach(() => {
  cleanup();
  delete (globalThis as any).IntersectionObserver;
  // WHY: the folding tests below flip to fake timers to drive the fold-idle
  // debounce; restore real ones unconditionally so later tests in this file
  // (and later files, since vitest's timer mock is global) never inherit them.
  vi.useRealTimers();
});

describe('SessionPreviewPane', () => {
  it('draws the newest page with the chat\'s own bubbles, and loads the older page when the reader reaches the top', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce(page('abc', [58, 59], 500));
    const { container } = render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText('ask59')).toBeTruthy();
    expect(screen.getByText('reply59')).toBeTruthy();
    // The chat's own components, not a lookalike: theme packs style these hooks.
    expect(container.querySelectorAll('.user-bubble')).toHaveLength(2);
    expect(container.querySelector('.assistant-bubble')).toBeTruthy();
    expect((window as any).claude.chatsearch.read).toHaveBeenCalledWith({ provider: 'claude', id: 'abc' });

    (window as any).claude.chatsearch.read.mockResolvedValueOnce(page('abc', [56, 57], null));
    await reachTop();
    await waitFor(() => expect(screen.getByText('ask56')).toBeTruthy());
    expect((window as any).claude.chatsearch.read).toHaveBeenLastCalledWith({ provider: 'claude', id: 'abc', before: 500 });
    // Older above newer, as in the chat.
    const asks = [...container.querySelectorAll('.user-bubble')].map((b) => b.textContent);
    expect(asks.map((t) => t?.match(/ask\d\d/)?.[0])).toEqual(['ask56', 'ask57', 'ask58', 'ask59']);
    // The beginning of the conversation: nothing left to page.
    expect(container.querySelector('[data-history-sentinel]')).toBeNull();
  });

  // Case (a) — docs/error-message-standards.md: the backend gave a real
  // reason, so it's shown verbatim, paired with Retry, and nothing is
  // invented on top of it.
  it('surfaces the real error verbatim with a Retry', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false, error: 'EACCES: permission denied, open /x.jsonl' });
    render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText(/EACCES: permission denied/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Report bug' })).toBeNull();
  });

  // Case (b): chatsearch:read answered { ok: false } with no `error`. The
  // honest answer is the general two-action card, never an invented cause
  // (the ast-grep rule no-hardcoded-error-fallback guards the same line).
  it('a failure with no error string shows the general card, not a fabricated cause', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false });
    render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText(COPY.errReadUnknownTitle)).toBeTruthy();
    expect(screen.getByText(COPY.errReadUnknownExplainer)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Report bug' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Diagnose with the assistant' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('labels the lane for humans', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce(page('abc', [1], null));
    render(<SessionPreviewPane provider="native" id="abc" title={TITLE} />);
    expect(await screen.findByText(/YouCoded assistant/)).toBeTruthy();
    expect(screen.queryByText(/\bnative\b/)).toBeNull();
  });

  // The drawer reuses the pane for a second conversation before the first
  // one's read resolves; a late answer for the FIRST must never land.
  it('a late response for a superseded conversation never overwrites the one now on screen', async () => {
    let resolveFirst!: (v: any) => void;
    (window as any).claude.chatsearch.read.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }));
    const { rerender } = render(<SessionPreviewPane provider="claude" id="first" title="First" />);
    (window as any).claude.chatsearch.read.mockResolvedValueOnce(page('second', [10], null));
    rerender(<SessionPreviewPane provider="claude" id="second" title="Second" />);
    expect(await screen.findByText('ask10')).toBeTruthy();
    await act(async () => { resolveFirst(page('first', [99], null)); });
    expect(screen.queryByText('ask99')).toBeNull();
    expect(screen.getByText('ask10')).toBeTruthy();
  });

  it('a first-load failure shows the full-pane error and no messages', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false, error: 'ENOENT: no such file, open /y.jsonl' });
    const { container } = render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText(/ENOENT: no such file/)).toBeTruthy();
    expect(container.querySelector('.user-bubble')).toBeNull();
  });

  // A failed older page is non-destructive: what is on screen stays, the error
  // shows at the top, and Retry asks for the SAME older page.
  it('a failed older page keeps the loaded messages and Retry asks for that same page', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce(page('abc', [58, 59], 500));
    render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText('ask59')).toBeTruthy();

    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false, error: 'ETIMEDOUT reading older page' });
    await reachTop();
    expect(await screen.findByText(/ETIMEDOUT reading older page/)).toBeTruthy();
    expect(screen.getByText('ask58')).toBeTruthy();
    // No paging while the error shows — the top is still in view, and
    // re-arming would retry in a loop. (The fold hook's own, unrelated
    // observer stays live regardless — this checks the SENTINEL specifically.)
    expect(sentinelObservers()).toHaveLength(0);

    (window as any).claude.chatsearch.read.mockResolvedValueOnce(page('abc', [56, 57], null));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('ask56')).toBeTruthy());
    expect((window as any).claude.chatsearch.read).toHaveBeenLastCalledWith({ provider: 'claude', id: 'abc', before: 500 });
    expect(screen.getByText('ask59')).toBeTruthy();
  });

  it('a failed older page with no error string shows the general card', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce(page('abc', [58, 59], 500));
    render(<SessionPreviewPane provider="claude" id="abc" title={TITLE} />);
    expect(await screen.findByText('ask59')).toBeTruthy();
    (window as any).claude.chatsearch.read.mockResolvedValueOnce({ ok: false });
    await reachTop();
    expect(await screen.findByText(COPY.errReadUnknownTitle)).toBeTruthy();
    expect(screen.getByText('ask58')).toBeTruthy();
  });

  // A3: the right-click "Ask about this" scaffold (build-menu.ts) reads the
  // conversation's id and title off the transcript container.
  it('stamps the title prop and id onto the transcript, for the right-click scaffold to read', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce(page('abc', [1], null));
    const { container } = render(<SessionPreviewPane provider="claude" id="abc" title="Debugging sync" />);
    await screen.findByText('ask1');
    expect(container.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id')).toBe('abc');
    expect(container.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-title')).toBe('Debugging sync');
  });

  it('stamps an empty title as-is for an untitled conversation', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce(page('abc', [1], null));
    const { container } = render(<SessionPreviewPane provider="claude" id="abc" title="" />);
    await screen.findByText('ask1');
    expect(container.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-title')).toBe('');
  });
});

// A single-page, single-observer fixture: `hasMore: false` (cursor `null`)
// means the history-sentinel effect never observes anything, so the only
// IntersectionObserver constructed for these tests is the fold hook's — a
// test can grab it by construction order without disambiguating two.
// 30 turns * (1 user bubble + 1 assistant-turn bubble) = 60 timeline entries,
// matching the task brief's "first page has 60 entries" fixture.
const bigPage = (id: string, turns: number) =>
  page(id, Array.from({ length: turns }, (_, i) => i + 1), null);

// A minimal IntersectionObserver stub that (unlike the module-level FakeIO
// above, shared with the history-sentinel tests) exposes its callback and
// observed elements directly — the same shape use-entry-folding.test.ts uses
// to drive the hook itself, needed here to fire a REAL fold rather than only
// asserting the attribute that lets folding find an entry.
class FoldIO {
  static instances: FoldIO[] = [];
  cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void;
  observed: Element[] = [];
  constructor(cb: FoldIO['cb']) { this.cb = cb; FoldIO.instances.push(this); }
  observe(el: Element) { this.observed.push(el); }
  unobserve(el: Element) { this.observed = this.observed.filter((o) => o !== el); }
  disconnect() { this.observed = []; }
  takeRecords() { return []; }
}

describe('PreviewTimeline folding', () => {
  beforeEach(() => { FoldIO.instances = []; });

  // (a) alone is a lookalike — it passes with the attribute wired up and
  // nothing ever folded. Kept anyway because it pins the registration key
  // every entry must carry for folding to be able to find it at all.
  it('gives every timeline entry a data-entry-key, the fold hook\'s registration key', async () => {
    (window as any).claude.chatsearch.read.mockResolvedValueOnce(bigPage('fold-a', 30));
    const { container } = render(<SessionPreviewPane provider="claude" id="fold-a" title={TITLE} />);
    await screen.findByText('ask30');

    const entries = container.querySelectorAll('.timeline-entry');
    expect(entries.length).toBe(60);
    for (const el of entries) {
      expect(el.getAttribute('data-entry-key')).toBeTruthy();
    }
  });

  it('folds an entry the observer reports out of view into a same-height, contentless spacer, while an intersecting entry keeps its content', async () => {
    (globalThis as any).IntersectionObserver = FoldIO;
    (window as any).claude.chatsearch.read.mockResolvedValueOnce(bigPage('fold-b', 30));
    const { container } = render(<SessionPreviewPane provider="claude" id="fold-b" title={TITLE} />);
    await screen.findByText('ask30');

    // hasMore is false for this page, so the fold hook's observer is the only
    // one built — see the comment on bigPage above.
    expect(FoldIO.instances).toHaveLength(1);
    const io = FoldIO.instances[0];

    const entryEls = [...container.querySelectorAll<HTMLElement>('.timeline-entry[data-entry-key]')];
    const target = entryEls[0];
    const kept = entryEls[1];
    const targetText = target.textContent;
    // jsdom measures every element at 0; the hook REFUSES to fold a 0-height
    // entry (a 0px spacer would collapse the scroll height under the reader
    // mid-read), so a real fold needs a stubbed, non-zero offsetHeight —
    // exactly as use-entry-folding.test.ts's own `entry()` helper does.
    Object.defineProperty(target, 'offsetHeight', { get: () => 240, configurable: true });

    vi.useFakeTimers();
    // Reports `target` out of view; `kept` is never reported, so it stays
    // intersecting (the hook's default) and must never fold.
    act(() => { io.cb([{ target, isIntersecting: false }]); });
    // Folding waits for scrolling to go IDLE before it commits (FOLD_IDLE_MS) —
    // advance past exactly that settle delay.
    await act(async () => { await vi.advanceTimersByTimeAsync(FOLD_IDLE_MS); });

    expect(target.style.height).toBe('240px');
    expect(target.children.length).toBe(0);
    expect(target.textContent).toBe('');
    expect(targetText).not.toBe('');

    expect(kept.style.height).toBe('');
    expect(kept.children.length).toBeGreaterThan(0);
  });
});
