import fs from 'fs';
import path from 'path';
import { parseTranscriptLine } from './transcript-watcher';
import { SubagentIndex } from './subagent-index';
import { TranscriptEvent } from '../shared/types';

interface PerFileState {
  agentId: string;
  jsonlPath: string;
  metaPath: string;
  offset: number;
  partialLine: string;
  seenUuids: Set<string>;
  watcher: fs.FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  // Fix 5: cache meta on first read so deliver() never re-reads from disk
  meta: { description: string; agentType: string };
}

export interface SubagentWatcherOptions {
  sessionId: string;
  subagentsDir: string;
  index: SubagentIndex;
  emit: (event: TranscriptEvent) => void;
}

/**
 * Watches one parent session's `<parent>/subagents/` directory. For each
 * `agent-<id>.jsonl` that appears, reads the sibling .meta.json, binds to
 * a parent Agent tool_use via SubagentIndex, then streams the JSONL
 * through parseTranscriptLine with parentAgentToolUseId + agentId stamped
 * on each emitted event.
 *
 * Windows fs.watch on a directory is flaky — we combine fs.watch with a
 * 1s poll that lists the directory and picks up new .jsonl files. On each
 * JSONL we combine fs.watch-on-file with a 2s poll for the same reason,
 * matching the strategy in TranscriptWatcher.
 */
export class SubagentWatcher {
  private readonly sessionId: string;
  private readonly subagentsDir: string;
  private readonly index: SubagentIndex;
  private readonly emitFn: (event: TranscriptEvent) => void;
  private perFile = new Map<string, PerFileState>();
  private dirWatcher: fs.FSWatcher | null = null;
  private dirPollTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(opts: SubagentWatcherOptions) {
    this.sessionId = opts.sessionId;
    this.subagentsDir = opts.subagentsDir;
    this.index = opts.index;
    this.emitFn = opts.emit;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scanDirectory(); // synchronous replay of any existing files
    this.attachDirWatcher();
    // Age out pending buffered events every 5s so a lingering unbound
    // subagent doesn't leak memory.
    this.pruneTimer = setInterval(() => this.index.pruneExpired(), 5000);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
    if (this.dirPollTimer) { clearInterval(this.dirPollTimer); this.dirPollTimer = null; }
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    // Fix 3: null each watcher/timer before clearing the map so a
    // one-more-firing callback finds state already cleaned up.
    for (const state of this.perFile.values()) {
      if (state.watcher) { state.watcher.close(); state.watcher = null; }
      if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    }
    this.perFile.clear();
  }

