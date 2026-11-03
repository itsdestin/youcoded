import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import {
  parseTranscriptLine,
  emptyTurnUsageTally,
  TranscriptWatcher,
} from '../src/main/transcript-watcher';
import { ccProjectSlug } from '../src/main/slug-encoding';
import { looseData, type TranscriptEvent } from '../src/shared/types';

/** Poll ceilings as tries counts, sized to ~15s at each loop's own interval —
 *  same reasoning as POLL_TRIES in native-session-host.test.ts: these loops wait
 *  on a real condition (`events.length > 0`), and only the ceiling was a guess.
 *  Note the one loop in this file WITHOUT a break condition keeps a small fixed
 *  count instead — see its own comment. */
const POLL_TRIES_100MS = 150;


// Fixed sleep. ONLY valid before a NEGATIVE assertion ("nothing emitted yet") or
// as a settle that lets a WRONG extra event land before asserting it didn't —
// a too-short sleep there fails safe. NEVER sleep before a POSITIVE assertion:
// reads are async and fs.watch delivery is load-dependent, so a fixed budget is
// a bet that loses as the machine gets busy. Use `vi.waitFor(...)` to poll.
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Generous ceilings — they only bound the FAILURE case; a passing assertion
// returns the moment it holds, so raising them costs nothing on green runs.
const SETTLE_MS = 5_000;   // in-process: watcher read + emit
const WATCH_MS = 15_000;   // fs.watch/stat-poll delivery of an external write

// ...and the second knob, without which the ceilings above are fiction: a file
// with no vi.setConfig inherits vitest's DEFAULT 5000ms testTimeout, so a
// 15_000ms vi.waitFor can never actually wait 15s — the test dies at 5s first.
// Same gap that kept sync-spaces-engine.test.ts flaking on macOS after PR #180
// raised its poll ceiling and nothing else. One bounds the poll, one bounds the
// test; both are required.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// parseTranscriptLine
// ---------------------------------------------------------------------------
describe('parseTranscriptLine', () => {
  const sessionId = 'desktop-session-1';
  const parse = (o: object, sid = sessionId) => parseTranscriptLine(JSON.stringify(o), sid);
  const assistant = (content: unknown[], extra: Record<string, unknown> = {}, msgExtra: Record<string, unknown> = {}) =>
    ({ type: 'assistant', uuid: 'uuid-1', message: { role: 'assistant', content, stop_reason: null, ...msgExtra }, ...extra });
  const userLine = (content: unknown, extra: Record<string, unknown> = {}) =>
    ({ type: 'user', uuid: 'uuid-3', message: { role: 'user', content }, ...extra });
  const bridge = { kind: 'plugin', name: 'youcoded-control-bridge' };

  it('recognizes an app mod command envelope even without promptId', () => {
    // A /model command line draws nothing itself; the "Set model to" reply after it draws the divider.
    const content = '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>';
    expect(parse(userLine(content, { uuid: 'mod-model', origin: bridge }))).toEqual([]);
  });

  it('drops only the bridge command\'s extra compact row, not actual user text or other plugins', () => {
    const row = userLine('/compact preserve details', { uuid: 'extra', promptId: 'p', origin: bridge });
    expect(parse(row)).toEqual([]);
    expect(parse({ ...row, origin: { ...bridge, asUser: true } })).toMatchObject([{ type: 'user-message', data: { text: '/compact preserve details' } }]);
    expect(parse({ ...row, origin: { kind: 'plugin', name: 'someone-else' } })).toMatchObject([{ type: 'user-message', data: { text: '/compact preserve details' } }]);
    expect(parse(userLine('still not a user prompt', { uuid: 'hidden' }))).toEqual([]);
  });

  it('parses assistant text, tool_use, tool_result and a prompted user line into typed events', () => {
    const text = parse(assistant([{ type: 'text', text: 'Hello, world!' }]));
    expect(text).toHaveLength(1);
    expect(text[0]).toMatchObject({ type: 'assistant-text', sessionId, uuid: 'uuid-1' });
    expect(looseData(text[0]).text).toBe('Hello, world!');

    const use = parse(assistant([{ type: 'tool_use', id: 'toolu_abc', name: 'Read', input: { file_path: '/tmp/test.ts' } }]));
    expect(use).toHaveLength(1);
    expect(use[0].type).toBe('tool-use');
    expect(looseData(use[0])).toMatchObject({ toolUseId: 'toolu_abc', toolName: 'Read', toolInput: { file_path: '/tmp/test.ts' } });

    const result = parse(userLine([{ type: 'tool_result', tool_use_id: 'toolu_abc', content: 'file contents here', is_error: false }]));
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool-result');
    expect(looseData(result[0])).toMatchObject({ toolUseId: 'toolu_abc', toolResult: 'file contents here', isError: false });

    const prompt = parse(userLine('Fix the bug in main.ts', { promptId: 'prompt-xyz' }));
    expect(prompt).toHaveLength(1);
    expect(prompt[0].type).toBe('user-message');
    expect(looseData(prompt[0]).text).toBe('Fix the bug in main.ts');
  });

  it('joins array tool_result text blocks with a newline', () => {
    const events = parse(userLine([{ type: 'tool_result', tool_use_id: 'toolu_arr', content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }], is_error: false }]));
    expect(events).toHaveLength(1);
    expect(looseData(events[0]).toolResult).toBe('line one\nline two');
  });

  it.each([
    ['a file-history-snapshot line', JSON.stringify({ type: 'file-history-snapshot', uuid: 'u6', files: ['/tmp/test.ts'] })],
    ['invalid JSON', 'not json at all{{{'],
    ['a user line without promptId (tool result wrapper)', JSON.stringify(userLine('some automatic content'))],
    ['a line missing the message field', JSON.stringify({ type: 'user', uuid: 'u11' })],
  ])('returns [] for %s', (_n, line) => {
    expect(parseTranscriptLine(line, sessionId)).toEqual([]);
  });

  it('emits turn-complete after content events for end_turn, and content blocks in order (text + tool_use, thinking heartbeat)', () => {
    const done = parse(assistant([{ type: 'text', text: 'Done.' }], {}, { stop_reason: 'end_turn' }));
    expect(done.map((e) => e.type)).toEqual(['assistant-text', 'turn-complete']);
    expect(looseData(done[0]).text).toBe('Done.');
    expect(looseData(done[1]).stopReason).toBe('end_turn');

    const mixed = parse(assistant([{ type: 'text', text: 'Let me read that file.' }, { type: 'tool_use', id: 'toolu_def', name: 'Read', input: { file_path: '/tmp/foo.ts' } }]));
    expect(mixed.map((e) => e.type)).toEqual(['assistant-text', 'tool-use']);
    expect(looseData(mixed[1]).toolName).toBe('Read');

    // Thinking surfaces as a heartbeat so the attention classifier doesn't read extended-thinking pauses as 'stuck'.
    const thinking = parse(assistant([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Here is my answer.' }]));
    expect(thinking.map((e) => e.type)).toEqual(['assistant-thinking', 'assistant-text']);
    expect(looseData(thinking[1]).text).toBe('Here is my answer.');
  });

  it('emits stopReason, model, request id and whole-prompt usage on turn-complete for max_tokens', () => {
    const events = parse(assistant([{ type: 'text', text: 'truncated...' }], { sessionId: 's1', uuid: 'u1', timestamp: '2026-04-17T00:00:00.000Z', requestId: 'req_abc' },
      { model: 'claude-opus-4-7', stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 4096, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } }), 's1');
    // inputTokens is the WHOLE prompt (10 raw + 5 read + 2 created), as in the native runtime and the CC statusline.
    expect(events.find((e) => e.type === 'turn-complete')!.data).toEqual({
      stopReason: 'max_tokens', model: 'claude-opus-4-7', anthropicRequestId: 'req_abc',
      usage: { inputTokens: 17, outputTokens: 4096, cacheReadTokens: 5, cacheCreationTokens: 2 },
    });
  });
});

