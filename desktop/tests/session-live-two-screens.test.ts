// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionRecords } from '../src/main/session-record';
import { createPublish } from '../src/main/publish';
import { SessionLiveFacts } from '../src/main/session-live';
import { openSession } from '../src/main/session-open';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState, type SessionChatState } from '../src/renderer/state/chat-types';
import { routeSessionLive } from '../src/renderer/state/transcript-batch';
import { dispatchSlashCommand } from '../src/renderer/state/slash-command-dispatcher';
import { DESKTOP_WINDOW_CAPABILITIES, ANDROID_LOCAL_CAPABILITIES } from '../src/shared/capabilities';
import { WindowRegistry } from '../src/main/window-registry';
import { SessionScreens, type ScreenTerminal } from '../src/main/session-screens';
import { findChannel } from '../src/main/ipc/channel-table';
import { applySessionLive } from '../src/renderer/state/apply-session-live';
import { Terminal } from '@xterm/headless';

// Two screens, one record (one-core R5-4a). For each live fact: act on screen A (the computer's window) and check screen B (a phone) shows the
// same WITHOUT B doing anything; and on the screen that typed, each divider and card appears exactly once. The host half is real (record,
// publish, the live-facts reader); each screen is a real chat reducer fed through the real route (`routeSessionLive`).
describe('two screens one record', () => {
  // A screen whose host keeps no session record and that reads its own terminal — the old Android runtime's shape, kept
  // for an older computer that sends no record (the Android app now runs the desktop backend, 2026-10-14).
  const NO_RECORD_SCREEN = { ...ANDROID_LOCAL_CAPABILITIES, sessionRecord: false, terminalTransport: 'raw-bytes' as const };

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
      facts.noteInput(S, '/model sonnet\r');
      for (const s of [A, B]) expect(s.get().modelAnnounced?.model).toBe('sonnet');
      // No divider from the host: it is drawn from the transcript's model-switch record (transcript-event-actions).
      expect(markers(A.get())).toEqual([]);
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
      for (const s of [A, B]) s.apply({ type: 'COMPACTION_COMPLETE', sessionId: S, operationId: s.get().compactionPending?.id, markerId: 'compact-done-x', afterContextTokens: 1000 });
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
      facts.noteInput(S, '/model opus\r');
      facts.noteInput(S, '/compact\r');
      expect(markers(A.get())).toEqual(['Conversation cleared']);
      expect(A.get().timeline.filter((e: any) => e.kind === 'compacting')).toHaveLength(1);
    });

    it('the Android app\'s own runtime, which has no record, still draws them from the screen', () => {
      const { A } = setup();
      run('/clear', NO_RECORD_SCREEN, A);
      run('/compact', NO_RECORD_SCREEN, A);
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
});

