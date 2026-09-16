import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseTranscriptLine,
  emptyTurnUsageTally,
  TranscriptWatcher,
} from '../src/main/transcript-watcher';
import { ccProjectSlug } from '../src/main/slug-encoding';
import type { TranscriptEvent } from '../src/shared/types';

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

  it('parses assistant text block → assistant-text event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello, world!' }],
        stop_reason: null,
      },
    });

    const events = parseTranscriptLine(line, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant-text');
    expect(events[0].sessionId).toBe(sessionId);
    expect(events[0].uuid).toBe('uuid-1');
    expect(events[0].data.text).toBe('Hello, world!');
  });

  it('parses tool_use block → tool-use event with id, name, input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-2',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'Read',
            input: { file_path: '/tmp/test.ts' },
          },
        ],
        stop_reason: null,
      },
    });

    const events = parseTranscriptLine(line, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool-use');
    expect(events[0].data.toolUseId).toBe('toolu_abc');
    expect(events[0].data.toolName).toBe('Read');
    expect(events[0].data.toolInput).toEqual({ file_path: '/tmp/test.ts' });
  });

  it('parses tool_result from user message → tool-result event', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'uuid-3',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_abc',
            content: 'file contents here',
            is_error: false,
          },
        ],
      },
    });

    const events = parseTranscriptLine(line, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool-result');
    expect(events[0].data.toolUseId).toBe('toolu_abc');
    expect(events[0].data.toolResult).toBe('file contents here');
    expect(events[0].data.isError).toBe(false);
  });

  it('parses user prompt (has promptId) → user-message event', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'uuid-4',
      promptId: 'prompt-xyz',
      message: {
        role: 'user',
        content: 'Fix the bug in main.ts',
      },
    });

    const events = parseTranscriptLine(line, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user-message');
    expect(events[0].data.text).toBe('Fix the bug in main.ts');
  });

  it('emits turn-complete for end_turn stop reason (in addition to content events)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-5',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      },
    });

    const events = parseTranscriptLine(line, sessionId);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant-text');
    expect(events[0].data.text).toBe('Done.');
    expect(events[1].type).toBe('turn-complete');
    expect(events[1].data.stopReason).toBe('end_turn');
  });

  it('returns [] for file-history-snapshot lines', () => {
    const line = JSON.stringify({
      type: 'file-history-snapshot',
      uuid: 'uuid-6',
      files: ['/tmp/test.ts'],
    });

    const events = parseTranscriptLine(line, sessionId);
    expect(events).toEqual([]);
  });

  it('returns [] for invalid JSON', () => {
    const events = parseTranscriptLine('not json at all{{{', sessionId);
    expect(events).toEqual([]);
  });

  it('handles mixed content blocks (text + tool_use) → multiple events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-7',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me read that file.' },
          {
            type: 'tool_use',
            id: 'toolu_def',
            name: 'Read',
            input: { file_path: '/tmp/foo.ts' },
          },
        ],
        stop_reason: null,
      },
    });

    const events = parseTranscriptLine(line, sessionId);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant-text');
    expect(events[0].data.text).toBe('Let me read that file.');
    expect(events[1].type).toBe('tool-use');
    expect(events[1].data.toolName).toBe('Read');
  });

  it('emits assistant-thinking heartbeat alongside text for reasoning blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-8',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think about this...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
        stop_reason: null,
      },
    });

    const events = parseTranscriptLine(line, sessionId);
    // Thinking blocks now surface as a lightweight heartbeat so the
    // attention classifier doesn't misread extended-thinking pauses as 'stuck'.
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant-thinking');
    expect(events[1].type).toBe('assistant-text');
    expect(events[1].data.text).toBe('Here is my answer.');
  });

  it('skips user messages without promptId (tool result wrappers)', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'uuid-9',
      message: {
        role: 'user',
        content: 'some automatic content',
      },
    });

    const events = parseTranscriptLine(line, sessionId);
    expect(events).toEqual([]);
  });

  it('handles tool_result with array content (extracts text blocks, joins with \\n)', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'uuid-10',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_arr',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
            is_error: false,
          },
        ],
      },
    });

    const events = parseTranscriptLine(line, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool-result');
    expect(events[0].data.toolResult).toBe('line one\nline two');
  });

  it('returns [] for lines missing message field', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'uuid-11',
    });

    const events = parseTranscriptLine(line, sessionId);
    expect(events).toEqual([]);
  });

  it('emits stopReason on turn-complete for max_tokens stops', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      uuid: 'u1',
      timestamp: '2026-04-17T00:00:00.000Z',
      requestId: 'req_abc',
      message: {
        model: 'claude-opus-4-7',
        role: 'assistant',
        content: [{ type: 'text', text: 'truncated...' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 4096, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
      },
    });
    const events = parseTranscriptLine(line, 's1');
    const turnComplete = events.find((e) => e.type === 'turn-complete');
    expect(turnComplete).toBeDefined();
    expect(turnComplete!.data).toEqual({
      stopReason: 'max_tokens',
      model: 'claude-opus-4-7',
      anthropicRequestId: 'req_abc',
      // inputTokens is the WHOLE prompt now (10 raw + 5 read + 2 created = 17),
      // matching what the native runtime and the Claude Code statusline both
      // mean by it. See the TurnUsageTally comment in transcript-watcher.ts.
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
    // Short poll interval so the "falls back to polling" test still passes
    // within ~1s. Production default is 2000ms.
    watcher = new TranscriptWatcher(tmpDir, 500);
  });

  afterEach(() => {
    watcher.stopAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits transcript-event when lines are appended to the file', async () => {
    const desktopSessionId = 'desktop-1';
    const claudeSessionId = 'claude-session-abc';
    const cwd = 'C:\\Users\\alice';

    // Create the project directory and JSONL file
    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);
    fs.writeFileSync(jsonlPath, '');

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd, jsonlPath);

    // Append a line
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-watch-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from watcher' }],
        stop_reason: null,
      },
    });
    fs.appendFileSync(jsonlPath, line + '\n');

    // Wait for fs.watch or polling to pick up the change.
    // readNewLinesForSession triggers an async read, so retry
    // until events arrive or timeout.
    for (let i = 0; i < POLL_TRIES_100MS; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      watcher.readNewLinesForSession(desktopSessionId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (events.length > 0) break;
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe('assistant-text');
    expect(events[0].data.text).toBe('Hello from watcher');
  });

  it('startWatching on an existing file starts at EOF and emits nothing for old content', async () => {
    // Perf cycle 2: history is the page reader's job (transcript-page.ts). The
    // tailer used to start at byte 0, re-reading and re-emitting the WHOLE file
    // on every resume/re-dock — the double-delivery this pins shut.
    const desktopSessionId = 'desktop-eof';
    const claudeSessionId = 'claude-session-eof';
    const cwd = 'C:\\Users\\alice';
    const projectDir = path.join(tmpDir, 'proj-eof');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);

    const makeLine = (uuid: string, text: string) => JSON.stringify({
      type: 'assistant', uuid,
      message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: null },
    });
    fs.writeFileSync(jsonlPath, makeLine('old-1', 'old one') + '\n' + makeLine('old-2', 'old two') + '\n');
    const startSize = fs.statSync(jsonlPath).size;

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));
    watcher.startWatching(desktopSessionId, claudeSessionId, cwd, jsonlPath);

    // Negative assertion: give the read every chance to fire, then require silence.
    // DELIBERATELY a small fixed count, NOT a poll ceiling: this loop has no
    // break condition — it is "wait a bounded while and confirm nothing arrived",
    // so every iteration is paid on every run. Sizing it like the wait-for-success
    // loops below turned a 250ms pause into 15s and made this file 6x slower for
    // no added confidence (caught 2026-08-28 by measuring, before it was pushed).
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 50));
      watcher.readNewLinesForSession(desktopSessionId);
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(0);
    expect(watcher.getStartOffset(desktopSessionId)).toBe(startSize);

    // A genuinely NEW append still streams live.
    fs.appendFileSync(jsonlPath, makeLine('new-1', 'brand new') + '\n');
    for (let i = 0; i < POLL_TRIES_100MS; i++) {
      await new Promise((r) => setTimeout(r, 100));
      watcher.readNewLinesForSession(desktopSessionId);
      await new Promise((r) => setTimeout(r, 50));
      if (events.length > 0) break;
    }
    expect(events.map((e) => e.data.text)).toContain('brand new');
    expect(events.map((e) => e.data.text)).not.toContain('old one');
  });

  it('deduplicates events by uuid', async () => {
    const desktopSessionId = 'desktop-2';
    const claudeSessionId = 'claude-session-dedup';
    const cwd = '/home/user/project';

    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);

    // Write two lines with the same uuid (simulates Claude's incremental writes)
    const makeLine = (text: string) =>
      JSON.stringify({
        type: 'assistant',
        uuid: 'uuid-dup',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
          stop_reason: null,
        },
      });

    fs.writeFileSync(jsonlPath, '');

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd, jsonlPath);
    // Perf cycle 2: the tailer starts at EOF, so content must be appended AFTER
    // startWatching to stream. Pre-existing content is the page reader's job.
    fs.appendFileSync(jsonlPath, makeLine('first') + '\n' + makeLine('second') + '\n');
    watcher.readNewLinesForSession(desktopSessionId);
    // readNewLines is async — poll for the initial read rather than betting on a
    // fixed 100ms, which lost under vitest's parallel pool.
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), { timeout: SETTLE_MS });
    // Settle before the dedup assertion: both lines were written before the
    // watch started so they arrive in ONE read, but waiting only for "length is
    // 1" would let a regression that DOES emit the dup pass at the instant the
    // count first hits 1.
    await wait(50);

    // Only the first occurrence should be emitted (second uuid-dup is deduplicated)
    expect(events).toHaveLength(1);
    expect(events[0].data.text).toBe('first');
  });

  it('stopWatching cleans up the session', () => {
    const desktopSessionId = 'desktop-3';
    const claudeSessionId = 'claude-session-stop';
    const cwd = 'C:\\Users\\alice';

    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);
    fs.writeFileSync(jsonlPath, '');

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd, jsonlPath);
    watcher.stopWatching(desktopSessionId);

    // Should not throw when stopping a non-existent session
    watcher.stopWatching(desktopSessionId);
  });

  it('handles partial lines across reads', async () => {
    const desktopSessionId = 'desktop-4';
    const claudeSessionId = 'claude-session-partial';
    const cwd = '/home/user/project';

    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);

    const fullLine = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-partial',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial test' }],
        stop_reason: null,
      },
    });

    fs.writeFileSync(jsonlPath, '');

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd, jsonlPath);
    // Perf cycle 2: the tailer starts at EOF, so content must be appended AFTER
    // startWatching to stream. Pre-existing content is the page reader's job.
    // Append a partial line (no newline) — should not emit events
    fs.appendFileSync(jsonlPath, fullLine.substring(0, 50));
    watcher.readNewLinesForSession(desktopSessionId);
    await wait(200); // negative assertion below — a fixed settle is correct here
    expect(events).toHaveLength(0); // Incomplete line, no events

    // Append the rest with newline — now the full line is parseable
    fs.appendFileSync(jsonlPath, fullLine.substring(50) + '\n');
    // fs.watch/poll delivery — poll for it instead of betting 2500ms.
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: WATCH_MS });
    expect(events[0].data.text).toBe('partial test');
  });

  it('emits all events from a single line (dedup is per-line, not per-event)', async () => {
    const desktopSessionId = 'desktop-6';
    const claudeSessionId = 'claude-session-multi';
    const cwd = '/home/user/project';

    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);

    // A line with text + end_turn should emit both assistant-text and turn-complete
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-multi-event',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
      },
    });
    fs.writeFileSync(jsonlPath, '');

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd, jsonlPath);
    // Perf cycle 2: the tailer starts at EOF, so content must be appended AFTER
    // startWatching to stream. Pre-existing content is the page reader's job.
    fs.appendFileSync(jsonlPath, line + '\n');
    watcher.readNewLinesForSession(desktopSessionId);
    // readNewLines is async — poll for the initial read, don't bet on 100ms.
    await vi.waitFor(() => expect(events).toHaveLength(2), { timeout: SETTLE_MS });

    expect(events[0].type).toBe('assistant-text');
    expect(events[1].type).toBe('turn-complete');
  });

  it('falls back to polling if file does not exist yet', async () => {
    const desktopSessionId = 'desktop-5';
    const claudeSessionId = 'claude-session-poll';
    const cwd = 'C:\\Users\\alice\\newproject';

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    // Path is known up front (this is what the hook would hand us) even
    // though the file itself doesn't exist yet.
    const projectDir = path.join(tmpDir, 'proj');
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);

    // Start watching before the file exists — should not throw
    watcher.startWatching(desktopSessionId, claudeSessionId, cwd, jsonlPath);

    // Now create the file
    fs.mkdirSync(projectDir, { recursive: true });
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-poll',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'From polling' }],
        stop_reason: null,
      },
    });
    fs.writeFileSync(jsonlPath, line + '\n');

    // Poll until the watcher's own poll interval picks the file up — a fixed
    // 1500ms is under the interval's worst case on a loaded machine.
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1), { timeout: WATCH_MS });

    expect(events[0].data.text).toBe('From polling');
  });

  // Regression: if a listener threw mid-batch, session.offset had already
  // advanced past the un-emitted chunks, permanently stranding them. A later
  // file growth couldn't recover them because readNewLines reads from the new
  // (advanced) offset forward. Fix: emits must not abort the batch loop.
  it('continues emitting remaining events when a listener throws on one', async () => {
    const desktopSessionId = 'desktop-throw';
    const claudeSessionId = 'claude-session-throw';
    const cwd = '/home/user/project';

    const projectDir = path.join(tmpDir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);

    const makeLine = (uuid: string, text: string) =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
          stop_reason: null,
        },
      });

    fs.writeFileSync(jsonlPath, '');

    const received: string[] = [];
    // Listener throws on B; with the fix, A and C still reach this listener.
    watcher.on('transcript-event', (ev: TranscriptEvent) => {
      if (ev.type !== 'assistant-text') return;
      if (ev.data.text === 'msg B') throw new Error('boom');
      received.push(ev.data.text);
    });

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd, jsonlPath);
    // Perf cycle 2: the tailer starts at EOF, so content must be appended AFTER
    // startWatching to stream. Pre-existing content is the page reader's job.
    fs.appendFileSync(
      jsonlPath,
      [
        makeLine('uuid-a', 'msg A'),
        makeLine('uuid-b', 'msg B'),
        makeLine('uuid-c', 'msg C'),
      ].join('\n') + '\n',
    );
    watcher.readNewLinesForSession(desktopSessionId);
    await vi.waitFor(() => {
      expect(received).toContain('msg A');
      expect(received).toContain('msg C');
    }, { timeout: SETTLE_MS });
  });

  it('records Agent tool_use in SubagentIndex for correlation', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-agent-'));
    const slug = 'C--tmp-project';
    const projectDir = path.join(tmpRoot, slug);
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = 'sess-abc';
    const parentJsonl = path.join(projectDir, `${sessionId}.jsonl`);
    const subagentsDir = path.join(projectDir, sessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });

    fs.writeFileSync(parentJsonl, JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-1',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 'toolu_P1', name: 'Agent',
          input: { description: 'Find bug', subagent_type: 'Explore', prompt: 'go' },
        }],
        stop_reason: null,
      },
    }) + '\n');

    fs.writeFileSync(
      path.join(subagentsDir, 'agent-abc.meta.json'),
      JSON.stringify({ description: 'Find bug', agentType: 'Explore' }),
    );
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-abc.jsonl'),
      JSON.stringify({
        type: 'assistant', uuid: 'uuid-s1', isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_S1', name: 'Read', input: { file_path: '/a' } }],
          stop_reason: null,
        },
      }) + '\n',
    );

    const tw = new TranscriptWatcher(tmpRoot);
    tw.startWatching('desktop-sess-1', sessionId, 'C:/tmp/project');

    const history = tw.getHistory('desktop-sess-1');
    tw.stopWatching('desktop-sess-1');
    fs.rmSync(tmpRoot, { recursive: true, force: true });

    const parentToolUse = history.find(e => e.type === 'tool-use' && e.data.toolName === 'Agent');
    const subagentToolUse = history.find(e => e.type === 'tool-use' && e.data.toolName === 'Read');
    expect(parentToolUse).toBeDefined();
    expect(parentToolUse!.data.parentAgentToolUseId).toBeUndefined();
    expect(subagentToolUse).toBeDefined();
    expect(subagentToolUse!.data.parentAgentToolUseId).toBe('toolu_P1');
    expect(subagentToolUse!.data.agentId).toBe('abc');
  });
});

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
    for (let i = 0; i < 20 && events.length === 0; i++) {
      watcher.readNewLinesForSession('desktop-utf8');
      await new Promise((r) => setTimeout(r, 100));
    }

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

    const texts = events.filter((e) => e.type === 'assistant-text').map((e) => e.data.text.split(':')[0]);
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

  it('getHistory skips repeated assistant-text for the same uuid (mirrors live dedup)', () => {
    const jsonlPath = setupSession('desktop-replay', 'claude-replay');

    const assistantLine = (text: string) =>
      JSON.stringify({
        type: 'assistant',
        uuid: 'uuid-replay-dup',
        message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: null },
      });
    // Claude rewrites the same uuid line as the message grows — replay must
    // apply first-write-wins exactly like the live path, or a re-docked
    // window renders duplicate text segments.
    fs.writeFileSync(jsonlPath, assistantLine('grow') + '\n' + assistantLine('grow more') + '\n');

    const history = watcher.getHistory('desktop-replay');
    const texts = history.filter((e) => e.type === 'assistant-text');
    expect(texts.length).toBe(1);
    expect(texts[0].data.text).toBe('grow');
  });
});

