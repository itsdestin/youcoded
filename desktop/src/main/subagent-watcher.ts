import fs from 'fs';
import path from 'path';
import { parseTranscriptLine } from './transcript-watcher';
import { SubagentIndex, SubagentMeta } from './subagent-index';
import { TranscriptEvent } from '../shared/types';

/** `agent-<id>.jsonl` — a helper's transcript (not its .meta.json). */
function isAgentJsonl(name: string): boolean {
  return name.endsWith('.jsonl') && name.startsWith('agent-');
}
function agentIdOf(name: string): string {
  return name.slice('agent-'.length, -'.jsonl'.length);
}

interface PerFileState {
  agentId: string;
  jsonlPath: string;
  metaPath: string;
  offset: number;
  // Incomplete-trailing-line carry, kept as BYTES (a decoded-string carry
  // corrupts multi-byte UTF-8 chars split across a read boundary — each half
  // decodes to U+FFFD independently). Mirrors TranscriptWatcher.
  partialBytes: Buffer;
  // Serialization guard: one readNewLines per file at a time; overlapping
  // triggers (fs.watch burst + poll + forced re-read) coalesce into a rerun.
  // Mirrors TranscriptWatcher — see its readNewLines comment for the race.
  reading: boolean;
  rerunQueued: boolean;
  seenUuids: Set<string>;
  watcher: fs.FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  // True once the parent's tool-result for this helper has landed and its
  // final read ran. WHY (perf, many tabs): a settled helper no longer holds its
  // own fs.watch — every helper ever spawned used to keep one open until the
  // whole session closed. The entry itself stays (offset + meta only) so a
  // directory re-scan never re-tracks the file from byte 0 and replays it.
  settled: boolean;
  // Fix 5: cache meta on first read so deliver() never re-reads from disk
  meta: SubagentMeta;
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
 * Windows fs.watch on a directory is flaky — there we combine fs.watch with a
 * slow poll that lists the directory and picks up new .jsonl files, and each
 * JSONL's fs.watch with a slow stat poll, matching TranscriptWatcher. Off
 * Windows the watches deliver on their own, so no poll runs beside a healthy
 * watch; a poll appears only when a watch fails (simplification audit W8).
 *
 * Timers are armed on demand, never at start: most sessions never run a helper,
 * so a session begins with NO timer. The bootstrap poll that waits for the
 * subagents directory to appear is armed by kickScan() (a parent Agent tool_use
 * was just seen — the directory is about to exist) and retired once it does;
 * the prune timer is armed by the first buffered event and stands down once the
 * buffer empties.
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
  // Directory-scan serialization (see scanDirectory). `generation` bumps on
  // stop() so a scan still in flight tracks nothing for a closed session.
  private scanInFlight: Promise<void> | null = null;
  private rescanQueued = false;
  private generation = 0;