// The card path, end to end (one-core R5-4b): the computer's own copy of the terminal finds a card, the host publishes it, a phone draws it with no
// computer window involved, the phone answers, and the card is dismissed everywhere when the menu leaves. Nothing a screen sends can create or
// remove a card: the channel they used in R5-4a is gone.
describe('card path end to end', () => {
  const S = 's1', PHONE = -1001;
  const screen = () => {
    let st = new Map<string, SessionChatState>([[S, createSessionChatState()]]);
    const apply = (a: any) => { st = chatReducer(st, a); };
    return { apply, get: () => st.get(S)!, live: (p: any) => applySessionLive(p, { batcher: { push: apply }, contextTokens: () => null, isNative: () => false, setChipModel: () => {}, setSessionModel: () => {} }) };
  };
  const cards = (s: SessionChatState) => s.timeline.filter((e: any) => e.kind === 'prompt') as any[];

  // A usage-limit menu as Claude Code draws it (the parser titles it from the body's "limit to reset" sentence).
  const USAGE_MENU = ['You have hit your usage limit. Wait for the limit to reset, or upgrade.', 'What do you want to do?', '', '❯ 1. Stop and wait', '  2. Upgrade your plan', '', 'Enter to confirm · Esc to cancel'].join('\r\n');

  function rig() {
    const registry = new WindowRegistry();            // NO window registered at all: the computer has none open
    registry.registerSocket(PHONE);
    const records = new SessionRecords(); records.begin(S);
    const phone = screen();
    const publish = createPublish({
      records,
      toWindows: () => {},
      toSockets: (m, ids) => { if (m.type === 'session:live' && (!ids || ids.includes(PHONE))) phone.live(m.payload); },
      socketsFor: (sid) => registry.resolveAudience(sid).socketIds,
    });
    const live = new SessionLiveFacts({ publish, records, isClaude: () => true });
    let t = 1_000_000;
    let parsing = 0;
    const timers: Array<{ at: number; fn: () => void; dead?: boolean }> = [];
    const screens = new SessionScreens({
      records, live, isClaude: () => true, now: () => t,
      setTimer: (fn, ms) => { const e = { at: t + ms, fn }; timers.push(e); return e; },
      clearTimer: (h) => { (h as any).dead = true; },
      setRepeat: () => ({}), clearRepeat: () => {},
      // The real terminal, wrapped so the test can wait for its parsing to finish instead of sleeping.
      createTerminal: (cols, rows) => {
        const term = new Terminal({ cols, rows, allowProposedApi: true });
        return {
          get rows() { return term.rows; }, get buffer() { return term.buffer; },
          write: (d: string, cb?: () => void) => { parsing++; term.write(d, () => { parsing--; cb?.(); }); },
          resize: (c: number, r: number) => term.resize(c, r), dispose: () => term.dispose(),
        } as unknown as ScreenTerminal;
      },
    });
    records.onScreenNeedChange((id) => screens.refresh(id));
    const advance = async (ms: number) => {
      await vi.waitFor(() => expect(parsing).toBe(0));   // the terminal has taken in what was written
      const end = t + ms;
      for (;;) {
        const next = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at; next.dead = true; next.fn();
        await vi.waitFor(() => expect(parsing).toBe(0));
      }
      t = end;
    };
    const output = (data: string) => { screens.noteOutput(S, data); };
    return { registry, records, phone, screens, output, advance };
  }

  describe('the card path, end to end', () => {
    it('the computer finds the card with no window open; the phone draws it; answered, then dismissed everywhere when the menu leaves', async () => {
      const r = rig();
      r.registry.subscribe(S, PHONE);                         // the phone watches this conversation
      r.output(USAGE_MENU);
      await r.advance(500);                                    // the debounce, then the card
      expect(cards(r.phone.get())).toHaveLength(1);
      expect(cards(r.phone.get())[0].prompt.title).toBe('Usage Limit Reached');
      expect(r.records.openPrompts(S).map((p) => p.title)).toEqual(['Usage Limit Reached']);
      // The phone answers (its click writes the digit into the terminal; its own card shows the answer).
      r.phone.apply({ type: 'COMPLETE_PROMPT', sessionId: S, promptId: r.records.openPrompts(S)[0].promptId, selection: 'Stop and wait' });
      // The menu leaves the terminal.
      r.output('\x1b[2J\x1b[H❯ \r\n? for shortcuts');
      await r.advance(2000);
      expect(cards(r.phone.get()).map((c) => c.prompt.completed)).toEqual(['Stop and wait']);   // kept as the record of the answer, no live card
      expect(r.records.openPrompts(S)).toEqual([]);
      expect(r.records.liveFill(S).some((p: any) => p.payload.kind === 'prompt-show')).toBe(false);
    });

    it('a phone has no channel to create, remove or reconcile a card (the R5-4a reporting channel is gone)', () => {
      expect(findChannel('session:prompt-report')).toBeUndefined();
    });

    it('a card already open when a phone connects is handed to it', async () => {
      const r = rig();
      r.output(USAGE_MENU);
      await r.advance(500);
      const late = screen();
      for (const p of r.records.liveFill(S)) if (p.type === 'session:live') late.live(p.payload);
      expect(cards(late.get())).toHaveLength(1);
    });
  });
});