// ---------------------------------------------------------------------------
// TranscriptWatcher
// ---------------------------------------------------------------------------
describe('TranscriptWatcher', () => {
  let watcher: TranscriptWatcher;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-test-'));
    // Short poll interval so the "falls back to polling" test passes within ~1s. Production default is 2000ms.
    watcher = new TranscriptWatcher(tmpDir, 500);
  });

  afterEach(() => {
    watcher.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const textLine = (uuid: string, text: string, stop_reason: string | null = null) => JSON.stringify({
    type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason },
  });
  const SID = 'desktop-1';
  /** Starts watching a transcript (created with `initial`, or not at all when null); returns its path and the collected events. */
  function tail(initial: string | null = '') {
    const projectDir = path.join(tmpDir, 'proj');
    const jsonlPath = path.join(projectDir, 'claude-session.jsonl');
    if (initial !== null) { fs.mkdirSync(projectDir, { recursive: true }); fs.writeFileSync(jsonlPath, initial); }
    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));
    watcher.startWatching(SID, 'claude-session', '/home/user/project', jsonlPath);
    return { jsonlPath, projectDir, events };
  }
  // The tailer starts at EOF, so content must be appended AFTER startWatching; earlier content is the page reader's job.
  const appendAndRead = (jsonlPath: string, data: string) => { fs.appendFileSync(jsonlPath, data); watcher.readNewLinesForSession(SID); };

  it('emits transcript-event when lines are appended, including a live append after starting at EOF on an existing file', async () => {
    // History is the page reader's job: the tailer used to start at byte 0 and re-emit the WHOLE file on every re-dock.
    const old = textLine('old-1', 'old one') + '\n' + textLine('old-2', 'old two') + '\n';
    const { jsonlPath, events } = tail(old);
    // Negative assertion: give the read every chance to fire, then require silence. A small FIXED count on purpose
    // (no break condition, so every iteration is paid on every run; sizing it like a poll ceiling made the file 6x slower).
    for (let i = 0; i < 5; i++) { await wait(50); watcher.readNewLinesForSession(SID); }
    await wait(100);
    expect(events).toHaveLength(0);
    expect(watcher.getStartOffset(SID)).toBe(fs.statSync(jsonlPath).size);

    fs.appendFileSync(jsonlPath, textLine('new-1', 'Hello from watcher') + '\n');
    for (let i = 0; i < POLL_TRIES_100MS; i++) {
      await wait(100);
      watcher.readNewLinesForSession(SID);
      await wait(50);
      if (events.length > 0) break;
    }
    expect(events.map((e) => looseData(e).text)).toEqual(['Hello from watcher']);
  });

  it('deduplicates events by uuid', async () => {
    const { jsonlPath, events } = tail();
    appendAndRead(jsonlPath, textLine('uuid-dup', 'first') + '\n' + textLine('uuid-dup', 'second') + '\n');
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), { timeout: SETTLE_MS });
    // settle: waiting only for "length is 1" would let a regression that DOES emit the duplicate pass at that instant.
    await wait(50);
    expect(events).toHaveLength(1);
    expect(looseData(events[0]).text).toBe('first');
  });

  it('stopWatching cleans up the session and does not throw for one that is gone', () => {
    tail();
    watcher.stopWatching(SID);
    watcher.stopWatching(SID);
  });

  it('handles partial lines across reads', async () => {
    const fullLine = textLine('uuid-partial', 'partial test');
    const { jsonlPath, events } = tail();
    appendAndRead(jsonlPath, fullLine.substring(0, 50));
    await wait(200); // settle: a fixed wait is correct before a negative assertion
    expect(events).toHaveLength(0);
    fs.appendFileSync(jsonlPath, fullLine.substring(50) + '\n');
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: WATCH_MS });
    expect(looseData(events[0]).text).toBe('partial test');
  });

  it('emits all events from a single line (dedup is per-line, not per-event)', async () => {
    const { jsonlPath, events } = tail();
    appendAndRead(jsonlPath, textLine('uuid-multi-event', 'Done.', 'end_turn') + '\n');
    await vi.waitFor(() => expect(events).toHaveLength(2), { timeout: SETTLE_MS });
    expect(events.map((e) => e.type)).toEqual(['assistant-text', 'turn-complete']);
  });

  it('falls back to polling if the file does not exist yet', async () => {
    const { jsonlPath, projectDir, events } = tail(null);   // must not throw
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(jsonlPath, textLine('uuid-poll', 'From polling') + '\n');
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), { timeout: WATCH_MS });
    expect(looseData(events[0]).text).toBe('From polling');
  });

  // Regression: a throwing listener used to abort the batch loop after session.offset had advanced, stranding the
  // un-emitted chunks forever. Emits must not abort the batch.
  it('continues emitting remaining events when a listener throws on one', async () => {
    const received: string[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => {
      if (ev.type !== 'assistant-text') return;
      if (ev.data.text === 'msg B') throw new Error('boom');
      received.push(ev.data.text as string);
    });
    const { jsonlPath } = tail();
    appendAndRead(jsonlPath, ['A', 'B', 'C'].map((x) => textLine(`uuid-${x}`, `msg ${x}`)).join('\n') + '\n');
    await vi.waitFor(() => expect(received).toEqual(['msg A', 'msg C']), { timeout: SETTLE_MS });
  });

  // WHY live, not replay (2026-09-24, B1): TranscriptWatcher.getHistory — the
  // whole-transcript replay this test used to read — was removed as dead. The
  // correlation it pinned is the LIVE path's: a parent Agent tool_use the
  // tailer reads binds the helper file, whose events come out stamped.
  it('records Agent tool_use in SubagentIndex for correlation', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-agent-'));
    const slug = 'C--tmp-project';
    const projectDir = path.join(tmpRoot, slug);
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = 'sess-abc';
    const parentJsonl = path.join(projectDir, `${sessionId}.jsonl`);
    const subagentsDir = path.join(projectDir, sessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(parentJsonl, '');

    fs.writeFileSync(
      path.join(subagentsDir, 'agent-abc.meta.json'),
      JSON.stringify({ description: 'Find bug', agentType: 'Explore' }),
    );
    // WHY empty at start (2026-10-22): existing helper files are no longer replayed when watching starts
    // (their history comes from the page reader); the helper's line arrives after, as it does live.
    const subagentJsonl = path.join(subagentsDir, 'agent-abc.jsonl');
    fs.writeFileSync(subagentJsonl, '');
    const subagentLine = JSON.stringify({
        type: 'assistant', uuid: 'uuid-s1', isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_S1', name: 'Read', input: { file_path: '/a' } }],
          stop_reason: null,
        },
      }) + '\n';

    const tw = new TranscriptWatcher(tmpRoot);
    const events: TranscriptEvent[] = [];
    tw.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));
    tw.startWatching('desktop-sess-1', sessionId, 'C:/tmp/project');
    try {
      fs.appendFileSync(parentJsonl, agentToolUseLine('uuid-1', 'toolu_P1') + '\n');
      // Wait until the helper file is tracked (its start point fixed) before it gets its line.
      await vi.waitFor(() => expect((tw as any).sessions.get('desktop-sess-1').subagentWatcher.perFile.has('abc')).toBe(true), { timeout: WATCH_MS });
      fs.appendFileSync(subagentJsonl, subagentLine);
      tw.readNewLinesForSession('desktop-sess-1');
      await vi.waitFor(() => {
        expect(events.map(e => e.type + ':' + (looseData(e).toolName ?? ''))).toContain('tool-use:Read');
      }, { timeout: WATCH_MS });
    } finally {
      tw.stopWatching('desktop-sess-1');
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    const parentToolUse = events.find(e => e.type === 'tool-use' && e.data.toolName === 'Agent');
    const subagentToolUse = events.find(e => e.type === 'tool-use' && e.data.toolName === 'Read');
    expect(parentToolUse).toBeDefined();
    expect(looseData(parentToolUse!).parentAgentToolUseId).toBeUndefined();
    expect(looseData(subagentToolUse!).parentAgentToolUseId).toBe('toolu_P1');
    expect(looseData(subagentToolUse!).agentId).toBe('abc');
  });
});

