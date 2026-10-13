// @vitest-environment jsdom
// The card path, end to end (one-core R5-4b): the computer's own copy of the terminal finds a card, the host publishes it, a phone draws it with no
// computer window involved, the phone answers, and the card is dismissed everywhere when the menu leaves. Nothing a screen sends can create or
// remove a card: the channel they used in R5-4a is gone.
import { describe, it, expect, vi } from 'vitest';
import { WindowRegistry } from '../src/main/window-registry';
import { SessionRecords } from '../src/main/session-record';
import { createPublish } from '../src/main/publish';
import { SessionLiveFacts } from '../src/main/session-live';
import { SessionScreens, type ScreenTerminal } from '../src/main/session-screens';
import { findChannel } from '../src/main/ipc/channel-table';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState, type SessionChatState } from '../src/renderer/state/chat-types';
import { applySessionLive } from '../src/renderer/state/apply-session-live';
import { Terminal } from '@xterm/headless';

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
