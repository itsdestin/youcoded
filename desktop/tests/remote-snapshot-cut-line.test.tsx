// @vitest-environment jsdom
//
// Remote access batch 2, design §1 "the cut line" (T0).
//
// The snapshot a phone hydrates from must be serialized from the synchronous
// store AFTER the renderer's transcript batch is flushed — on the desktop
// before answering the export, on the phone before applying the hydrate.
// These tests drive the REAL batcher module and the REAL exporter component
// under jsdom with a real ChatProvider store; a fake of either would pass
// while the ordering they exist to guarantee was wrong.
import React, { useEffect } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { ChatProvider, useChatStore, type ChatStore } from '../src/renderer/state/chat-context';
import { RemoteSnapshotExporter } from '../src/renderer/components/RemoteSnapshotExporter';
import {
  installTranscriptBatcher,
  applyChatHydrate,
  type TranscriptBatcher,
} from '../src/renderer/state/transcript-batch';
import { serializeChatState, type ChatAction, type SerializedChatState } from '../src/renderer/state/chat-types';

type Holder = { store: ChatStore | null; batcher: TranscriptBatcher | null; dispatched: ChatAction[] };

// Mirrors App's transcript effect: the batcher is installed with the store's
// dispatch and disposed on cleanup. Nothing else App does is needed here.
// `dispatched` counts what the batcher handed the store — the reducer's uuid
// dedup would otherwise hide a double flush behind an unchanged state.
function Probe({ holder }: { holder: Holder }) {
  const store = useChatStore();
  holder.store = store;
  useEffect(() => {
    const batcher = installTranscriptBatcher((a) => { holder.dispatched.push(a); store.dispatch(a); });
    holder.batcher = batcher;
    return () => batcher.dispose();
  }, [store, holder]);
  return null;
}

// A manual animation-frame queue so the test decides when the frame fires.
let frames: FrameRequestCallback[] = [];
function runFrames() {
  const due = frames.splice(0);
  for (const cb of due) cb(performance.now());
}

let exportRequests: Array<(requestId: string) => void> = [];
let responses: Array<{ requestId: string; snapshot: SerializedChatState }> = [];

const realRaf = window.requestAnimationFrame;
const realCaf = window.cancelAnimationFrame;
let cancelled: number[] = [];
let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  frames = [];
  cancelled = [];
  exportRequests = [];
  responses = [];
  visibility = 'visible';
  window.requestAnimationFrame = (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; };
  window.cancelAnimationFrame = (id: number) => { cancelled.push(id); };
  (window as any).claude = {
    onChatExportSnapshot: (cb: (requestId: string) => void) => { exportRequests.push(cb); return () => {}; },
    sendChatSnapshotResponse: (payload: { requestId: string; snapshot: SerializedChatState }) => { responses.push(payload); },
  };
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as any).claude;
  window.requestAnimationFrame = realRaf;
  window.cancelAnimationFrame = realCaf;
  delete (document as any).visibilityState;
});

function mount() {
  const holder: Holder = { store: null, batcher: null, dispatched: [] };
  render(
    <ChatProvider>
      <Probe holder={holder} />
      <RemoteSnapshotExporter />
    </ChatProvider>,
  );
  act(() => { holder.store!.dispatch({ type: 'SESSION_INIT', sessionId: 's1' }); });
  return { store: holder.store!, batcher: holder.batcher!, dispatched: holder.dispatched };
}

function delta(uuid: string, text: string) {
  return { type: 'TRANSCRIPT_ASSISTANT_TEXT' as const, sessionId: 's1', uuid, text, timestamp: 1, partId: 'p1' };
}

function textOf(store: ChatStore): string[] {
  const s = store.getSession('s1');
  const out: string[] = [];
  for (const turn of s.assistantTurns.values()) {
    for (const seg of turn.segments) if (seg.type === 'text') out.push(seg.content);
  }
  return out;
}