/** A parent-transcript line carrying one Agent tool_use ('Find bug' / Explore). */
function agentToolUseLine(uuid: string, toolUseId: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: toolUseId, name: 'Agent',
        input: { description: 'Find bug', subagent_type: 'Explore', prompt: 'go' },
      }],
      stop_reason: null,
    },
  });
}

// ---------------------------------------------------------------------------
// Read serialization, UTF-8 boundary safety, replay dedup (2026-07-10 review)
// ---------------------------------------------------------------------------
describe('TranscriptWatcher read integrity', () => {
  let watcher: TranscriptWatcher;
  let tmpDir: string;

  function setupSession(desktopId: string, claudeId: string) {
    const cwd = '/home/user/integrity';
    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeId}.jsonl`);
    fs.writeFileSync(jsonlPath, '');
    watcher.startWatching(desktopId, claudeId, cwd, jsonlPath);
    return jsonlPath;
  }

  const userLine = (uuid: string, text: string) =>
    JSON.stringify({
      type: 'user',
      uuid,
      promptId: `prompt-${uuid}`,
      message: { role: 'user', content: text },
    });

  beforeEach(() => {
    // Long poll interval so the global poll can't interfere with the
    // deterministic manual triggers these tests rely on.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-integrity-'));
    watcher = new TranscriptWatcher(tmpDir, 60_000);
  });

  afterEach(() => {
    watcher.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not double-emit when two reads are triggered concurrently', async () => {
    const jsonlPath = setupSession('desktop-race', 'claude-race');
    // Let the startWatching initial read settle on the empty file.
    await new Promise((r) => setTimeout(r, 200));

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    fs.appendFileSync(jsonlPath, userLine('uuid-race-1', 'hello once') + '\n');

    // Two synchronous triggers — without per-session serialization both stat
    // the same file size before either advances session.offset, so both read
    // and emit the same byte range (user-message is deliberately re-emitted
    // on repeated uuids, so uuid dedup does not mask the race).
    watcher.readNewLinesForSession('desktop-race');
    watcher.readNewLinesForSession('desktop-race');

    // Poll for the first emit (the read is async — a fixed 500ms raced it under
    // load), THEN settle so a second, racing emit would have landed before we
    // assert it didn't. The old single sleep was doing both jobs at once.
    await vi.waitFor(
      () => expect(events.filter((e) => e.type === 'user-message').length).toBeGreaterThanOrEqual(1),
      { timeout: SETTLE_MS },
    );
    // settle (negative assertion): a second, racing emit would land here.
    await wait(200);

    const userMessages = events.filter((e) => e.type === 'user-message');
    expect(userMessages.length).toBe(1);
  });

  it('preserves a multi-byte UTF-8 character split across two reads', async () => {
    const jsonlPath = setupSession('desktop-utf8', 'claude-utf8');
    await new Promise((r) => setTimeout(r, 200));

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    const full = Buffer.from(userLine('uuid-utf8-1', 'emoji 😀 intact') + '\n', 'utf8');
    // Split inside the emoji's 4-byte sequence. The emoji is the only 4-byte
    // char, so cutting 2 bytes after its first byte is guaranteed mid-sequence.
    const emojiStart = full.indexOf(Buffer.from('😀', 'utf8'));
    const splitAt = emojiStart + 2;

    fs.appendFileSync(jsonlPath, full.subarray(0, splitAt));
    watcher.readNewLinesForSession('desktop-utf8');
    await new Promise((r) => setTimeout(r, 300));

    fs.appendFileSync(jsonlPath, full.subarray(splitAt));
    await vi.waitFor(() => { watcher.readNewLinesForSession('desktop-utf8'); expect(events.length).toBeGreaterThan(0); }, { interval: 100 });

    const msg = events.find((e) => e.type === 'user-message');
    expect(msg).toBeDefined();
    expect(msg!.data.text).toContain('😀');
    expect(msg!.data.text).not.toContain('�');
  });

  // 300 assistant-text lines of ~10 KB each ≈ 3 MB written in ONE fs write —
  // simulates a /compact rewrite, a huge pasted tool result, or a transcript
  // that grew while the app was suspended: all arrive as a single delta that
  // must still deliver every line, whatever the per-read byte cap is.
  const bigBurstLine = (i: number) =>
    JSON.stringify({
      uuid: `u${i}`,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `${i}:` + 'x'.repeat(10_000) }] },
      timestamp: new Date().toISOString(),
    }) + '\n';

  // WHY a session with NO fs.watch: the cap/drain tests below must prove the
  // watcher drains a multi-pass burst ON ITS OWN from one trigger. startWatching
  // attaches fs.watch only when the file already exists, so creating the file
  // AFTERWARDS leaves no watch attached; the describe's 60s poll interval is far
  // longer than any waitFor here. The only read that can happen is the one the
  // test triggers — nothing external can do the draining for it.
  function setupUnwatchedSession(desktopId: string, claudeId: string) {
    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeId}.jsonl`);
    watcher.startWatching(desktopId, claudeId, '/home/user/integrity', jsonlPath);
    return jsonlPath;
  }

  it('delivers every line of a burst larger than one read cap, in order', async () => {
    const jsonlPath = setupUnwatchedSession('desktop-burst', 'claude-burst');

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    fs.writeFileSync(jsonlPath, Array.from({ length: 300 }, (_, i) => bigBurstLine(i)).join(''));

    // ONE trigger, no retry loop: ~3 MB against a 1 MiB cap needs at least three
    // passes, and only readNewLines' own rerun request can chain them.
    watcher.readNewLinesForSession('desktop-burst');
    await vi.waitFor(
      () => expect(events.filter((e) => e.type === 'assistant-text')).toHaveLength(300),
      { timeout: SETTLE_MS },
    );

    const texts = events.filter((e) => e.type === 'assistant-text').map((e) => e.data.text!.split(':')[0]);
    expect(texts).toEqual(Array.from({ length: 300 }, (_, i) => String(i)));
  });

  it('never allocates more than the read cap per pass', async () => {
    const jsonlPath = setupUnwatchedSession('desktop-cap', 'claude-cap');

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    const sizes: number[] = [];
    const orig = Buffer.alloc.bind(Buffer);
    // Narrow to allocations that could plausibly be a tail-read buffer (>= 64
    // KiB) — Buffer.alloc is a common global utility (e.g. the shrink-reset
    // `partialBytes = Buffer.alloc(0)` a few lines away), and recording every
    // call would make this spy flaky against unrelated callers rather than
    // proving anything about the read cap.
    const spy = vi.spyOn(Buffer, 'alloc').mockImplementation((n: number, ...rest: any[]) => {
      if (n >= 64 * 1024) sizes.push(n);
      return orig(n, ...rest);
    });
    try {
      fs.writeFileSync(jsonlPath, Array.from({ length: 300 }, (_, i) => bigBurstLine(i)).join(''));

      // One trigger, same reason as the burst test above.
      watcher.readNewLinesForSession('desktop-cap');
      await vi.waitFor(
        () => expect(events.filter((e) => e.type === 'assistant-text')).toHaveLength(300),
        { timeout: SETTLE_MS },
      );

      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1024 * 1024);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not spin retrying when opening the transcript keeps failing', async () => {
    // WHY: a failed open makes no progress, so it must wait for the next watch
    // event or poll tick — never rerun at once. An immediate rerun loops
    // stat+open as fast as libuv's 4-thread pool allows for as long as the error
    // lasts (EMFILE, a Windows sharing violation during an antivirus scan),
    // starving lease writes, transcript copies and other reads.
    const jsonlPath = setupUnwatchedSession('desktop-open-fail', 'claude-open-fail');
    // Larger than one read cap, so a pass that asked for a rerun before opening
    // (the regression) would have a reason to ask.
    fs.writeFileSync(jsonlPath, Array.from({ length: 150 }, (_, i) => bigBurstLine(i)).join(''));

    const openSpy = vi.spyOn(fs.promises, 'open').mockRejectedValue(
      Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }),
    );
    try {
      watcher.readNewLinesForSession('desktop-open-fail');
      await vi.waitFor(() => expect(openSpy).toHaveBeenCalled(), { timeout: SETTLE_MS });
      // Fixed settle before a NEGATIVE assertion (see `wait` above): it gives a
      // retry loop time to show itself. No watch is attached and the poll is 60s,
      // so exactly one open is correct; a tight loop makes hundreds in 300ms.
      await wait(300);
      expect(openSpy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      openSpy.mockRestore();
    }
  });
  // (The replay-side dedup test that lived here moved to transcript-page.test.ts
  //  with the removal of TranscriptWatcher.getHistory — B1, 2026-09-24.)
});

