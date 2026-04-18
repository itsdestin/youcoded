import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SubagentIndex } from '../src/main/subagent-index';
import { SubagentWatcher } from '../src/main/subagent-watcher';
import type { TranscriptEvent } from '../src/shared/types';

function writeMeta(dir: string, agentId: string, description: string, agentType: string) {
  fs.writeFileSync(
    path.join(dir, `agent-${agentId}.meta.json`),
    JSON.stringify({ description, agentType }),
  );
}

function appendLine(dir: string, agentId: string, obj: any) {
  fs.appendFileSync(
    path.join(dir, `agent-${agentId}.jsonl`),
    JSON.stringify(obj) + '\n',
  );
}

function toolUseLine(uuid: string, toolUseId: string, toolName: string, input: any) {
  return {
    type: 'assistant',
    uuid,
    isSidechain: true,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
      stop_reason: null,
    },
  };
}

function wait(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('SubagentWatcher', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let index: SubagentIndex;
  let emitted: TranscriptEvent[];
  let watcher: SubagentWatcher;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watcher-'));
    subagentsDir = path.join(tmpRoot, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    index = new SubagentIndex();
    emitted = [];
    watcher = new SubagentWatcher({
      sessionId: 'sess-1',
      subagentsDir,
      index,
      emit: e => emitted.push(e),
    });
  });

  afterEach(() => {
    watcher.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('replays an existing subagent file on start', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await wait(100);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('tool-use');
    expect(emitted[0].data.parentAgentToolUseId).toBe('toolu_parent');
    expect(emitted[0].data.agentId).toBe('abc');
    expect(emitted[0].data.toolUseId).toBe('toolu_X');
  });

  it('picks up a subagent file that appears after start', async () => {
    watcher.start();
    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');

    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));
    await wait(1500); // allow fs.watch/poll to fire

    const stamped = emitted.find(e => e.type === 'tool-use');
    expect(stamped?.data.parentAgentToolUseId).toBe('toolu_parent');
  });

  it('streams new lines appended to an existing subagent file', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await wait(100);
    expect(emitted).toHaveLength(1);

    appendLine(subagentsDir, 'abc', toolUseLine('u2', 'toolu_Y', 'Grep', { pattern: 'foo' }));
    await wait(1500);

    expect(emitted.length).toBeGreaterThanOrEqual(2);
    const grep = emitted.find(e => e.data.toolName === 'Grep');
    expect(grep?.data.parentAgentToolUseId).toBe('toolu_parent');
    expect(grep?.data.agentId).toBe('abc');
  });

  it('buffers events when no parent binding exists, flushes when parent arrives', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    watcher.start();
    await wait(100);
    expect(emitted).toHaveLength(0); // buffered

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.flushPendingFor('abc');
    await wait(50);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.parentAgentToolUseId).toBe('toolu_parent');
  });

  it('dedups on re-reading the same lines (seen-uuid window)', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await wait(100);
    expect(emitted).toHaveLength(1);

    // Simulate file-size shrink then re-growth (e.g. poll triggers redundant read).
    watcher.forceRereadFor('abc');
    await wait(50);
    expect(emitted).toHaveLength(1); // no duplicate emit
  });

  it('getHistory yields all events from all subagent files for replay', () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));
    writeMeta(subagentsDir, 'def', 'Other', 'Plan');
    appendLine(subagentsDir, 'def', toolUseLine('u2', 'toolu_Y', 'Grep', { pattern: 'foo' }));

    index.recordParentAgentToolUse('toolu_P1', 'Find bug', 'Explore');
    index.recordParentAgentToolUse('toolu_P2', 'Other', 'Plan');

    const events = watcher.getHistory();
    expect(events.length).toBe(2);
    const byTool: Record<string, TranscriptEvent> = {};
    for (const e of events) byTool[e.data.toolName!] = e;
    expect(byTool['Read'].data.parentAgentToolUseId).toBe('toolu_P1');
    expect(byTool['Read'].data.agentId).toBe('abc');
    expect(byTool['Grep'].data.parentAgentToolUseId).toBe('toolu_P2');
    expect(byTool['Grep'].data.agentId).toBe('def');
  });
});
