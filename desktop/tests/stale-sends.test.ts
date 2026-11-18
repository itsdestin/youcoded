// Destin, 2026-11-18: "bare pasted images/filepaths getting stuck to the bottom of the chat renderer despite sending fine in claude code"
// and "the message just being pinned there forever doesn't make sense".
//
// Reproduced in a dev copy the same day: a picture attached with no words reached Claude Code as only its `Attached: "…"` line and was
// answered, but the chat's bubble stayed pending under the reply. The watcher reads that line back as text '' plus attachedFiles, and
// eventToAction dropped every user message with no text. These tests pin the fix and the general safety net (state/stale-sends.ts).
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { eventToAction } from '../src/renderer/state/transcript-event-actions';
import { dueStaleSends, SETTLE_BOUND_MS, GIVE_UP_MS } from '../src/renderer/state/stale-sends';
import type { ChatState, ChatAction } from '../src/renderer/state/chat-types';

const SID = 's1';
const PIC = '/home/u/.config/youcoded/queue-files/q/a/paste-1.png';

function run(actions: ChatAction[], from?: ChatState): ChatState {
  return actions.reduce(chatReducer, from ?? chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID }));
}
const tl = (s: ChatState) => s.get(SID)!.timeline as any[];
const order = (s: ChatState) => tl(s).map(e => e.kind === 'user' ? `user:${e.message.content}${e.pending ? '(pending)' : ''}` : e.kind);

const sendPicture = (t: number, sendId = 'send-1'): ChatAction =>
  ({ type: 'USER_PROMPT', sessionId: SID, content: PIC, timestamp: t, attachments: [PIC], sendId, sendTransport: 'queue' });
const sendWords = (text: string, t: number, sendId?: string): ChatAction =>
  ({ type: 'USER_PROMPT', sessionId: SID, content: text, timestamp: t, ...(sendId ? { sendId, sendTransport: 'queue' as const } : {}) });
const reply = (text: string, uuid: string, t: number): ChatAction => ({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SID, uuid, text, timestamp: t });
const done = (uuid: string, t: number) => ({ type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SID, uuid, timestamp: t } as ChatAction);
const bound = (sendId: string, uuid: string): ChatAction => ({ type: 'QUEUE_SYNCED', sessionId: SID, queue: [], bound: [{ sendId, uuid }] });
const stale = (s: ChatState, now: number): ChatAction[] => {
  const ids = dueStaleSends(s.get(SID)!.timeline, now);
  return ids.length ? [{ type: 'SENDS_STALE', sessionId: SID, messageIds: ids, now }] : [];
};

describe('a picture sent with no words', () => {
  // What the transcript watcher emits for Claude Code's line `Attached: "<path>"` (shared/claude-queue-wire.ts parseQueueWire).
  const recorded = { type: 'user-message', sessionId: SID, uuid: 'u-pic', timestamp: 5, data: { text: '', attachedFiles: [PIC] } } as any;

  it('becomes a chat message instead of being dropped', () => {
    const actions = eventToAction(recorded, { live: true });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'TRANSCRIPT_USER_MESSAGE', text: '', attachedFiles: [PIC] });
    // A user line with neither words nor files still draws nothing.
    expect(eventToAction({ ...recorded, data: { text: '' } }, { live: true })).toEqual([]);
  });

  it('confirms the sender\'s bubble, which then sits above the reply (it was pinned below it before)', () => {
    const s = run([sendPicture(1), ...eventToAction(recorded, { live: true }), reply('A red square.', 'a1', 6), done('t1', 7)]);
    expect(order(s)).toEqual([`user:${PIC}`, 'assistant-turn']);
  });

  it('confirms it by the queue\'s identity too, whichever arrives first', () => {
    const s = run([sendPicture(1), bound('send-1', 'u-pic'), ...eventToAction(recorded, { live: true }), reply('A red square.', 'a1', 6)]);
    expect(order(s)).toEqual([`user:${PIC}`, 'assistant-turn']);
  });

  it('shows on a screen that only reads the transcript (a reopen or another device)', () => {
    const s = run(eventToAction(recorded, { live: false }));
    expect(tl(s)[0]).toMatchObject({ kind: 'user', pending: false, message: { attachments: [PIC] } });
  });
});

