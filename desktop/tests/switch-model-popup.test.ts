// @vitest-environment jsdom
// The "Switch model?" confirmation, end to end (sync of the one-core series with master's popups work, 2026-10-01).
//
// THE CASE: after a typed `/model` in a conversation that already had a turn, Claude Code opens "Switch model?  1. Yes, switch / 2. No, go back". A chat
// message typed then lands in it and its Enter answers "Yes": the message is lost while its bubble looks sent (what Destin hit on the series tip). Master
// refuses that send and shows a card; the series lost both, then got only a toast back. This pins the merged behaviour on BOTH screens: the computer's own
// reading of the terminal (main/session-screens.ts, the only reader) publishes a card and "the keyboard is held", a PHONE (no terminal of its own) and the
// computer's window both refuse a chat send with the draft kept, and everything clears when the pop-up closes.
//
// THE CAPTURE: this is a SYNTHETIC chunk, not a recording. No real capture of this dialog exists in tests/fixtures/popup-corpus, and recording one needs a
// Claude login (not touched for this work). It is built from the dialog text Claude Code 2.1.286 carries (strings dump: "Switch model?", "This conversation is
// cached for the current ...", "Yes, switch to ...", "No, go back") and the debug agent's observation of the screen, drawn the way the classic renderer draws any
// pop-up: the message box replaced by ONE column-0 rule with the indented body under it. ASSUMED, not seen: the standard Ink footer "Enter to confirm · Esc to
// cancel" (without it the send is still refused, but no card is drawn: see the last test). Replace with a real recording when one exists.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WindowRegistry } from '../src/main/window-registry';
import { SessionRecords } from '../src/main/session-record';
import { createPublish } from '../src/main/publish';
import { SessionLiveFacts } from '../src/main/session-live';
import { SessionScreens, type ScreenTerminal } from '../src/main/session-screens';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState, type SessionChatState } from '../src/renderer/state/chat-types';
import { applySessionLive } from '../src/renderer/state/apply-session-live';
import { clearScreenInputBlocks } from '../src/renderer/state/screen-input-store';
import { sendBlock, screenInputBlock } from '../src/renderer/state/pty-input-gate';
import { REMOTE_SCREEN_CAPABILITIES } from '../src/shared/capabilities';
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

