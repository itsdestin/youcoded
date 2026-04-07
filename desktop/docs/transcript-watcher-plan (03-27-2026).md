# Transcript Watcher — Real-Time Chat from JSONL

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hook-based chat reconstruction with a real-time transcript file watcher that captures intermediate assistant messages, full tool results, and correct message ordering.

**Architecture:** A new `TranscriptWatcher` class in the main process watches the Claude Code JSONL transcript file during active sessions. On each file change, it reads new lines from the last known offset, parses them into typed events, and emits them to the renderer via IPC. The renderer's chat reducer handles these new events to build the timeline. The hook system is preserved *only* for the blocking `PermissionRequest` flow and session initialization detection. All other chat state (user messages, assistant text, tool calls, tool results) comes from the transcript.

**Tech Stack:** Node.js `fs.watch` + `fs.read` with byte offset tracking, IPC via Electron `webContents.send`, existing React chat reducer pattern.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/main/transcript-watcher.ts` | **Create** | Watches JSONL files, parses new lines, emits typed events |
| `src/shared/types.ts` | **Modify** | Add `TranscriptEvent` type and IPC channel constant |
| `src/main/ipc-handlers.ts` | **Modify** | Wire up TranscriptWatcher lifecycle, forward events to renderer + remote clients |
| `src/main/remote-server.ts` | **Modify** | Buffer and broadcast transcript events to remote clients |
| `src/main/preload.ts` | **Modify** | Expose new `transcript:event` IPC listener |
| `src/renderer/remote-shim.ts` | **Modify** | Handle `transcript:event` push events from WebSocket |
| `src/renderer/state/chat-types.ts` | **Modify** | Add new `TRANSCRIPT_*` action types, remove `STOP` action type |
| `src/renderer/state/chat-reducer.ts` | **Modify** | Handle `TRANSCRIPT_*` actions, remove old `STOP`/`PRE_TOOL_USE`/`POST_TOOL_USE` handlers |
| `src/renderer/state/hook-dispatcher.ts` | **Modify** | Strip down to only `PermissionRequest`/`PermissionExpired`/`UserPromptSubmit` (for thinking state) |
| `src/renderer/App.tsx` | **Modify** | Subscribe to new `transcript:event` IPC channel, dispatch actions |
| `tests/transcript-watcher.test.ts` | **Create** | Unit tests for JSONL parsing and offset tracking |
| `tests/transcript-reducer.test.ts` | **Create** | Unit tests for new chat reducer actions |

---

## Task 1: Define TranscriptEvent Types

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write the TranscriptEvent type and IPC constant**

Add to `src/shared/types.ts` after the existing `HookEvent` interface:

```typescript
// --- Transcript watcher types ---

export type TranscriptEventType =
  | 'user-message'
  | 'assistant-text'
  | 'tool-use'
  | 'tool-result'
  | 'thinking'
  | 'turn-complete';

export interface TranscriptEvent {
  type: TranscriptEventType;
  sessionId: string; // desktop session ID
  /** The JSONL line's uuid — used for deduplication */
  uuid: string;
  timestamp: number;
  data: {
    text?: string;
    toolUseId?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: string;
    isError?: boolean;
    stopReason?: string;
  };
}
```

Add to the `IPC` constant object:

```typescript
TRANSCRIPT_EVENT: 'transcript:event',
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add TranscriptEvent types and IPC channel"
```

---

## Task 2: Build the TranscriptWatcher

**Files:**
- Create: `src/main/transcript-watcher.ts`
- Test: `tests/transcript-watcher.test.ts`

- [ ] **Step 1: Write the failing test — JSONL line parsing**

Create `tests/transcript-watcher.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseTranscriptLine } from '../src/main/transcript-watcher';

