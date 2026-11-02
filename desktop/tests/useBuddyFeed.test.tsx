// @vitest-environment jsdom
// The buddy window's feed: useBuddyFeed fills and listens for the ONE conversation the buddy chat shows. The buddy draws that
// conversation with the main window's ChatView (buddy rebuild, 2026-10-25), so drawing and folding are covered by ChatView's own
// tests; this file pins the FEED: the session:open fill, the live listeners, asks, refills and the shared event translator.
// Mounted as a tiny harness, with the chat store replaced by a dispatch spy so the assertions are the actions the feed applies.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { MATRIX } from './helpers/transcript-event-matrix';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), session: { compactionPending: false } }));
// A page with a message in it: an EMPTY page is ambiguous ("no history" or "not found yet") and the loader would retry it (first-page-retry.ts).
const aPage = (over: object = {}) => ({ events: [{ type: 'user-message', sessionId: 's1', uuid: 'p1', timestamp: 1, data: { text: 'hi' } }], cursor: null, hasMore: false, ...over });
const bridge = { listeners: {} as Record<string, Array<(...a: any[]) => void>>, open: vi.fn() as any };

vi.mock('../src/renderer/state/chat-context', () => ({
  useChatDispatch: () => mocks.dispatch,
  // The feed applies each frame through the store's one-notification path (the main window's batcher); here it lands on the same spy.
  // getSession is how the feed learns whether a compaction is pending (the translator needs it to tell a native marker from ours).
  useChatStore: () => ({ getSession: () => mocks.session, dispatchMany: (actions: unknown[]) => { for (const a of actions) mocks.dispatch(a); } }),
}));

beforeEach(() => {
  mocks.dispatch.mockClear();
  mocks.session = { compactionPending: false };
  // The feed owns its own IPC subscriptions (the buddy is a separate renderer from App.tsx). The feed is filled by `session:open` (as the
  // main window is), and what the answer carries is played back through the same listeners a live push reaches. `bridge.play` below is
  // the preload's `session.play`: it hands each push to the listeners registered for its channel.
  bridge.listeners = {};
  bridge.open = vi.fn().mockResolvedValue({ ok: true, resume: 'page', epoch: 'e', headSeq: 0, before: [], page: aPage(), after: [], facts: { working: false } });
  const on = (channel: string) => (h: (...a: any[]) => void) => { (bridge.listeners[channel] ??= []).push(h); return () => { bridge.listeners[channel] = bridge.listeners[channel].filter((x) => x !== h); }; };
  (window as any).claude = {
    capabilities: { sessionRecord: true }, // Current desktop/Android host, not the legacy fallback.
    on: {
      transcriptEvent: (h: any) => { on('transcript:event')(h); return h; },
      hookEvent: (h: any) => { on('hook:event')(h); return h; },
      specialistEvent: on('specialists:event'),
      shellEvent: on('native:shell-event'),
      sessionLive: on('session:live'),
      hookReplayComplete: on('hook:replay-complete'),
    },
    off: () => {},
    session: {
      open: (req: unknown) => bridge.open(req),
      onRefill: (cb: (sid: string) => void) => { (bridge.listeners['refill'] ??= []).push(cb as any); return () => {}; },
      play: (pushes: Array<{ type: string; payload: unknown }>) => { for (const p of pushes) for (const h of bridge.listeners[p.type] ?? []) h(p.payload); },
    },
    detach: { requestTranscriptPage: () => Promise.resolve(null) },
  };
});

import { useBuddyFeed } from '../src/renderer/components/buddy/useBuddyFeed';

// The harness: the hook draws nothing, so this renders nothing.
function Feed({ sessionId }: { sessionId: string }) { useBuddyFeed(sessionId); return null; }

