// Destin, 2026-09-11, phone test of remote access batches 2/3: "if i spam a few messages,
// sometimes the responses and the messages interweave in different orders across the two
// platforms."
//
// WHY this test exists: the device that sends a message draws it at once as a pending
// bubble; every other device draws it only when Claude Code records it in the transcript.
// A reply that starts after the send but before the transcript records the message used to
// land BELOW the sender's pending bubble, and confirming the bubble never moved it — so the
// sender kept send order while every other device showed transcript order. The two screens
// must converge on transcript order.
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState, ChatAction } from '../src/renderer/state/chat-types';

const SID = 's1';

function run(actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID }));
}

/** The timeline as a reader sees it: user bubbles by text, everything else by kind. */
function order(state: ChatState): string[] {
  return state.get(SID)!.timeline.map((e: any) => (e.kind === 'user' ? `user:${e.message.content}` : e.kind));
}

const sent = (content: string, t: number): ChatAction => ({ type: 'USER_PROMPT', sessionId: SID, content, timestamp: t });
const recordedUser = (text: string, uuid: string, t: number): ChatAction =>
  ({ type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid, text, timestamp: t });
const reply = (text: string, uuid: string, t: number): ChatAction =>
  ({ type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SID, uuid, text, timestamp: t });
const turnDone = (uuid: string, t: number): ChatAction =>
  ({ type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SID, uuid, timestamp: t } as ChatAction);

describe('rapid messages: the sending device and a watching device show the same order', () => {
  it('a second message sent before the first reply lands after that reply on both devices', () => {
    // What Claude Code recorded, in order: A, reply to A, B, reply to B.
    const transcript: ChatAction[] = [
      recordedUser('what are you up to', 'u1', 1),
      reply('Just started the session.', 'a1', 2),
      turnDone('t1', 3),
      recordedUser('aadsf', 'u2', 4),
      reply('Not sure what that means!', 'a2', 5),
      turnDone('t2', 6),
    ];
    // The watching device only ever sees the transcript.
    const watcher = run(transcript);

    // The sending device typed A and B back to back, before any of it was recorded.
    const senderMidway = run([sent('what are you up to', 0), sent('aadsf', 0.5), ...transcript.slice(0, 3)]);
    // While B is still unrecorded, it stays the last thing on the sender's screen.
    expect(order(senderMidway).at(-1)).toBe('user:aadsf');

    const sender = run([sent('what are you up to', 0), sent('aadsf', 0.5), ...transcript]);
    expect(order(sender)).toEqual(order(watcher));
    expect(sender.get(SID)!.timeline.every((e: any) => e.kind !== 'user' || e.pending === false)).toBe(true);
  });

  it('a message typed on the computer mid-reply keeps the reply above it on both devices', () => {
    const transcript: ChatAction[] = [
      recordedUser('first', 'u1', 1),
      reply('Part one', 'a1', 2),
      reply('Part two', 'a1b', 3),
      turnDone('t1', 4),
      recordedUser('second', 'u2', 5),
    ];
    const watcher = run(transcript);
    // The sender typed "second" after "Part one" had arrived but before "Part two".
    const sender = run([sent('first', 0), transcript[0], transcript[1], sent('second', 2.5), ...transcript.slice(2)]);
    expect(order(sender)).toEqual(order(watcher));
  });

  it('a message nobody typed here (entered in the terminal) is not placed below this device\'s unsent bubble', () => {
    // Recorded order: "from terminal", then "from phone". The phone's own bubble is still
    // pending when the terminal message arrives.
    const phone = run([sent('from phone', 0), recordedUser('from terminal', 'u1', 1)]);
    expect(order(phone)).toEqual(['user:from terminal', 'user:from phone']);
    const settled = run([sent('from phone', 0), recordedUser('from terminal', 'u1', 1), recordedUser('from phone', 'u2', 2)]);
    expect(order(settled)).toEqual(order(run([recordedUser('from terminal', 'u1', 1), recordedUser('from phone', 'u2', 2)])));
  });
});