describe('parseTranscriptLine', () => {
  it('parses an assistant text block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Let me check that.' }],
        stop_reason: null,
      },
    });

    const events = parseTranscriptLine(line, 'session-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assistant-text');
    expect(events[0].data.text).toBe('Let me check that.');
    expect(events[0].uuid).toBe('uuid-1');
  });

  it('parses a tool_use block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-2',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_abc',
          name: 'Read',
          input: { file_path: '/tmp/foo.ts' },
        }],
        stop_reason: 'tool_use',
      },
    });

    const events = parseTranscriptLine(line, 'session-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool-use');
    expect(events[0].data.toolName).toBe('Read');
    expect(events[0].data.toolUseId).toBe('toolu_abc');
  });

  it('parses a tool_result from a user message', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'uuid-3',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_abc',
          content: 'file contents here',
        }],
      },
    });

    const events = parseTranscriptLine(line, 'session-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool-result');
    expect(events[0].data.toolUseId).toBe('toolu_abc');
    expect(events[0].data.toolResult).toBe('file contents here');
  });

  it('parses a user prompt', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'uuid-4',
      promptId: 'prompt-1',
      message: {
        role: 'user',
        content: 'Hello Claude',
      },
    });

    const events = parseTranscriptLine(line, 'session-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('user-message');
    expect(events[0].data.text).toBe('Hello Claude');
  });

  it('emits turn-complete for end_turn stop reason', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-5',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the answer.' }],
        stop_reason: 'end_turn',
      },
    });

    const events = parseTranscriptLine(line, 'session-1');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant-text');
    expect(events[1].type).toBe('turn-complete');
  });

  it('returns empty array for non-message lines', () => {
    const line = JSON.stringify({ type: 'file-history-snapshot', snapshot: {} });
    const events = parseTranscriptLine(line, 'session-1');
    expect(events).toHaveLength(0);
  });

  it('returns empty array for invalid JSON', () => {
    const events = parseTranscriptLine('not json', 'session-1');
    expect(events).toHaveLength(0);
  });

  it('handles content blocks array with mixed types', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-6',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking at that file.' },
          { type: 'tool_use', id: 'toolu_xyz', name: 'Bash', input: { command: 'ls' } },
        ],
        stop_reason: 'tool_use',
      },
    });

    const events = parseTranscriptLine(line, 'session-1');
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant-text');
    expect(events[0].data.text).toBe('Looking at that file.');
    expect(events[1].type).toBe('tool-use');
    expect(events[1].data.toolName).toBe('Bash');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:/Users/alice/destinclaude/desktop && npx vitest run tests/transcript-watcher.test.ts`
Expected: FAIL — `parseTranscriptLine` not found.

- [ ] **Step 3: Write the TranscriptWatcher implementation**

Create `src/main/transcript-watcher.ts`:

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { TranscriptEvent } from '../shared/types';

/**
 * Parses a single JSONL line from a Claude Code transcript into TranscriptEvents.
 * Exported for testing.
 */
export function parseTranscriptLine(line: string, sessionId: string): TranscriptEvent[] {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }

  const msgType = obj.type; // 'user' | 'assistant' | 'file-history-snapshot' | 'queue-operation' | etc.
  const message = obj.message;
  const uuid = obj.uuid || '';
  const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();

  if (!message || (msgType !== 'user' && msgType !== 'assistant')) {
    return [];
  }

  const content = message.content;
  const stopReason = message.stop_reason;
  const events: TranscriptEvent[] = [];

  // String content = user prompt text
  if (typeof content === 'string') {
    if (obj.promptId) {
      // This is a user-typed prompt (has promptId), not a tool_result wrapper
      events.push({
        type: 'user-message',
        sessionId,
        uuid,
        timestamp,
        data: { text: content },
      });
    }
    return events;
  }

  // Array content = content blocks
  if (!Array.isArray(content)) return [];

  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (message.role === 'assistant') {
          events.push({
            type: 'assistant-text',
            sessionId,
            uuid,
            timestamp,
            data: { text: block.text },
          });
        } else if (message.role === 'user' && obj.promptId) {
          // User message with text block (e.g., follow-up with image)
          events.push({
            type: 'user-message',
            sessionId,
            uuid,
            timestamp,
            data: { text: block.text },
          });
        }
        break;

      case 'tool_use':
        events.push({
          type: 'tool-use',
          sessionId,
          uuid,
          timestamp,
          data: {
            toolUseId: block.id,
            toolName: block.name,
            toolInput: block.input,
          },
        });
        break;

      case 'tool_result': {
        const resultContent = block.content;
        let resultText: string;
        if (typeof resultContent === 'string') {
          resultText = resultContent;
        } else if (Array.isArray(resultContent)) {
          resultText = resultContent
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n');
        } else {
          resultText = JSON.stringify(resultContent);
        }
        events.push({
          type: 'tool-result',
          sessionId,
          uuid,
          timestamp,
          data: {
            toolUseId: block.tool_use_id,
            toolResult: resultText,
            isError: block.is_error === true,
          },
        });
        break;
      }

      case 'thinking':
        // Skip thinking blocks — they contain extended thinking content
        // that we don't display in the chat view
        break;
    }
  }

  // Emit turn-complete when Claude's turn ends
  if (message.role === 'assistant' && stopReason === 'end_turn') {
    events.push({
      type: 'turn-complete',
      sessionId,
      uuid,
      timestamp,
      data: { stopReason },
    });
  }

  return events;
}

/**
 * Converts a CWD path to the Claude Code project directory slug.
 * e.g., "C:\Users\alice" → "C--Users-alice"
 *       "/home/user/project" → "-home-user-project"
 */
export function cwdToProjectSlug(cwd: string): string {
  // Normalize to forward slashes, then replace separators with dashes
  return cwd
    .replace(/\\/g, '/')
    .replace(/:/g, '-')
    .replace(/\//g, '-')
    // Remove leading dash if present (Unix paths start with /)
    .replace(/^-/, '');
}

interface WatchedSession {
  desktopSessionId: string;
  claudeSessionId: string;
  cwd: string;
  transcriptPath: string;
  watcher: fs.FSWatcher | null;
  /** Byte offset — how far we've read into the file */
  offset: number;
  /** Partial line buffer — in case a write splits a line across reads */
  partialLine: string;
  /** Set of uuids we've already emitted — prevents duplicates on re-reads */
  seenUuids: Set<string>;
}

export class TranscriptWatcher extends EventEmitter {
  private sessions = new Map<string, WatchedSession>();
  private projectsDir: string;

  constructor() {
    super();
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
  }

  /**
   * Start watching a session's transcript file.
   * Called when the first hook event arrives and we know the Claude session ID.
   */
  startWatching(desktopSessionId: string, claudeSessionId: string, cwd: string): void {
    if (this.sessions.has(desktopSessionId)) return;

    const slug = cwdToProjectSlug(cwd);
    const transcriptPath = path.join(this.projectsDir, slug, `${claudeSessionId}.jsonl`);

    const session: WatchedSession = {
      desktopSessionId,
      claudeSessionId,
      cwd,
      transcriptPath,
      watcher: null,
      offset: 0,
      partialLine: '',
      seenUuids: new Set(),
    };

    this.sessions.set(desktopSessionId, session);

    // Read existing content first (catch up with anything already written)
    this.readNewLines(session);

    // Then start watching for changes
    try {
      session.watcher = fs.watch(transcriptPath, { persistent: false }, () => {
        this.readNewLines(session);
      });
      session.watcher.on('error', () => {
        // File may not exist yet — retry with polling
        session.watcher?.close();
        session.watcher = null;
        this.pollUntilExists(session);
      });
    } catch {
      // fs.watch failed — fall back to polling
      this.pollUntilExists(session);
    }
  }

  /**
   * Poll for the transcript file to appear, then start watching it.
   */
  private pollUntilExists(session: WatchedSession): void {
    const interval = setInterval(() => {
      if (!this.sessions.has(session.desktopSessionId)) {
        clearInterval(interval);
        return;
      }
      if (fs.existsSync(session.transcriptPath)) {
        clearInterval(interval);
        this.readNewLines(session);
        try {
          session.watcher = fs.watch(session.transcriptPath, { persistent: false }, () => {
            this.readNewLines(session);
          });
          session.watcher.on('error', () => {
            // If it fails again, just stop trying
            session.watcher = null;
          });
        } catch { /* give up on watching */ }
      }
    }, 500);
  }

  /**
   * Read new bytes from the transcript file starting at the stored offset.
   * Parse complete lines and emit events.
   */
  private readNewLines(session: WatchedSession): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(session.transcriptPath);
    } catch {
      return; // File doesn't exist yet
    }

    if (stat.size <= session.offset) return; // No new data

    const fd = fs.openSync(session.transcriptPath, 'r');
    try {
      const bytesToRead = stat.size - session.offset;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, session.offset);
      session.offset = stat.size;

      const text = session.partialLine + buffer.toString('utf8');
      const lines = text.split('\n');

      // Last element may be a partial line (no trailing newline yet)
      session.partialLine = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const events = parseTranscriptLine(trimmed, session.desktopSessionId);
        for (const event of events) {
          // Deduplicate — the same uuid can appear multiple times as
          // Claude Code writes incremental updates to the same message
          if (event.uuid && session.seenUuids.has(event.uuid)) continue;
          if (event.uuid) session.seenUuids.add(event.uuid);

          this.emit('transcript-event', event);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Stop watching a session's transcript.
   */
  stopWatching(desktopSessionId: string): void {
    const session = this.sessions.get(desktopSessionId);
    if (!session) return;
    session.watcher?.close();
    this.sessions.delete(desktopSessionId);
  }

  /**
   * Stop watching all sessions.
   */
  stopAll(): void {
    for (const [id] of this.sessions) {
      this.stopWatching(id);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:/Users/alice/destinclaude/desktop && npx vitest run tests/transcript-watcher.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Write additional test — cwdToProjectSlug**

Add to `tests/transcript-watcher.test.ts`:

```typescript
import { cwdToProjectSlug } from '../src/main/transcript-watcher';

