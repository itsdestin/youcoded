import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { TranscriptEvent } from '../shared/types';
import { SubagentIndex } from './subagent-index';
import { SubagentWatcher } from './subagent-watcher';

// ---------------------------------------------------------------------------
// cwdToProjectSlug
// ---------------------------------------------------------------------------

/**
 * Converts a filesystem path to Claude Code's project directory slug.
 * e.g. `C:\Users\alice` → `C--Users-alice`
 *      `/home/user/project` → `-home-user-project`
 */
export function cwdToProjectSlug(cwd: string): string {
  return cwd
    .replace(/\\/g, '/')   // backslash → forward slash
    .replace(/:/g, '-')    // colon → dash
    .replace(/\//g, '-');   // slash → dash
}

// ---------------------------------------------------------------------------
// parseTranscriptLine
// ---------------------------------------------------------------------------

/**
 * Parses a single JSONL line from a Claude Code transcript file.
 * Returns zero or more TranscriptEvents.
 */
export function parseTranscriptLine(line: string, sessionId: string): TranscriptEvent[] {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  // Only process user / assistant message lines
  if (parsed.type !== 'user' && parsed.type !== 'assistant') {
    return [];
  }
  if (!parsed.message) {
    return [];
  }

  const uuid: string = parsed.uuid || '';
  const timestamp = Date.now();
  const message = parsed.message;
  const events: TranscriptEvent[] = [];

  // --- User messages ---
  if (parsed.type === 'user') {
    const content = message.content;

    // Compact-summary entry: Claude Code writes this after /compact (appended
    // to the same JSONL) or resume-from-summary (first entry of a new JSONL).
    // isVisibleInTranscriptOnly=true means it's meant to stay hidden from UI —
    // we suppress the user-message event and emit a dedicated signal that
    // App.tsx uses to clear compactionPending and finalize the marker.
    if (parsed.isCompactSummary) {
      events.push({
        type: 'compact-summary',
        sessionId,
        uuid,
        timestamp,
        data: {},
      });
      return events;
    }

    // Skip system-injected content (skills, CLAUDE.md, system reminders).
    // These have isMeta: true and should never appear in the chat timeline.
    if (parsed.isMeta) {
      return [];
    }

    // Tool results are wrapped in user messages and also carry a promptId,
    // so check for tool_result blocks BEFORE the user-text branch.
    if (Array.isArray(content)) {
      const hasToolResult = content.some((b: any) => b.type === 'tool_result');
      if (hasToolResult) {
        // Edit/MultiEdit results carry a jsdiff-style `structuredPatch` array
        // at the JSONL line's top level (NOT inside message.content). Pull it
        // through so the renderer can show absolute file line numbers instead
        // of re-diffing old_string/new_string from 1.
        const structuredPatch = Array.isArray(parsed.toolUseResult?.structuredPatch)
          ? parsed.toolUseResult.structuredPatch
          : undefined;
        for (const block of content) {
          if (block.type === 'tool_result') {
            events.push({
              type: 'tool-result',
              sessionId,
              uuid,
              timestamp,
              data: {
                toolUseId: block.tool_use_id,
                toolResult: extractToolResultContent(block.content),
                isError: block.is_error ?? false,
                ...(structuredPatch ? { structuredPatch } : {}),
              },
            });
          }
        }
        return events;
      }
    }

    // User-typed prompt: has a promptId and text content (not tool results)
    if (parsed.promptId) {
      const raw = typeof content === 'string'
        ? content
        : extractTextFromBlocks(content);
      const text = stripSystemTags(raw);
      // Skip empty messages (e.g. interrupted tool use placeholders)
      if (!text) return [];
      events.push({
        type: 'user-message',
        sessionId,
        uuid,
        timestamp,
        data: { text },
      });
      return events;
    }

    return events;
  }

  // --- Assistant messages ---
  const content = message.content;
  const messageModel: string | undefined = message.model;
  if (Array.isArray(content)) {
    for (const block of content) {
      switch (block.type) {
        case 'text': {
          const cleaned = stripSystemTags(block.text);
          if (!cleaned) break; // Skip blocks that were entirely system tags
          events.push({
            type: 'assistant-text',
            sessionId,
            uuid,
            timestamp,
            data: { text: cleaned, ...(messageModel ? { model: messageModel } : {}) },
          });
          break;
        }

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

        // Extended-thinking models write `thinking` blocks with no visible
        // text — emit a lightweight heartbeat so the renderer's attention
        // classifier knows Claude is still working and doesn't flag a
        // multi-minute reasoning pause as 'stuck'.
        case 'thinking':
          events.push({
            type: 'assistant-thinking',
            sessionId,
            uuid,
            timestamp,
            data: {},
          });
          break;

        // Skip images, etc.
        default:
          break;
      }
    }
  } else if (typeof content === 'string') {
    const cleaned = stripSystemTags(content);
    if (cleaned) {
      events.push({
        type: 'assistant-text',
        sessionId,
        uuid,
        timestamp,
        data: { text: cleaned, ...(messageModel ? { model: messageModel } : {}) },
      });
    }
  }

  // Emit turn-complete for any definitive stop reason except tool_use
  // (tool_use means Claude is waiting for tool results, not actually done).
  // Enrich with model + usage + anthropicRequestId so the reducer can attach
  // them to the completing AssistantTurn for UI surfacing.
  if (message.stop_reason && message.stop_reason !== 'tool_use') {
    const usage = message.usage && {
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
    };
    events.push({
      type: 'turn-complete',
      sessionId,
      uuid,
      timestamp,
      data: {
        stopReason: message.stop_reason,
        ...(messageModel ? { model: messageModel } : {}),
        ...(parsed.requestId ? { anthropicRequestId: parsed.requestId } : {}),
        ...(usage ? { usage } : {}),
      },
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextFromBlocks(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
}

/**
 * Strips internal XML tags and ANSI escapes that should never appear in
 * the chat timeline. These are injected by Claude Code's harness and
 * aren't part of the assistant's actual response.
 *  - Tags stripped entirely: system-reminder, task-notification, antml_thinking,
 *    command-name, command-message, command-args
 *  - Tags unwrapped (inner text kept): local-command-stdout, local-command-stderr
 */
const STRIP_ENTIRELY_RE = /<(task-notification|system-reminder|antml_thinking|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;
const UNWRAP_RE = /<(local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g;
const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;

function stripSystemTags(text: string): string {
  return text
    .replace(STRIP_ENTIRELY_RE, '')
    .replace(UNWRAP_RE, (_match, _tag, inner) => inner)
    .replace(ANSI_RE, '')
    .trim();
}

function extractToolResultContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  return String(content ?? '');
}

// ---------------------------------------------------------------------------
// TranscriptWatcher
// ---------------------------------------------------------------------------

// Dedup window: retain at least this many recent UUIDs. Actual retention
// ranges from DEDUP_CAP to 2*DEDUP_CAP due to two-Set rotation. Slightly
// wider than the old exact-500 prune, strictly safer for dedup correctness.
const DEDUP_CAP = 500;

interface WatchedSession {
  desktopSessionId: string;
  claudeSessionId: string;
  cwd: string;
  jsonlPath: string;
  offset: number;
  partialLine: string;
  // Perf: rotating two-Set dedup. `has` checks both; `add` writes to recent.
  // When recent exceeds DEDUP_CAP, we rotate (discard old, promote recent to
  // old, start a fresh recent). Replaces the old "build an array, slice it,
  // rebuild the Set" prune which was O(DEDUP_CAP) per prune event.
  seenUuidsRecent: Set<string>;
  seenUuidsOld: Set<string>;
  watcher: fs.FSWatcher | null;
  // Whether this session still needs the global poll: true until fs.watch
  // is attached, then stays true as a safety-net (fs.watch on Windows can
  // silently miss notifications). A single class-level timer iterates all
  // sessions rather than each session owning its own setInterval.
  needsPoll: boolean;
  subagentIndex: SubagentIndex;
  subagentWatcher: SubagentWatcher;
}

/**
 * Watches Claude Code JSONL transcript files and emits structured events.
 *
 * @param claudeConfigDir  Override for `~/.claude` — used in tests to
 *                         point at a temp directory instead of the real home.
 */
export class TranscriptWatcher extends EventEmitter {
  private sessions = new Map<string, WatchedSession>();
  private claudeConfigDir: string;
  // One global poll timer shared across sessions. Previously each session owned
  // its own setInterval, which meant N sessions → N independent timer ticks +
  // N fs.stat calls per second. The global timer ticks at pollIntervalMs and
  // iterates the sessions map, skipping any that don't need polling.
  private globalPollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;

  constructor(claudeConfigDir?: string, pollIntervalMs = 2000) {
    super();
    this.claudeConfigDir = claudeConfigDir || path.join(os.homedir(), '.claude', 'projects');
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Start watching the transcript for a session.
   */
  startWatching(desktopSessionId: string, claudeSessionId: string, cwd: string): void {
    if (this.sessions.has(desktopSessionId)) {
      this.stopWatching(desktopSessionId);
    }

    const slug = cwdToProjectSlug(cwd);
    const jsonlPath = path.join(this.claudeConfigDir, slug, `${claudeSessionId}.jsonl`);
    const subagentsDir = path.join(this.claudeConfigDir, slug, claudeSessionId, 'subagents');

    const subagentIndex = new SubagentIndex();
    const subagentWatcher = new SubagentWatcher({
      sessionId: desktopSessionId,
      subagentsDir,
      index: subagentIndex,
      emit: (event) => this.emit('transcript-event', event),
    });

    const session: WatchedSession = {
      desktopSessionId, claudeSessionId, cwd, jsonlPath,
      offset: 0,
      partialLine: '',
      seenUuidsRecent: new Set(),
      seenUuidsOld: new Set(),
      watcher: null,
      needsPoll: true,
      subagentIndex,
      subagentWatcher,
    };
    this.sessions.set(desktopSessionId, session);

    subagentWatcher.start();

    // Try to start an fs.watch; fall back to the global poll if the file
    // doesn't exist yet. needsPoll stays true either way — when fs.watch is
    // attached the global poll acts as a safety net (fs.watch on Windows can
    // silently miss notifications).
    if (fs.existsSync(jsonlPath)) {
      this.readNewLines(session);
      this.attachFsWatch(session);
    }
    this.ensureGlobalPoll();
  }

  /**
   * Stop watching a specific session.
   */
  stopWatching(desktopSessionId: string): void {
    const session = this.sessions.get(desktopSessionId);
    if (!session) return;
    this.cleanupSession(session);
    this.sessions.delete(desktopSessionId);
    this.stopGlobalPollIfIdle();
  }

  /**
   * Stop all watchers.
   */
  stopAll(): void {
    for (const session of this.sessions.values()) {
      this.cleanupSession(session);
    }
    this.sessions.clear();
    this.stopGlobalPollIfIdle();
  }

  /**
   * Manually trigger a read for a session — useful in tests and as a
   * fallback when fs.watch misses a notification.
   */
  readNewLinesForSession(desktopSessionId: string): void {
    const session = this.sessions.get(desktopSessionId);
    if (session) {
      this.readNewLines(session);
    }
  }

  /**
   * Return every TranscriptEvent parsed from disk for a currently-watched
   * session. Used during ownership transfer: when a new window acquires a
   * session via detach/re-dock, it calls this once through IPC to rebuild its
   * reducer state from the JSONL (disk is the source of truth). Does not
   * mutate watcher state — safe to call alongside live watching.
   */
  getHistory(desktopSessionId: string): TranscriptEvent[] {
    const session = this.sessions.get(desktopSessionId);
    if (!session) return [];
    const events: TranscriptEvent[] = [];
    // Fresh, throwaway index so replay doesn't corrupt live correlation.
    const replayIndex = new SubagentIndex();
    if (fs.existsSync(session.jsonlPath)) {
      let raw: string;
      try { raw = fs.readFileSync(session.jsonlPath, 'utf8'); }
      catch { raw = ''; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const parsed = parseTranscriptLine(line, desktopSessionId);
        for (const ev of parsed) {
          if (ev.type === 'tool-use' && ev.data.toolName === 'Agent') {
            replayIndex.recordParentAgentToolUse(
              ev.data.toolUseId!,
              (ev.data.toolInput?.description as string) || '',
              (ev.data.toolInput?.subagent_type as string) || '',
            );
          }
          events.push(ev);
        }
      }
    }
    for (const ev of session.subagentWatcher.getHistory(replayIndex)) events.push(ev);
    return events;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private attachFsWatch(session: WatchedSession): void {
    try {
      session.watcher = fs.watch(session.jsonlPath, () => {
        this.readNewLines(session);
      });
      session.watcher.on('error', () => {
        // If the watcher errors, fall back to the global poll (already running)
        if (session.watcher) {
          session.watcher.close();
          session.watcher = null;
        }
        session.needsPoll = true;
      });
      // Global poll continues alongside fs.watch as a safety net — on Windows,
      // fs.watch can silently miss change notifications. readNewLines is a
      // no-op when the file hasn't grown, so this is cheap.
    } catch {
      // fs.watch can throw on some platforms — global poll will cover it.
      session.needsPoll = true;
    }
  }

  /**
   * Start the class-level poll timer if it isn't already running. Runs every
   * GLOBAL_POLL_MS, iterating all sessions that still need polling. Replaces
   * the prior per-session setInterval (N timers → 1 timer).
   */
  private ensureGlobalPoll(): void {
    if (this.globalPollTimer) return;
    this.globalPollTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (!session.needsPoll) continue;
        if (!fs.existsSync(session.jsonlPath)) continue;
        this.readNewLines(session);
        // If fs.watch isn't attached yet, upgrade from poll-only to watch+poll.
        if (!session.watcher) {
          this.attachFsWatch(session);
        }
      }
    }, this.pollIntervalMs);
  }

  /**
   * Stop the global poll when no sessions remain. Important so tests and the
   * normal stopAll() path don't leak a timer into Node's event loop.
   */
  private stopGlobalPollIfIdle(): void {
    if (this.sessions.size === 0 && this.globalPollTimer) {
      clearInterval(this.globalPollTimer);
      this.globalPollTimer = null;
    }
  }

  private cleanupSession(session: WatchedSession): void {
    if (session.watcher) {
      session.watcher.close();
      session.watcher = null;
    }
    session.needsPoll = false;
    session.subagentWatcher.stop();
  }

  private async readNewLines(session: WatchedSession): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(session.jsonlPath);
    } catch {
      return; // File doesn't exist (yet)
    }

    const fileSize = stat.size;

    // /clear truncates the JSONL. /compact rewrites it with a summary.
    // In either case, if it shrank below our offset we reset to 0 so subsequent
    // writes are read correctly. Without this, we'd silently skip every new
    // event until the new writes pass the old offset.
    // Also resets the partial-line buffer so a split UTF-8 sequence from
    // before the truncation doesn't corrupt the new content.
    // Emits 'transcript-shrink' so App.tsx can detect /compact completion
    // (the compaction state machine awaits this signal to finalize the marker).
    if (fileSize < session.offset) {
      const oldOffset = session.offset;
      session.offset = 0;
      session.partialLine = '';
      this.emit('transcript-shrink', { sessionId: session.desktopSessionId, oldSize: oldOffset, newSize: fileSize });
      // Don't return — fall through and read from offset 0 if the file has content now
    }
    if (fileSize <= session.offset) return; // No new data

    const bytesToRead = fileSize - session.offset;
    const buffer = Buffer.alloc(bytesToRead);

    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(session.jsonlPath, 'r');
    } catch {
      return;
    }

    try {
      await handle.read(buffer, 0, bytesToRead, session.offset);
    } finally {
      await handle.close();
    }

    session.offset = fileSize;

    const text = buffer.toString('utf8');
    const chunks = text.split('\n');

    // Prepend any leftover partial line from previous read
    chunks[0] = session.partialLine + chunks[0];
    // Last element is either empty (if text ended with \n) or a partial line
    session.partialLine = chunks.pop() || '';

    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;

      const events = parseTranscriptLine(trimmed, session.desktopSessionId);
      if (events.length === 0) continue;

      // Deduplicate by uuid — Claude writes incremental updates with the
      // same uuid as the assistant message grows. For repeated UUIDs:
      //
      // - assistant-text: SKIP (would create duplicate text segments;
      //   the first write's text is already in the timeline)
      // - tool-use: EMIT (may be new; reducer Map.set deduplicates by
      //   toolUseId so re-emitting an existing one is harmless)
      // - tool-result: EMIT (reducer Map.set deduplicates by toolUseId)
      // - turn-complete: EMIT (only appears on the final write;
      //   critical for clearing the "thinking" state)
      // - user-message: EMIT (reducer has its own text-based dedup)
      const lineUuid = events[0].uuid;
      const isRepeat =
        !!lineUuid && (session.seenUuidsRecent.has(lineUuid) || session.seenUuidsOld.has(lineUuid));
      if (lineUuid) {
        session.seenUuidsRecent.add(lineUuid);
        // Rotate instead of rebuild when the recent set fills. Old set is
        // discarded, recent promotes to old, a fresh recent is allocated.
        // Effective dedup window is [DEDUP_CAP, 2*DEDUP_CAP] UUIDs — strictly
        // >= the old exact-500 window, so no missed dedups.
        if (session.seenUuidsRecent.size > DEDUP_CAP) {
          session.seenUuidsOld = session.seenUuidsRecent;
          session.seenUuidsRecent = new Set();
        }
      }

      for (const event of events) {
        if (isRepeat && event.type === 'assistant-text') continue;
        // Isolate each emit: a throwing listener must NOT abort the batch.
        // session.offset has already advanced — if a throw skipped remaining
        // chunks, they'd be permanently stranded (next readNewLines reads
        // from the advanced offset forward). This is the root cause of the
        // "rare missing Claude message" symptom we investigated.
        //
        // Emit the parent event first so reducer subscribers create the
        // parent Agent ToolCallState before any buffered subagent events
        // flush into it — otherwise subagent events for a brand-new parent
        // arrive before the parent and get silently dropped by
        // applySubagentEvent.
        try {
          this.emit('transcript-event', event);
        } catch (err) {
          // Surface to the process's unhandled-exception path without
          // breaking the loop. console.error preserves stack; the main
          // process logs it alongside other diagnostics.
          // eslint-disable-next-line no-console
          console.error('[TranscriptWatcher] listener threw for', event.type, err);
        }
        if (event.type === 'tool-use' && event.data.toolName === 'Agent') {
          const description = (event.data.toolInput?.description as string) || '';
          const subagentType = (event.data.toolInput?.subagent_type as string) || '';
          session.subagentIndex.recordParentAgentToolUse(
            event.data.toolUseId!, description, subagentType,
          );
          session.subagentWatcher.flushAllPending();
        }
      }
    }
  }
}