describe('the desktop serializes AFTER flushing the transcript batch', () => {
  it('a native delta delivered in the frame before the export is in the snapshot, and applied once', () => {
    const { store, batcher, dispatched } = mount();
    // Two per-delta text events arrive; the frame that would apply them has not fired.
    batcher.push(delta('u1', 'Hel'));
    batcher.push(delta('u2', 'lo'));
    expect(textOf(store)).toEqual([]);           // still queued — the frame is pending

    act(() => { exportRequests[0]('req-1'); });    // main asks for the snapshot NOW

    expect(responses).toHaveLength(1);
    const sessions = new Map(responses[0].snapshot.sessions);
    const turns = sessions.get('s1')!.assistantTurns.map(([, t]) => t);
    expect(turns.flatMap((t) => t.segments.filter((s) => s.type === 'text').map((s: any) => s.content))).toEqual(['Hello']);

    // The frame fires later: the batch was consumed by the flush, so nothing is applied twice.
    expect(dispatched).toHaveLength(2);
    act(() => { runFrames(); });
    expect(dispatched).toHaveLength(2);           // the store was handed each delta exactly once
    expect(textOf(store)).toEqual(['Hello']);
  });

  it('the hidden-window case: a batch stalled on the 16 ms timer is flushed by the export too', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    visibility = 'hidden';
    const { store, batcher, dispatched } = mount();
    batcher.push(delta('u1', 'Hel'));
    batcher.push(delta('u2', 'lo'));
    expect(frames).toHaveLength(0);              // hidden → timer path, no frame requested
    expect(textOf(store)).toEqual([]);

    act(() => { exportRequests[0]('req-2'); });

    const sessions = new Map(responses[0].snapshot.sessions);
    const turns = sessions.get('s1')!.assistantTurns.map(([, t]) => t);
    expect(turns.flatMap((t) => t.segments.filter((s) => s.type === 'text').map((s: any) => s.content))).toEqual(['Hello']);

    act(() => { vi.runAllTimers(); });
    expect(dispatched).toHaveLength(2);
    expect(textOf(store)).toEqual(['Hello']);
  });

  it('hiding the window while a frame is pending hands the batch to the timer, so it cannot strand', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { store, batcher, dispatched } = mount();
    batcher.push(delta('u1', 'Hello'));
    expect(frames).toHaveLength(1);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));  // Electron suspends rAF from here on
    expect(cancelled).toEqual([1]);                          // the pending frame is withdrawn…
    act(() => { vi.advanceTimersByTime(16); });              // …and the timer applies the batch
    expect(dispatched).toHaveLength(1);
    expect(textOf(store)).toEqual(['Hello']);
  });

  it('a push after dispose neither queues nor arms a frame', () => {
    const { batcher, dispatched } = mount();
    batcher.dispose();
    batcher.push(delta('u1', 'late'));
    expect(frames).toHaveLength(0);
    batcher.flush();
    expect(dispatched).toHaveLength(0);
  });

  it('serializes the synchronous store, never a render-lagged ref', () => {
    const { store } = mount();
    // Dispatch straight into the store and ask for the snapshot in the SAME
    // tick, before React has re-rendered anything. A ref updated in an effect
    // would still hold the pre-dispatch state here.
    store.dispatch(delta('u1', 'Hello'));
    exportRequests[0]('req-3');
    const sessions = new Map(responses[0].snapshot.sessions);
    const turns = sessions.get('s1')!.assistantTurns.map(([, t]) => t);
    expect(turns.flatMap((t) => t.segments.filter((s) => s.type === 'text').map((s: any) => s.content))).toEqual(['Hello']);
  });
});

describe('the phone flushes ITS pending batch before applying a hydrate', () => {
  it('a stale turn-complete waiting for its frame cannot end the turn the snapshot shows in flight', () => {
    const { store, batcher } = mount();
    // The phone received, in order: a prompt, its answer, turn 1 complete, a
    // second prompt and the start of its answer — all in the frame before the
    // hydrate landed. None is applied yet.
    const events = [
      { type: 'TRANSCRIPT_USER_MESSAGE' as const, sessionId: 's1', uuid: 'm1', text: 'first question', timestamp: 1 },
      delta('u1', 'first answer'),
      { type: 'TRANSCRIPT_TURN_COMPLETE' as const, sessionId: 's1', uuid: 'u2', timestamp: 2, stopReason: 'end_turn', model: null, anthropicRequestId: null, usage: null },
      { type: 'TRANSCRIPT_USER_MESSAGE' as const, sessionId: 's1', uuid: 'm2', text: 'second question', timestamp: 3 },
      { type: 'TRANSCRIPT_ASSISTANT_TEXT' as const, sessionId: 's1', uuid: 'u3', text: 'second, still going', timestamp: 4, partId: 'p2' },
    ];
    for (const e of events) batcher.push(e);
    expect(store.getSession('s1').isThinking).toBe(false);

    // The host's snapshot, taken past the cut line: the same five events applied.
    const snapshot = snapshotFrom([{ type: 'SESSION_INIT', sessionId: 's1' }, ...events]);
    const hostSession = new Map(snapshot.sessions).get('s1')!;
    expect(hostSession.isThinking).toBe(true);   // turn 2 is in flight on the host

    act(() => { applyChatHydrate(store.dispatch, snapshot); });
    act(() => { runFrames(); });                  // the phone's frame fires after the hydrate

    const s = store.getSession('s1');
    expect(s.isThinking).toBe(true);              // turn 2 still in flight — not ended by the stale complete
    expect(s.currentTurnId).not.toBeNull();
    expect(textOf(store)).toEqual(['first answer', 'second, still going']);
  });
});

// Build a serialized snapshot by running actions through a real store.
function snapshotFrom(actions: Parameters<ChatStore['dispatch']>[0][]): SerializedChatState {
  let captured: ChatStore | null = null;
  function Grab() { captured = useChatStore(); return null; }
  const { unmount } = render(<ChatProvider><Grab /></ChatProvider>);
  act(() => { for (const a of actions) captured!.dispatch(a); });
  const out = serializeChatState(captured!.getState());
  unmount();
  return out;
}
