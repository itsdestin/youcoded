// @vitest-environment jsdom
// Two screens, one record (one-core R5-4a). For each live fact: act on screen A (the computer's window) and check screen B (a phone) shows the
// same WITHOUT B doing anything; and on the screen that typed, each divider and card appears exactly once. The host half is real (record,
// publish, the live-facts reader); each screen is a real chat reducer fed through the real route (`routeSessionLive`).
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRecords } from '../src/main/session-record';
import { createPublish } from '../src/main/publish';
import { SessionLiveFacts } from '../src/main/session-live';
import { openSession } from '../src/main/session-open';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState, type SessionChatState } from '../src/renderer/state/chat-types';
import { routeSessionLive } from '../src/renderer/state/transcript-batch';
import { dispatchSlashCommand } from '../src/renderer/state/slash-command-dispatcher';
import { DESKTOP_WINDOW_CAPABILITIES, ANDROID_LOCAL_CAPABILITIES } from '../src/shared/capabilities';

const S = 's1';
function screen() {
  let state = new Map<string, SessionChatState>([[S, createSessionChatState()]]);
  const apply = (a: any) => { state = chatReducer(state, a); };
  return {
    get: () => state.get(S)!,
    apply,
    live: (p: any) => routeSessionLive(p, { batcher: { push: apply }, contextTokens: () => 5000, now: () => 1 }),
  };
}
const markers = (s: SessionChatState) => s.timeline.filter((e: any) => e.kind === 'system-marker').map((e: any) => e.marker.label);

function setup() {
  const records = new SessionRecords();
  records.begin(S);
  const A = screen(), B = screen();
  const publish = createPublish({
    records,
    toWindows: (_s, ch, args) => { if (ch === 'session:live') A.live(args[0]); },
    toSockets: (m) => { if (m.type === 'session:live') B.live(m.payload); },
  });
  const facts = new SessionLiveFacts({ publish, records, isClaude: () => true });
  return { records, A, B, publish, facts };
}

describe('two screens match with no reply from the second', () => {
  it('queue: a message queued on the computer shows on the phone, and is gone from both when cancelled', () => {
    const { A, B, publish } = setup();
    const q1 = [{ queueId: 'q1', content: 'next thing', timestamp: 1 }];
    publish(S, 'session:live', { sessionId: S, kind: 'queue', queue: q1 });
    expect(A.get().queuedMessages).toEqual(q1);
    expect(B.get().queuedMessages).toEqual(q1);
    publish(S, 'session:live', { sessionId: S, kind: 'queue', queue: [] });   // cancelled from the phone: the host announces the new queue
    expect(A.get().queuedMessages).toEqual([]);
    expect(B.get().queuedMessages).toEqual([]);
  });

  it('model: /model typed on one screen changes the chip on the other at once, and a later reply replaces it', () => {
    const { A, B, facts } = setup();
    facts.noteInput(S, '/model sonnet\r', 'model-switch');
    for (const s of [A, B]) expect(s.get().modelAnnounced?.model).toBe('sonnet');
    // The typed command's divider: once on each screen.
    expect(markers(A.get())).toEqual(['Model switched to Sonnet']);
    expect(markers(B.get())).toEqual(['Model switched to Sonnet']);
  });

  it('clear: the SessionStart hook draws "Conversation cleared" once on both', () => {
    const { A, B, facts } = setup();
    facts.noteSessionStart(S, 'clear', 'new-id');
    expect(markers(A.get())).toEqual(['Conversation cleared']);
    expect(markers(B.get())).toEqual(['Conversation cleared']);
  });

  it('compaction: the spinner shows on both; the summary line ends it on both with the same note', () => {
    const { A, B, facts } = setup();
    facts.noteInput(S, '/compact\r');
    for (const s of [A, B]) {
      expect(s.get().compactionPending).not.toBeNull();
      expect(s.get().timeline.some((e: any) => e.kind === 'compacting')).toBe(true);
    }
    for (const s of [A, B]) s.apply({ type: 'COMPACTION_COMPLETE', sessionId: S, markerId: 'compact-done-x', afterContextTokens: 1000 });
    for (const s of [A, B]) { expect(s.get().compactionPending).toBeNull(); expect(markers(s.get())).toEqual(['Compacted · freed 4,000 tokens']); }
  });

  it('prompt card: found by the computer in the terminal, drawn once on both, removed on both when dismissed', () => {
    const { A, B, facts } = setup();
    const card = { promptId: 'p1', title: 'Usage Limit Reached', buttons: [{ label: 'Stop and wait', input: '2' }] };
    facts.showPrompt(S, card); facts.showPrompt(S, card);
    for (const s of [A, B]) expect(s.get().timeline.filter((e: any) => e.kind === 'prompt')).toHaveLength(1);
    facts.dismissPrompt(S, 'p1');
    for (const s of [A, B]) expect(s.get().timeline.filter((e: any) => e.kind === 'prompt')).toHaveLength(0);
  });

  it('the stuck banner: the computer says it once and both screens show it, and clearing it clears only its own', () => {
    const { A, B, facts } = setup();
    facts.attention(S, 'stuck');
    for (const s of [A, B]) expect(s.get().attentionState).toBe('stuck');
    A.apply({ type: 'ATTENTION_STATE_CHANGED', sessionId: S, state: 'error' });
    facts.attention(S, 'ok');
    expect(A.get().attentionState).toBe('error'); // somebody else's state is not wiped by the computer taking back its own
    expect(B.get().attentionState).toBe('ok');
  });

  it('a screen that opens mid-compaction with a card open is handed both (the spinner a phone joining mid-compaction used to lose)', async () => {
    const { records, facts } = setup();
    facts.noteInput(S, '/compact\r');
    facts.showPrompt(S, { promptId: 'p9', title: 'Resume Session', buttons: [] });
    const reply: any = await openSession({
      records, knows: () => true, native: () => null,
      page: async () => ({ events: [], cursor: null, hasMore: false }),
    }, { sessionId: S });
    const late = screen();
    for (const p of reply.after) if (p.type === 'session:live') late.live(p.payload);
    expect(late.get().compactionPending).not.toBeNull();
    expect(late.get().timeline.filter((e: any) => e.kind === 'prompt')).toHaveLength(1);
  });

  it('a native queue is the host\'s truth for a fresh screen (an empty list clears stale rows)', async () => {
    const { records } = setup();
    const native = { askEvents: () => [], specialistRuns: () => [], shellRuns: () => [], usageProgress: () => null, sessionContext: () => null, idle: () => false,
      queue: () => [{ queueId: 'q7', content: 'waiting', timestamp: 3 }], permissionMode: () => 'ask' };
    const reply: any = await openSession({ records, knows: () => true, native: () => native as any, page: async () => ({ events: [], cursor: null, hasMore: false }) }, { sessionId: S });
    const fresh = screen();
    for (const p of reply.after) if (p.type === 'session:live') fresh.live(p.payload);
    expect(fresh.get().queuedMessages.map((q) => q.queueId)).toEqual(['q7']);
    expect(reply.after.some((p: any) => p.type === 'native:permission-mode' && p.payload.mode === 'ask')).toBe(true);
  });
});