  constructor(opts: SubagentWatcherOptions) {
    this.sessionId = opts.sessionId;
    this.subagentsDir = opts.subagentsDir;
    this.index = opts.index;
    this.emitFn = opts.emit;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Replay of any existing files. Async (B1): the helpers are tracked a tick
    // later; their lines were always delivered asynchronously anyway.
    void this.scanDirectory();
    this.attachDirWatcher();
    // The prune timer is armed lazily by deliver() on the first buffered event.
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.generation++;
    this.scanInFlight = null;
    this.rescanQueued = false;
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
   * Subagent replay for one history page. Called by readTranscriptPage
   * (transcript-page.ts) on every conversation open, scroll-up and buddy open.
   *
   * Takes a REQUIRED `index` parameter — the caller supplies a fresh,
   * throwaway SubagentIndex primed with the parent Agent tool_uses from
   * the current page. The live `this.index` is NEVER consulted, so
   * replay can safely run alongside an active start() without corrupting
   * live correlation.
   *
   * WHY async (2026-09-24, blocking-call batch B1): this listed the directory,
   * read every helper's .meta.json and then every bound helper's whole
   * transcript with *Sync calls, per page — with many helpers, every window
   * froze on each scroll-up. Reads now run in parallel off the main thread;
   * BINDING still happens in directory order (two helpers with the same
   * description bind to parents in that order) and events come out in that
   * same order, so the page is identical to what the sync version built.
   */
  async getHistory(index: SubagentIndex): Promise<TranscriptEvent[]> {
    let names: string[];
    try { names = await fs.promises.readdir(this.subagentsDir); } catch { return []; }
    const agentIds = names.filter(isAgentJsonl).map(agentIdOf);
    const metas = await Promise.all(agentIds.map((id) => this.readMeta(id)));
    const bound: { agentId: string; parentToolUseId: string }[] = [];
    agentIds.forEach((agentId, i) => {
      const meta = metas[i];
      if (!meta) return;
      const parentToolUseId = index.bindSubagent(agentId, meta);
      if (parentToolUseId) bound.push({ agentId, parentToolUseId });
    });
    // Only helpers whose parent is on this page are read at all.
    const raws = await Promise.all(bound.map(({ agentId }) =>
      fs.promises.readFile(path.join(this.subagentsDir, `agent-${agentId}.jsonl`), 'utf8').catch(() => null)));
    const events: TranscriptEvent[] = [];
    bound.forEach(({ agentId, parentToolUseId }, i) => {
      const raw = raws[i];
      if (raw == null) return;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = parseTranscriptLine(trimmed, this.sessionId);
        for (const ev of parsed) {
          events.push(this.stamp(ev, parentToolUseId, agentId));
        }
      }
    });
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

  /**
   * Event-driven kick from TranscriptWatcher when a parent Agent tool_use is
   * recorded: a subagent just started, so discover the subagents dir / new
   * JSONL files NOW instead of waiting for the safety-net polls. This is what
   * lets the polls run slow (5s) without delaying first subagent output.
   */
  kickScan(): void {
    if (!this.started) return;
    if (!fs.existsSync(this.subagentsDir)) {
      // A helper was just started but Claude Code has not created the
      // directory yet — poll for it to appear (retired once it does). This is
      // the only way the bootstrap poll is armed off Windows.
      this.startBootstrapPoll();
      return;
    }
    if (!this.dirWatcher) {
      // Dir just appeared — retire the bootstrap poll and upgrade to
      // fs.watch (+ the safety-net poll on Windows; attachDirWatcher decides).
      if (this.dirPollTimer) { clearInterval(this.dirPollTimer); this.dirPollTimer = null; }
      void this.scanDirectory();
      this.attachDirWatcher();
      return;
    }
    void this.scanDirectory();
  }

  /**
   * Called by TranscriptWatcher when a tool-result lands: if it completes a
   * parent Agent tool call, that subagent's transcript is done growing — do
   * one final read (bytes written between the last watch/poll tick and the
   * result), then release the helper's own fs.watch AND its safety-net stat
   * poll. Without this settle, a session that ran 50 subagents held 50
   * watches (and, on Windows, 50 stat-poll timers) until it closed.
   *
   * WHY releasing the watch is safe: an unexpected late write still arrives.
   * The session's DIRECTORY watch (which lives as long as the session) fires
   * for writes to any file inside it, and onDirEvent() drains a settled
   * helper's file when its name comes through — one stat + read per actual
   * write, nothing while the file is quiet. When the directory watch is NOT
   * healthy (it failed and a directory poll stands in, or Windows' safety-net
   * poll catches a dropped notification), that poll drains settled helpers
   * too (drainSettled). The session's own close (stop()) releases every
   * entry, settled or not.
   */
  async settleByParent(parentToolUseId: string): Promise<void> {
    for (const state of this.perFile.values()) {
      if (this.index.lookup(state.agentId) !== parentToolUseId) continue;
      try { await this.readNewLines(state); } catch { /* file may be gone */ }
      state.settled = true;
      if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
      if (state.watcher) { state.watcher.close(); state.watcher = null; }
    }
  }

  /** Test-only: whether an agent file's safety-net stat poll is running. */
  hasActivePoll(agentId: string): boolean {
    return !!this.perFile.get(agentId)?.pollTimer;
  }

  /** Test-only: whether an agent file still holds its own fs.watch. */
  hasActiveWatch(agentId: string): boolean {
    return !!this.perFile.get(agentId)?.watcher;
  }

  /** Test-only: how many helper entries this session is tracking. */
  trackedCount(): number {
    return this.perFile.size;
  }

  // ---- internals ----

  // WHY async (B1): read per helper on every history page and on every
  // directory scan. A missing file is the same `null` the old existsSync gave.
  private async readMeta(agentId: string): Promise<SubagentMeta | null> {
    const metaPath = path.join(this.subagentsDir, `agent-${agentId}.meta.json`);
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8');
      const obj = JSON.parse(raw);
      if (typeof obj?.description !== 'string' || typeof obj?.agentType !== 'string') return null;
      // toolUseId: the exact parent card — see SubagentIndex.bindSubagent.
      return {
        description: obj.description, agentType: obj.agentType,
        ...(typeof obj.toolUseId === 'string' && obj.toolUseId ? { toolUseId: obj.toolUseId } : {}),
      };
    } catch { return null; }
  }

