// @vitest-environment jsdom
//
// Regression for the 2026-09-28 load-sensitive flake in
// journeys/permission-approve.json step 8: TRANSCRIPT_ASSISTANT_TEXT deltas
// are rAF-batched (transcript-batch.ts), but a hook-derived action (e.g.
// PermissionRequest) used to dispatch immediately. Under a stalled frame, a
// hook action that is logically LATER than an in-flight text stream could
// apply to the reducer FIRST, inserting a tool-group segment mid-stream and
// splitting one assistant bubble into two. applyHookEvent
// (state/hook-dispatcher.ts) fixes this by flushing the transcript batch
// before it dispatches — shared by App.tsx (main window) and useBuddyFeed.ts
// (buddy window), both of which have their own transcript batcher instance
// (a separate BrowserWindow/renderer process each) but reach the SAME
// module-level `active` pointer via transcript-batch.ts's flush/install
// pair. These tests drive the REAL batcher, the REAL reducer and (for
// useBuddyFeed) the REAL component — a fake of any would pass while the
// ordering it exists to guarantee was wrong. Modeled on
// tests/remote-snapshot-cut-line.test.tsx, which pins the same module for a
// different caller (the remote snapshot exporter).
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { ChatProvider, useChatStore, type ChatStore } from '../src/renderer/state/chat-context';
import { useBuddyFeed } from '../src/renderer/components/buddy/useBuddyFeed';
import { installTranscriptBatcher, type TranscriptBatcher } from '../src/renderer/state/transcript-batch';
import { applyHookEvent } from '../src/renderer/state/hook-dispatcher';
import type { HookEvent } from '../src/shared/types';

// A manual animation-frame queue: frames are recorded, never fired, so every
// test controls exactly when a "stalled" batch would otherwise flush.
const realRaf = window.requestAnimationFrame;
const realCaf = window.cancelAnimationFrame;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  frames = [];
  window.requestAnimationFrame = (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; };
  window.cancelAnimationFrame = () => {};
});

afterEach(() => {
  cleanup();
  window.requestAnimationFrame = realRaf;
  window.cancelAnimationFrame = realCaf;
  delete (window as any).claude;
  delete (window as any).IntersectionObserver;
});

function textDelta(uuid: string, text: string, partId = 'p1') {
  return { type: 'TRANSCRIPT_ASSISTANT_TEXT' as const, sessionId: 's1', uuid, text, timestamp: 1, partId };
}

const permissionRequest: HookEvent = {
  type: 'PermissionRequest',
  sessionId: 's1',
  timestamp: 1,
  payload: { tool_name: 'mcp__google_calendar__create_event', tool_input: {}, _requestId: 'req-1' },
};

function textSegments(store: ChatStore) {
  const session = store.getSession('s1');
  const turn = [...session.assistantTurns.values()].at(-1);
  return turn ? turn.segments : [];
}

describe('applyHookEvent flushes the transcript batch before a hook action lands', () => {
  function Probe({ holder }: { holder: { store: ChatStore | null } }) {
    holder.store = useChatStore();
    return null;
  }

  function mount() {
    const holder: { store: ChatStore | null } = { store: null };
    render(<ChatProvider><Probe holder={holder} /></ChatProvider>);
    act(() => { holder.store!.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
    return holder.store!;
  }

  it('a same-partId text stream stays ONE segment, before the tool group, even when a hook action lands mid-stream', () => {
    const store = mount();
    const batcher: TranscriptBatcher = installTranscriptBatcher(store.dispatchMany);
    // WHY try/finally: a failed expectation must still remove the batcher, or its
    // installed hooks leak into the next test in this file.
    try {
      // Two chunks of the SAME streamed message queue up — the frame that would
      // apply them has not fired (mirrors a stalled rAF under CPU load). This is
      // the real production shape: a script (or the native harness) dispatches
      // every chunk of one message before moving on to the next thing, so by
      // the time a permission ask for the NEXT step fires, every chunk of THIS
      // message is already queued, just not yet applied.
      batcher.push(textDelta('u1', 'Draft is in for your review. Now'));
      batcher.push(textDelta('u2', ' the invites.'));
      expect(textSegments(store)).toEqual([]);

      // A permission ask for a tool with no card yet lands NOW — the synchronous
      // dispatch that used to jump ahead of the still-queued text above.
      act(() => { applyHookEvent(permissionRequest, store.dispatch); });

      // Exactly one text segment carrying the FULL merged text, and it comes
      // BEFORE the tool group the permission ask opened.
      const segments = textSegments(store);
      expect(segments.map((s) => s.type)).toEqual(['text', 'tool-group']);
      expect((segments[0] as { content: string }).content).toBe('Draft is in for your review. Now the invites.');
    } finally {
      batcher.dispose();
    }
  });
});

// The buddy's feed hook draws nothing, so the harness renders no DOM.
function Feed({ sessionId }: { sessionId: string }) { useBuddyFeed(sessionId); return null; }

describe('useBuddyFeed (buddy window) applies the same protection through the shared batcher', () => {
  let transcriptHandler: ((event: unknown) => void) | null = null;
  let hookHandler: ((event: unknown) => void) | null = null;

  beforeEach(() => {
    transcriptHandler = null;
    hookHandler = null;
    (window as any).claude = {
      on: {
        transcriptEvent: (h: (event: unknown) => void) => { transcriptHandler = h; return h; },
        hookEvent: (h: (event: unknown) => void) => { hookHandler = h; return h; },
        specialistEvent: () => () => {},
        shellEvent: () => () => {},
      },
      off: () => {},
      detach: { requestTranscriptPage: () => Promise.resolve(null) },
    };
  });

  it('a same-partId text stream stays ONE segment across a mid-stream PermissionRequest', () => {
    let store: ChatStore | null = null;
    function Probe() { store = useChatStore(); return null; }
    render(<ChatProvider><Probe /><Feed sessionId="s1" /></ChatProvider>);
    expect(transcriptHandler).not.toBeNull();
    expect(hookHandler).not.toBeNull();

    // Both chunks of the SAME streamed message queue up in the feed's own
    // batcher first — mirrors the real order (a message's chunks all arrive
    // before the NEXT step's permission ask does) with a stalled frame.
    act(() => { transcriptHandler!({ type: 'assistant-text', sessionId: 's1', uuid: 'u1', timestamp: 1, data: { text: 'Draft is in for your review. Now', partId: 'p1' } }); });
    act(() => { transcriptHandler!({ type: 'assistant-text', sessionId: 's1', uuid: 'u2', timestamp: 2, data: { text: ' the invites.', partId: 'p1' } }); });
    expect(textSegments(store!)).toEqual([]);   // queued in the feed's own batcher, not yet applied

    act(() => { hookHandler!(permissionRequest); });   // useBuddyFeed's hook effect: applyHookEvent flushes first

    const segments = textSegments(store!);
    expect(segments.map((s) => s.type)).toEqual(['text', 'tool-group']);
    expect((segments[0] as { content: string }).content).toBe('Draft is in for your review. Now the invites.');
  });
});
