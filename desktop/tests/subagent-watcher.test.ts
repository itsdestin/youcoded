import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import { SubagentIndex } from '../src/main/subagent-index';
import { SubagentWatcher } from '../src/main/subagent-watcher';
import { looseData, type TranscriptEvent } from '../src/shared/types';

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

// Fixed sleep: ONLY before a NEGATIVE assertion ("nothing was emitted"). Before a positive one use
// vi.waitFor — fs.watch delivery is load-dependent (macOS FSEvents, Windows parallel pool).
function wait(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Ceilings only bound the FAILURE case; green runs return as soon as the condition holds.
const SETTLE_MS = 5_000;   // in-process: watcher read + emit
const WATCH_MS = 15_000;   // fs.watch/stat-poll delivery of an external write
// WHY: without this a 15s vi.waitFor dies at vitest's default 5s test timeout.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// One temp-dir + index + watcher rig; each describe's beforeEach destructures it into its own lets.
function makeRig(prefix: string, opts: { mkdir?: boolean; replay?: boolean } = {}) {
  const { mkdir = true, replay = true } = opts;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const subagentsDir = path.join(tmpRoot, 'subagents');
  if (mkdir) fs.mkdirSync(subagentsDir, { recursive: true });
  const index = new SubagentIndex();
  const emitted: TranscriptEvent[] = [];
  // replayExisting:true because most tests write a file first, then start; the default is pinned in its own describe.
  const watcher = new SubagentWatcher({
    sessionId: 's', subagentsDir, index, emit: e => emitted.push(e), ...(replay ? { replayExisting: true } : {}),
  });
  return { tmpRoot, subagentsDir, index, emitted, watcher };
}

describe('SubagentWatcher', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let index: SubagentIndex;
  let emitted: TranscriptEvent[];
  let watcher: SubagentWatcher;

  beforeEach(() => { ({ tmpRoot, subagentsDir, index, emitted, watcher } = makeRig('subagent-watcher-')); });

  afterEach(() => {
    watcher.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('replays an existing subagent file on start', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: SETTLE_MS });

    expect(emitted[0].type).toBe('tool-use');
    expect(looseData(emitted[0]).parentAgentToolUseId).toBe('toolu_parent');
    expect(looseData(emitted[0]).agentId).toBe('abc');
    expect(looseData(emitted[0]).toolUseId).toBe('toolu_X');
  });

  it('picks up a subagent file that appears after start', async () => {
    watcher.start();
    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');

    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    await vi.waitFor(() => {
      const stamped = emitted.find(e => e.type === 'tool-use');
      expect(stamped?.data.parentAgentToolUseId).toBe('toolu_parent');
    }, { timeout: WATCH_MS });
  });

  it('streams new lines appended to an existing subagent file', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: SETTLE_MS });

    appendLine(subagentsDir, 'abc', toolUseLine('u2', 'toolu_Y', 'Grep', { pattern: 'foo' }));
    // fs.watch delivery of the append — poll, don't sleep (see wait() above).
    await vi.waitFor(() => {
      expect(emitted.find(e => looseData(e).toolName === 'Grep')).toBeDefined();
    }, { timeout: WATCH_MS });

    expect(emitted.length).toBeGreaterThanOrEqual(2);
    const grep = emitted.find(e => looseData(e).toolName === 'Grep');
    expect((grep && looseData(grep).parentAgentToolUseId)).toBe('toolu_parent');
    expect((grep && looseData(grep).agentId)).toBe('abc');
  });

  it('buffers events when no parent binding exists, flushes when parent arrives', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    watcher.start();
    await wait(100);
    expect(emitted).toHaveLength(0); // buffered

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    // WHY retry: the read is async, so a single flush under load ran against an empty buffer.
    await vi.waitFor(() => {
      watcher.flushPendingFor('abc');
      expect(emitted).toHaveLength(1);
    }, { timeout: SETTLE_MS });
    expect(looseData(emitted[0]).parentAgentToolUseId).toBe('toolu_parent');
  });

  it('dedups on re-reading the same lines (seen-uuid window)', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: SETTLE_MS });

    // Simulate file-size shrink then re-growth (e.g. poll triggers redundant read).
    watcher.forceRereadFor('abc');
    await wait(50); // negative assertion below — a fixed settle is correct here
    expect(emitted).toHaveLength(1); // no duplicate emit
  });

  it('getHistory yields all events from all subagent files for replay', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));
    writeMeta(subagentsDir, 'def', 'Other', 'Plan');
    appendLine(subagentsDir, 'def', toolUseLine('u2', 'toolu_Y', 'Grep', { pattern: 'foo' }));

    const historyIndex = new SubagentIndex();
    historyIndex.recordParentAgentToolUse('toolu_P1', 'Find bug', 'Explore');
    historyIndex.recordParentAgentToolUse('toolu_P2', 'Other', 'Plan');

    const events = await watcher.getHistory(historyIndex);
    expect(events.length).toBe(2);
    const byTool: Record<string, TranscriptEvent> = {};
    for (const e of events) byTool[looseData(e).toolName!] = e;
    expect(looseData(byTool['Read']).parentAgentToolUseId).toBe('toolu_P1');
    expect(looseData(byTool['Read']).agentId).toBe('abc');
    expect(looseData(byTool['Grep']).parentAgentToolUseId).toBe('toolu_P2');
    expect(looseData(byTool['Grep']).agentId).toBe('def');
  });

  it('live-path flush: buffered subagent events emit in order after parent arrives', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));
    appendLine(subagentsDir, 'abc', toolUseLine('u2', 'toolu_Y', 'Grep', { pattern: 'foo' }));

    watcher.start();
    await wait(100);
    expect(emitted).toHaveLength(0); // both lines buffered, no parent yet

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    // WHY retry: on Windows the read landed after the sleep, so a single flush found an empty buffer.
    await vi.waitFor(() => {
      watcher.flushAllPending();
      expect(emitted).toHaveLength(2);
    }, { timeout: SETTLE_MS });
    // Preserved order: first buffered event still emits first.
    expect(looseData(emitted[0]).toolName).toBe('Read');
    expect(looseData(emitted[1]).toolName).toBe('Grep');
    // Both stamped with the correct parent.
    expect(looseData(emitted[0]).parentAgentToolUseId).toBe('toolu_parent');
    expect(looseData(emitted[1]).parentAgentToolUseId).toBe('toolu_parent');
    expect(looseData(emitted[0]).agentId).toBe('abc');
  });

  it('getHistory never touches a blocking fs call, and a missing directory is an empty replay', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));
    const historyIndex = new SubagentIndex();
    historyIndex.recordParentAgentToolUse('toolu_P1', 'Find bug', 'Explore');
    const sync = [vi.spyOn(fs, 'readFileSync'), vi.spyOn(fs, 'readdirSync'), vi.spyOn(fs, 'existsSync')];
    try {
      expect(await watcher.getHistory(historyIndex)).toHaveLength(1);
      for (const spy of sync) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of sync) spy.mockRestore();
    }
    const gone = new SubagentWatcher({ sessionId: 's', subagentsDir: path.join(tmpRoot, 'nope'), index, emit: () => undefined });
    expect(await gone.getHistory(new SubagentIndex())).toEqual([]);
  });

  it('getHistory binds same-description helpers in directory order, even though reads run in parallel', async () => {
    // Two helpers share a description: binding is FIFO over parents in the
    // order the directory lists the files — exactly the sync version's order.
    for (const id of ['a1', 'a2', 'a3']) {
      writeMeta(subagentsDir, id, 'Same task', 'Explore');
      appendLine(subagentsDir, id, toolUseLine(`u-${id}`, `toolu_${id}`, 'Read', { file_path: `/${id}` }));
    }
    const order = fs.readdirSync(subagentsDir).filter(n => n.endsWith('.jsonl')).map(n => n.slice(6, -6));
    const historyIndex = new SubagentIndex();
    for (const p of ['P1', 'P2', 'P3']) historyIndex.recordParentAgentToolUse(p, 'Same task', 'Explore');
    const events = await watcher.getHistory(historyIndex);
    expect(events.map(e => looseData(e).agentId)).toEqual(order);
    expect(events.map(e => looseData(e).parentAgentToolUseId)).toEqual(['P1', 'P2', 'P3']);
  });

  it('overlapping directory scans coalesce: a burst of triggers is one scan plus one rerun', async () => {
    watcher.start();
    await vi.waitFor(() => expect((watcher as any).scanInFlight).toBeNull(), { timeout: SETTLE_MS });
    const readdir = vi.spyOn(fs.promises, 'readdir');
    try {
      for (let i = 0; i < 20; i++) watcher.kickScan(); // e.g. 20 appended lines → 20 dir events
      // WHY count the moment the scan promise settles, not after a poll (macOS CI flake: 3 > 2): the real directory watch can deliver a
      // late event of its own (FSEvents batches) between the burst's scans finishing and the next poll, and that is a new burst,
      // not a failure to coalesce this one. The count is read in the microtask right after the last scan, before any such event.
      await (watcher as any).scanInFlight;
      const scans = readdir.mock.calls.length;
      expect(scans).toBeLessThanOrEqual(2);
      expect(scans).toBeGreaterThanOrEqual(1);
    } finally {
      readdir.mockRestore();
    }
  });

  it('stop() while a scan is in flight tracks nothing and leaves no watch behind', async () => {
    writeMeta(subagentsDir, 'late', 'Late', 'Explore');
    appendLine(subagentsDir, 'late', toolUseLine('u-l', 'toolu_L', 'Read', { file_path: '/l' }));
    index.recordParentAgentToolUse('toolu_parent_l', 'Late', 'Explore');
    const watchSpy = vi.spyOn(fs, 'watch');
    try {
      watcher.start(); // scan starts (async readdir)…
      watcher.stop();  // …and the session closes before it lands
      await wait(100); // negative assertion — a fixed settle is correct here
      expect(watcher.trackedCount()).toBe(0);
      expect(emitted).toEqual([]);
      // Only the directory watch start() attaches synchronously — no per-helper watch.
      expect(watchSpy.mock.calls.every(c => c[0] === subagentsDir)).toBe(true);
    } finally {
      watchSpy.mockRestore();
    }
  });

  it('a helper whose parent was recorded while its first read was in flight still emits (no lost output)', async () => {
    // The race the async scan widened: tracked with no parent → first read in
    // flight → the parent's Agent tool_use lands and flushAllPending() finds
    // an EMPTY buffer → the read then buffers the lines. Before the fix nothing
    // flushed them again, so the helper's output never showed.
    writeMeta(subagentsDir, 'race', 'Race task', 'Explore');
    appendLine(subagentsDir, 'race', toolUseLine('u-r', 'toolu_R', 'Read', { file_path: '/r' }));
    const realOpen = fs.promises.open;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: Parameters<typeof realOpen>) => {
      await gate;
      return realOpen(...args);
    }) as typeof realOpen);
    try {
      watcher.start();
      await vi.waitFor(() => expect(watcher.trackedCount()).toBe(1), { timeout: SETTLE_MS });
      await vi.waitFor(() => expect(openSpy).toHaveBeenCalled(), { timeout: SETTLE_MS }); // read is in flight
      index.recordParentAgentToolUse('toolu_parent_r', 'Race task', 'Explore');
      watcher.flushAllPending(); // what TranscriptWatcher does — nothing buffered yet
      release();
      await vi.waitFor(() => expect(emitted.map(e => looseData(e).toolUseId)).toEqual(['toolu_R']), { timeout: SETTLE_MS });
      expect(looseData(emitted[0]).parentAgentToolUseId).toBe('toolu_parent_r');
    } finally {
      release();
      openSpy.mockRestore();
    }
  });
});