  /** The directory watch fired. New helper files are picked up by the scan;
   *  a write to an already-SETTLED helper (which no longer has its own watch —
   *  see settleByParent) is drained here so a late line is never lost. */
  private onDirEvent(filename: string | Buffer | null): void {
    void this.scanDirectory();
    if (!filename) return;
    const name = filename.toString();
    if (!isAgentJsonl(name)) return;
    const state = this.perFile.get(agentIdOf(name));
    if (state?.settled) this.readNewLines(state).catch(() => undefined);
  }

  /**
   * List the directory and start tracking any helper not yet tracked.
   *
   * WHY async + single-flight (2026-09-24, blocking-call batch B1): on Linux the
   * directory watch fires for EVERY line an active helper appends, and each
   * fire ran a readdirSync (+ a sync .meta.json read per new helper) on the
   * main thread. Now one scan runs at a time; triggers that land meanwhile
   * coalesce into ONE rerun (the readNewLines pattern), so two scans can never
   * both track the same helper. `generation` fences a scan that is still in
   * flight when stop() runs: it tracks nothing afterwards (no watch leaked on
   * a closed session). Helpers are tracked in directory order, as before —
   * binding order matters when two share a description.
   */
  private scanDirectory(): Promise<void> {
    if (this.scanInFlight) { this.rescanQueued = true; return this.scanInFlight; }
    const gen = this.generation;
    // Declared first so the finally below can compare against it (it only
    // runs after the first await, by which point `run` is assigned).
    let run: Promise<void> | null = null;
    run = (async () => {
      try {
        do {
          this.rescanQueued = false;
          await this.scanOnce(gen);
        } while (this.rescanQueued && gen === this.generation);
      } finally {
        if (this.scanInFlight === run) this.scanInFlight = null;
      }
    })();
    this.scanInFlight = run;
    return run;
  }

  private async scanOnce(gen: number): Promise<void> {
    let names: string[];
    try { names = await fs.promises.readdir(this.subagentsDir); } catch { return; }
    if (gen !== this.generation) return;
    const fresh = names.filter(isAgentJsonl).map(agentIdOf).filter((id) => !this.perFile.has(id));
    if (fresh.length === 0) return;
    const metas = await Promise.all(fresh.map((id) => this.readMeta(id)));
    if (gen !== this.generation) return; // stop() ran during the reads
    fresh.forEach((agentId, i) => {
      const meta = metas[i];
      if (meta) this.trackSubagent(agentId, meta);
    });
  }

  private attachDirWatcher(): void {
    if (!fs.existsSync(this.subagentsDir)) {
      // The directory is created by Claude Code only once a subagent runs.
      // Off Windows nothing is armed here: kickScan() starts the bootstrap
      // poll when a helper actually starts. Windows keeps the poll from the
      // start, as before, since its directory watch is the flaky one.
      if (process.platform === 'win32') this.startBootstrapPoll();
      return;
    }
    try {
      this.dirWatcher = fs.watch(this.subagentsDir, (_evt, filename) => this.onDirEvent(filename));
      this.dirWatcher.on('error', () => {
        if (this.dirWatcher) { this.dirWatcher.close(); this.dirWatcher = null; }
        this.startDirPoll();
      });
      // WHY Windows only (audit W8): the safety-net poll exists for dropped
      // directory notifications, which only Windows produces once a watch is
      // armed; elsewhere it was a readdir every 5 s for the session's life.
      if (process.platform === 'win32') this.startDirPoll();
    } catch {
      this.startDirPoll();
    }
  }

  /** Poll for the subagents directory to appear; upgrade to fs.watch once it
   *  does. 5 s is deliberately slow — kickScan() (fired on the parent Agent
   *  tool_use) covers the fast path, and is what arms this off Windows. */
  private startBootstrapPoll(): void {
    if (this.dirPollTimer) return;
    this.dirPollTimer = setInterval(() => {
      // Fix 2: stop() was called after setInterval was scheduled — bail.
      if (!this.started) return;
      if (fs.existsSync(this.subagentsDir)) {
        if (this.dirPollTimer) { clearInterval(this.dirPollTimer); this.dirPollTimer = null; }
        void this.scanDirectory();
        this.attachDirWatcher();
      }
    }, 5000);
  }

  private startDirPoll(): void {
    if (this.dirPollTimer) return;
    // Fix 2 (defensive): guard against one-more-firing after stop().
    // 5s: fs.watch + kickScan() are the fast paths; this only catches the
    // rare Windows fs.watch dropped notification (or stands in for a watch
    // that failed), so it can afford to be slow.
    this.dirPollTimer = setInterval(() => {
      if (!this.started) return;
      void this.scanDirectory();
      this.drainSettled();
    }, 5000);
  }

