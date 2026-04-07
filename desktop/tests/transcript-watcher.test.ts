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

  it('skips thinking blocks', () => {
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
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant-text');
    expect(events[0].data.text).toBe('Here is my answer.');
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

  it('converts nested Windows path: C:\\Users\\alice\\destinclaude\\desktop → C--Users-alice-destinclaude-desktop', () => {
    expect(cwdToProjectSlug('C:\\Users\\alice\\destinclaude\\desktop')).toBe(
      'C--Users-alice-destinclaude-desktop'
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
    watcher = new TranscriptWatcher(tmpDir);
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

    // Give fs.watch / polling time to pick up the change
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Trigger a manual read in case fs.watch hasn't fired yet
    watcher.readNewLinesForSession(desktopSessionId);

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
    watcher.readNewLinesForSession(desktopSessionId);

    // Only the first occurrence should be emitted
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

  it('handles partial lines across reads', () => {
    const desktopSessionId = 'desktop-4';
    const claudeSessionId = 'claude-session-partial';
    const cwd = '/home/user/project';

    const slug = cwdToProjectSlug(cwd);
    const projectDir = path.join(tmpDir, slug);
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonlPath = path.join(projectDir, `${claudeSessionId}.jsonl`);
    fs.writeFileSync(jsonlPath, '');

    const events: TranscriptEvent[] = [];
    watcher.on('transcript-event', (ev: TranscriptEvent) => events.push(ev));

    watcher.startWatching(desktopSessionId, claudeSessionId, cwd);

    // Write a partial line (no trailing newline)
    const fullLine = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-partial',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial test' }],
        stop_reason: null,
      },
    });

    // Write first half without newline
    fs.writeFileSync(jsonlPath, fullLine.substring(0, 50));
    watcher.readNewLinesForSession(desktopSessionId);
    expect(events).toHaveLength(0); // Incomplete line, no events

    // Write the rest with newline
    fs.writeFileSync(jsonlPath, fullLine + '\n');
    watcher.readNewLinesForSession(desktopSessionId);
    expect(events).toHaveLength(1);
    expect(events[0].data.text).toBe('partial test');
  });

  it('emits all events from a single line (dedup is per-line, not per-event)', () => {
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
    watcher.readNewLinesForSession(desktopSessionId);

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
});
