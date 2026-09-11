/**
 * The bounded reader behind the preview pane, on both lanes.
 *
 * Four things here are safety properties rather than features, and each has
 * its own describe block: the reader must never read outside the folders the
 * app is allowed to read, must never present a subagent's transcript as a
 * conversation, must never read a whole large file to show its last page, and
 * must never show a tool-gap count it did not actually finish counting.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseClaudeTranscript, parseNativeTranscript, containedTranscriptPath, readTranscriptSlice, type ReadDeps,
} from '../src/main/chatsearch-index/transcript-reader';
import { COPY } from '../src/shared/chatsearch-refs';

const FX = path.join(__dirname, 'fixtures', 'chatsearch');
const read = (n: string) => fs.readFileSync(path.join(FX, n), 'utf8');
const ID = 'a3f2aaaa-0000-4000-8000-000000000000';
const MIRROR_LINE = '{"type":"user","uuid":"z","promptId":"p","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"MIRROR"}}';

describe('parseClaudeTranscript', () => {
  it('keeps every assistant text block, drops tool blocks, counts each gap correctly', () => {
    // Deliberately NOT loadHistory's rule (assistant text only where
    // stop_reason === 'end_turn'), which on a real 42 MB transcript threw away
    // 1,135 of 1,405 assistant messages. A preview exists to remember what was
    // decided, and the deciding happens between the tool calls.
    const text = read('claude-session.jsonl');
    const { messages, allSidechain } = parseClaudeTranscript(text);
    expect(allSidechain).toBe(false);
    expect(messages.map((x) => [x.role, x.content, x.droppedToolCalls])).toEqual([
      ['user', 'Fix the timeout', 0],
      ['assistant', 'Looking at it.', 0],
      ['assistant', 'Done — **fixed**.', 2],
      ['user', 'thanks', 0],
    ]);
    // seq is the BYTE offset of the message's line — the cursor "Load older"
    // hands back. Each one must point at the start of a line naming that text.
    const buf = Buffer.from(text, 'utf8');
    for (const m of messages) {
      expect(m.seq === 0 || buf[m.seq - 1] === 0x0a).toBe(true);
    }
  });

  it('dedupes by uuid (last wins) and ignores unparseable lines', () => {
    const text = read('claude-session.jsonl')
      + '\n{"type":"user","uuid":"u5","promptId":"p2","timestamp":"2026-07-26T00:00:09Z","message":{"role":"user","content":"thanks again"}}\n garbage';
    const { messages } = parseClaudeTranscript(text);
    expect(messages[messages.length - 1].content).toBe('thanks again');
  });

  it('flags a transcript whose lines are all sidechain', () => {
    expect(parseClaudeTranscript(read('subagent.jsonl')).allSidechain).toBe(true);
  });
});

describe('parseNativeTranscript', () => {
  it('skips the header, keeps user + assistant text, counts tool-use gaps', () => {
    expect(parseNativeTranscript(read('native-session.jsonl')).map((x) => [x.role, x.content, x.droppedToolCalls]))
      .toEqual([['user', 'hello', 0], ['assistant', 'hi, checking', 0], ['assistant', 'done', 1]]);
  });
});

describe('containedTranscriptPath', () => {
  it('accepts a real file under a root; refuses traversal, foreign roots, a look-alike root, and a symlink escaping the root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-out-'));
    fs.writeFileSync(path.join(root, 'ok.jsonl'), '');
    fs.writeFileSync(path.join(outside, 'secret.jsonl'), '');
    fs.symlinkSync(path.join(outside, 'secret.jsonl'), path.join(root, 'link.jsonl'));
    expect(await containedTranscriptPath(path.join(root, 'ok.jsonl'), [root])).toBe(fs.realpathSync(path.join(root, 'ok.jsonl')));
    expect(await containedTranscriptPath(path.join(root, '..', path.basename(outside), 'secret.jsonl'), [root])).toBeNull();
    expect(await containedTranscriptPath(path.join(outside, 'secret.jsonl'), [root])).toBeNull();
    // A symlink INSIDE the root pointing out of it is the interesting case:
    // the string check passes and only realpath catches it.
    expect(await containedTranscriptPath(path.join(root, 'link.jsonl'), [root])).toBeNull();
    // The trailing-separator check: `/tmp/cs-root-x-evil` must not pass as
    // being under `/tmp/cs-root-x`. The look-alike has to REALLY EXIST or
    // realpath refuses it first and this asserts nothing — which is exactly
    // what it did until a mutation run caught it (dropping `path.sep` from the
    // containment check broke no test).
    fs.mkdirSync(root + '-evil');
    fs.writeFileSync(path.join(root + '-evil', 'x.jsonl'), '');
    expect(await containedTranscriptPath(path.join(root + '-evil', 'x.jsonl'), [root])).toBeNull();
  });
});

describe('readTranscriptSlice', () => {
  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-read-'));
    const local = path.join(root, 'local');
    const space = path.join(root, 'space');
    fs.mkdirSync(path.join(local, 'slug'), { recursive: true });
    fs.mkdirSync(space, { recursive: true });
    return { local, space };
  }
  const depsFor = (
    local: string, space: string,
    entry: { transcriptPath: string; tombstone: boolean } | null,
    localPath: string | null,
  ): ReadDeps => ({ entryFor: () => entry, localPathFor: () => localPath, roots: [local, space], cache: new Map() });

  it('refuses an id that is not a session uuid', async () => {
    const { local, space } = setup();
    expect(await readTranscriptSlice({ provider: 'claude', id: '../x', tail: 5 }, depsFor(local, space, null, null)))
      .toEqual({ ok: false, error: COPY.errNotAnId });
  });

  it('says so when the id is not in the index at all', async () => {
    const { local, space } = setup();
    expect(await readTranscriptSlice({ provider: 'claude', id: ID, tail: 5 }, depsFor(local, space, null, null)))
      .toEqual({ ok: false, error: COPY.errNotIndexed });
  });

  it('prefers the local transcript over the mirror', async () => {
    const { local, space } = setup();
    fs.writeFileSync(path.join(local, 'slug', `${ID}.jsonl`), read('claude-session.jsonl'));
    fs.writeFileSync(path.join(space, `${ID}.jsonl`), MIRROR_LINE);
    const r = await readTranscriptSlice(
      { provider: 'claude', id: ID, tail: 50 },
      depsFor(local, space, { transcriptPath: path.join(space, `${ID}.jsonl`), tombstone: false }, path.join(local, 'slug', `${ID}.jsonl`)),
    );
    expect(r.ok && r.messages[0].content).toBe('Fix the timeout');
  });

  it('falls back to the mirror when local is absent', async () => {
    const { local, space } = setup();
    fs.writeFileSync(path.join(space, `${ID}.jsonl`), MIRROR_LINE);
    const r = await readTranscriptSlice(
      { provider: 'claude', id: ID, tail: 50 },
      depsFor(local, space, { transcriptPath: path.join(space, `${ID}.jsonl`), tombstone: false }, path.join(local, 'slug', `${ID}.jsonl`)),
    );
    expect(r.ok && r.messages[0].content).toBe('MIRROR');
  });

  it('says the transcript is gone for a tombstone, and surfaces the real fs error otherwise', async () => {
    const { local, space } = setup();
    expect(await readTranscriptSlice({ provider: 'claude', id: ID, tail: 5 }, depsFor(local, space, { transcriptPath: path.join(space, 'x.jsonl'), tombstone: true }, null)))
      .toEqual({ ok: false, error: COPY.previewTombstone });
    // Not a guess: whatever the filesystem actually said, verbatim.
    const missing = await readTranscriptSlice({ provider: 'claude', id: ID, tail: 5 }, depsFor(local, space, { transcriptPath: path.join(space, 'nope.jsonl'), tombstone: false }, null));
    expect(!missing.ok && missing.error).toMatch(/ENOENT/);
  });

  it('refuses a subagent transcript by path segment and by content', async () => {
    const { local, space } = setup();
    fs.mkdirSync(path.join(local, 'slug', ID, 'subagents'), { recursive: true });
    const p = path.join(local, 'slug', ID, 'subagents', 'agent-1.jsonl');
    fs.writeFileSync(p, read('subagent.jsonl'));
    expect(await readTranscriptSlice({ provider: 'claude', id: ID, tail: 5 }, depsFor(local, space, { transcriptPath: p, tombstone: false }, null)))
      .toEqual({ ok: false, error: COPY.errNotAConversation });
    // Same refusal with nothing in the path to give it away — the content has
    // to be enough on its own.
    const flat = path.join(space, `${ID}.jsonl`);
    fs.writeFileSync(flat, read('subagent.jsonl'));
    expect(await readTranscriptSlice({ provider: 'claude', id: ID, tail: 5 }, depsFor(local, space, { transcriptPath: flat, tombstone: false }, null)))
      .toEqual({ ok: false, error: COPY.errNotAConversation });
  });

  it('refuses a native specialist transcript — the lane equivalent of a subagent', async () => {
    const { local, space } = setup();
    const p = path.join(space, `${ID}.jsonl`);
    fs.writeFileSync(p, read('native-specialist.jsonl'));
    expect(await readTranscriptSlice({ provider: 'native', id: ID, tail: 5 }, depsFor(local, space, { transcriptPath: p, tombstone: false }, null)))
      .toEqual({ ok: false, error: COPY.errNotAConversation });
  });

  it('reads an ordinary native session', async () => {
    const { local, space } = setup();
    const p = path.join(space, `${ID}.jsonl`);
    fs.writeFileSync(p, read('native-session.jsonl'));
    const r = await readTranscriptSlice({ provider: 'native', id: ID, tail: 5 }, depsFor(local, space, { transcriptPath: p, tombstone: false }, null));
    expect(r.ok && r.messages.map((m) => m.content)).toEqual(['hello', 'hi, checking', 'done']);
  });

  it('refuses a path outside every root even when the index names it', async () => {
    const { local, space } = setup();
    // The decoy has to EXIST, or the reader reports the filesystem's ENOENT —
    // which is also correct behaviour, just not the refusal under test. This
    // used to name /etc/hostname: absent on macOS CI and on Windows, where the
    // test failed with an ENOENT for D:\etc\hostname.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-outside-'));
    const secret = path.join(outside, 'secret.jsonl');
    fs.writeFileSync(secret, read('claude-session.jsonl'));
    expect(await readTranscriptSlice({ provider: 'claude', id: ID, tail: 5 }, depsFor(local, space, { transcriptPath: secret, tombstone: false }, null)))
      .toEqual({ ok: false, error: COPY.errOutsideRoots });
  });

  it('reports the filesystem error when the index names a path that is not there at all', async () => {
    // The other half of the pair above: absent is not the same as forbidden,
    // and the reader must not word one as the other.
    const { local, space } = setup();
    const gone = await readTranscriptSlice({ provider: 'claude', id: ID, tail: 5 }, depsFor(local, space, { transcriptPath: path.join(space, 'nowhere', 'x.jsonl'), tombstone: false }, null));
    expect(!gone.ok && gone.error).toMatch(/ENOENT/);
  });

  // A conversation shaped like a real one: runs of tool calls between the
  // messages, and a non-ASCII message so a character/byte mix-up in the
  // offsets would land a cursor mid-line.
  function longConversation(messages: number): string {
    const lines: string[] = [];
    for (let i = 0; i < messages; i++) {
      for (let t = 0; t < i % 4; t++) {
        lines.push(JSON.stringify({ type: 'assistant', uuid: `t${i}-${t}`, timestamp: '2026-07-26T00:00:00Z',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: `x${i}${t}`, name: 'Bash', input: { command: 'x'.repeat(300) } }] } }));
      }
      lines.push(JSON.stringify(i % 2
        ? { type: 'assistant', uuid: `a${i}`, timestamp: '2026-07-26T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i} — naïve ✓` }] } }
        : { type: 'user', uuid: `u${i}`, promptId: `p${i}`, timestamp: '2026-07-26T00:00:00Z', message: { role: 'user', content: `ask ${i}` } }));
    }
    return lines.join('\n') + '\n';
  }

  it('reads only the end of a large file for the newest page', async () => {
    const { local, space } = setup();
    const p = path.join(space, `${ID}.jsonl`);
    fs.writeFileSync(p, longConversation(4000));
    const size = fs.statSync(p).size;
    let bytes = 0;
    const deps = depsFor(local, space, { transcriptPath: p, tombstone: false }, null);
    deps.readRange = async (file, start, end) => { bytes += end - start; return fs.readFileSync(file).subarray(start, end); };
    const r = await readTranscriptSlice({ provider: 'claude', id: ID, tail: 40 }, deps);
    expect(r.ok && r.messages).toHaveLength(40);
    expect(r.ok && r.hasMore).toBe(true);
    // The whole point: a 40-message page of a multi-megabyte file costs one
    // window, not the file. Reading everything is exactly the regression.
    expect(size).toBeGreaterThan(2 * 1024 * 1024);
    expect(bytes).toBeLessThan(size / 2);
  });

  it('pages back to the start with no message lost, repeated or miscounted, across window edges', async () => {
    const { local, space } = setup();
    const p = path.join(space, `${ID}.jsonl`);
    const text = longConversation(60);
    fs.writeFileSync(p, text);
    const deps = depsFor(local, space, { transcriptPath: p, tombstone: false }, null);
    // A window smaller than one line forces every edge case: windows that
    // start mid-line, windows that must grow, and gaps split across windows.
    deps.firstWindowBytes = 97;
    let all: unknown[] = [];
    let before: number | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const r = await readTranscriptSlice({ provider: 'claude', id: ID, tail: 7, ...(before === undefined ? {} : { before }) }, deps);
      if (!r.ok) throw new Error(r.error);
      all = [...r.messages, ...all];
      if (!r.hasMore || !r.messages.length) break;
      before = r.messages[0].seq;
    }
    expect(all).toEqual(parseClaudeTranscript(text).messages);
  });

  it('answers an unchanged slice from memory — hovering then clicking reads the file once', async () => {
    const { local, space } = setup();
    const p = path.join(space, `${ID}.jsonl`);
    fs.writeFileSync(p, read('claude-session.jsonl'));
    let reads = 0;
    const deps = depsFor(local, space, { transcriptPath: p, tombstone: false }, null);
    deps.readRange = async (file, start, end) => { reads++; return fs.readFileSync(file).subarray(start, end); };
    const first = await readTranscriptSlice({ provider: 'claude', id: ID, tail: 40 }, deps);
    const readsAfterFirst = reads;
    expect(await readTranscriptSlice({ provider: 'claude', id: ID, tail: 40 }, deps)).toEqual(first);
    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(reads).toBe(readsAfterFirst);
  });

  it('re-reads when the file has changed since it was cached', async () => {
    const { local, space } = setup();
    const p = path.join(space, `${ID}.jsonl`);
    fs.writeFileSync(p, read('claude-session.jsonl'));
    const deps = depsFor(local, space, { transcriptPath: p, tombstone: false }, null);
    const first = await readTranscriptSlice({ provider: 'claude', id: ID, tail: 50 }, deps);
    expect(first.ok && first.messages).toHaveLength(4);
    fs.writeFileSync(p, read('claude-session.jsonl')
      + '\n{"type":"user","uuid":"u9","promptId":"p9","timestamp":"2026-07-26T00:00:20Z","message":{"role":"user","content":"one more"}}');
    const second = await readTranscriptSlice({ provider: 'claude', id: ID, tail: 50 }, deps);
    expect(second.ok && second.messages[second.messages.length - 1].content).toBe('one more');
  });
});