// ---------------------------------------------------------------------------
// startWatching path source (spec §5.0): hook-supplied transcript_path wins,
// slug derivation is fallback-only.
// ---------------------------------------------------------------------------
describe('startWatching path source', () => {
  let watcher: TranscriptWatcher;
  let tmpDir: string;

  beforeEach(() => {
    // Canonicalize: on macOS, FSEvents reports the RESOLVED path (os.tmpdir()
    // is a symlink, /var/folders/... -> /private/var/folders/...), so a raw
    // mkdtemp path here can silently diverge from what the watcher actually
    // sees fire.
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-pathsource-')));
    watcher = new TranscriptWatcher(tmpDir);
  });

  afterEach(() => {
    watcher.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the hook-supplied transcript_path verbatim when present', async () => {
    const dir = path.join(tmpDir, 'anything CC chose — no slug involved');
    fs.mkdirSync(dir, { recursive: true });
    const jsonlPath = path.join(dir, 'claude-x.jsonl');
    fs.writeFileSync(jsonlPath, '');
    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));
    watcher.startWatching('desktop-x', 'claude-x', '/some/cwd/that/would/derive/elsewhere', jsonlPath);
    fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'user', uuid: 'u1', promptId: 'prompt-u1', message: { role: 'user', content: 'hi' } }) + '\n');
    // Poll instead of a fixed sleep — see the file header: a fixed budget loses
    // on a busy runner (this is exactly the macOS-CI flake shape).
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: WATCH_MS });
  });

  it('falls back to ccProjectSlug derivation when transcript_path is absent', async () => {
    const cwd = '/home/user/My Project, With & Punct';
    const projectDir = path.join(tmpDir, ccProjectSlug(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, 'claude-y.jsonl');
    fs.writeFileSync(jsonlPath, '');
    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));
    watcher.startWatching('desktop-y', 'claude-y', cwd);
    fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'user', uuid: 'u2', promptId: 'prompt-u2', message: { role: 'user', content: 'hi' } }) + '\n');
    // Poll instead of a fixed sleep — see the file header: a fixed budget loses
    // on a busy runner (this is exactly the macOS-CI flake shape).
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: WATCH_MS });
  });

  // WHY: fallback tests can't distinguish dirname-based from slug-based
  // subagentsDir — this divergent path can. Under the 3-arg fallback,
  // path.dirname(jsonlPath) and path.join(claudeConfigDir, ccProjectSlug(cwd))
  // are the SAME directory, so a regression that reverted subagentsDir to
  // slug-derivation would still pass every other test in this file (including
  // the line-~599 "records Agent tool_use" test, which is 3-arg/fallback).
  // Here cwd's slug ("C--tmp-project") and the hook-supplied transcript
  // directory are deliberately different strings — subagentsDir can only be
  // computed correctly by riding jsonlPath's own dirname.
  it('subagentsDir follows the hook-supplied transcript path, not slug(cwd)', async () => {
    const cwd = 'C:/tmp/project'; // slug(cwd) === 'C--tmp-project' — must NOT appear below
    const divergentDir = path.join(tmpDir, 'not a slug CC would ever produce');
    fs.mkdirSync(divergentDir, { recursive: true });
    const sessionId = 'sess-hook';
    const parentJsonl = path.join(divergentDir, `${sessionId}.jsonl`);
    const subagentsDir = path.join(divergentDir, sessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });

    fs.writeFileSync(parentJsonl, '');

    fs.writeFileSync(
      path.join(subagentsDir, 'agent-hook.meta.json'),
      JSON.stringify({ description: 'Find bug', agentType: 'Explore' }),
    );
    // Empty at start: existing helper files are not replayed (2026-10-22); the line arrives after watching starts.
    const hookSubagentJsonl = path.join(subagentsDir, 'agent-hook.jsonl');
    fs.writeFileSync(hookSubagentJsonl, '');
    const hookSubagentLine = JSON.stringify({
        type: 'assistant', uuid: 'uuid-hook-s1', isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_HS1', name: 'Read', input: { file_path: '/a' } }],
          stop_reason: null,
        },
      }) + '\n';

    // 4-arg: transcriptPath (parentJsonl, inside divergentDir) wins over any
    // cwd-derived slug. If subagentsDir regressed to slug-derivation, it would
    // look under tmpDir/C--tmp-project/sess-hook/subagents instead — a
    // directory that was never created — and the subagent tool_use below
    // would never be found.
    const history: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => history.push(ev));
    watcher.startWatching('desktop-hook-1', sessionId, cwd, parentJsonl);
    // Live path (getHistory was removed in B1): the parent's Agent tool_use is
    // appended after watching starts, which binds the helper file.
    fs.appendFileSync(parentJsonl, agentToolUseLine('uuid-hook-1', 'toolu_HP1') + '\n');
    await vi.waitFor(() => expect((watcher as any).sessions.get('desktop-hook-1').subagentWatcher.perFile.has('hook')).toBe(true), { timeout: WATCH_MS });
    fs.appendFileSync(hookSubagentJsonl, hookSubagentLine);
    watcher.readNewLinesForSession('desktop-hook-1');
    await vi.waitFor(() => {
      expect(history.some(e => e.type === 'tool-use' && e.data.toolName === 'Read')).toBe(true);
    }, { timeout: WATCH_MS });

    const parentToolUse = history.find(e => e.type === 'tool-use' && e.data.toolName === 'Agent');
    const subagentToolUse = history.find(e => e.type === 'tool-use' && e.data.toolName === 'Read');
    expect(parentToolUse).toBeDefined();
    expect(subagentToolUse).toBeDefined();
    expect(looseData(subagentToolUse!).parentAgentToolUseId).toBe('toolu_HP1');
    expect(looseData(subagentToolUse!).agentId).toBe('hook');
  });
});