describe('a bubble the echo never confirms is not pinned at the bottom forever', () => {
  it('nothing is due before the waits are up', () => {
    const s = run([sendWords('hello', 1000, 'send-1'), bound('send-1', 'u1')]);
    expect(dueStaleSends(tl(s), 1000 + SETTLE_BOUND_MS - 1)).toEqual([]);
    const t = run([sendWords('hello', 1000, 'send-2')]);
    expect(dueStaleSends(tl(t), 1000 + GIVE_UP_MS - 1)).toEqual([]);
  });

  it('settles a bubble the computer says Claude Code recorded: an ordinary message, back above the reply that answered it, no note', () => {
    // An older exchange, then the stuck send: recorded (bound) but its echo was never matched; the reply arrived above it.
    let s = run([sendWords('earlier', 1_000), { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u0', text: 'earlier', timestamp: 1_000 },
      reply('Earlier answer.', 'a0', 2_000), done('t0', 2_100),
      sendWords('stuck', 50_000, 'send-1'), bound('send-1', 'u1'), reply('Answer to stuck.', 'a1', 51_000), done('t1', 51_100)]);
    expect(order(s)).toEqual(['user:earlier', 'assistant-turn', 'assistant-turn', 'user:stuck(pending)']);
    s = run(stale(s, 100_000), s);
    expect(order(s)).toEqual(['user:earlier', 'assistant-turn', 'user:stuck', 'assistant-turn']);
    const settled = tl(s).find(e => e.kind === 'user' && e.message.content === 'stuck');
    expect(settled).toMatchObject({ pending: false, uuid: 'u1' });
    expect(settled.sendNote).toBeUndefined();
    // A late echo of the same recorded line does not draw a second copy.
    s = run([{ type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u1', text: 'stuck', timestamp: 50_500 }], s);
    expect(order(s).filter(x => x.startsWith('user:stuck'))).toHaveLength(1);
  });

  it('gives up on a bubble with no sign of arrival: a doubt note, and later messages go below it', () => {
    let s = run([sendWords('lost', 100_000, 'send-1')]);
    expect(s.get(SID)!.isThinking).toBe(true);
    s = run(stale(s, 200_000), s);
    expect(tl(s)[0]).toMatchObject({ pending: true, sendStale: true, sendNote: 'unsure' });
    // The spinner that send started stops: nothing is running.
    expect(s.get(SID)!.isThinking).toBe(false);
    // A later exchange lands BELOW it, not above (it is no longer held at the bottom).
    s = run([sendWords('next', 200_100, 'send-2'), { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u2', text: 'next', timestamp: 200_200 },
      reply('Hi.', 'a2', 200_300)], s);
    expect(order(s)).toEqual(['user:lost(pending)', 'user:next', 'assistant-turn']);
    // It is handled once, not again on every check.
    expect(dueStaleSends(tl(s), 300_000)).toEqual([]);
  });

  it('a late echo still confirms a given-up bubble, and the note goes', () => {
    let s = run([sendWords('slow', 100_000, 'send-1')]);
    s = run(stale(s, 200_000), s);
    s = run([{ type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u1', text: 'slow', timestamp: 200_500 }], s);
    expect(tl(s)).toHaveLength(1);
    expect(tl(s)[0]).toMatchObject({ pending: false, uuid: 'u1' });
    expect(tl(s)[0].sendNote).toBeUndefined();
    expect(tl(s)[0].sendStale).toBeUndefined();
  });

  it('a message sent the moment a reply ended settles after that reply, not above it', () => {
    // Reply A's last event lands half a second before B is sent; B is recorded but its echo is missed, and B's answer arrives above it.
    let s = run([sendWords('a', 1_000), { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'ua', text: 'a', timestamp: 1_000 },
      reply('Answer A.', 'ra', 49_500), done('ta', 49_500),
      sendWords('b', 50_000, 'send-b'), bound('send-b', 'ub'), reply('Answer B.', 'rb', 51_000), done('tb', 51_100)]);
    s = run(stale(s, 70_000), s);
    expect(order(s)).toEqual(['user:a', 'assistant-turn', 'user:b', 'assistant-turn']);
    const turns = tl(s).filter(e => e.kind === 'assistant-turn').map(e => s.get(SID)!.assistantTurns.get(e.turnId)!.segments.map((g: any) => g.text ?? g.content).join(''));
    expect(turns[0]).toContain('Answer A.');
  });

  it('retyping the words of a given-up message confirms the new bubble, not the old one', () => {
    let s = run([sendWords('yes', 100_000, 'send-1')]);
    s = run(stale(s, 200_000), s);
    s = run([sendWords('yes', 200_100, 'send-2'), { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u2', text: 'yes', timestamp: 200_200 }], s);
    const users = tl(s).filter(e => e.kind === 'user');
    expect(users.find(e => e.sendId === 'send-1')).toMatchObject({ pending: true, sendStale: true, sendNote: 'unsure' });
    expect(users.find(e => e.uuid === 'u2')).toMatchObject({ pending: false });
  });

  it('gives up on a slash command quietly: no note, since many get no echo and Send again would run it twice', () => {
    let s = run([sendWords('/compact', 100_000, 'send-1')]);
    s = run(stale(s, 200_000), s);
    expect(tl(s)[0]).toMatchObject({ pending: true, sendStale: true });
    expect(tl(s)[0].sendNote).toBeUndefined();
  });

  it('adds no note where one would be wrong or useless, but still releases the bubble', () => {
    let s = run([sendWords('no id', 100_000), // a bubble with no send id has no Send again / Dismiss to offer
      // Dismiss is only offered once a doubt note is showing (a phone's reconnect check put one there).
      sendWords('dismissed', 100_000, 'send-d'), { type: 'SEND_NOTE', sessionId: SID, sendId: 'send-d', note: 'unsure' },
      { type: 'SEND_NOTE', sessionId: SID, sendId: 'send-d', note: null, dismissed: true }]);
    s = run(stale(s, 200_000), s);
    for (const e of tl(s)) { expect(e.sendStale).toBe(true); expect(e.sendNote).toBeUndefined(); }
  });
});
