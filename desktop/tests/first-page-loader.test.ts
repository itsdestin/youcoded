import { describe, it, expect, vi } from 'vitest';
import { createFirstPageLoader, FIRST_PAGE_MAX_RUNS } from '../src/renderer/state/first-page-loader';
import { FIRST_PAGE_UNRESOLVED_ATTEMPTS } from '../src/renderer/state/first-page-retry';
import type { ChatAction } from '../src/renderer/state/chat-types';
import type { TranscriptPageRequest, TranscriptPageResult } from '../src/shared/types';
import type { OpenReply, Push } from '../src/shared/session-open-types';

// The blank-chat bug (2026-09-27): a live conversation showed "Start a conversation" because its one first-page load failed and nothing
// ever asked again. These pin the ways back. Since one-core R5-2 the first request is `session:open` (its answer carries the page and
// what only memory holds); the page request is only the retry while the transcript is not found yet.

const real: TranscriptPageResult = { events: [{ type: 'user-message' } as any], cursor: null, hasMore: false };
const unresolved: TranscriptPageResult = { events: [], cursor: null, hasMore: false, unresolved: true };
const LOC = { claudeSessionId: 'cc-1', projectSlug: '-home-x' };

const pageReply = (page: TranscriptPageResult, extra: Partial<Extract<OpenReply, { ok: true }>> = {}): OpenReply =>
  ({ ok: true, epoch: 'e', headSeq: 3, resume: 'page', before: [{ type: 'transcript:event', payload: { b: 1 } }], page, after: [{ type: 'hook:replay-complete', payload: {} }], facts: { working: false }, ...extract(extra) });
const extract = <T,>(x: T) => x;

/** `answer(n)` is the page for the nth request of ANY kind: the open first, then page retries. */
function rig(answer: (n: number, req: any) => TranscriptPageResult | null | Promise<never> | Promise<TranscriptPageResult>) {
  const actions: ChatAction[] = [];
  const opens: any[] = [];
  const pages: TranscriptPageRequest[] = [];
  const played: Push[][] = [];
  let n = 0;
  const loader = createFirstPageLoader({
    open: vi.fn(async (req) => { opens.push(req); const a = await answer(++n, req); return a ? pageReply(a) : undefined; }),
    requestPage: vi.fn(async (req) => { pages.push(req); return answer(++n, req) as any; }),
    dispatch: (a) => actions.push(a), flush: () => actions.push({ type: 'FLUSH' } as any), play: (p) => { played.push(p); actions.push({ type: 'PLAY' } as any); },
    sleep: async () => {},
  });
  const types = (): string[] => actions.map((a) => a.type as string);
  return { loader, actions, opens, pages, played, types, requests: () => n };
}