  /**
   * Full-history replay. Called by TranscriptWatcher.getHistory() so a
   * detach/re-dock or remote-access replay can rebuild nested state.
   *
   * Takes a REQUIRED `index` parameter — the caller supplies a fresh,
   * throwaway SubagentIndex primed with the parent Agent tool_uses from
   * the current replay. The live `this.index` is NEVER consulted, so
   * replay can safely run alongside an active start() without corrupting
   * live correlation.
   */
  getHistory(index: SubagentIndex): TranscriptEvent[] {
    if (!fs.existsSync(this.subagentsDir)) return [];
    const events: TranscriptEvent[] = [];
    for (const name of fs.readdirSync(this.subagentsDir)) {
      if (!name.endsWith('.jsonl') || !name.startsWith('agent-')) continue;
      const agentId = name.slice('agent-'.length, -'.jsonl'.length);
      const meta = this.readMeta(agentId);
      if (!meta) continue;
      const parentToolUseId = index.bindSubagent(agentId, meta);
      if (!parentToolUseId) continue;
      const jsonlPath = path.join(this.subagentsDir, name);
      let raw: string;
      try { raw = fs.readFileSync(jsonlPath, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = parseTranscriptLine(trimmed, this.sessionId);
        for (const ev of parsed) {
          events.push(this.stamp(ev, parentToolUseId, agentId));
        }
      }
    }
    return events;
  }

  /**
   * Called by TranscriptWatcher when it records a new parent Agent
   * tool_use. Attempts to flush any pending (buffered) events for any
   * agentId whose meta matches.
   */
  // Fix 1: remove state.bound mutation — index.lookup is single source of truth.
  flushPendingFor(agentId: string): void {
    const res = this.index.tryFlushPending(agentId);
    if (!res) return;
    for (const ev of res.events as TranscriptEvent[]) {
      this.emitFn(this.stamp(ev, res.parentToolUseId, agentId));
    }
  }

  /**
   * Convenience wrapper for TranscriptWatcher: after the parent parses any
   * new Agent tool_use, flush every agentId with pending buffered events.
   * Most calls are no-ops.
   */
  // Fix 6: expose flushAllPending for Task 4 callers.
  flushAllPending(): void {
    for (const agentId of this.perFile.keys()) this.flushPendingFor(agentId);
  }

  /** Test-only hook: force a re-read of a single subagent file. */
  forceRereadFor(agentId: string): void {
    const state = this.perFile.get(agentId);
    if (state) this.readNewLines(state).catch(() => undefined);
  }

  // ---- internals ----

  private readMeta(agentId: string): { description: string; agentType: string } | null {
    const metaPath = path.join(this.subagentsDir, `agent-${agentId}.meta.json`);
    if (!fs.existsSync(metaPath)) return null;
    try {
      const raw = fs.readFileSync(metaPath, 'utf8');
      const obj = JSON.parse(raw);
      if (typeof obj?.description !== 'string' || typeof obj?.agentType !== 'string') return null;
      return { description: obj.description, agentType: obj.agentType };
    } catch { return null; }
  }

  private scanDirectory(): void {
    if (!fs.existsSync(this.subagentsDir)) return;
    for (const name of fs.readdirSync(this.subagentsDir)) {
      if (!name.endsWith('.jsonl') || !name.startsWith('agent-')) continue;
      const agentId = name.slice('agent-'.length, -'.jsonl'.length);
      this.trackSubagent(agentId);
    }
  }

  private attachDirWatcher(): void {
    if (!fs.existsSync(this.subagentsDir)) {
      // The directory is created by Claude Code only once a subagent runs.
      // Poll the parent until it exists; upgrade to fs.watch once it does.
      this.dirPollTimer = setInterval(() => {
        // Fix 2: stop() was called after setInterval was scheduled — bail.
        if (!this.started) return;
        if (fs.existsSync(this.subagentsDir)) {
          if (this.dirPollTimer) { clearInterval(this.dirPollTimer); this.dirPollTimer = null; }
          this.scanDirectory();
          this.attachDirWatcher();
        }
      }, 1000);
      return;
    }
    try {
      this.dirWatcher = fs.watch(this.subagentsDir, () => this.scanDirectory());
      this.dirWatcher.on('error', () => {
        if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
        this.startDirPoll();
      });
      this.startDirPoll(); // 1s safety-net poll alongside watch
    } catch {
      this.startDirPoll();
    }
  }

  private startDirPoll(): void {
    if (this.dirPollTimer) return;
    // Fix 2 (defensive): guard against one-more-firing after stop().
    this.dirPollTimer = setInterval(() => {
      if (!this.started) return;
      this.scanDirectory();
    }, 1000);
  }

  private trackSubagent(agentId: string): void {
    if (this.perFile.has(agentId)) return;
    const meta = this.readMeta(agentId);
    if (!meta) return;
    const jsonlPath = path.join(this.subagentsDir, `agent-${agentId}.jsonl`);
    const metaPath = path.join(this.subagentsDir, `agent-${agentId}.meta.json`);
    // Fix 1 + 5: removed `bound` field; meta is cached on state so deliver()
    // never re-reads from disk and has no fragile two-source binding check.
    const state: PerFileState = {
      agentId,
      jsonlPath,
      metaPath,
      offset: 0,
      partialLine: '',
      seenUuids: new Set(),
      watcher: null,
      pollTimer: null,
      meta,
    };
    this.perFile.set(agentId, state);

    // Try to bind immediately. If no parent yet, events read from the file
    // will be buffered until flushPendingFor() is called by TranscriptWatcher.
    this.index.bindSubagent(agentId, meta);

    this.attachFileWatch(state);
    // Initial read — catches all existing bytes.
    this.readNewLines(state).catch(() => undefined);
  }

  private attachFileWatch(state: PerFileState): void {
    try {
      state.watcher = fs.watch(state.jsonlPath, () => {
        this.readNewLines(state).catch(() => undefined);
      });
      state.watcher.on('error', () => {
        if (state.watcher) { state.watcher.close(); state.watcher = null; }
        this.startFilePoll(state);
      });
      this.startFilePoll(state); // 2s safety-net poll alongside watch
    } catch {
      this.startFilePoll(state);
    }
  }

  private startFilePoll(state: PerFileState): void {
    if (state.pollTimer) return;
    // Fix 2 (defensive): guard against one-more-firing after stop().
    state.pollTimer = setInterval(() => {
      if (!this.started) return;
      this.readNewLines(state).catch(() => undefined);
    }, state.watcher ? 2000 : 1000);
  }

  private async readNewLines(state: PerFileState): Promise<void> {
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(state.jsonlPath); } catch { return; }
    const fileSize = stat.size;
    if (fileSize < state.offset) {
      state.offset = 0;
      state.partialLine = '';
    }
    if (fileSize <= state.offset) return;

    const buffer = Buffer.alloc(fileSize - state.offset);
    let handle: fs.promises.FileHandle;
    try { handle = await fs.promises.open(state.jsonlPath, 'r'); } catch { return; }
    // Fix 4: advance offset only by bytesRead (not fileSize) so a short read
    // or throw never skips unread bytes. Also slice the buffer to bytesRead so
    // we don't stringify uninitialized padding.
    let bytesRead = 0;
    try {
      const result = await handle.read(buffer, 0, buffer.length, state.offset);
      bytesRead = result.bytesRead;
    } finally {
      await handle.close();
    }
    if (bytesRead === 0) return;
    state.offset += bytesRead;

    const text = buffer.toString('utf8', 0, bytesRead);
    const chunks = text.split('\n');
    chunks[0] = state.partialLine + chunks[0];
    state.partialLine = chunks.pop() || '';

    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      const events = parseTranscriptLine(trimmed, this.sessionId);
      if (events.length === 0) continue;
      const lineUuid = events[0].uuid;
      if (lineUuid) {
        if (state.seenUuids.has(lineUuid)) continue;
        state.seenUuids.add(lineUuid);
        if (state.seenUuids.size > 500) {
          state.seenUuids = new Set([...state.seenUuids].slice(-500));
        }
      }
      for (const ev of events) this.deliver(state, ev);
    }
  }

  // Fix 1: consult index.lookup as the single source of truth for binding.
  // The old two-check pattern (state.bound + index.lookup) was fragile —
  // a stale state.bound=true after an unbind() would silently drop events.
  private deliver(state: PerFileState, ev: TranscriptEvent): void {
    const parentToolUseId = this.index.lookup(state.agentId);
    if (parentToolUseId) {
      this.emitFn(this.stamp(ev, parentToolUseId, state.agentId));
      return;
    }
    // Not bound yet — buffer for eventual flush using cached meta.
    this.index.bufferPendingEvent(state.agentId, state.meta, ev);
  }

  private stamp(ev: TranscriptEvent, parentAgentToolUseId: string, agentId: string): TranscriptEvent {
    return { ...ev, data: { ...ev.data, parentAgentToolUseId, agentId } };
  }
}