describe('cwdToProjectSlug', () => {
  it('converts a Windows path', () => {
    expect(cwdToProjectSlug('C:\\Users\\desti')).toBe('C--Users-alice');
  });

  it('converts a Unix path', () => {
    expect(cwdToProjectSlug('/home/user/project')).toBe('home-user-project');
  });

  it('handles nested paths', () => {
    expect(cwdToProjectSlug('C:\\Users\\desti\\destinclaude\\desktop'))
      .toBe('C--Users-alice-destinclaude-desktop');
  });
});
```

- [ ] **Step 6: Run tests**

Run: `cd C:/Users/alice/destinclaude/desktop && npx vitest run tests/transcript-watcher.test.ts`
Expected: All 10 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/transcript-watcher.ts tests/transcript-watcher.test.ts
git commit -m "feat: add TranscriptWatcher with JSONL parsing and file watching"
```

---

## Task 3: Add New Chat Reducer Actions

**Files:**
- Modify: `src/renderer/state/chat-types.ts`
- Modify: `src/renderer/state/chat-reducer.ts`
- Test: `tests/transcript-reducer.test.ts`

- [ ] **Step 1: Write failing tests for transcript-driven chat actions**

Create `tests/transcript-reducer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, createSessionChatState } from '../src/renderer/state/chat-types';

function makeState(sessionId: string): ChatState {
  const state: ChatState = new Map();
  state.set(sessionId, createSessionChatState());
  return state;
}

describe('transcript-driven chat actions', () => {
  const sid = 'test-session';

  it('TRANSCRIPT_USER_MESSAGE adds a user bubble and sets isThinking', () => {
    const state = makeState(sid);
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: sid,
      uuid: 'uuid-1',
      text: 'Hello',
      timestamp: 1000,
    });
    const session = next.get(sid)!;
    expect(session.timeline).toHaveLength(1);
    expect(session.timeline[0].kind).toBe('user');
    expect(session.isThinking).toBe(true);
  });

  it('TRANSCRIPT_ASSISTANT_TEXT adds an assistant bubble', () => {
    let state = makeState(sid);
    // First send user message to set isThinking
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: sid,
      uuid: 'uuid-1',
      text: 'Hello',
      timestamp: 1000,
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: sid,
      uuid: 'uuid-2',
      text: 'Let me check.',
      timestamp: 1001,
    });
    const session = state.get(sid)!;
    expect(session.timeline).toHaveLength(2);
    expect(session.timeline[1].kind).toBe('assistant');
    if (session.timeline[1].kind === 'assistant') {
      expect(session.timeline[1].message.content).toBe('Let me check.');
    }
    // Still thinking — turn hasn't completed
    expect(session.isThinking).toBe(true);
    // currentGroupId should be null (no tool group yet)
    expect(session.currentGroupId).toBeNull();
  });

  it('TRANSCRIPT_TOOL_USE creates a tool group', () => {
    let state = makeState(sid);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: sid,
      uuid: 'uuid-3',
      toolUseId: 'toolu_abc',
      toolName: 'Read',
      toolInput: { file_path: '/tmp/foo.ts' },
    });
    const session = state.get(sid)!;
    expect(session.timeline).toHaveLength(1);
    expect(session.timeline[0].kind).toBe('tool-group');
    expect(session.toolCalls.size).toBe(1);
    const tool = session.toolCalls.get('toolu_abc')!;
    expect(tool.toolName).toBe('Read');
    expect(tool.status).toBe('running');
  });

  it('TRANSCRIPT_TOOL_RESULT completes a tool', () => {
    let state = makeState(sid);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: sid,
      uuid: 'uuid-3',
      toolUseId: 'toolu_abc',
      toolName: 'Read',
      toolInput: {},
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_RESULT',
      sessionId: sid,
      uuid: 'uuid-4',
      toolUseId: 'toolu_abc',
      result: 'file contents here',
      isError: false,
    });
    const session = state.get(sid)!;
    const tool = session.toolCalls.get('toolu_abc')!;
    expect(tool.status).toBe('complete');
    expect(tool.response).toBe('file contents here');
  });

  it('TRANSCRIPT_TURN_COMPLETE clears isThinking', () => {
    let state = makeState(sid);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: sid,
      uuid: 'uuid-1',
      text: 'Hello',
      timestamp: 1000,
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE',
      sessionId: sid,
      uuid: 'uuid-5',
      timestamp: 2000,
    });
    const session = state.get(sid)!;
    expect(session.isThinking).toBe(false);
    expect(session.currentGroupId).toBeNull();
  });

  it('TRANSCRIPT_ASSISTANT_TEXT after a tool group starts a new group boundary', () => {
    let state = makeState(sid);
    // Tool call
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: sid,
      uuid: 'uuid-1',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      toolInput: {},
    });
    // Tool result
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_RESULT',
      sessionId: sid,
      uuid: 'uuid-2',
      toolUseId: 'toolu_1',
      result: 'output',
      isError: false,
    });
    // Intermediate text (the key feature!)
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: sid,
      uuid: 'uuid-3',
      text: 'Now let me look at the other file.',
      timestamp: 1000,
    });
    // Next tool call — should be in a new group
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: sid,
      uuid: 'uuid-4',
      toolUseId: 'toolu_2',
      toolName: 'Read',
      toolInput: {},
    });

    const session = state.get(sid)!;
    // Timeline: [tool-group-1, assistant-text, tool-group-2]
    expect(session.timeline).toHaveLength(3);
    expect(session.timeline[0].kind).toBe('tool-group');
    expect(session.timeline[1].kind).toBe('assistant');
    expect(session.timeline[2].kind).toBe('tool-group');
  });

  it('deduplicates by uuid', () => {
    let state = makeState(sid);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: sid,
      uuid: 'uuid-dup',
      text: 'Hello',
      timestamp: 1000,
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: sid,
      uuid: 'uuid-dup',
      text: 'Hello',
      timestamp: 1000,
    });
    const session = state.get(sid)!;
    expect(session.timeline).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd C:/Users/alice/destinclaude/desktop && npx vitest run tests/transcript-reducer.test.ts`