  /** Read any late output from helpers that already SETTLED. WHY: a settled
   *  helper has no watch of its own (settleByParent), and scanDirectory() skips
   *  files it already tracks — so when this directory poll is running (the
   *  directory watch failed, or it is Windows' safety net for dropped
   *  notifications), this is the only thing that still reads a background
   *  helper that keeps writing after its parent's tool result. readNewLines is
   *  one async stat per helper and returns at once when the file hasn't grown. */
  private drainSettled(): void {
    for (const state of this.perFile.values()) {
      if (state.settled) this.readNewLines(state).catch(() => undefined);
    }
  }

  /** Age out pending buffered events every 5 s so a lingering unbound helper
   *  doesn't leak memory. Armed by the first buffered event; stands down as
   *  soon as the buffer is empty again (audit W8: it used to run for every
   *  session's life over a structure that is empty almost always). */
  private armPruneTimer(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      this.index.pruneExpired();
      if (!this.index.hasPending() && this.pruneTimer) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = null;
      }
    }, 5000);
  }

  private trackSubagent(agentId: string, meta: SubagentMeta): void {
    if (this.perFile.has(agentId)) return;
    const jsonlPath = path.join(this.subagentsDir, `agent-${agentId}.jsonl`);
    const metaPath = path.join(this.subagentsDir, `agent-${agentId}.meta.json`);
    // Fix 1 + 5: removed `bound` field; meta is cached on state so deliver()
    // never re-reads from disk and has no fragile two-source binding check.
    const state: PerFileState = {
      agentId,
      jsonlPath,
      metaPath,
      offset: 0,
      partialBytes: Buffer.alloc(0),
      reading: false,
      rerunQueued: false,
      seenUuids: new Set(),
      watcher: null,
      pollTimer: null,
      settled: false,
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
        // A settled helper needs no stand-in poll — the directory watch
        // covers its rare late write (see settleByParent).
        if (state.settled) return;
        this.startFilePoll(state);
      });
      // Same platform rule as the directory poll (audit W8): a safety-net stat
      // poll beside a healthy file watch only on Windows.
      if (process.platform === 'win32') this.startFilePoll(state);
    } catch {
      this.startFilePoll(state);
    }
  }

  private startFilePoll(state: PerFileState): void {
    if (state.pollTimer) return;
    // Fix 2 (defensive): guard against one-more-firing after stop().
    // Slow when fs.watch is attached (pure safety net — settleByParent stops
    // this timer entirely once the parent tool-result lands); faster only
    // when fs.watch failed and polling is the sole delivery path.
    state.pollTimer = setInterval(() => {
      if (!this.started) return;
      this.readNewLines(state).catch(() => undefined);
    }, state.watcher ? 5000 : 1500);
  }

  private async readNewLines(state: PerFileState): Promise<void> {
    // Serialized per file — see PerFileState.reading.
    if (state.reading) {
      state.rerunQueued = true;
      return;
    }
    state.reading = true;
    try {
      do {
        state.rerunQueued = false;
        await this.readNewLinesOnce(state);
      } while (state.rerunQueued);
    } finally {
      state.reading = false;
    }
  }

  private async readNewLinesOnce(state: PerFileState): Promise<void> {
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(state.jsonlPath); } catch { return; }
    const fileSize = stat.size;
    if (fileSize < state.offset) {
      state.offset = 0;
      state.partialBytes = Buffer.alloc(0);
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

    // Stitch the byte carry BEFORE decoding so a multi-byte UTF-8 char split
    // across reads reassembles losslessly (mirrors TranscriptWatcher).
    const fresh = buffer.subarray(0, bytesRead);
    const combined = state.partialBytes.length
      ? Buffer.concat([state.partialBytes, fresh])
      : fresh;
    const lastNewline = combined.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      state.partialBytes = Buffer.from(combined);
      return;
    }
    state.partialBytes = Buffer.from(combined.subarray(lastNewline + 1));
    const text = combined.subarray(0, lastNewline).toString('utf8');
    const chunks = text.split('\n');

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
    // WHY flush right away (B1, 2026-09-24): the parent's Agent tool_use may
    // have been recorded — and its flushAllPending() already run — AFTER this
    // helper was tracked but BEFORE its first read landed. Nothing would flush
    // again until an unrelated Agent call, so the helper's output sat unseen.
    // The async directory scan widened that gap; tryFlushPending binds only
    // if a matching parent exists and emits the buffer in order, else no-op.
    this.flushPendingFor(state.agentId);
    if (!this.index.lookup(state.agentId)) this.armPruneTimer();
  }

  private stamp(ev: TranscriptEvent, parentAgentToolUseId: string, agentId: string): TranscriptEvent {
    return { ...ev, data: { ...ev.data, parentAgentToolUseId, agentId } };
  }
}