describe('parseTranscriptLine — recordedAt on tool results', () => {
  const line = (extra: Record<string, unknown>) => JSON.stringify({
    type: 'user', uuid: 'u-1', ...extra,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sent 1 file to the user.' }] },
  });

  it("carries the line's own timestamp so the renderer can tell replayed history from a live result", () => {
    const events = parseTranscriptLine(line({ timestamp: '2026-08-25T10:00:00.000Z' }), 'sess');
    const result = events.find((e) => e.type === 'tool-result');
    expect(result?.data.recordedAt).toBe(Date.parse('2026-08-25T10:00:00.000Z'));
  });

  it('fails CLOSED when the line has no usable timestamp (recordedAt 0 = never fresh)', () => {
    const events = parseTranscriptLine(line({}), 'sess');
    expect(events.find((e) => e.type === 'tool-result')?.data.recordedAt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A turn is MANY requests, and until 2026-09-03 only the last one was counted.
//
// Claude Code writes one assistant line per API request; every tool call is
// another round trip, and only the final line of a turn carries a stop_reason
// other than `tool_use`. The parser reported that final line's usage as the
// turn's, so the app was recording a few percent of the truth. Measured across
// six of Destin's real transcripts: turn-complete lines are 4-17% of the
// assistant lines that carry usage, and one 42-hour session's Out: chip read
// 713 output tokens against a true 124,912.
// ---------------------------------------------------------------------------
describe('parseTranscriptLine — a turn is summed across all its requests', () => {
  const assistantLine = (
    uuid: string,
    stopReason: string,
    usage: Record<string, number> | null,
  ) => JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-09-03T00:00:00.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'working' }],
      stop_reason: stopReason,
      ...(usage ? { usage } : {}),
    },
  });

  const req = (input: number, output: number, read = 0, create = 0) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: create,
  });

  const usageOf = (events: ReturnType<typeof parseTranscriptLine>) =>
    events.find((e) => e.type === 'turn-complete')?.data.usage;

  it('adds up every request of a turn, not just the one that ended it', () => {
    const tally = emptyTurnUsageTally();
    // Three tool-loop requests, then the reply that ends the turn.
    parseTranscriptLine(assistantLine('a1', 'tool_use', req(10, 100, 1_000, 50)), 's1', tally);
    parseTranscriptLine(assistantLine('a2', 'tool_use', req(10, 200, 2_000, 0)), 's1', tally);
    parseTranscriptLine(assistantLine('a3', 'tool_use', req(10, 300, 3_000, 0)), 's1', tally);
    const events = parseTranscriptLine(assistantLine('a4', 'end_turn', req(10, 400, 4_000, 0)), 's1', tally);

    // Output is the whole turn's: 100 + 200 + 300 + 400. Before the fix this
    // was 400 — the last request alone.
    expect(usageOf(events)).toEqual({
      inputTokens: 10_090,      // each request's WHOLE prompt (raw + read + create)
      outputTokens: 1_000,
      cacheReadTokens: 10_000,
      cacheCreationTokens: 50,
    });
    expect(usageOf(events)!.outputTokens).not.toBe(400);
  });

  it('resets between turns so the second turn is not the running total', () => {
    const tally = emptyTurnUsageTally();
    parseTranscriptLine(assistantLine('b1', 'tool_use', req(0, 100, 1_000)), 's1', tally);
    parseTranscriptLine(assistantLine('b2', 'end_turn', req(0, 100, 1_000)), 's1', tally);
    const second = parseTranscriptLine(assistantLine('b3', 'end_turn', req(0, 7, 70)), 's1', tally);
    expect(usageOf(second)).toEqual({
      inputTokens: 70, outputTokens: 7, cacheReadTokens: 70, cacheCreationTokens: 0,
    });
  });

  it('still closes the turn when only the intermediate requests were measured', () => {
    // A final line with no usage block must not throw away the requests that
    // came before it — that is the original bug wearing a different hat.
    const tally = emptyTurnUsageTally();
    parseTranscriptLine(assistantLine('c1', 'tool_use', req(0, 500, 9_000)), 's1', tally);
    const events = parseTranscriptLine(assistantLine('c2', 'end_turn', null), 's1', tally);
    expect(usageOf(events)).toEqual({
      inputTokens: 9_000, outputTokens: 500, cacheReadTokens: 9_000, cacheCreationTokens: 0,
    });
  });

  it('omits usage entirely when a turn measured nothing', () => {
    const tally = emptyTurnUsageTally();
    const events = parseTranscriptLine(assistantLine('d1', 'end_turn', null), 's1', tally);
    expect(usageOf(events)).toBeUndefined();
  });

  it('stamps inputTokens as the WHOLE prompt, the way both other sources do', () => {
    // The native runtime's inputTokens is the whole prompt, and so is the
    // statusline's context_window.total_input_tokens (it is literally built as
    // input + cache_creation + cache_read). Raw Anthropic input_tokens — the
    // uncached remainder — is the odd one out, so it is converted here rather
    // than leaving every downstream reader to guess which it got.
    const tally = emptyTurnUsageTally();
    const events = parseTranscriptLine(assistantLine('e1', 'end_turn', req(7, 1, 900, 93)), 's1', tally);
    expect(usageOf(events)!.inputTokens).toBe(1_000);
  });
});