// ---------------------------------------------------------------------------
// startWatching path source (spec §5.0): hook-supplied transcript_path wins,
// slug derivation is fallback-only.
// ---------------------------------------------------------------------------
describe('startWatching path source (spec §5.0)', () => {
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
  it('subagentsDir follows the hook-supplied transcript path, not slug(cwd)', () => {
    const cwd = 'C:/tmp/project'; // slug(cwd) === 'C--tmp-project' — must NOT appear below
    const divergentDir = path.join(tmpDir, 'not a slug CC would ever produce');
    fs.mkdirSync(divergentDir, { recursive: true });
    const sessionId = 'sess-hook';
    const parentJsonl = path.join(divergentDir, `${sessionId}.jsonl`);
    const subagentsDir = path.join(divergentDir, sessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });

    fs.writeFileSync(parentJsonl, JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-hook-1',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 'toolu_HP1', name: 'Agent',
          input: { description: 'Find bug', subagent_type: 'Explore', prompt: 'go' },
        }],
        stop_reason: null,
      },
    }) + '\n');

    fs.writeFileSync(
      path.join(subagentsDir, 'agent-hook.meta.json'),
      JSON.stringify({ description: 'Find bug', agentType: 'Explore' }),
    );
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-hook.jsonl'),
      JSON.stringify({
        type: 'assistant', uuid: 'uuid-hook-s1', isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_HS1', name: 'Read', input: { file_path: '/a' } }],
          stop_reason: null,
        },
      }) + '\n',
    );

    // 4-arg: transcriptPath (parentJsonl, inside divergentDir) wins over any
    // cwd-derived slug. If subagentsDir regressed to slug-derivation, it would
    // look under tmpDir/C--tmp-project/sess-hook/subagents instead — a
    // directory that was never created — and the subagent tool_use below
    // would never be found.
    watcher.startWatching('desktop-hook-1', sessionId, cwd, parentJsonl);

    const history = watcher.getHistory('desktop-hook-1');

    const parentToolUse = history.find(e => e.type === 'tool-use' && e.data.toolName === 'Agent');
    const subagentToolUse = history.find(e => e.type === 'tool-use' && e.data.toolName === 'Read');
    expect(parentToolUse).toBeDefined();
    expect(subagentToolUse).toBeDefined();
    expect(subagentToolUse!.data.parentAgentToolUseId).toBe('toolu_HP1');
    expect(subagentToolUse!.data.agentId).toBe('hook');
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

  it("the dimmed echo of a command's output stays hidden", () => {
    const esc = String.fromCharCode(27);
    expect(parseTranscriptLine(commandLine(`<local-command-stdout>${esc}[2mCompacted${esc}[22m</local-command-stdout>`), 's1')).toEqual([]);
  });
});