describe('useBuddyFeed paging', () => {
  it('passes the first page’s interrupted tools to its own chat reducer', async () => {
    bridge.open.mockResolvedValue({ ok: true, resume: 'page', epoch: 'e', headSeq: 0, before: [], after: [], facts: { working: false },
      page: aPage({ reconcileInterrupted: true, reconcileInterruptedToolIds: ['pre-resume-tool'] }) });
    render(<Feed sessionId="s1" />);
    await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'HISTORY_PAGE_LOADED', sessionId: 's1', reconcileInterrupted: true,
      reconcileInterruptedToolIds: ['pre-resume-tool'],
    })));
  });
});

// One-core sync-fix3 (audit item 1): the buddy used to fill from a page alone and listen to no `session:live`, so a conversation's compaction spinner,
// cards, queue strip and dividers, and an ask raised before the buddy looked at it, never appeared in it.
describe('useBuddyFeed is filled the way the main window is', () => {
  const live = (over: object) => ({ sessionId: 's1', ...over });
  const reply = (after: Array<{ type: string; payload: unknown }>, before: Array<{ type: string; payload: unknown }> = []) =>
    ({ ok: true, resume: 'page', epoch: 'e', headSeq: 3, before, page: aPage(), after, facts: { working: true } });
  const types = () => mocks.dispatch.mock.calls.map((c) => c[0].type);

  it('asks `session:open` for its conversation (not a bare page) and starts from a fresh page', async () => {
    render(<Feed sessionId="s1" />);
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalled());
    expect(bridge.open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', fresh: true }));
  });

  it('applies the compaction spinner, an open prompt card, the dividers and an ask that were all raised BEFORE the buddy looked', async () => {
    const ask = { type: 'PermissionRequest', sessionId: 's1', payload: { _requestId: 'r1', tool_name: 'Bash', tool_input: { command: 'ls' } }, timestamp: 1 };
    bridge.open.mockResolvedValue(reply([
      { type: 'hook:event', payload: ask },
      { type: 'session:live', payload: live({ kind: 'prompt-show', promptId: 'p1', title: 'Usage limit', buttons: [] }) },
      { type: 'session:live', payload: live({ kind: 'compact-start', id: 'c1' }) },
      { type: 'hook:replay-complete', payload: { sessionId: 's1', pendingRequestIds: ['r1'] } },
    ], [
      { type: 'session:live', payload: live({ kind: 'model-switch', id: 'ms1', label: 'Model switched to Opus' }) },
      { type: 'session:live', payload: live({ kind: 'clear', id: 'cl1' }) },
    ]));
    render(<Feed sessionId="s1" />);
    await vi.waitFor(() => expect(types()).toEqual(expect.arrayContaining([
      'MODEL_SWITCH_MARKER', 'CLEAR_TIMELINE', 'SESSION_FILL_RESET', 'HISTORY_PAGE_LOADED', 'PERMISSION_REQUEST', 'SHOW_PROMPT', 'COMPACTION_PENDING', 'PERMISSION_REPLAY_COMPLETE',
    ])));
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'COMPACTION_PENDING', hostOwned: true }));
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'PERMISSION_REPLAY_COMPLETE', sessionId: 's1', pendingRequestIds: ['r1'] });
    // the divider that was in the record's past lands BEFORE the page, which prepends below it (the fill's order)
    expect(types().indexOf('MODEL_SWITCH_MARKER')).toBeLessThan(types().indexOf('HISTORY_PAGE_LOADED'));
  });

  it('keeps listening: a live `session:live` for this conversation is applied, one for another conversation is not', async () => {
    render(<Feed sessionId="s1" />);
    await vi.waitFor(() => expect(bridge.listeners['session:live']?.length).toBeGreaterThan(0));
    mocks.dispatch.mockClear();
    act(() => { for (const h of bridge.listeners['session:live']) { h(live({ kind: 'compact-start', id: 'live1' })); h({ sessionId: 'other', kind: 'compact-start', id: 'x' }); } });
    await vi.waitFor(() => expect(types()).toContain('COMPACTION_PENDING'));
    expect(mocks.dispatch.mock.calls.filter((c) => c[0].type === 'COMPACTION_PENDING')).toHaveLength(1);
  });

  it('clears an ask card when the ask ends elsewhere (the computer now tells the watching buddy)', async () => {
    render(<Feed sessionId="s1" />);
    await vi.waitFor(() => expect(bridge.listeners['hook:event']?.length).toBeGreaterThan(0));
    mocks.dispatch.mockClear();
    act(() => { for (const h of bridge.listeners['hook:event']) h({ type: 'PermissionResolved', sessionId: 's1', payload: { _requestId: 'r1' }, timestamp: 2 }); });
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: 'PERMISSION_RESOLVED_ELSEWHERE', sessionId: 's1', requestId: 'r1' });
  });

  it('fills again from a fresh page when the computer says its hold expired (session:refill), for its own conversation only', async () => {
    render(<Feed sessionId="s1" />);
    await vi.waitFor(() => expect(types()).toContain('HISTORY_PAGE_LOADED'));   // the first fill has finished
    await vi.waitFor(() => expect(bridge.listeners['refill']?.length).toBeGreaterThan(0));
    await act(async () => { bridge.listeners['refill'].forEach((h) => { h('other' as any); h('s1' as any); }); });
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(2));
    expect(bridge.open).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 's1', fresh: true }));
  });

  it('a filled conversation\'s replayed skill card and /clear are applied (the three gaps are closed), the clear line once from the record', async () => {
    bridge.open.mockResolvedValue(reply([], [
      { type: 'transcript:event', payload: { type: 'skill-invoked', sessionId: 's1', uuid: 'k1', timestamp: 1, data: { skillId: 'x', displayName: 'X', body: 'b' } } },
      { type: 'transcript:event', payload: { type: 'context-clear', sessionId: 's1', uuid: 'k2', timestamp: 2, data: {} } },
      { type: 'session:live', payload: { sessionId: 's1', kind: 'clear', id: 'clear-k2', at: 2 } },
    ]));
    render(<Feed sessionId="s1" />);
    await vi.waitFor(() => expect(types()).toContain('HISTORY_PAGE_LOADED'));
    expect(types()).toContain('TRANSCRIPT_SKILL_INVOKED');
    const clears = mocks.dispatch.mock.calls.map((c) => c[0]).filter((a) => a.type === 'CLEAR_TIMELINE');
    expect(clears.map((a) => a.markerId)).toEqual([undefined, 'clear-k2']); // the event resets, the record's line draws
  });
});