// Destin, 2026-09-11, phone pass: "still having issues with messages not always appearing in the
// same order on the desktop and the remote client". Two kinds of message Claude Code records
// outside an ordinary user line were dropped here, so the device that typed them kept an
// unconfirmed bubble pinned to the bottom while every other device never showed them. Measured
// on the 400 newest transcripts on this machine: 84 queued typed messages (82 from a person, 2
// sent in by another Claude Code session), 1,218 queued background-task notices, and no
// ordinary user line repeating a queued message within three lines.
describe('messages recorded outside an ordinary user line', () => {
  const queued = (prompt: string, commandMode: string, origin?: unknown) => JSON.stringify({
    type: 'attachment', uuid: 'q1', timestamp: '2026-09-11T10:00:00.000Z',
    attachment: { type: 'queued_command', prompt, commandMode, ...(origin === undefined ? {} : { origin }), timestamp: '2026-09-11T10:00:00.000Z' },
  });
  const commandLine = (content: string) => JSON.stringify({
    type: 'user', uuid: 'c1', promptId: 'p1', timestamp: '2026-09-11T10:00:00.000Z', message: { role: 'user', content },
  });

  it('a message typed while Claude is working is a user message', () => {
    expect(parseTranscriptLine(queued('second', 'prompt', { kind: 'human' }), 's1')).toEqual([
      expect.objectContaining({ type: 'user-message', sessionId: 's1', uuid: 'q1', data: { text: 'second' } }),
    ]);
  });

  it('a queue send shows the words the person typed, with its attached files and without the read instruction', () => {
    const wire = 'Read this entire file: "/p/notes.md"\nUse Read before answering; read large text in chunks if needed. If a file is unavailable or cannot be read, say so. Do not assume the file contents were supplied automatically.\n\nCompare "/p/notes.md"\n\nAttached: "/q/shot.png"';
    expect(parseTranscriptLine(queued(wire, 'prompt', { kind: 'human' }), 's1')).toEqual([
      expect.objectContaining({ type: 'user-message', uuid: 'q1', data: { text: 'Compare "/p/notes.md"', attachedFiles: ['/q/shot.png'] } }),
    ]);
    expect(parseTranscriptLine(commandLine('what is this\n\nAttached: "/q/shot.png"'), 's1')).toEqual([
      expect.objectContaining({ type: 'user-message', data: { text: 'what is this', attachedFiles: ['/q/shot.png'] } }),
    ]);
  });

  it('a background task notice stays hidden', () => {
    expect(parseTranscriptLine(queued('<task-notification><task-id>b1</task-id></task-notification>', 'task-notification'), 's1')).toEqual([]);
  });

  it('a message another Claude Code session sent in is not shown as something the person typed', () => {
    expect(parseTranscriptLine(queued('Heads-up from the Plan C session', 'prompt', { kind: 'peer', from: 'uds:/run/x.sock' }), 's1')).toEqual([]);
  });

  it('a slash command is a user message, marked as a command', () => {
    const line = commandLine('<command-name>/reload-plugins</command-name>\n            <command-message>reload-plugins</command-message>\n            <command-args></command-args>');
    expect(parseTranscriptLine(line, 's1')).toEqual([
      expect.objectContaining({ type: 'user-message', uuid: 'c1', data: { text: '/reload-plugins', slashCommand: true } }),
    ]);
  });

  it('a slash command keeps its arguments', () => {
    const line = commandLine('<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args>we are going to prepare the plan.</command-args>');
    expect(parseTranscriptLine(line, 's1')).toEqual([
      expect.objectContaining({ data: { text: '/compact we are going to prepare the plan.', slashCommand: true } }),
    ]);
  });

  it('a /model command line naming a model, or none, is not a user bubble', () => {
    for (const args of ['opus[1m]', 'sonnet', 'claude-haiku-5-5', '']) {
      const line = commandLine(`<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>${args}</command-args>`);
      expect(parseTranscriptLine(line, 's1')).toEqual([]);
    }
  });

  it('a /model command line naming no known model stays the plain command', () => {
    const line = commandLine('<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>gpt-weird</command-args>');
    expect(parseTranscriptLine(line, 's1')).toEqual([expect.objectContaining({ type: 'user-message', data: { text: '/model gpt-weird', slashCommand: true } })]);
  });

  it("Claude Code's \"Set model to\" reply is the model switch, in every spelling it has used", () => {
    const esc = String.fromCharCode(27);
    for (const [reply, model] of [
      [`Set model to ${esc}[1mOpus 5 (1M context)${esc}[22m and saved as your default for new sessions`, 'opus[1m]'],
      ['Set model to `Sonnet 5.5` and saved as your default for new sessions', 'sonnet'],
      [`Set model to ${esc}[1mHaiku 4.5${esc}[22m`, 'haiku'],
      ['Set model to Fable 5 and saved as your default for new sessions · Draws from usage', 'fable'],
      ['Set model to Mystery 9', 'Mystery 9'],
    ] as const) {
      expect(parseTranscriptLine(commandLine(`<local-command-stdout>${reply}</local-command-stdout>`), 's1'))
        .toEqual([expect.objectContaining({ type: 'model-switch', uuid: 'c1', data: { model } })]);
    }
  });

  it('a declined switch ("Kept model as") draws nothing', () => {
    expect(parseTranscriptLine(commandLine('<local-command-stdout>Kept model as `Opus 5.5 (1M context)`</local-command-stdout>'), 's1')).toEqual([]);
  });

  it("the dimmed echo of a command's output stays hidden", () => {
    const esc = String.fromCharCode(27);
    expect(parseTranscriptLine(commandLine(`<local-command-stdout>${esc}[2mCompacted${esc}[22m</local-command-stdout>`), 's1')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The safety-net poll (simplification audit W7). It used to tick every 2 s for
// every open session on every platform beside a working fs.watch. Only Windows
// drops notifications after the watch is armed, so off Windows the poll now
// stops once the watch is attached, and comes back only when a watch fails.
// ---------------------------------------------------------------------------
describe('TranscriptWatcher safety-net poll', () => {
  let watcher: TranscriptWatcher;
  let tmpDir: string;
  const realPlatform = process.platform;

  const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

  function existingTranscript(name: string): string {
    const jsonlPath = path.join(tmpDir, `${name}.jsonl`);
    fs.writeFileSync(jsonlPath, '');
    return jsonlPath;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-poll-'));
    watcher = new TranscriptWatcher(tmpDir, 500);
  });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.restoreAllMocks();
    watcher.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs no poll timer on Linux and macOS once the watch is attached, and still delivers appended lines', async () => {
    setPlatform('linux');
    const jsonlPath = existingTranscript('healthy');
    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));
    watcher.startWatching('d-healthy', 'healthy', '/proj', jsonlPath);
    expect(watcher.isPolling()).toBe(false);

    fs.appendFileSync(jsonlPath, JSON.stringify({
      type: 'assistant', uuid: 'u-healthy',
      message: { role: 'assistant', content: [{ type: 'text', text: 'via fs.watch' }], stop_reason: null },
    }) + '\n');
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), { timeout: WATCH_MS });
    expect(looseData(events[0]).text).toBe('via fs.watch');
    expect(watcher.isPolling()).toBe(false);
  });

  it('keeps the poll alongside the watch on Windows', () => {
    setPlatform('win32');
    watcher.startWatching('d-win', 'win', '/proj', existingTranscript('win'));
    expect(watcher.isPolling()).toBe(true);
  });

  it('polls when fs.watch cannot be attached at all', () => {
    setPlatform('linux');
    vi.spyOn(fs, 'watch').mockImplementation(() => { throw new Error('EMFILE'); });
    watcher.startWatching('d-nowatch', 'nowatch', '/proj', existingTranscript('nowatch'));
    expect(watcher.isPolling()).toBe(true);
  });

  it('brings the poll back when an attached watcher reports an error', () => {
    setPlatform('linux');
    const fakeWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    vi.spyOn(fs, 'watch').mockReturnValue(fakeWatcher as any);
    watcher.startWatching('d-err', 'err', '/proj', existingTranscript('err'));
    expect(watcher.isPolling()).toBe(false);

    fakeWatcher.emit('error', new Error('watch dropped'));
    expect(fakeWatcher.close).toHaveBeenCalled();
    expect(watcher.isPolling()).toBe(true);
  });

  it("re-watches the path on a 'rename' event, so a rename-replaced transcript keeps delivering", () => {
    setPlatform('linux');
    const fakes: Array<EventEmitter & { close: ReturnType<typeof vi.fn> }> = [];
    const watch = vi.spyOn(fs, 'watch').mockImplementation(((_p: string, cb: (ev: string) => void) => {
      const w = Object.assign(new EventEmitter(), { close: vi.fn() });
      w.on('change', (ev: string) => cb(ev));
      fakes.push(w);
      return w as any;
    }) as any);
    watcher.startWatching('d-ren', 'ren', '/proj', existingTranscript('ren'));
    expect(watch).toHaveBeenCalledTimes(1);

    fakes[0].emit('change', 'rename'); // the inode under the watch was replaced
    expect(fakes[0].close).toHaveBeenCalled();
    expect(watch).toHaveBeenCalledTimes(2); // re-attached by path
    expect(watcher.isPolling()).toBe(false); // healthy again, no poll needed

    watch.mockImplementation(() => { throw new Error('ENOENT'); }); // renamed away, nothing to watch yet
    fakes[1].emit('change', 'rename');
    expect(watcher.isPolling()).toBe(true); // the poll covers the gap and re-attaches later
  });

  it('polls only until the transcript file appears, then hands over to the watch', async () => {
    setPlatform('linux');
    const jsonlPath = path.join(tmpDir, 'later', 'later.jsonl');
    watcher.startWatching('d-later', 'later', '/proj', jsonlPath);
    expect(watcher.isPolling()).toBe(true); // nothing to watch yet

    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    fs.writeFileSync(jsonlPath, '');
    await vi.waitFor(() => expect(watcher.isPolling()).toBe(false), { timeout: WATCH_MS });
  });
});

