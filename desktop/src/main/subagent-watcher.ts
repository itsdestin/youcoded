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
  bound: boolean; // true once SubagentIndex has a parent for this agent
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
    for (const state of this.perFile.values()) {
      if (state.watcher) state.watcher.close();
      if (state.pollTimer) clearInterval(state.pollTimer);
    }
    this.perFile.clear();
  }

  /**
   * Full-history replay. Called by TranscriptWatcher.getHistory() so a
   * detach/re-dock or remote-access replay can rebuild nested state.
   * Does NOT mutate live watcher state — safe alongside an active start().
   */
  getHistory(): TranscriptEvent[] {
    if (!fs.existsSync(this.subagentsDir)) return [];
    const events: TranscriptEvent[] = [];
    for (const name of fs.readdirSync(this.subagentsDir)) {
      if (!name.endsWith('.jsonl') || !name.startsWith('agent-')) continue;
      const agentId = name.slice('agent-'.length, -'.jsonl'.length);
      const meta = this.readMeta(agentId);
      if (!meta) continue;
      const parentToolUseId = this.index.bindSubagent(agentId, meta);
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
  flushPendingFor(agentId: string): void {
    const res = this.index.tryFlushPending(agentId);
    if (!res) return;
    for (const ev of res.events as TranscriptEvent[]) {
      this.emitFn(this.stamp(ev, res.parentToolUseId, agentId));
    }
    const state = this.perFile.get(agentId);
    if (state) state.bound = true;
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
    this.dirPollTimer = setInterval(() => this.scanDirectory(), 1000);
  }

  private trackSubagent(agentId: string): void {
    if (this.perFile.has(agentId)) return;
    const meta = this.readMeta(agentId);
    if (!meta) return;
    const jsonlPath = path.join(this.subagentsDir, `agent-${agentId}.jsonl`);
    const metaPath = path.join(this.subagentsDir, `agent-${agentId}.meta.json`);
    const state: PerFileState = {
      agentId,
      jsonlPath,
      metaPath,
      offset: 0,
      partialLine: '',
      seenUuids: new Set(),
      watcher: null,
      pollTimer: null,
      bound: false,
    };
    this.perFile.set(agentId, state);

    // Try to bind immediately. If no parent yet, events read from the file
    // will be buffered until flushPendingFor() is called by TranscriptWatcher.
    const parentToolUseId = this.index.bindSubagent(agentId, meta);
    state.bound = !!parentToolUseId;

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
    state.pollTimer = setInterval(() => {
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
    try { await handle.read(buffer, 0, buffer.length, state.offset); }
    finally { await handle.close(); }
    state.offset = fileSize;

    const text = buffer.toString('utf8');
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

  private deliver(state: PerFileState, ev: TranscriptEvent): void {
    if (state.bound) {
      const parentToolUseId = this.index.lookup(state.agentId);
      if (parentToolUseId) {
        this.emitFn(this.stamp(ev, parentToolUseId, state.agentId));
        return;
      }
    }
    // Not bound yet — buffer for eventual flush.
    const meta = this.readMeta(state.agentId);
    if (meta) this.index.bufferPendingEvent(state.agentId, meta, ev);
  }

  private stamp(ev: TranscriptEvent, parentAgentToolUseId: string, agentId: string): TranscriptEvent {
    return { ...ev, data: { ...ev.data, parentAgentToolUseId, agentId } };
  }
}
