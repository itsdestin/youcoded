// @vitest-environment jsdom
// The card path, end to end through the real channel (one-core R5-4a review): a window reports a card, the host publishes it, a phone draws it,
// the phone answers, and the card is dismissed everywhere when the menu leaves. Also the phone-as-reporter rules.
import { describe, it, expect, afterEach } from 'vitest';
import { WindowRegistry } from '../src/main/window-registry';
import { SessionRecords } from '../src/main/session-record';
import { createPublish } from '../src/main/publish';
import { SessionLiveFacts } from '../src/main/session-live';
import { findChannel } from '../src/main/ipc/channel-table';
import { bindSessionOps } from '../src/main/ipc/session';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState, type SessionChatState } from '../src/renderer/state/chat-types';
import { applySessionLive } from '../src/renderer/state/apply-session-live';

const S = 's1', WIN = 10, PHONE = -1001, PHONE2 = -1002;
const screen = () => {
  let st = new Map<string, SessionChatState>([[S, createSessionChatState()]]);
  const apply = (a: any) => { st = chatReducer(st, a); };
  return { apply, get: () => st.get(S)!, live: (p: any) => applySessionLive(p, { batcher: { push: apply }, contextTokens: () => null, isNative: () => false, setChipModel: () => {}, setSessionModel: () => {} }) };
};
const cards = (s: SessionChatState) => s.timeline.filter((e: any) => e.kind === 'prompt') as any[];

function rig() {
  const registry = new WindowRegistry();
  registry.registerWindow(WIN, 1);
  registry.assignSession(S, WIN);
  registry.registerSocket(PHONE); registry.registerSocket(PHONE2);
  const records = new SessionRecords(); records.begin(S);
  const A = screen(), B = screen();
  const publish = createPublish({
    records,
    toWindows: (_s, ch, args) => { if (ch === 'session:live') A.live(args[0]); },
    toSockets: (m, ids) => { if (m.type === 'session:live' && (!ids || ids.includes(PHONE))) B.live(m.payload); },
    socketsFor: (sid) => registry.resolveAudience(sid).socketIds,
  });
  const liveFacts = new SessionLiveFacts({ publish, records, isClaude: () => true });
  bindSessionOps({ publish, liveFacts, windowRegistry: registry } as any);
  const call = (report: any, door: 'desktop' | 'remote', audienceId?: number) =>
    findChannel('session:prompt-report')!.handler(report, { door, runtime: null, broadcast: () => {}, audienceId } as any);
  return { registry, records, A, B, call };
}
afterEach(() => bindSessionOps(null));

const show = { sessionId: S, action: 'show', promptId: 'usage1', title: 'Usage Limit Reached', buttons: [{ label: 'Stop and wait', input: '2' }, { label: 'Upgrade', input: '1' }] };

describe('the card path, end to end', () => {
  it('window reports, phone draws, phone answers, dismissed everywhere', async () => {
    const r = rig();
    r.registry.subscribe(S, PHONE);                        // the phone watches this conversation
    expect(await r.call(show, 'desktop')).toEqual({ ok: true });
    expect(cards(r.A.get())).toHaveLength(1);
    expect(cards(r.B.get())).toHaveLength(1);              // the phone draws the computer's card, with no reply asked for
    expect(cards(r.B.get())[0].prompt.title).toBe('Usage Limit Reached');
    // The phone answers (its click writes the digit into the terminal; its own card shows the answer).
    r.B.apply({ type: 'COMPLETE_PROMPT', sessionId: S, promptId: 'usage1', selection: 'Stop and wait' });
    // The menu leaves the computer's terminal: the window reports it going away.
    expect(await r.call({ sessionId: S, action: 'dismiss', promptId: 'usage1' }, 'desktop')).toEqual({ ok: true });
    expect(cards(r.A.get())).toHaveLength(0);              // removed where nobody answered
    expect(cards(r.B.get()).map((c) => c.prompt.completed)).toEqual(['Stop and wait']);   // kept as the record of the answer, no live card anywhere
    expect(r.records.openPrompts(S)).toEqual([]);
    expect(r.records.liveFill(S).some((p: any) => p.payload.kind === 'prompt-show')).toBe(false);
  });

  it('a phone that watches the conversation may report a card; one that does not may not; neither may sync', async () => {
    const r = rig();
    expect(await r.call(show, 'remote', PHONE)).toEqual({ ok: false });              // not watching
    r.registry.subscribe(S, PHONE);
    expect(await r.call(show, 'remote', PHONE)).toEqual({ ok: true });
    expect(cards(r.A.get())).toHaveLength(1);                                         // the COMPUTER's window draws what the phone saw
    expect(await r.call({ sessionId: S, action: 'sync', seen: [] }, 'remote', PHONE)).toEqual({ ok: false });
    expect(cards(r.A.get())).toHaveLength(1);
    expect(await r.call(show, 'remote', PHONE2)).toEqual({ ok: false });             // another phone, not watching
  });

  it('a window that reloaded while the menu was up reconciles on its first read', async () => {
    const r = rig();
    await r.call(show, 'desktop');
    // (window reloads; the menu is answered in the terminal view meanwhile; the new detector reads an empty screen)
    await r.call({ sessionId: S, action: 'sync', seen: [] }, 'desktop');
    expect(cards(r.A.get())).toHaveLength(0);
    expect(r.records.openPrompts(S)).toEqual([]);
  });
});