// ---------------------------------------------------------------------------
// parseTranscriptLine — control messages CC writes as user lines
// ---------------------------------------------------------------------------

describe('parseTranscriptLine — control messages written as user lines', () => {
  function makeUserLine(
    text: string,
    promptId = 'pid-1',
    uuid = 'u-1',
    timestamp = '2026-04-21T00:00:00Z',
  ) {
    return JSON.stringify({
      type: 'user',
      promptId,
      uuid,
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  }

  describe('transcript-watcher interrupt detection', () => {
    it('emits user-interrupt (kind=plain) for "[Request interrupted by user]"', () => {
      const events = parseTranscriptLine(
        makeUserLine('[Request interrupted by user]'),
        'sess-1',
      );
      expect(events).toEqual([
        expect.objectContaining({
          type: 'user-interrupt',
          sessionId: 'sess-1',
          data: { kind: 'plain' },
        }),
      ]);
    });

    it('emits user-interrupt (kind=tool-use) for "[Request interrupted by user for tool use]"', () => {
      const events = parseTranscriptLine(
        makeUserLine('[Request interrupted by user for tool use]'),
        'sess-1',
      );
      expect(events).toEqual([
        expect.objectContaining({
          type: 'user-interrupt',
          sessionId: 'sess-1',
          data: { kind: 'tool-use' },
        }),
      ]);
    });

    it('does NOT emit a user-message when emitting user-interrupt', () => {
      const events = parseTranscriptLine(
        makeUserLine('[Request interrupted by user]'),
        'sess-1',
      );
      expect(events.some((e) => e.type === 'user-message')).toBe(false);
    });

    it('emits user-message for a normal user prompt', () => {
      const events = parseTranscriptLine(makeUserLine('hello claude'), 'sess-1');
      expect(events).toEqual([
        expect.objectContaining({
          type: 'user-message',
          data: expect.objectContaining({ text: 'hello claude' }),
        }),
      ]);
    });

    it('treats interrupt text embedded in longer content as a normal user-message', () => {
      const events = parseTranscriptLine(
        makeUserLine('hey, [Request interrupted by user] btw'),
        'sess-1',
      );
      expect(events).toEqual([
        expect.objectContaining({ type: 'user-message' }),
      ]);
    });
  });

  // Regression tests for the post-/compact bugs:
  //   (1) a "Compacted (ctrl+o to see full summary)" user bubble appearing
  //       after every /compact, and
  //   (2) chat view permanently stuck in "thinking" state after every /compact.
  // Both stemmed from the parser UNWRAPPING <local-command-stdout>, which let CC's
  // dimmed stdout echo of /compact reach the reducer's TRANSCRIPT_USER_MESSAGE
  // "no pending match" path — appending a fake user bubble AND setting
  // isThinking:true with no transcript turn to ever clear it.
  describe('transcript-watcher local-command-stdout suppression', () => {
    it('emits NO events for the dimmed "Compacted (...)" stdout echo after /compact', () => {
      const line = JSON.stringify({
        type: 'user',
        promptId: 'pid-1',
        uuid: 'u-compact-stdout',
        timestamp: '2026-04-29T05:29:38.779Z',
        message: {
          role: 'user',
          // Exact shape CC v2.1.119 writes — ANSI [2m dim wrap around the inner text.
          content: '<local-command-stdout>[2mCompacted (ctrl+o to see full summary)[22m</local-command-stdout>',
        },
      });
      const events = parseTranscriptLine(line, 'sess-1');
      expect(events).toEqual([]);
    });

    it('strips <local-command-stderr> the same way', () => {
      const line = JSON.stringify({
        type: 'user',
        promptId: 'pid-1',
        uuid: 'u-stderr',
        message: { role: 'user', content: '<local-command-stderr>boom</local-command-stderr>' },
      });
      expect(parseTranscriptLine(line, 'sess-1')).toEqual([]);
    });
  });

  describe('transcript-watcher compact-summary forwarding', () => {
    it('emits compact-summary with the summary text from an isCompactSummary line', () => {
      const summary = 'Summary:\n1. Primary Request: do the thing\n2. Files: foo.ts';
      const line = JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        uuid: 'u-compact',
        timestamp: '2026-04-29T05:29:38.615Z',
        message: { role: 'user', content: summary },
      });
      const events = parseTranscriptLine(line, 'sess-1');
      expect(events).toEqual([
        expect.objectContaining({
          type: 'compact-summary',
          sessionId: 'sess-1',
          timestamp: Date.parse('2026-04-29T05:29:38.615Z'),
          data: { summary, sourceTimestamp: Date.parse('2026-04-29T05:29:38.615Z') },
        }),
      ]);
    });

    it('omits summary field on an isCompactSummary line with empty content', () => {
      const line = JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        uuid: 'u-empty',
        message: { role: 'user', content: '' },
      });
      const events = parseTranscriptLine(line, 'sess-1');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('compact-summary');
      expect(events[0].data).toEqual({ sourceTimestamp: 0 });
    });
  });
});