// A multi-byte char split across two reads must reassemble (mirrors the TranscriptWatcher byte-carry fix).
describe('SubagentWatcher read integrity', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let index: SubagentIndex;
  let emitted: TranscriptEvent[];
  let watcher: SubagentWatcher;

  beforeEach(() => { ({ tmpRoot, subagentsDir, index, emitted, watcher } = makeRig('subagent-utf8-')); });

  afterEach(() => {
    watcher.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('preserves a multi-byte UTF-8 character split across two reads', async () => {
    writeMeta(subagentsDir, 'utf8', 'Emoji task', 'claude');
    index.recordParentAgentToolUse('toolu_parent_utf8', 'Emoji task', 'claude');

    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u-emoji',
      isSidechain: true,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'result 😀 done' }],
        stop_reason: null,
      },
    });
    const full = Buffer.from(line + '\n', 'utf8');
    const emojiStart = full.indexOf(Buffer.from('😀', 'utf8'));
    const splitAt = emojiStart + 2;
    const jsonlPath = path.join(subagentsDir, 'agent-utf8.jsonl');

    // First half (cut mid-emoji), then start + read — leaves a partial carry.
    fs.writeFileSync(jsonlPath, full.subarray(0, splitAt));
    watcher.start();
    await wait(150);
    expect(emitted).toHaveLength(0);

    // Second half completes the line; poll the reread until the carried bytes reassemble.
    fs.appendFileSync(jsonlPath, full.subarray(splitAt));
    await vi.waitFor(() => {
      watcher.forceRereadFor('utf8');
      expect(emitted.length).toBeGreaterThan(0);
    }, { timeout: SETTLE_MS });

    const text = emitted.find(e => e.type === 'assistant-text');
    expect(text).toBeDefined();
    expect(text!.data.text).toContain('😀');
    expect(text!.data.text).not.toContain('�');
  });
});

