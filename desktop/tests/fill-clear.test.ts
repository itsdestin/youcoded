// A Claude Code /clear, then a fresh open (R5-2 review): the screen must show what the computer shows, not the pre-clear messages.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionRecords } from '../src/main/session-record';
import { openSession } from '../src/main/session-open';
import { parseTranscriptLine } from '../src/main/transcript-watcher';
import { readTranscriptPage } from '../src/main/transcript-page';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { applyOpenReply, type OpenOk } from '../src/renderer/state/session-fill';
import { playInto } from './helpers/fill-harness';
import { newState, screenOf, SID } from './helpers/fill-scenarios';

const line = (type: string, text: string, n: number) => type === 'user'
  ? JSON.stringify({ type: 'user', uuid: `u${n}`, promptId: `p${n}`, timestamp: new Date(1_700_000_000_000 + n).toISOString(), message: { role: 'user', content: text } })
  : JSON.stringify({ type: 'assistant', uuid: `a${n}`, timestamp: new Date(1_700_000_000_000 + n).toISOString(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

async function scenario(clear: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-clear-'));
  const oldFile = path.join(dir, 'old.jsonl'), newFile = path.join(dir, 'new.jsonl');
  const records = new SessionRecords(); records.begin(SID);
  const feed = (file: string, ls: string[]) => { for (const l of ls) { fs.appendFileSync(file, l + '\n'); for (const e of parseTranscriptLine(l, SID)) records.note(SID, 'transcript:event', e); } };
  feed(oldFile, [line('user', 'before the clear', 1), line('assistant', 'old answer', 2)]);
  if (clear) records.startNewTranscript(SID);              // main sees the transcript file rotate
  feed(newFile, [line('user', 'after the clear', 3), line('assistant', 'new answer', 4)]);
  let current = newFile;
  const reply = await openSession({ records, knows: () => true, native: () => null,
    page: () => readTranscriptPage({ jsonlPath: current, sessionId: SID, endOffset: null }) }, { sessionId: SID, fresh: true });
  const st = { value: newState() };
  applyOpenReply({ dispatch: (a) => { st.value = chatReducer(st.value, a); }, flush: () => {}, play: (p) => playInto(st, p) }, SID, reply as OpenOk, { acceptPage: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return screenOf(st.value)!.timeline;
}

describe('a screen opened after a Claude Code /clear', () => {
  it('shows only what came after it, like the computer\'s window', async () => {
    expect(await scenario(true)).toEqual(['user: after the clear', 'assistant: text(new answer) [stop=end_turn]']);
  });
  it('(without the transcript rotation reaching the record the pre-clear messages would replay: the guard is real)', async () => {
    expect((await scenario(false)).join('\n')).toContain('before the clear');
  });
});
