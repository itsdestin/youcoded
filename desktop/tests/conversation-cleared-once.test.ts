// @vitest-environment jsdom
// "Conversation cleared" is drawn EXACTLY ONCE on every screen, for BOTH runtimes, live and after a reload (sync-fix6, Destin 2026-10-04).
//
// Before: a Claude Code clear came from the computer's record (`session:live`) and a native clear from the `context-clear` transcript event,
// two sources by runtime. Now the record says it for both and the event only resets the turn, so a double draw would need two sources to
// reappear. The host half here is REAL (record, publish, the live-facts reader); each screen is a real reducer fed through the same
// translators the windows use; a reload goes through the real `session:open` answer with the page the disk would hold.
import { describe, it, expect } from 'vitest';
import { SessionRecords } from '../src/main/session-record';
import { createPublish } from '../src/main/publish';
import { SessionLiveFacts } from '../src/main/session-live';
import { openSession } from '../src/main/session-open';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { applyOpenReply, type OpenOk } from '../src/renderer/state/session-fill';
import { routeSessionLive } from '../src/renderer/state/transcript-batch';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { createSessionChatState, type ChatState } from '../src/renderer/state/chat-types';
import { playInto } from './helpers/fill-harness';
import { newState, screenOf } from './helpers/fill-scenarios';
import { ev } from './helpers/transcript-events';
import type { TranscriptEvent } from '../src/shared/types';

const S = 's1';
const CLEARED = 'marker: Conversation cleared';

/** A screen: transcript pushes through `eventToAction` (live), `session:live` pushes through the shared router, in arrival order. */
function screen() {
  let st: ChatState = new Map([[S, createSessionChatState()]]);
  const apply = (a: any) => { st = chatReducer(st, a); };
  return {
    get: () => st,
    push(channel: string, payload: any) {
      if (channel === 'transcript:event') for (const a of eventToAction(payload, { live: true })) apply(a);
      else if (channel === 'session:live') routeSessionLive(payload, { batcher: { push: apply }, contextTokens: () => null });
    },
  };
}

function host(kind: 'claude' | 'native') {
  const records = new SessionRecords();
  records.begin(S);
  const window = screen(), phone = screen();
  const publish = createPublish({
    records,
    toWindows: (_s, ch, args) => window.push(ch, args[0]),
    toSockets: (m) => phone.push(m.type, m.payload),
  });
  const facts = new SessionLiveFacts({ publish, records, isClaude: () => kind === 'claude' });
  /** What the main process does for a native clear (ipc-handlers' native listener). */
  const nativeClear = (e: TranscriptEvent) => { publish(S, 'transcript:event', e); facts.nativeCleared(S, e.uuid, e.timestamp); };
  return { records, window, phone, facts, publish, nativeClear };
}

const hello = ev('user-message', { text: 'hello' }, { sessionId: S, uuid: 'u1', timestamp: 1000 });
const clearEvent = ev('context-clear', { contextUsedAfter: 0 }, { sessionId: S, uuid: 'c1', timestamp: 2000 });
const after = ev('user-message', { text: 'after' }, { sessionId: S, uuid: 'u2', timestamp: 3000 });
const dividers = (st: ChatState) => screenOf(st)!.timeline.filter((l) => l === CLEARED).length;

async function reload(records: SessionRecords, page: TranscriptEvent[]) {
  const reply = await openSession({ records, knows: () => true, native: () => null, page: async () => ({ events: page, cursor: null, hasMore: false }) }, { sessionId: S, fresh: true });
  const st = { value: newState() };
  applyOpenReply({ dispatch: (a) => { st.value = chatReducer(st.value, a); }, flush: () => {}, play: (p) => playInto(st, p) }, S, reply as OpenOk, { acceptPage: true });
  return st.value;
}

describe('native clear', () => {
  it('draws the line once on the window AND the phone, between the messages it separates', () => {
    const h = host('native');
    h.publish(S, 'transcript:event', hello);
    h.nativeClear(clearEvent);
    h.publish(S, 'transcript:event', after);
    for (const s of [h.window, h.phone]) {
      expect(screenOf(s.get())!.timeline).toEqual(['user: hello', CLEARED, 'user: after']);
    }
  });

  it('the clear EVENT alone draws nothing (a second source would be a double draw)', () => {
    const h = host('native');
    h.publish(S, 'transcript:event', clearEvent);
    expect(dividers(h.window.get())).toBe(0);
  });

  it('a replay of the same clear (the event and the line delivered again) still shows one line', () => {
    const h = host('native');
    h.nativeClear(clearEvent);
    h.nativeClear(clearEvent);
    expect(dividers(h.window.get())).toBe(1);
  });

  it('reloaded: the record holds the line AND the disk page holds the event, and the screen shows one line, in order', async () => {
    const h = host('native');
    h.publish(S, 'transcript:event', hello);
    h.nativeClear(clearEvent);
    h.publish(S, 'transcript:event', after);
    const st = await reload(h.records, [hello, clearEvent, after]);
    expect(screenOf(st)!.timeline).toEqual(['user: hello', CLEARED, 'user: after']);
  });

  it('reloaded when the record has rolled past the clear: the page alone draws it once, where it happened', async () => {
    const h = host('native');
    h.publish(S, 'transcript:event', after);
    const st = await reload(h.records, [hello, clearEvent, after]);
    expect(screenOf(st)!.timeline).toEqual(['user: hello', CLEARED, 'user: after']);
  });
});

describe('Claude Code clear', () => {
  it('draws the line once on the window AND the phone, even if the typed-/clear fallback and the SessionStart hook both fire', () => {
    const h = host('claude');
    h.publish(S, 'transcript:event', hello);
    h.facts.noteSessionStart(S, 'clear', 'new-id');
    h.facts.noteSessionStart(S, 'clear', 'new-id');   // a replayed hook
    for (const s of [h.window, h.phone]) expect(dividers(s.get())).toBe(1);
  });

  it('a Claude Code host never says the native line (no second source by runtime)', () => {
    const h = host('claude');
    h.facts.nativeCleared(S, 'c1', 1);
    expect(dividers(h.window.get())).toBe(0);
  });

  it('reloaded: the record\'s line shows once (the disk has no clear event for Claude Code)', async () => {
    const h = host('claude');
    h.publish(S, 'transcript:event', hello);
    h.facts.noteSessionStart(S, 'clear', 'new-id');
    const st = await reload(h.records, [hello]);
    expect(dividers(st)).toBe(1);
  });
});