// WHY: timers once leaked per session (a dir poll) and per helper file (a stat poll), never pruned: idle CPU crept up.
describe('SubagentWatcher timer lifecycle', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let index: SubagentIndex;
  let emitted: TranscriptEvent[];
  let watcher: SubagentWatcher;

  beforeEach(() => { ({ tmpRoot, subagentsDir, index, emitted, watcher } = makeRig('subagent-timers-', { mkdir: false })); });

  afterEach(() => {
    watcher.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('kickScan discovers a brand-new subagent dir immediately (no poll wait)', async () => {
    // Dir does not exist at start — the bootstrap poll is now slow (5s), so
    // without the kick the first subagent's output would sit undiscovered.
    watcher.start();

    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'kick', 'Kicked task', 'claude');
    index.recordParentAgentToolUse('toolu_parent_kick', 'Kicked task', 'claude');
    appendLine(subagentsDir, 'kick', toolUseLine('u-kick', 'toolu_K', 'Read', { file_path: '/k' }));

    watcher.kickScan();
    await vi.waitFor(() => {
      expect(emitted.some(e => looseData(e).agentId === 'kick')).toBe(true);
    }, { timeout: SETTLE_MS });
  });

  it('settleByParent releases the helper\'s own watch and poll, and a late write still arrives via the directory watch', async () => {
    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'done', 'Finished task', 'claude');
    index.recordParentAgentToolUse('toolu_parent_done', 'Finished task', 'claude');
    appendLine(subagentsDir, 'done', toolUseLine('u-d1', 'toolu_D1', 'Read', { file_path: '/d' }));

    // The stat poll beside a healthy watch is a Windows-only safety net (audit
    // W8); the platform is stubbed so the poll exists for settle to stop.
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      watcher.start();
      await vi.waitFor(() => expect(emitted.length).toBeGreaterThanOrEqual(1), { timeout: SETTLE_MS });
      expect(watcher.hasActivePoll('done')).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }

    expect(watcher.hasActiveWatch('done')).toBe(true);
    await watcher.settleByParent('toolu_parent_done');
    expect(watcher.hasActivePoll('done')).toBe(false);
    // Perf (many tabs): a finished helper must not hold its own fs.watch until the session closes.
    expect(watcher.hasActiveWatch('done')).toBe(false);
    // The entry stays (offset only) so a re-scan never replays it from byte 0.
    expect(watcher.trackedCount()).toBe(1);

    // Late write after settle must still arrive — the session's directory
    // watch sees the write and drains the settled helper's file.
    const before = emitted.length;
    appendLine(subagentsDir, 'done', toolUseLine('u-d2', 'toolu_D2', 'Grep', { pattern: 'x' }));
    await vi.waitFor(() => expect(emitted.length).toBeGreaterThan(before), { timeout: WATCH_MS });
  });

  it('a directory re-scan after settle does not replay the settled helper', async () => {
    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'once', 'Once task', 'claude');
    index.recordParentAgentToolUse('toolu_parent_once', 'Once task', 'claude');
    appendLine(subagentsDir, 'once', toolUseLine('u-o1', 'toolu_O1', 'Read', { file_path: '/o' }));
    watcher.start();
    await vi.waitFor(() => expect(emitted.length).toBe(1), { timeout: SETTLE_MS });
    await watcher.settleByParent('toolu_parent_once');
    watcher.kickScan(); // re-scans the directory
    // settle (negative assertion): the settled agent must not be emitted again.
    await wait(100);
    expect(emitted.length).toBe(1);
    expect(watcher.hasActiveWatch('once')).toBe(false);
  });

  it('stop() (session close) releases every helper entry, settled or not', async () => {
    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'a1', 'Task one', 'claude');
    writeMeta(subagentsDir, 'a2', 'Task two', 'claude');
    index.recordParentAgentToolUse('toolu_parent_a1', 'Task one', 'claude');
    index.recordParentAgentToolUse('toolu_parent_a2', 'Task two', 'claude');
    appendLine(subagentsDir, 'a1', toolUseLine('u-a1', 'toolu_A1', 'Read', { file_path: '/a' }));
    appendLine(subagentsDir, 'a2', toolUseLine('u-a2', 'toolu_A2', 'Read', { file_path: '/b' }));
    watcher.start();
    await vi.waitFor(() => expect(emitted.length).toBe(2), { timeout: SETTLE_MS });
    await watcher.settleByParent('toolu_parent_a1');
    expect(watcher.trackedCount()).toBe(2);
    watcher.stop();
    expect(watcher.trackedCount()).toBe(0);
    expect(watcher.hasActiveWatch('a2')).toBe(false);
  });

  it('settleByParent for an unknown parent is a harmless no-op', async () => {
    watcher.start();
    await expect(watcher.settleByParent('toolu_never_seen')).resolves.toBeUndefined();
  });
});