function rig(onInputBlocked?: (id: string, b: boolean) => void) {
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
    records, live, isClaude: () => true, now: () => t, onInputBlocked,
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


const RULE = '─'.repeat(78);
const HISTORY = ['> /model sonnet', '  ⎿  Set model to Sonnet 5.5', '', '> hi', '', '● Hi Destin. What would you like to work on?', '', '✻ Baked for 1s', ''];
/** The pop-up in place of the message box. */
const SWITCH_MODEL = [
  ...HISTORY, RULE,
  ' Switch model?', '',
  ' This conversation is cached for the current model (Sonnet 5.5). Switching to Opus 4.5 means the full history gets re-read on your next message.', '',
  ' ❯ 1. Yes, switch to Opus 4.5', '   2. No, go back', '',
  ' Enter to confirm · Esc to cancel',
].join('\r\n');
/** The ordinary message box again (the pop-up was answered). */
const MESSAGE_BOX = ['\x1b[2J\x1b[H', ...HISTORY, RULE, '❯ ', RULE, '  Opus 4.5 | Context: 9%'].join('\r\n');

beforeEach(() => {
  clearScreenInputBlocks();
  // Both kinds of screen that draw from the computer's record (a window and a phone) say sessionRecord.
  (window as any).claude = { capabilities: { ...REMOTE_SCREEN_CAPABILITIES, sessionRecord: true } };
});

describe('"Switch model?" after a mid-conversation /model', () => {
  it('the computer shows it as a card on the phone, refuses a chat send at once and again once the card is up, and lets go when it closes', async () => {
    const blocked: boolean[] = [];
    const r = rig((_id, b) => blocked.push(b));
    r.registry.subscribe(S, PHONE);
    r.output(SWITCH_MODEL);
    // Within a fraction of a second, before any card exists: the keyboard is known to be held, so a send is refused with the screen as the reason.
    await r.advance(150);
    expect(blocked).toEqual([true]);
    expect(screenInputBlock(S)).toEqual({ kind: 'popup', heading: 'Switch model?' });
    expect(sendBlock(r.phone.get(), S)?.kind).toBe('screen');
    expect(cards(r.phone.get())).toHaveLength(0);
    // After the generic-card wait (1 s): one card, titled as Claude Code titles it, on the phone.
    await r.advance(1200);
    expect(cards(r.phone.get())).toHaveLength(1);
    expect(cards(r.phone.get())[0].prompt.title).toBe('Switch model?');
    expect(cards(r.phone.get())[0].prompt.buttons.map((b: any) => b.label)).toEqual(['Yes, switch to Opus 4.5', 'No, go back']);
    // The send is still refused, now naming the card (so the toast offers "Show card").
    expect(sendBlock(r.phone.get(), S)?.kind).toBe('prompt');
    // A phone that connects NOW (never saw the events) is handed the same card and the same hold.
    const late = screen();
    for (const p of r.records.liveFill(S)) if (p.type === 'session:live') late.live(p.payload);
    expect(cards(late.get())).toHaveLength(1);
    expect(screenInputBlock(S)).not.toBeNull();
    // The pop-up is answered: the box is back; the card goes and nothing refuses any more.
    r.output(MESSAGE_BOX);
    await r.advance(2000);
    expect(blocked).toEqual([true, false]);
    expect(screenInputBlock(S)).toBeNull();
    expect(r.records.openPrompts(S)).toEqual([]);
    expect(sendBlock(createSessionChatState(), S)).toBeNull();
  });

  it('an ordinary conversation with its message box is never refused', async () => {
    const r = rig();
    r.output(['\x1b[2J\x1b[H', ...HISTORY, RULE, '❯ ', RULE, '  Sonnet 5.5 | Context: 9%'].join('\r\n'));
    await r.advance(2000);
    expect(screenInputBlock(S)).toBeNull();
    expect(sendBlock(createSessionChatState(), S)).toBeNull();
    expect(cards(r.phone.get())).toHaveLength(0);
  });

  it('a hook-reported permission ask owns its menu: no second (generic) card beside it', async () => {
    const r = rig();
    r.registry.subscribe(S, PHONE);
    r.records.note(S, 'hook:event', { type: 'PermissionRequest', sessionId: S, payload: { _requestId: 'r1', tool_name: 'Bash' }, timestamp: 1 });
    r.output(SWITCH_MODEL);
    await r.advance(3000);
    expect(cards(r.phone.get())).toHaveLength(0);
    expect(screenInputBlock(S)).not.toBeNull();   // the keyboard is still held: sends are refused either way
  });
});

// THE REAL CAPTURE (2026-10-02): Claude Code 2.1.287 recorded by test-conpty/capture-popup-corpus.mjs (scenario switch-model-confirm, classic and fullscreen
// renderers). It shows what the synthetic chunk above could only assume: the real "Switch model?" pop-up has NO "Enter to confirm · Esc to cancel" footer.
// With the footer required, no card was ever drawn for it (Destin saw none).
import fs from 'fs';
import path from 'path';
describe.each(['switch-model-confirm', 'fs-switch-model-confirm'])('"Switch model?" as Claude Code really draws it (%s)', (name) => {
  const cap = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'popup-corpus', `${name}.json`), 'utf8'));
  const chunks: string[] = cap.chunks.map((c: any) => Buffer.from(c.b64, 'base64').toString('utf8'));
  const marks = cap.marks.filter((m: any) => m.label === 'truth');
  // The driver pressed Enter ("Yes") at the last 'send' mark: everything before it is the pop-up being drawn, everything after is its answer.
  const yesAt: number = cap.marks.filter((m: any) => m.label === 'send').slice(-1)[0].chunkIndex;
  const answeredAt: number = marks.find((m: any) => m.data?.note === 'after answering').chunkIndex;

  it('draws one card with both buttons, refuses sends meanwhile, and clears it all once the pop-up is answered', async () => {
    const r = rig();
    r.registry.subscribe(S, PHONE);
    r.screens.noteResize(S, cap.cols, cap.rows);
    r.records.note(S, 'hook:event', { type: 'SessionStart', sessionId: S, payload: {}, timestamp: 1 });   // Claude Code has started (its first hook ran): a mid-session pop-up
    // Everything up to and including the pop-up's own drawing .
    for (let i = 0; i < yesAt; i++) r.output(chunks[i]);
    await r.advance(150);
    expect(screenInputBlock(S)).toMatchObject({ kind: 'popup' });
    await r.advance(1500);
    expect(cards(r.phone.get())).toHaveLength(1);
    expect(cards(r.phone.get())[0].prompt.title).toBe('Switch model?');
    expect(cards(r.phone.get())[0].prompt.buttons.map((b: any) => b.label)).toEqual([expect.stringMatching(/^Yes, switch to/), 'No, go back']);
    // Answered: the rest of the capture draws the result and the message box again.
    for (let i = yesAt; i <= answeredAt + 1 && i < chunks.length; i++) r.output(chunks[i]);
    await r.advance(2500);
    expect(screenInputBlock(S)).toBeNull();
    expect(r.records.openPrompts(S)).toEqual([]);
  });
});