Expected: FAIL — action types not recognized.

- [ ] **Step 3: Add action types to chat-types.ts**

Add to the `ChatAction` union type in `src/renderer/state/chat-types.ts`:

```typescript
  | {
      type: 'TRANSCRIPT_USER_MESSAGE';
      sessionId: string;
      uuid: string;
      text: string;
      timestamp: number;
    }
  | {
      type: 'TRANSCRIPT_ASSISTANT_TEXT';
      sessionId: string;
      uuid: string;
      text: string;
      timestamp: number;
    }
  | {
      type: 'TRANSCRIPT_TOOL_USE';
      sessionId: string;
      uuid: string;
      toolUseId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
    }
  | {
      type: 'TRANSCRIPT_TOOL_RESULT';
      sessionId: string;
      uuid: string;
      toolUseId: string;
      result: string;
      isError: boolean;
    }
  | {
      type: 'TRANSCRIPT_TURN_COMPLETE';
      sessionId: string;
      uuid: string;
      timestamp: number;
    }
```

Add `seenUuids` to `SessionChatState`:

```typescript
export interface SessionChatState {
  timeline: TimelineEntry[];
  toolCalls: Map<string, ToolCallState>;
  toolGroups: Map<string, ToolGroupState>;
  isThinking: boolean;
  streamingText: string;
  currentGroupId: string | null;
  lastActivityAt: number;
  /** Transcript uuids already processed — prevents duplicate entries */
  seenUuids: Set<string>;
}
```