// Timers are armed on demand: sessions without helpers must not run 5s polls.
describe('SubagentWatcher arms timers only when there is something to poll', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let index: SubagentIndex;
  let emitted: TranscriptEvent[];
  let watcher: SubagentWatcher;
  const realPlatform = process.platform;
  const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    ({ tmpRoot, subagentsDir, index, emitted, watcher } = makeRig('subagent-lazy-', { mkdir: false }));
  });

  afterEach(() => {
    watcher.stop();
    setPlatform(realPlatform);
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('a session that never runs a helper arms no timer at all (Linux, macOS)', () => {
    setPlatform('linux');
    watcher.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('on Windows the directory bootstrap poll runs from the start', () => {
    setPlatform('win32');
    watcher.start();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('kickScan arms the bootstrap poll, and the watch takes over with no poll once the directory appears', async () => {
    setPlatform('linux');
    watcher.start();
    watcher.kickScan(); // parent Agent tool_use seen, directory not created yet
    expect(vi.getTimerCount()).toBe(1);

    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'k', 'Kicked task', 'claude');
    index.recordParentAgentToolUse('toolu_parent_k', 'Kicked task', 'claude');
    appendLine(subagentsDir, 'k', toolUseLine('u-k', 'toolu_K', 'Read', { file_path: '/k' }));
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(emitted.some(e => looseData(e).agentId === 'k')).toBe(true), { timeout: SETTLE_MS });
    // Directory watched, file watched, helper bound: nothing left to poll.
    expect(vi.getTimerCount()).toBe(0);
    expect(watcher.hasActivePoll('k')).toBe(false);
  });

  it('the prune timer is armed by the first buffered event and stands down once the buffer empties', async () => {
    setPlatform('linux');
    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'orphan', 'Early task', 'claude');
    appendLine(subagentsDir, 'orphan', toolUseLine('u-o', 'toolu_O', 'Read', { file_path: '/o' }));
    watcher.start(); // no parent recorded yet: the line is buffered
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1), { timeout: SETTLE_MS });
    expect(emitted).toEqual([]);

    index.recordParentAgentToolUse('toolu_parent_o', 'Early task', 'claude');
    watcher.flushPendingFor('orphan');
    expect(emitted.some(e => looseData(e).agentId === 'orphan')).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); // the next prune tick finds nothing buffered
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a directory whose fs.watch cannot be attached falls back to the polls', async () => {
    setPlatform('linux');
    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'nw', 'No watch', 'claude');
    index.recordParentAgentToolUse('toolu_parent_nw', 'No watch', 'claude');
    appendLine(subagentsDir, 'nw', toolUseLine('u-nw', 'toolu_NW', 'Read', { file_path: '/nw' }));
    vi.spyOn(fs, 'watch').mockImplementation(() => { throw new Error('EMFILE'); });
    watcher.start();
    // The helper is tracked by the async directory scan (B1), so its file poll
    // arms a tick after start().
    await vi.waitFor(() => expect(watcher.hasActivePoll('nw')).toBe(true), { timeout: SETTLE_MS });
    expect(vi.getTimerCount()).toBe(2); // directory poll + this helper's file poll
  });

  // A settled helper has no watch of its own, and a directory re-scan skips
  // files it already tracks — so on the poll paths below, only the poll's
  // drain of settled helpers reads output a background helper writes after
  // its parent's tool result. Without it that output was silently lost.
  it('with the directory watch failed, a settled helper\'s late write still arrives via the directory poll', async () => {
    setPlatform('linux');
    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'lf', 'Late fallback', 'claude');
    index.recordParentAgentToolUse('toolu_parent_lf', 'Late fallback', 'claude');
    appendLine(subagentsDir, 'lf', toolUseLine('u-lf1', 'toolu_LF1', 'Read', { file_path: '/lf' }));
    vi.spyOn(fs, 'watch').mockImplementation(() => { throw new Error('EMFILE'); });
    watcher.start();
    await vi.waitFor(() => expect(emitted.length).toBe(1), { timeout: SETTLE_MS });
    await watcher.settleByParent('toolu_parent_lf');
    expect(watcher.hasActivePoll('lf')).toBe(false);

    appendLine(subagentsDir, 'lf', toolUseLine('u-lf2', 'toolu_LF2', 'Grep', { pattern: 'x' }));
    await vi.advanceTimersByTimeAsync(5000); // one directory-poll tick
    await vi.waitFor(() => expect(emitted.map(e => looseData(e).toolUseId)).toContain('toolu_LF2'), { timeout: SETTLE_MS });
    expect(emitted).toHaveLength(2); // drained once, not replayed
  });

  it('on Windows, a settled helper\'s late write the directory watch never reported arrives via the safety-net poll', async () => {
    setPlatform('win32');
    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'lw', 'Late windows', 'claude');
    index.recordParentAgentToolUse('toolu_parent_lw', 'Late windows', 'claude');
    appendLine(subagentsDir, 'lw', toolUseLine('u-lw1', 'toolu_LW1', 'Read', { file_path: '/lw' }));
    // Watches attach fine but never fire — a dropped Windows notification.
    vi.spyOn(fs, 'watch').mockImplementation(() => {
      const w = new EventEmitter() as unknown as fs.FSWatcher;
      (w as any).close = () => undefined;
      return w;
    });
    watcher.start();
    await vi.waitFor(() => expect(emitted.length).toBe(1), { timeout: SETTLE_MS });
    await watcher.settleByParent('toolu_parent_lw');
    expect(watcher.hasActiveWatch('lw')).toBe(false);

    appendLine(subagentsDir, 'lw', toolUseLine('u-lw2', 'toolu_LW2', 'Grep', { pattern: 'y' }));
    await vi.advanceTimersByTimeAsync(5000); // one safety-net tick
    await vi.waitFor(() => expect(emitted.map(e => looseData(e).toolUseId)).toContain('toolu_LW2'), { timeout: SETTLE_MS });
    expect(emitted).toHaveLength(2);
  });
});

