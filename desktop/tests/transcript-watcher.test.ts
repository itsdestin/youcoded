import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseTranscriptLine,
  cwdToProjectSlug,
  TranscriptWatcher,
} from '../src/main/transcript-watcher';
import type { TranscriptEvent } from '../src/shared/types';

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
      usage: { inputTokens: 10, outputTokens: 4096, cacheReadTokens: 5, cacheCreationTokens: 2 },
    });
  });
});

// ---------------------------------------------------------------------------
// cwdToProjectSlug
// ---------------------------------------------------------------------------
describe('cwdToProjectSlug', () => {
  it('converts Windows path: C:\\Users\\alice → C--Users-alice', () => {
    expect(cwdToProjectSlug('C:\\Users\\alice')).toBe('C--Users-alice');
  });

  it('converts Unix path: /home/user/project → -home-user-project', () => {
    expect(cwdToProjectSlug('/home/user/project')).toBe('-home-user-project');
  });

  it('converts nested Windows path: C:\\Users\\alice\\youcoded-core\\desktop → C--Users-alice-youcoded-core-desktop', () => {
    expect(cwdToProjectSlug('C:\\Users\\alice\\youcoded-core\\desktop')).toBe(
      'C--Users-alice-youcoded-core-desktop'
    );
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
    const slug = cwdToProjectSlug(cwd);
    const projectDir = path.join(tmpDir, slug);
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);
    fs.writeFileSync(jsonlPath, '');

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd);

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
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      watcher.readNewLinesForSession(desktopSessionId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (events.length > 0) break;
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe('assistant-text');
    expect(events[0].data.text).toBe('Hello from watcher');
  });

  it('deduplicates events by uuid', async () => {
    const desktopSessionId = 'desktop-2';
    const claudeSessionId = 'claude-session-dedup';
    const cwd = '/home/user/project';

    const slug = cwdToProjectSlug(cwd);
    const projectDir = path.join(tmpDir, slug);
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

    fs.writeFileSync(jsonlPath, makeLine('first') + '\n' + makeLine('second') + '\n');

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd);
    // readNewLines is async — wait for the initial read triggered by startWatching
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Only the first occurrence should be emitted (second uuid-dup is deduplicated)
    expect(events).toHaveLength(1);
    expect(events[0].data.text).toBe('first');
  });

  it('stopWatching cleans up the session', () => {
    const desktopSessionId = 'desktop-3';
    const claudeSessionId = 'claude-session-stop';
    const cwd = 'C:\\Users\\alice';

    const slug = cwdToProjectSlug(cwd);
    const projectDir = path.join(tmpDir, slug);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${claudeSessionId}.jsonl`), '');

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd);
    watcher.stopWatching(desktopSessionId);

    // Should not throw when stopping a non-existent session
    watcher.stopWatching(desktopSessionId);
  });

  it('handles partial lines across reads', async () => {
    const desktopSessionId = 'desktop-4';
    const claudeSessionId = 'claude-session-partial';
    const cwd = '/home/user/project';

    const slug = cwdToProjectSlug(cwd);
    const projectDir = path.join(tmpDir, slug);
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

    // Write partial line (no newline) — should not emit events
    fs.writeFileSync(jsonlPath, fullLine.substring(0, 50));

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(events).toHaveLength(0); // Incomplete line, no events

    // Append the rest with newline — now the full line is parseable
    fs.appendFileSync(jsonlPath, fullLine.substring(50) + '\n');
    // Wait for fs.watch or polling to pick up the change
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(events).toHaveLength(1);
    expect(events[0].data.text).toBe('partial test');
  });

  it('emits all events from a single line (dedup is per-line, not per-event)', async () => {
    const desktopSessionId = 'desktop-6';
    const claudeSessionId = 'claude-session-multi';
    const cwd = '/home/user/project';

    const slug = cwdToProjectSlug(cwd);
    const projectDir = path.join(tmpDir, slug);
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
    fs.writeFileSync(jsonlPath, line + '\n');

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd);
    // readNewLines is async — wait for the initial read triggered by startWatching
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant-text');
    expect(events[1].type).toBe('turn-complete');
  });

  it('falls back to polling if file does not exist yet', async () => {
    const desktopSessionId = 'desktop-5';
    const claudeSessionId = 'claude-session-poll';
    const cwd = 'C:\\Users\\alice\\newproject';

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    // Start watching before the file exists — should not throw
    watcher.startWatching(desktopSessionId, claudeSessionId, cwd);

    // Now create the file
    const slug = cwdToProjectSlug(cwd);
    const projectDir = path.join(tmpDir, slug);
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);
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

    // Wait for the poll interval to pick up the file
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(events.length).toBeGreaterThanOrEqual(1);
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

    const slug = cwdToProjectSlug(cwd);
    const projectDir = path.join(tmpDir, slug);
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

    fs.writeFileSync(
      jsonlPath,
      [
        makeLine('uuid-a', 'msg A'),
        makeLine('uuid-b', 'msg B'),
        makeLine('uuid-c', 'msg C'),
      ].join('\n') + '\n',
    );

    const received: string[] = [];
    // Listener throws on B; with the fix, A and C still reach this listener.
    watcher.on('transcript-event', (ev: TranscriptEvent) => {
      if (ev.type !== 'assistant-text') return;
      if (ev.data.text === 'msg B') throw new Error('boom');
      received.push(ev.data.text);
    });

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(received).toContain('msg A');
    expect(received).toContain('msg C');
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