Update `createSessionChatState` to include `seenUuids: new Set()`.

- [ ] **Step 4: Implement reducer cases in chat-reducer.ts**

Add these cases to the `chatReducer` switch statement in `src/renderer/state/chat-reducer.ts`:

```typescript
    case 'TRANSCRIPT_USER_MESSAGE': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      if (action.uuid && session.seenUuids.has(action.uuid)) return state;

      const seenUuids = new Set(session.seenUuids);
      if (action.uuid) seenUuids.add(action.uuid);

      // Deduplicate against optimistic USER_PROMPT from InputBar
      const lastEntry = session.timeline[session.timeline.length - 1];
      if (lastEntry?.kind === 'user' && lastEntry.message.content === action.text) {
        next.set(action.sessionId, { ...session, isThinking: true, currentGroupId: null, seenUuids });
        return next;
      }

      const message = {
        id: nextMessageId(),
        role: 'user' as const,
        content: action.text,
        timestamp: action.timestamp,
      };

      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'user', message }],
        isThinking: true,
        currentGroupId: null,
        seenUuids,
      });
      return next;
    }

    case 'TRANSCRIPT_ASSISTANT_TEXT': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      if (action.uuid && session.seenUuids.has(action.uuid)) return state;

      const seenUuids = new Set(session.seenUuids);
      if (action.uuid) seenUuids.add(action.uuid);

      const message = {
        id: nextMessageId(),
        role: 'assistant' as const,
        content: action.text,
        timestamp: action.timestamp,
      };

      // Clear currentGroupId so the next tool_use starts a fresh group
      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'assistant', message }],
        currentGroupId: null,
        lastActivityAt: Date.now(),
        seenUuids,
      });
      return next;
    }

    case 'TRANSCRIPT_TOOL_USE': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);
      toolCalls.set(action.toolUseId, {
        toolUseId: action.toolUseId,
        toolName: action.toolName,
        input: action.toolInput,
        status: 'running',
      });

      const toolGroups = new Map(session.toolGroups);
      let timeline = session.timeline;
      let currentGroupId = session.currentGroupId;

      if (currentGroupId && toolGroups.has(currentGroupId)) {
        const group = toolGroups.get(currentGroupId)!;
        toolGroups.set(currentGroupId, {
          ...group,
          toolIds: [...group.toolIds, action.toolUseId],
        });
      } else {
        currentGroupId = nextGroupId();
        toolGroups.set(currentGroupId, {
          id: currentGroupId,
          toolIds: [action.toolUseId],
        });
        timeline = [...timeline, { kind: 'tool-group', groupId: currentGroupId }];
      }

      next.set(action.sessionId, {
        ...session,
        toolCalls,
        toolGroups,
        timeline,
        currentGroupId,
        lastActivityAt: Date.now(),
      });
      return next;
    }

    case 'TRANSCRIPT_TOOL_RESULT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);
      const existing = toolCalls.get(action.toolUseId);
      if (existing) {
        toolCalls.set(action.toolUseId, {
          ...existing,
          status: action.isError ? 'failed' : 'complete',
          response: action.isError ? undefined : action.result,
          error: action.isError ? action.result : undefined,
        });
      }

      next.set(action.sessionId, { ...session, toolCalls, lastActivityAt: Date.now() });
      return next;
    }

    case 'TRANSCRIPT_TURN_COMPLETE': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      next.set(action.sessionId, {
        ...session,
        isThinking: false,
        streamingText: '',
        currentGroupId: null,
      });
      return next;
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd C:/Users/alice/destinclaude/desktop && npx vitest run tests/transcript-reducer.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/state/chat-types.ts src/renderer/state/chat-reducer.ts tests/transcript-reducer.test.ts
git commit -m "feat: add transcript-driven chat reducer actions with deduplication"
```