describe('first-page loader (one fill)', () => {
  it('loads once, even when asked twice while loading', async () => {
    const r = rig(() => real);
    await Promise.all([r.loader.load('s'), r.loader.load('s')]);
    await r.loader.load('s');
    expect(r.opens).toHaveLength(1);
    expect(r.types()).toEqual(['HISTORY_PAGE_REQUESTED', 'SESSION_FILL_RESET', 'PLAY', 'FLUSH', 'HISTORY_PAGE_LOADED', 'SESSION_WORKING_SYNCED', 'PLAY']);
  });

  it('a first load never resumes: it asks for a fresh page', async () => {
    const r = rig(() => real);
    await r.loader.load('s');
    expect(r.opens[0]).toMatchObject({ sessionId: 's', fresh: true });
  });

  it('plays the record\'s recent past BEFORE the page and what only memory holds AFTER it', async () => {
    const r = rig(() => real);
    await r.loader.load('s');
    const t = r.types();
    expect(t.indexOf('PLAY')).toBeLessThan(t.indexOf('HISTORY_PAGE_LOADED'));
    expect(t.lastIndexOf('PLAY')).toBeGreaterThan(t.indexOf('HISTORY_PAGE_LOADED'));
    expect(r.played[0]).toEqual([{ type: 'transcript:event', payload: { b: 1 } }]);
    expect(r.played[1]).toEqual([{ type: 'hook:replay-complete', payload: {} }]);
  });

  it('resume race: a locator supplied after an unlocated load started reaches its page retry', async () => {
    let resolveFirst!: (p: TranscriptPageResult) => void;
    const r = rig((n, req) => {
      if (n === 1) return new Promise((res) => { resolveFirst = res; }) as any;
      return req.claudeSessionId ? real : unresolved;
    });
    const unlocated = r.loader.load('s');
    const second = r.loader.load('s', LOC);        // waits on the first...
    resolveFirst(unresolved);
    await unlocated; await second;
    expect(r.pages[0].claudeSessionId).toBe('cc-1');   // ...but its locator was used
    expect(r.types()).toContain('HISTORY_PAGE_LOADED');
  });

  it('the page retry asks for the page to the END of the file', async () => {
    const r = rig((n) => (n === 1 ? unresolved : real));
    await r.loader.load('s');
    expect(r.pages[0]).toMatchObject({ toEnd: true, beforeCursor: null });
  });

  it('a page the computer could not find yet still gets the rest of the answer applied (asks, markers)', async () => {
    const r = rig((n) => (n === 1 ? unresolved : real));
    await r.loader.load('s');
    // before + after were played at the first answer; the page came later
    expect(r.played).toHaveLength(2);
    expect(r.types().indexOf('HISTORY_PAGE_LOADED')).toBeGreaterThan(r.types().lastIndexOf('PLAY'));
  });

  it('a second caller waits for the load already running (work ordered after the page stays after it)', async () => {
    let resolveFirst!: (p: TranscriptPageResult) => void;
    const r = rig(() => new Promise((res) => { resolveFirst = res; }) as any);
    void r.loader.load('s');
    let after = false;
    const chained = r.loader.load('s').then(() => { after = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(after).toBe(false);
    resolveFirst(real);
    await chained;
    expect(r.types()).toContain('HISTORY_PAGE_LOADED');
    expect(after).toBe(true);
  });

  it('a load that gave up is re-asked by the next live event, and then shows history', async () => {
    let hookLanded = false;
    const r = rig(() => (hookLanded ? real : unresolved));
    await r.loader.load('s');
    expect(r.requests()).toBe(FIRST_PAGE_UNRESOLVED_ATTEMPTS);
    expect(r.types().at(-1)).toBe('HISTORY_PAGE_FAILED');
    hookLanded = true;
    r.loader.noteLiveActivity('s');
    await vi.waitFor(() => expect(r.types()).toContain('HISTORY_PAGE_LOADED'));
  });

  it('a thrown open is re-askable too', async () => {
    let n = 0;
    const r = rig(() => (++n === 1 ? Promise.reject(new Error('ipc')) as any : real));
    await r.loader.load('s');
    expect(r.types().at(-1)).toBe('HISTORY_PAGE_FAILED');
    r.loader.noteLiveActivity('s');
    await vi.waitFor(() => expect(r.types()).toContain('HISTORY_PAGE_LOADED'));
  });

  it('a bridge with no host record (the Android app on its own runtime) fails quietly, as it always did', async () => {
    const r = rig(() => null);
    expect(await r.loader.load('s')).toBe('failed');
    expect(r.types().at(-1)).toBe('HISTORY_PAGE_FAILED');
  });

  it('live events after a successful load never ask again (the hot path stays free)', async () => {
    const r = rig(() => real);
    await r.loader.load('s');
    for (let i = 0; i < 50; i++) r.loader.noteLiveActivity('s');
    expect(r.requests()).toBe(1);
  });

  it('re-asks are bounded for a session that will never have a transcript', async () => {
    const r = rig(() => unresolved);
    await r.loader.load('s');
    for (let i = 0; i < 20; i++) { r.loader.noteLiveActivity('s'); await new Promise((res) => setTimeout(res, 0)); }
    expect(r.requests()).toBe(FIRST_PAGE_MAX_RUNS * FIRST_PAGE_UNRESOLVED_ATTEMPTS);
  });

  it('a closed session is forgotten, so the same id reopened loads again', async () => {
    const r = rig(() => real);
    await r.loader.load('s');
    r.loader.retainOnly(new Set());
    await r.loader.load('s');
    expect(r.opens).toHaveLength(2);
  });

  it('a session closed mid-load records nothing from the stale answer', async () => {
    let resolveFirst!: (p: TranscriptPageResult) => void;
    const r = rig((n) => (n === 1 ? new Promise((res) => { resolveFirst = res; }) as any : real));
    const stale = r.loader.load('s');
    r.loader.retainOnly(new Set());
    await r.loader.load('s');
    resolveFirst(real);
    await stale;
    expect(r.types().filter((t) => t === 'HISTORY_PAGE_LOADED')).toHaveLength(1);
  });
});

describe('a conversation that ended while the screen was away', () => {
  it('is shown as ended, counts as answered (the strip must not say "may be behind"), and is never asked about again', async () => {
    const gone: string[] = [];
    const open = vi.fn(async () => ({ ok: false, error: 'ended', gone: true } as OpenReply));
    const loader = createFirstPageLoader({ open, requestPage: vi.fn(), dispatch: () => {}, flush: () => {}, play: () => {}, gone: (s) => gone.push(s), sleep: async () => {} });
    expect(await loader.refill('s', { fresh: false })).toBe('ok');
    expect(gone).toEqual(['s']);
    loader.noteLiveActivity('s');
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('refill (a reconnect, or Refresh)', () => {
  it('fills even a conversation whose first load gave up (a tear-off window always fills)', async () => {
    let n = 0;
    const r = rig(() => (++n <= FIRST_PAGE_UNRESOLVED_ATTEMPTS ? unresolved : real));
    await r.loader.load('s');
    expect(r.types().at(-1)).toBe('HISTORY_PAGE_FAILED');
    expect(await r.loader.refill('s', { fresh: true })).toBe('ok');
    expect(r.types()).toContain('HISTORY_PAGE_LOADED');
  });

  it('sends where the screen got to (no fresh) and applies ONLY the missed events when the computer can continue', async () => {
    const actions: ChatAction[] = [];
    const played: Push[][] = [];
    const open = vi.fn(async () => ({ ok: true, epoch: 'e', headSeq: 9, resume: 'events', before: [], page: null,
      after: [{ type: 'transcript:event', payload: { missed: 1 } }], facts: { working: true } } as OpenReply));
    const loader = createFirstPageLoader({ open, requestPage: vi.fn(), dispatch: (a) => actions.push(a), flush: () => {}, play: (p) => played.push(p), sleep: async () => {} });
    await loader.load('s');            // (the first load's answer is the same stub; irrelevant here)
    actions.length = 0; played.length = 0;
    expect(await loader.refill('s', { fresh: false })).toBe('ok');
    expect(open).toHaveBeenLastCalledWith(expect.not.objectContaining({ fresh: true }));
    expect(played).toEqual([[{ type: 'transcript:event', payload: { missed: 1 } }]]);
    expect(actions.map((a) => a.type)).toEqual(['SESSION_WORKING_SYNCED']);   // no reset, no page: the screen kept everything it had
  });

  it('Refresh takes a fresh page and starts the conversation over', async () => {
    const r = rig(() => real);
    await r.loader.load('s');
    r.actions.length = 0;
    expect(await r.loader.refill('s', { fresh: true })).toBe('ok');
    expect(r.opens.at(-1)).toMatchObject({ fresh: true });
    expect(r.types()[0]).toBe('SESSION_FILL_RESET');
  });

  it('a refill that cannot reach the computer leaves the screen as it was and says it failed (no blank, no forgetting)', async () => {
    let fail = false;
    const r = rig(() => (fail ? Promise.reject(new Error('down')) as any : real));
    await r.loader.load('s');
    r.actions.length = 0;
    fail = true;
    expect(await r.loader.refill('s', { fresh: false })).toBe('failed');
    expect(r.actions).toEqual([]);
  });

  it('waits for a load already running instead of filling twice', async () => {
    let resolveFirst!: (p: TranscriptPageResult) => void;
    const r = rig(() => new Promise((res) => { resolveFirst = res; }) as any);
    void r.loader.load('s');
    const again = r.loader.refill('s', { fresh: false });
    resolveFirst(real);
    await again;
    expect(r.opens).toHaveLength(1);
  });
});

describe('watch (a phone starts receiving a conversation)', () => {
  it('a conversation this page never filled takes a first fill and shows its loading state', async () => {
    const r = rig(() => real);
    await r.loader.watch('s');
    expect(r.opens).toHaveLength(1);
    expect(r.opens[0]).toMatchObject({ sessionId: 's', fresh: true });
    expect(r.types()[0]).toBe('HISTORY_PAGE_REQUESTED');
  });

  it('one it filled before and then stopped watching is filled AGAIN from where it got to (not a fresh page)', async () => {
    const r = rig(() => real);
    await r.loader.watch('s');
    await r.loader.watch('s');
    expect(r.opens).toHaveLength(2);
    expect(r.opens[1].fresh).toBeUndefined();         // the shim adds `have` from its cursor; no Refresh
    expect(r.types().filter((t) => t === 'HISTORY_PAGE_REQUESTED')).toHaveLength(1); // no loading state over content it already holds
  });

  it('waits for a fill already running instead of filling twice (a tap and the screen\'s own effect both ask)', async () => {
    const r = rig(() => real);
    await Promise.all([r.loader.watch('s'), r.loader.watch('s')]);
    expect(r.opens).toHaveLength(1);
  });

  it('a first fill that failed is asked as a first fill again', async () => {
    const r = rig((n) => (n === 1 ? null : real));
    expect(await r.loader.watch('s')).toBe('failed');
    expect(await r.loader.watch('s')).toBe('ok');
    expect(r.opens[1]).toMatchObject({ fresh: true });
  });
});

describe('abandon (the phone stopped watching while its open was still running)', () => {
  it('open in flight, evicted, tapped again: a NEW open goes out, and the stale answer is applied to nothing', async () => {
    const releases: Array<() => void> = [];
    const actions: ChatAction[] = [];
    const opens: any[] = [];
    const loader = createFirstPageLoader({
      open: vi.fn(async (req) => { opens.push(req); await new Promise<void>((r) => releases.push(r)); return pageReply(real); }),
      requestPage: vi.fn(async () => real),
      dispatch: (a) => actions.push(a), flush: () => {}, play: () => {}, sleep: async () => {},
    });
    const first = loader.watch('a');            // the tap: open #1 is running
    loader.abandon('a');                        // three more taps evicted it (unwatch sent)
    const second = loader.watch('a');           // tapped again
    expect(opens).toHaveLength(2);              // a new open, not the stale one
    releases.forEach((r) => r());
    expect(await first).toBe('failed');         // the stale answer records nothing
    expect(await second).toBe('ok');
    expect(actions.filter((a) => a.type === 'HISTORY_PAGE_LOADED')).toHaveLength(1);
  });

  it('a finished fill is not abandoned (its cursor still resumes)', async () => {
    const r = rig(() => real);
    await r.loader.watch('s');
    r.loader.abandon('s');
    await r.loader.watch('s');
    expect(r.opens[1].fresh).toBeUndefined();
  });
});