// 2026-10-22 freeze hunt: helpers that already exist when watching starts are NOT replayed (their
// history reaches the chat through getHistory, as the parent transcript's does), reads are capped, and
// helpers that appear or grow afterwards are still delivered in full.
describe('SubagentWatcher default: existing helper files are not replayed', () => {
  let tmpRoot: string; let subagentsDir: string; let index: SubagentIndex; let emitted: TranscriptEvent[]; let watcher: SubagentWatcher;
  beforeEach(() => { ({ tmpRoot, subagentsDir, index, emitted, watcher } = makeRig('subagent-noreplay-', { replay: false })); });
  afterEach(() => { watcher.stop(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  it('emits nothing for lines already in an existing file, but streams what is appended after start', async () => {
    writeMeta(subagentsDir, 'old', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'old', toolUseLine('u-old', 'toolu_OLD', 'Read', { file_path: '/old' }));
    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await vi.waitFor(() => expect((watcher as any).perFile.has('old')).toBe(true), { timeout: SETTLE_MS }); // tracked, so its start point is fixed
    await wait(200);
    expect(emitted).toHaveLength(0);
    appendLine(subagentsDir, 'old', toolUseLine('u-new', 'toolu_NEW', 'Read', { file_path: '/new' }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: WATCH_MS });
    expect(looseData(emitted[0]).toolUseId).toBe('toolu_NEW');
  });

  it('still reads a helper that first appears after start from its first byte', async () => {
    watcher.start();
    await wait(20); // a helper made in the very same instant as start() counts as already there
    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    writeMeta(subagentsDir, 'fresh', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'fresh', toolUseLine('u1', 'toolu_F1', 'Read', { file_path: '/a' }));
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: WATCH_MS });
  });

  it('reads a large backlog in capped pieces and loses no line', async () => {
    const file = path.join(subagentsDir, 'agent-big.jsonl');
    writeMeta(subagentsDir, 'big', 'Find bug', 'Explore');
    fs.writeFileSync(file, '');
    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await vi.waitFor(() => expect((watcher as any).perFile.has('big')).toBe(true), { timeout: SETTLE_MS });
    // ~3 MiB appended at once: several 1 MiB reads, with lines split across the cap boundaries.
    const lines = Array.from({ length: 3000 }, (_, i) => JSON.stringify(toolUseLine(`u${i}`, `toolu_${i}`, 'Read', { file_path: '/x'.repeat(500) })));
    fs.appendFileSync(file, lines.join('\n') + '\n');
    await vi.waitFor(() => expect(emitted).toHaveLength(3000), { timeout: WATCH_MS });
    expect(new Set(emitted.map((e) => looseData(e).toolUseId)).size).toBe(3000);
  });
});

describe('SubagentWatcher: nothing is delivered after stop()', () => {
  it('a backlog read cut short by stop() emits no further events', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-stop-'));
    const dir = path.join(tmp, 'subagents'); fs.mkdirSync(dir);
    const idx = new SubagentIndex(); const got: TranscriptEvent[] = [];
    const w = new SubagentWatcher({ sessionId: 's', subagentsDir: dir, index: idx, emit: (e) => got.push(e), replayExisting: true });
    writeMeta(dir, 'big', 'Find bug', 'Explore');
    idx.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    const lines = Array.from({ length: 3000 }, (_, i) => JSON.stringify(toolUseLine(`u${i}`, `toolu_${i}`, 'Read', { file_path: '/x'.repeat(500) })));
    fs.writeFileSync(path.join(dir, 'agent-big.jsonl'), lines.join('\n') + '\n');   // ~3 MiB: several capped reads
    w.start();
    await vi.waitFor(() => expect(got.length).toBeGreaterThan(0), { timeout: SETTLE_MS });
    w.stop();
    const atStop = got.length;
    // settle: a NEGATIVE check (nothing more arrives after stop), so a fixed wait is the right shape here.
    await wait(300);
    expect(got.length).toBe(atStop);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