---

## Task 4: Wire TranscriptWatcher into the Main Process

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/remote-server.ts`

- [ ] **Step 1: Create and start TranscriptWatcher in ipc-handlers.ts**

In `src/main/ipc-handlers.ts`, import and instantiate the watcher. The key integration point: when a hook event arrives and we discover the Claude session ID mapping (around line 394-401), also start the transcript watcher.

Add import at top:

```typescript
import { TranscriptWatcher } from './transcript-watcher';
```

Inside `registerIpcHandlers`, after the `sessionIdMap` declaration (line 328), add:

```typescript
  const transcriptWatcher = new TranscriptWatcher();
```

In the hook event listener that discovers the desktop→claude session ID mapping (around line 393-401), add after `startWatching(desktopId, claudeId)`:

```typescript
      // Start watching the transcript file for this session
      const sessionInfo = sessionManager.getSession(desktopId);
      if (sessionInfo) {
        transcriptWatcher.startWatching(desktopId, claudeId, sessionInfo.cwd);
      }
```

Forward transcript events to the renderer and remote server:

```typescript
  transcriptWatcher.on('transcript-event', (event: any) => {
    send(IPC.TRANSCRIPT_EVENT, event);
  });
```

Stop watching when sessions exit (add to the existing `session-exit` handler):

```typescript
    transcriptWatcher.stopWatching(sessionId);
```

In the cleanup function, add:

```typescript
    transcriptWatcher.stopAll();
```

- [ ] **Step 2: Add transcript event buffering to remote-server.ts**

In `src/main/remote-server.ts`, the transcript watcher lives in ipc-handlers, so we need to forward events. The simplest approach: have ipc-handlers emit transcript events through the sessionManager as a bus.

Actually, a cleaner approach: accept a `transcriptWatcher` parameter in `RemoteServer` constructor or expose the watcher via a setter, similar to how `hookRelay` is passed.

Instead, have `registerIpcHandlers` return the transcript watcher so `main.ts` can pass it to the remote server. But to keep changes minimal, emit transcript events through an IPC broadcast that remote-server can pick up.

In `ipc-handlers.ts`, inside the `transcriptWatcher.on('transcript-event')` handler, add remote broadcast:

```typescript
  transcriptWatcher.on('transcript-event', (event: any) => {
    send(IPC.TRANSCRIPT_EVENT, event);
    // Also forward to remote clients
    if (remoteServer) {
      remoteServer.broadcast({ type: 'transcript:event', payload: event });
    }
  });
```

This requires passing `remoteServer` to `registerIpcHandlers`. Check if it's already passed — yes, it is (line 21 of the function signature). So we just reference it directly.

- [ ] **Step 3: Buffer transcript events for remote replay**

In `src/main/remote-server.ts`, add a transcript event buffer alongside the existing hook buffer. In the `replayBuffers` method, replay transcript events after hook events.

Add to the class properties:

```typescript
  private transcriptBuffers = new Map<string, any[]>();
```

Add a public method to accept transcript events:

```typescript
  bufferTranscriptEvent(event: any): void {
    const sessionId = event.sessionId || '';
    let buf = this.transcriptBuffers.get(sessionId) || [];
    buf.push(event);
    if (buf.length > HOOK_BUFFER_SIZE) {
      buf = buf.slice(buf.length - HOOK_BUFFER_SIZE);
    }
    this.transcriptBuffers.set(sessionId, buf);
  }
```

In `replayBuffers`, after hook event replay, add:

```typescript
      // Transcript event buffers
      for (const [_sessionId, events] of this.transcriptBuffers) {
        for (const event of events) {
          ws.send(JSON.stringify({ type: 'transcript:event', payload: event }));
        }
      }
```

In `onSessionExit`, add: `this.transcriptBuffers.delete(sessionId);`

In `stop()`, add: `this.transcriptBuffers.clear();`

Back in `ipc-handlers.ts`, update the transcript event handler:

```typescript
  transcriptWatcher.on('transcript-event', (event: any) => {
    send(IPC.TRANSCRIPT_EVENT, event);
    if (remoteServer) {
      remoteServer.bufferTranscriptEvent(event);
      remoteServer.broadcast({ type: 'transcript:event', payload: event });
    }
  });
```

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/remote-server.ts
git commit -m "feat: wire TranscriptWatcher into main process with remote relay"
```

---

## Task 5: Expose Transcript Events to the Renderer