// Destin, 2026-10-22: one "wyd" sent from the phone showed as two bubbles. Claude Code had written the prompt twice — the second
// line after a stalled request, with the same parent entry and the same text — and its terminal showed one.
describe('a prompt Claude Code wrote twice', () => {
  const line = (uuid: string, parentUuid: string, text: string, ts: string) => JSON.stringify({
    parentUuid, type: 'user', message: { role: 'user', content: text }, uuid, promptId: `p-${uuid}`, timestamp: ts,
    origin: { kind: 'human' }, promptSource: 'typed',
  });
  const userTexts = (lines: string[]) => {
    const tally = emptyTurnUsageTally();
    return lines.flatMap((l) => parseTranscriptLine(l, 'desk-1', tally)).filter((e) => e.type === 'user-message').map((e) => (e.data as { text: string }).text);
  };

  it('shows once when the second copy follows the same entry', () => {
    expect(userTexts([
      line('a', 'root', 'wyd', '2026-10-22T18:34:08.567Z'),
      line('b', 'root', 'wyd', '2026-10-22T18:35:06.923Z'),
    ])).toEqual(['wyd']);
  });

  it('still shows the same words typed again after the first', () => {
    expect(userTexts([
      line('a', 'root', 'wyd', '2026-10-22T18:34:08.567Z'),
      line('b', 'a', 'wyd', '2026-10-22T18:35:06.923Z'),
    ])).toEqual(['wyd', 'wyd']);
  });
});