// The same complaint, later the same day ("still having issues with messages not always appearing
// in the same order"): messages the transcript never confirmed stayed pinned to the bottom of the
// sending device's chat. See the parser half in tests/transcript-watcher.test.ts.
describe('messages that used to stay unconfirmed', () => {
  const recordedCommand = (text: string, uuid: string, t: number): ChatAction =>
    ({ type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid, text, timestamp: t, slashCommand: true } as ChatAction);
  const noPending = (state: ChatState) => state.get(SID)!.timeline.every((e: any) => e.kind !== 'user' || e.pending === false);

  it('a message sent while Claude is working lands where Claude Code recorded it, on both devices', () => {
    const transcript: ChatAction[] = [
      recordedUser('first', 'u1', 1),
      reply('Working on first', 'a1', 2),
      recordedUser('second', 'q1', 3),          // the queued record, now read as a user message
      reply('Also answering second', 'a2', 4),
      turnDone('t1', 5),
      recordedUser('third', 'u3', 6),
      reply('Reply to third', 'a3', 7),
      turnDone('t3', 8),
    ];
    const watcher = run(transcript);
    const sender = run([sent('first', 0), transcript[0], transcript[1], sent('second', 2.5), ...transcript.slice(2, 5), sent('third', 5.5), ...transcript.slice(5)]);
    expect(order(sender)).toEqual(order(watcher));
    expect(noPending(sender)).toBe(true);
  });

  it('a slash command is confirmed where it was recorded, and does not leave a watching device thinking', () => {
    const transcript: ChatAction[] = [
      recordedUser('hello', 'u1', 1),
      reply('hi', 'a1', 2),
      turnDone('t1', 3),
      recordedCommand('/reload-plugins', 'c1', 4),
    ];
    const watcher = run(transcript);
    const sender = run([sent('hello', 0), ...transcript.slice(0, 3), sent('/reload-plugins', 3.5), transcript[3]]);
    expect(order(sender)).toEqual(order(watcher));
    expect(order(watcher).at(-1)).toBe('user:/reload-plugins');
    expect(noPending(sender)).toBe(true);
    expect(watcher.get(SID)!.isThinking).toBe(false);
  });

  it('the /compact and /clear echoes add no bubble on a watching device', () => {
    const watcher = run([recordedCommand('/compact keep going', 'c1', 1), recordedCommand('/clear', 'c2', 2)]);
    expect(order(watcher)).toEqual([]);
  });

  it('a message with a picture is confirmed, not drawn twice on the device that sent it', () => {
    const transcript: ChatAction[] = [
      recordedUser('[Image #1] what is this', 'u1', 1),
      reply('It is a cat', 'a1', 2),
      turnDone('t1', 3),
      recordedUser('thanks', 'u2', 4),
    ];
    const watcher = run(transcript);
    const withPicture = { type: 'USER_PROMPT', sessionId: SID, content: '/home/d/shot.png what is this', timestamp: 0, attachments: ['/home/d/shot.png'] } as ChatAction;
    const sender = run([withPicture, ...transcript.slice(0, 3), sent('thanks', 3.5), transcript[3]]);
    const kinds = (s: ChatState) => s.get(SID)!.timeline.map((e: any) => e.kind);
    expect(kinds(sender)).toEqual(kinds(watcher));
    expect(noPending(sender)).toBe(true);
  });

  it('a picture sent with no text is confirmed too', () => {
    const picture = { type: 'USER_PROMPT', sessionId: SID, content: '/home/d/a.png /home/d/b.png', timestamp: 0, attachments: ['/home/d/a.png', '/home/d/b.png'] } as ChatAction;
    const sender = run([picture, recordedUser('[Image #1] [Image #2]', 'u1', 1)]);
    expect(sender.get(SID)!.timeline.filter((e: any) => e.kind === 'user')).toHaveLength(1);
    expect(noPending(sender)).toBe(true);
  });
});