**Files:**
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/remote-shim.ts`

- [ ] **Step 1: Add IPC listener in preload.ts**

In `src/main/preload.ts`, add the channel constant:

```typescript
  TRANSCRIPT_EVENT: 'transcript:event',
```

Add the listener in the `on` object:

```typescript
    transcriptEvent: (cb: (event: any) => void) => {
      const handler = (_e: IpcRendererEvent, event: any) => cb(event);
      ipcRenderer.on(IPC.TRANSCRIPT_EVENT, handler);
      return handler;
    },
```

- [ ] **Step 2: Handle transcript events in remote-shim.ts**

In `src/renderer/remote-shim.ts`, add to the `handleMessage` switch statement:

```typescript
    case 'transcript:event':
      dispatchEvent('transcript:event', payload);
      break;
```

Add to the `on` object in `installShim`:

```typescript
      transcriptEvent: (cb: Callback) => addListener('transcript:event', cb),
```

- [ ] **Step 3: Commit**

```bash
git add src/main/preload.ts src/renderer/remote-shim.ts
git commit -m "feat: expose transcript:event IPC to renderer and remote shim"
```

---

## Task 6: Subscribe to Transcript Events in App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/state/hook-dispatcher.ts`

- [ ] **Step 1: Add transcript event handler in App.tsx**

In `src/renderer/App.tsx`, inside the main `useEffect` (the one that sets up all event handlers), add after the `hookHandler`:

```typescript
    const transcriptHandler = (window.claude.on as any).transcriptEvent?.((event: any) => {
      if (!event?.type || !event?.sessionId) return;

      switch (event.type) {
        case 'user-message':
          dispatch({
            type: 'TRANSCRIPT_USER_MESSAGE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            text: event.data.text,
            timestamp: event.timestamp,
          });
          break;
        case 'assistant-text':
          dispatch({
            type: 'TRANSCRIPT_ASSISTANT_TEXT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            text: event.data.text,
            timestamp: event.timestamp,
          });
          break;
        case 'tool-use':
          dispatch({
            type: 'TRANSCRIPT_TOOL_USE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            toolUseId: event.data.toolUseId,
            toolName: event.data.toolName,
            toolInput: event.data.toolInput || {},
          });
          break;
        case 'tool-result':
          dispatch({
            type: 'TRANSCRIPT_TOOL_RESULT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            toolUseId: event.data.toolUseId,
            result: event.data.toolResult || '',
            isError: event.data.isError || false,
          });
          break;
        case 'turn-complete':
          dispatch({
            type: 'TRANSCRIPT_TURN_COMPLETE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
          });
          break;
      }
    });
```

In the cleanup function, add:

```typescript
      if (transcriptHandler) window.claude.off('transcript:event', transcriptHandler);
```

- [ ] **Step 2: Strip hook-dispatcher.ts down to permissions only**

In `src/renderer/state/hook-dispatcher.ts`, remove the `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, and `UserPromptSubmit` cases. Keep only:

- `PermissionRequest` — still needed for blocking permission flow
- `PermissionExpired` — still needed for socket cleanup

The simplified file:

```typescript
import { HookEvent } from '../../shared/types';
import { ChatAction } from './chat-types';

/**
 * Maps a HookEvent into a ChatAction. Now only handles permission events —
 * all other chat state comes from the transcript watcher.
 */
export function hookEventToAction(event: HookEvent): ChatAction | null {
  const { type, sessionId, payload } = event;

  switch (type) {
    case 'PermissionRequest': {
      const toolName = (payload.tool_name as string) || 'Unknown';
      const toolInput = (payload.tool_input as Record<string, unknown>) || {};
      const requestId = payload._requestId as string;
      const permissionSuggestions = payload.permission_suggestions as string[] | undefined;

      if (!requestId) return null;

      return {
        type: 'PERMISSION_REQUEST',
        sessionId,
        toolName,
        input: toolInput,
        requestId,
        permissionSuggestions: permissionSuggestions || undefined,
      };
    }

    case 'PermissionExpired': {
      const requestId = payload._requestId as string;
      if (!requestId) return null;
      return { type: 'PERMISSION_EXPIRED', sessionId, requestId };
    }

    default:
      return null;
  }
}
```

**Important:** Keep the `hookHandler` in App.tsx — it still dispatches permission actions and triggers session initialization detection. Only the *content* of what it dispatches changes (fewer action types).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/App.tsx src/renderer/state/hook-dispatcher.ts
git commit -m "feat: subscribe to transcript events, strip hook-dispatcher to permissions only"
```

---

## Task 7: Remove Dead Code from the Reducer

**Files:**
- Modify: `src/renderer/state/chat-reducer.ts`
- Modify: `src/renderer/state/chat-types.ts`

- [ ] **Step 1: Remove old action types that are now replaced by transcript actions**

In `src/renderer/state/chat-types.ts`, remove these action variants from the `ChatAction` union:

