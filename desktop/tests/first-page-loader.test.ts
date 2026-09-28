import { describe, it, expect, vi } from 'vitest';
import { createFirstPageLoader, FIRST_PAGE_MAX_RUNS } from '../src/renderer/state/first-page-loader';
import { FIRST_PAGE_UNRESOLVED_ATTEMPTS } from '../src/renderer/state/first-page-retry';
import type { ChatAction } from '../src/renderer/state/chat-types';
import type { TranscriptPageRequest, TranscriptPageResult } from '../src/shared/types';

// The blank-chat bug (2026-09-27): a live conversation showed "Start a
// conversation" because its one first-page load failed and nothing ever asked
// again. These pin the three ways back.

const real: TranscriptPageResult = { events: [{ type: 'user-message' } as any], cursor: null, hasMore: false };
const unresolved: TranscriptPageResult = { events: [], cursor: null, hasMore: false, unresolved: true };
const LOC = { claudeSessionId: 'cc-1', projectSlug: '-home-x' };

function rig(answer: (req: TranscriptPageRequest, n: number) => TranscriptPageResult | null | Promise<never>) {
  const actions: ChatAction[] = [];
  const requests: TranscriptPageRequest[] = [];
  const request = vi.fn(async (req: TranscriptPageRequest) => { requests.push(req); return answer(req, requests.length); });
  const loader = createFirstPageLoader({
    request, dispatch: (a) => actions.push(a), mayLoad: () => true, sleep: async () => {},
  });
  const types = () => actions.map((a) => a.type);
  return { loader, actions, requests, types };
}

describe('first-page loader', () => {
  it('loads once, even when asked twice while loading', async () => {
    const r = rig(() => real);
    await Promise.all([r.loader.load('s'), r.loader.load('s')]);
    await r.loader.load('s');
    expect(r.requests).toHaveLength(1);
    expect(r.types()).toEqual(['HISTORY_PAGE_REQUESTED', 'HISTORY_PAGE_LOADED']);
  });

  it('resume race: a locator supplied after an unlocated load started reaches its next attempt', async () => {
    // Main can only find a just-resumed transcript through the locator until
    // Claude Code's hook lands.
    let resolveFirst!: (p: TranscriptPageResult) => void;
    const r = rig((req, n) => {
      if (n === 1) return new Promise((res) => { resolveFirst = res; }) as any;
      return req.claudeSessionId ? real : unresolved;
    });
    const unlocated = r.loader.load('s');           // the sessions effect, first
    await r.loader.load('s', LOC);                   // the resume reply, second: no second run...
    resolveFirst(unresolved);
    await unlocated;
    expect(r.requests[1].claudeSessionId).toBe('cc-1');   // ...but its locator was used
    expect(r.types()).toContain('HISTORY_PAGE_LOADED');
  });

  it('a rebuilt renderer asks for the page to the end, and a later locator keeps that', async () => {
    let resolveFirst!: (p: TranscriptPageResult) => void;
    const r = rig((_req, n) => (n === 1 ? new Promise((res) => { resolveFirst = res; }) as any : real));
    const run = r.loader.load('s', { toEnd: true });
    await r.loader.load('s', LOC);
    resolveFirst(unresolved);
    await run;
    expect(r.requests[0].toEnd).toBe(true);
    expect(r.requests[1]).toMatchObject({ toEnd: true, claudeSessionId: 'cc-1' });
  });

  it('an ordinary load never sends toEnd', async () => {
    const r = rig(() => real);
    await r.loader.load('s');
    expect(r.requests[0]).not.toHaveProperty('toEnd');
  });

  it('a load that gave up is re-asked by the next live event, and then shows history', async () => {
    let hookLanded = false;
    const r = rig(() => (hookLanded ? real : unresolved));
    await r.loader.load('s');
    expect(r.requests).toHaveLength(FIRST_PAGE_UNRESOLVED_ATTEMPTS);
    expect(r.types().at(-1)).toBe('HISTORY_PAGE_FAILED');
    hookLanded = true;
    r.loader.noteLiveActivity('s');
    await vi.waitFor(() => expect(r.types().at(-1)).toBe('HISTORY_PAGE_LOADED'));
  });

  it('a thrown request is re-askable too', async () => {
    let n = 0;
    const r = rig(() => (++n === 1 ? Promise.reject(new Error('ipc')) as any : real));
    await r.loader.load('s');
    expect(r.types().at(-1)).toBe('HISTORY_PAGE_FAILED');
    r.loader.noteLiveActivity('s');
    await vi.waitFor(() => expect(r.types().at(-1)).toBe('HISTORY_PAGE_LOADED'));
  });

  it('live events after a successful load never ask again (the hot path stays free)', async () => {
    const r = rig(() => real);
    await r.loader.load('s');
    for (let i = 0; i < 50; i++) r.loader.noteLiveActivity('s');
    expect(r.requests).toHaveLength(1);
  });

  it('re-asks are bounded for a session that will never have a transcript', async () => {
    const r = rig(() => unresolved);
    await r.loader.load('s');
    // Each nudge lands after the previous run finished (a macrotask lets the
    // instant-sleep run complete), so every one of them COULD start a run.
    for (let i = 0; i < 20; i++) {
      r.loader.noteLiveActivity('s');
      await new Promise((res) => setTimeout(res, 0));
    }
    expect(r.requests).toHaveLength(FIRST_PAGE_MAX_RUNS * FIRST_PAGE_UNRESOLVED_ATTEMPTS);
  });

  it('a closed session is forgotten, so the same id reopened loads again', async () => {
    const r = rig(() => real);
    await r.loader.load('s');
    r.loader.retainOnly(new Set());
    await r.loader.load('s');
    expect(r.requests).toHaveLength(2);
  });

  it('a session closed mid-load records nothing from the stale answer', async () => {
    let resolveFirst!: (p: TranscriptPageResult) => void;
    const r = rig((_req, n) => (n === 1 ? new Promise((res) => { resolveFirst = res; }) as any : real));
    const stale = r.loader.load('s');
    r.loader.retainOnly(new Set());
    await r.loader.load('s');                        // reopened under the same id
    resolveFirst(real);
    await stale;
    expect(r.types().filter((t) => t === 'HISTORY_PAGE_LOADED')).toHaveLength(1);
  });

  it('not-now (a remote client awaiting its hydrate) is not recorded as asked', async () => {
    let allowed = false;
    const requests: TranscriptPageRequest[] = [];
    const loader = createFirstPageLoader({
      request: async (req) => { requests.push(req); return real; },
      dispatch: () => {}, mayLoad: () => allowed, sleep: async () => {},
    });
    await loader.load('s');
    allowed = true;
    await loader.load('s');
    expect(requests).toHaveLength(1);
  });
});