describe('useBuddyFeed live transcript events', () => {
  // Delivers one live event the way the buddy window's IPC would, with the
  // animation-frame batcher flushed by hand, and returns what was dispatched.
  function deliver(event: Record<string, unknown>, session: { compactionPending: boolean } = { compactionPending: false }) {
    mocks.session = session;
    let handler: (e: unknown) => void = () => {};
    (window as any).claude.on.transcriptEvent = (h: (e: unknown) => void) => { handler = h; return h; };
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    render(<Feed sessionId="s1" />);
    mocks.dispatch.mockClear();
    handler({ sessionId: 's1', uuid: 'u1', timestamp: 500, ...event });
    act(() => { for (const f of frames.splice(0)) f(0); });
    return mocks.dispatch.mock.calls.map((c) => c[0] as { type: string });
  }

  // Delivers one `session:live` push the way the computer would, through the registered listener.
  function deliverLive(live: Record<string, unknown>) {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    render(<Feed sessionId="s1" />);
    mocks.dispatch.mockClear();
    for (const h of bridge.listeners['session:live'] ?? []) h({ sessionId: 's1', ...live });
    act(() => { for (const f of frames.splice(0)) f(0); });
    return mocks.dispatch.mock.calls.map((c) => c[0] as { type: string });
  }

  it('shows the same compaction marker as the main window: event id, freed-token counts, summary', () => {
    const calls = deliver(
      { type: 'compact-summary', data: { summary: 'S', autoCompaction: true, contextUsedBefore: 900, contextUsedAfter: 100 } },
    );
    expect(calls).toContainEqual(expect.objectContaining({
      type: 'COMPACTION_COMPLETE', markerId: 'compact-done-u1',
      beforeContextTokens: 900, afterContextTokens: 100, summary: 'S', auto: true,
    }));
  });

  it('restores a native compaction marker this window did not start', () => {
    const calls = deliver({ type: 'compact-summary', data: { summary: 'S', contextUsedAfter: 100 } });
    expect(calls).toContainEqual(expect.objectContaining({ type: 'COMPACTION_COMPLETE',
      recorded: true, timestamp: 500, markerId: 'compact-done-u1', summary: 'S' }));
  });

  it('does not turn a Claude Code resume summary into a fresh compaction', () => {
    const calls = deliver({ type: 'compact-summary', data: { summary: 'Resume summary' } });
    expect(calls.map((c) => c.type)).not.toContain('COMPACTION_COMPLETE');
  });

  it('applies EVERY event type and payload exactly as the shared translator says (no skipped types)', () => {
    // The buddy listener routes through the same translator as the main window for everything, so it can never again forget a type
    // (replay-complete, PR #287) or skip one by choice (the three gaps closed in sync-fix6).
    for (const c of MATRIX) {
      const expected = eventToAction(c.event, { live: true, compactionPending: c.ctx?.compactionPending, fallbackContextTokens: null });
      expect(deliver({ ...c.event }, { compactionPending: c.ctx?.compactionPending ?? false }), c.name).toEqual(expected);
    }
  });

  // The three gaps Destin closed (2026-10-04): the buddy's chat shows the same lines as the main window. Each is red on the old ledger, which dropped them.
  it('shows "Interrupted": an interrupt reaches the buddy\'s chat', () => {
    expect(deliver({ type: 'user-interrupt', data: { kind: 'plain' } }))
      .toContainEqual(expect.objectContaining({ type: 'TRANSCRIPT_INTERRUPT', kind: 'plain' }));
  });

  it('shows the skill-used card', () => {
    expect(deliver({ type: 'skill-invoked', data: { skillId: 'brainstorm', displayName: 'Brainstorm', body: 'long instructions' } }))
      .toContainEqual(expect.objectContaining({ type: 'TRANSCRIPT_SKILL_INVOKED', skillId: 'brainstorm', displayName: 'Brainstorm' }));
  });

  it('resets the turn on a clear, and the divider comes from the computer\'s record, once', () => {
    const calls = deliver({ type: 'context-clear', data: { contextUsedAfter: 1 } });
    expect(calls).toContainEqual(expect.objectContaining({ type: 'CLEAR_TIMELINE' }));
    expect((calls.find((c) => c.type === 'CLEAR_TIMELINE') as { markerId?: string }).markerId).toBeUndefined();
    // The record's own line (session:live) is what draws "Conversation cleared": it reaches the buddy through the shared feed.
    const live = deliverLive({ kind: 'clear', id: 'clear-u1', at: 700 });
    expect(live).toContainEqual(expect.objectContaining({ type: 'CLEAR_TIMELINE', markerId: 'clear-u1', timestamp: 700 }));
  });

  it('ignores an event type nobody has heard of without throwing', () => {
    expect(deliver({ type: 'streaming-text' })).toEqual([]);
  });

  it('treats a wire type named after an inherited object property as unknown', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(deliver({ type }), type).toEqual([]);
    }
  });

  it('stamps a tool-use with the event timestamp', () => {
    expect(deliver({ type: 'tool-use', data: { toolUseId: 't', toolName: 'Read' } }))
      .toContainEqual(expect.objectContaining({ type: 'TRANSCRIPT_TOOL_USE', timestamp: 500 }));
  });
});