- `PRE_TOOL_USE` — replaced by `TRANSCRIPT_TOOL_USE`
- `POST_TOOL_USE` — replaced by `TRANSCRIPT_TOOL_RESULT`
- `POST_TOOL_USE_FAILURE` — replaced by `TRANSCRIPT_TOOL_RESULT` (with `isError: true`)
- `STOP` — replaced by `TRANSCRIPT_TURN_COMPLETE` + `TRANSCRIPT_ASSISTANT_TEXT`
- `UPDATE_STREAMING` — no longer needed (transcript gives us complete text)
- `THINKING_TIMEOUT` — keep this as a safety net

Keep: `SESSION_INIT`, `SESSION_REMOVE`, `USER_PROMPT` (for InputBar optimistic dispatch), `SHOW_PROMPT`, `COMPLETE_PROMPT`, `DISMISS_PROMPT`, `THINKING_TIMEOUT`, `PERMISSION_REQUEST`, `PERMISSION_EXPIRED`, `PERMISSION_RESPONDED`, `TERMINAL_ACTIVITY`, and all new `TRANSCRIPT_*` types.

- [ ] **Step 2: Remove corresponding reducer cases**

In `src/renderer/state/chat-reducer.ts`, remove the `case` blocks for:

- `PRE_TOOL_USE`
- `POST_TOOL_USE`
- `POST_TOOL_USE_FAILURE`
- `STOP`
- `UPDATE_STREAMING`

- [ ] **Step 3: Run all tests to verify nothing broke**

Run: `cd C:/Users/alice/destinclaude/desktop && npx vitest run`
Expected: All tests PASS. Some old tests that reference removed action types may fail — update them to use the new `TRANSCRIPT_*` actions.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/state/chat-types.ts src/renderer/state/chat-reducer.ts
git commit -m "refactor: remove hook-based chat actions replaced by transcript watcher"
```

---

## Task 8: Manual Integration Test

**Files:** None — this is a test procedure.

- [ ] **Step 1: Start the app in dev mode**

Run: `cd C:/Users/alice/destinclaude/desktop && npm run dev`

- [ ] **Step 2: Create a new session and send a message that triggers multiple tool calls**

Type something like: "Read the file at C:/Users/alice/destinclaude/desktop/package.json and tell me the version"

- [ ] **Step 3: Verify the chat view shows the full sequence**

Expected timeline in Chat View:
1. User message bubble: your prompt
2. Assistant text bubble: "Let me read that file." (or similar intermediate text)
3. Tool group card: Read tool with file path
4. Assistant text bubble: final answer with the version number

Previously, only items 1, 3, and 4 would appear (and 2 would be missing). The intermediate text in step 2 is the key improvement.

- [ ] **Step 4: Verify the terminal view still works**

Switch to Terminal View — everything should render normally since PTY output is unchanged.

- [ ] **Step 5: Verify permission prompts still work**

In a non-bypass session, trigger a tool that requires permission (e.g., a Write). Verify the ToolCard shows Yes/Always Allow/No buttons and they work.

- [ ] **Step 6: Verify remote access works**

Connect from a phone/browser. Verify the chat view shows the same intermediate messages.

---

## Known Risks & Mitigations

1. **Transcript format changes:** Claude Code's JSONL format is undocumented. If it changes, parsing breaks. **Mitigation:** The `parseTranscriptLine` function is isolated and easy to update. Fallback: the terminal view always works.

2. **Race between watcher and hooks:** A `PermissionRequest` hook might arrive before the transcript watcher sees the `tool_use` line. **Mitigation:** The `PERMISSION_REQUEST` reducer case finds the tool by scanning `toolCalls` for a running tool — this still works because `TRANSCRIPT_TOOL_USE` fires first (transcript is written before hooks execute). If timing is off, the permission card will still render via the hook system.

3. **Duplicate messages from transcript + InputBar optimistic dispatch:** Both `USER_PROMPT` (from InputBar) and `TRANSCRIPT_USER_MESSAGE` (from watcher) fire for the same user message. **Mitigation:** The `TRANSCRIPT_USER_MESSAGE` reducer deduplicates by checking the last timeline entry's content, same pattern as the existing `USER_PROMPT` deduplication.

4. **Large transcript files:** Long sessions produce large JSONL files. **Mitigation:** We read from a byte offset, never re-reading old content. Memory usage is bounded by the `seenUuids` set, which grows linearly but each entry is just a UUID string (~36 bytes).

5. **`fs.watch` reliability on Windows:** `fs.watch` on Windows can sometimes fire duplicate events or miss events. **Mitigation:** The `readNewLines` method is idempotent — duplicate fires just re-read zero bytes. Missed events are caught by the next fire. Worst case, the uuid-based deduplication prevents double rendering.

6. **Project slug edge cases:** The `cwdToProjectSlug` function must exactly match Claude Code's internal path→slug conversion. **Mitigation:** We verified the pattern against actual directory names. Add a fallback that scans `~/.claude/projects/*/` for a file matching `{claudeSessionId}.jsonl` if the slug-based lookup fails.