describe('the screen that typed draws each line exactly once', () => {
  const run = (raw: string, caps: any, A: ReturnType<typeof screen>) => {
    (window as any).claude = { capabilities: caps };
    dispatchSlashCommand({ raw, sessionId: S, view: 'chat', files: [], dispatch: A.apply, timeline: [], callbacks: { onModelSwitchCommand: () => 'sent', getUsageSnapshot: () => null } as any } as any);
  };
  beforeEach(() => { delete (window as any).claude; });

  it('with a host record, /clear, /compact and /model draw nothing themselves; the host\'s event draws them once', () => {
    const { A, facts } = setup();
    run('/clear', DESKTOP_WINDOW_CAPABILITIES, A);
    run('/compact', DESKTOP_WINDOW_CAPABILITIES, A);
    run('/model opus', DESKTOP_WINDOW_CAPABILITIES, A);
    expect(markers(A.get())).toEqual([]);
    expect(A.get().compactionPending).toBeNull();
    facts.noteSessionStart(S, 'clear', 'c');
    facts.noteInput(S, '/model opus\r', 'model-switch');
    facts.noteInput(S, '/compact\r');
    expect(markers(A.get())).toEqual(['Conversation cleared', 'Model switched to Opus']);
    expect(A.get().timeline.filter((e: any) => e.kind === 'compacting')).toHaveLength(1);
  });

  it('the Android app\'s own runtime, which has no record, still draws them from the screen', () => {
    const { A } = setup();
    run('/clear', ANDROID_LOCAL_CAPABILITIES, A);
    run('/compact', ANDROID_LOCAL_CAPABILITIES, A);
    expect(markers(A.get())).toEqual(['Conversation cleared']);
    expect(A.get().compactionPending).not.toBeNull();
  });

  it('the same event delivered twice draws one divider', () => {
    const { A, facts } = setup();
    facts.noteSessionStart(S, 'clear', 'dup');
    A.live({ sessionId: S, kind: 'clear', id: 'clear-dup' });
    expect(markers(A.get())).toEqual(['Conversation cleared']);
  });
});
