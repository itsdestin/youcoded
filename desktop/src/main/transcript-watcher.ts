import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { TranscriptEvent } from '../shared/types';
import { SubagentIndex } from './subagent-index';
import { SubagentWatcher } from './subagent-watcher';
import { ccProjectSlug } from './slug-encoding';

// ---------------------------------------------------------------------------
// parseTranscriptLine
// ---------------------------------------------------------------------------

/** Running token tally for the turn currently being parsed.
 *
 *  WHY this exists: Claude Code writes ONE assistant line per API request, and
 *  a single user turn is normally many requests — every tool call is another
 *  round trip. Only the LAST of them carries a `stop_reason` other than
 *  `tool_use`, and only that one produced a `turn-complete` event, so the usage
 *  the app recorded was one request's, not the turn's. Measured across six of
 *  Destin's real transcripts on 2026-09-03: turn-complete lines are 4-17% of the
 *  assistant lines that carry usage, so the session's Out: chip was showing
 *  roughly a twentieth of the truth (713 output tokens for a 42-hour session).
 *
 *  The native runtime never had this bug because `native-session-host.ts` sums
 *  every step of a turn before it emits turn-complete. This makes the Claude
 *  Code path do the same thing, so ONE label means ONE measurement on both.
 *
 *  Subagents cannot contaminate it: Claude Code writes Task transcripts to
 *  their own files (watched by SubagentWatcher), and a main transcript contains
 *  zero `isSidechain` assistant lines — verified across those same six files. */
export interface TurnUsageTally {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function emptyTurnUsageTally(): TurnUsageTally {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

/**
 * Parses a single JSONL line from a Claude Code transcript file.
 * Returns zero or more TranscriptEvents.
 *
 * `tally` is the caller's per-session accumulator (TranscriptWatcher keeps one
 * on each WatchedSession). Every assistant line's usage is added to it, and a
 * turn-complete both reports and resets it. Omitting it keeps the OLD
 * one-request behaviour, which is only ever what a single-line unit test wants.
 */
export function parseTranscriptLine(
  line: string,
  sessionId: string,
  tally: TurnUsageTally = emptyTurnUsageTally(),
): TranscriptEvent[] {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  // A message typed while Claude is still working. Claude Code records it ONLY as a queued_command
  // attachment (no ordinary user line follows), and skipping it with every other non-user line left
  // the typing device's bubble unconfirmed at the bottom of its chat while every other device never
  // showed the message (Destin, 2026-09-11: "messages not always appearing in the same order on the
  // desktop and the remote client"). Measured on the 400 newest local transcripts: 84 typed, 1,218
  // background-task notices, and no ordinary user line repeating a queued message.
  const queuedText = queuedPromptText(parsed);
  if (queuedText !== null) {
    if (!queuedText) return [];
    return [{ type: 'user-message', sessionId, uuid: parsed.uuid || '', timestamp: Date.now(), data: { text: queuedText } }];
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
  // The line's own time. Fail closed (0) when absent/unparseable — a result
  // with no recorded time is treated as history, never as fresh.
  const parsedTs = Date.parse(parsed.timestamp);
  const recordedAt = Number.isFinite(parsedTs) ? parsedTs : 0;
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
    // Also forward the summary text so the marker can be expanded inline.
    if (parsed.isCompactSummary) {
      const summaryRaw = typeof content === 'string'
        ? content
        : extractTextFromBlocks(content);
      const summary = stripSystemTags(summaryRaw);
      events.push({
        type: 'compact-summary',
        sessionId,
        uuid,
        timestamp,
        data: summary ? { summary } : {},
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
                recordedAt,
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
      if (!text) {
        // A slash command: Claude Code wraps it in command tags, which strip to nothing, so its
        // bubble never confirmed (2026-09-11 order investigation). Read as the command typed and
        // marked, so the chat starts no turn for it: many commands get no reply, which is the
        // "stuck thinking" trap described on STRIP_ENTIRELY_RE below.
        const command = slashCommandText(raw);
        if (!command) return []; // e.g. interrupted tool use placeholders
        events.push({ type: 'user-message', sessionId, uuid, timestamp, data: { text: command, slashCommand: true } });
        return events;
      }

      // Claude Code writes these exact strings as user messages when the user
      // presses ESC mid-turn. Emit a dedicated user-interrupt event (consumed
      // by the reducer to end the in-flight turn) instead of a user-message,
      // so the marker does not render as a user bubble. Exact-match only;
      // embedded text is treated as a normal prompt (accepted edge).
      if (text === '[Request interrupted by user]') {
        events.push({
          type: 'user-interrupt',
          sessionId,
          uuid,
          timestamp,
          data: { kind: 'plain' },
        });
        return events;
      }
      if (text === '[Request interrupted by user for tool use]') {
        events.push({
          type: 'user-interrupt',
          sessionId,
          uuid,
          timestamp,
          data: { kind: 'tool-use' },
        });
        return events;
      }

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
  // Fold THIS request into the turn's running tally. Runs for every assistant
  // line, `tool_use` ones included — those are the ~95% the old code dropped.
  //
  // inputTokens is stamped as the WHOLE prompt (uncached remainder + cache read
  // + cache creation) rather than Anthropic's raw `input_tokens`, which is only
  // the remainder. That is deliberate and load-bearing: the native runtime's
  // inputTokens is already the whole prompt, and the Claude Code statusline's
  // `context_window.total_input_tokens` is built the same way (see the comment
  // in hook-scripts/statusline.sh). Every consumer of this field — the In:
  // chip, session-totals, selectCacheReuse — therefore gets one meaning from
  // both runtimes instead of two.
  const requestUsage = message.usage;
  if (requestUsage) {
    const read = requestUsage.cache_read_input_tokens ?? 0;
    const create = requestUsage.cache_creation_input_tokens ?? 0;
    tally.inputTokens += (requestUsage.input_tokens ?? 0) + read + create;
    tally.outputTokens += requestUsage.output_tokens ?? 0;
    tally.cacheReadTokens += read;
    tally.cacheCreationTokens += create;
  }

  if (message.stop_reason && message.stop_reason !== 'tool_use') {
    // Report the WHOLE turn, then reset for the next one. `hasUsage` is checked
    // against the tally rather than this line's own `message.usage`, because a
    // final line with no usage block can still be closing a turn whose earlier
    // requests were all measured — dropping those would put us back where we
    // started, only less obviously.
    const hasUsage = tally.inputTokens > 0 || tally.outputTokens > 0
      || tally.cacheReadTokens > 0 || tally.cacheCreationTokens > 0;
    const usage = hasUsage ? { ...tally } : undefined;
    tally.inputTokens = 0; tally.outputTokens = 0;
    tally.cacheReadTokens = 0; tally.cacheCreationTokens = 0;
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

/**
 * The text of a queued message a person typed; '' for a queued line that must stay hidden; null for
 * any other line. Background-task notices (commandMode 'task-notification') and messages another
 * Claude Code session sent in (origin.kind 'peer') are not something the person typed. A queued
 * line with no origin at all is read as typed: all 84 measured on 2026-09-11 carried one, so this
 * only matters for a Claude Code build this was not measured on. Mirrored in TranscriptWatcher.kt.
 */
function queuedPromptText(parsed: any): string | null {
  const a = parsed?.type === 'attachment' ? parsed.attachment : null;
  if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt') return null;
  if (a.origin !== undefined && a.origin?.kind !== 'human') return '';
  const raw = typeof a.prompt === 'string' ? a.prompt : extractTextFromBlocks(a.prompt);
  return stripSystemTags(raw);
}

/** "/name args" from a slash-command line, or null when the line is not one. Mirrored in
 *  TranscriptWatcher.kt. */
function slashCommandText(raw: string): string | null {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw)?.[1]?.replace(ANSI_RE, '').trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.replace(ANSI_RE, '').trim() ?? '';
  const command = name.startsWith('/') ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
}

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
 *    command-name, command-message, command-args,
 *    local-command-stdout, local-command-stderr
 *
 * Why local-command-stdout/stderr are stripped (not unwrapped): CC writes
 * these as dimmed (ANSI [2m) echoes of slash-command output, e.g.
 * "Compacted (ctrl+o to see full summary)" after /compact. Unwrapping them
 * surfaced the dim text as a user-typed bubble AND tripped the
 * TRANSCRIPT_USER_MESSAGE "no pending match" path, which set isThinking: true
 * with no transcript turn to ever clear it — leaving chat permanently stuck
 * in "thinking" after every compaction. The chat is the canonical
 * conversation; the terminal pane already shows raw CC output for users who
 * want to see slash-command stdout.
 */
const STRIP_ENTIRELY_RE = /<(task-notification|system-reminder|antml_thinking|command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;

function stripSystemTags(text: string): string {
  return text
    .replace(STRIP_ENTIRELY_RE, '')
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

// WHY (2026-09-10): a /compact rewrite, a paste of a huge tool result, or a
// transcript that grew while the app was suspended arrives as ONE delta.
// Buffer.alloc(delta) + one decode + one synchronous parse loop over the whole
// thing is a single long task on the main thread. Cap each read; the
// serialized runner below loops immediately until the file is drained, and
// every await in between lets timers and IPC run.
const MAX_TAIL_READ_BYTES = 1024 * 1024;

interface WatchedSession {
  desktopSessionId: string;
  claudeSessionId: string;
  cwd: string;
  jsonlPath: string;
  offset: number;
  // The byte the tailer STARTED at (perf cycle 2). The first history page reads
  // up to exactly this byte, so page and live stream can never overlap.
  startOffset: number;
  // Carry-over of an incomplete trailing line between reads, kept as BYTES.
  // A decoded-string carry corrupts multi-byte UTF-8 chars split across a
  // read boundary (each half decodes to U+FFFD independently) — bytes stitch
  // back losslessly.
  partialBytes: Buffer;
  // Serialization guard: only one readNewLines runs per session at a time.
  // Overlapping invocations (fs.watch bursts + global poll + manual triggers)
  // used to read the same byte range twice — double-emitting events — and
  // could corrupt the carry buffer via stale offsets. See readNewLines.
  reading: boolean;
  rerunQueued: boolean;
  // Perf: rotating two-Set dedup. `has` checks both; `add` writes to recent.
  // When recent exceeds DEDUP_CAP, we rotate (discard old, promote recent to
  // old, start a fresh recent). Replaces the old "build an array, slice it,
  // rebuild the Set" prune which was O(DEDUP_CAP) per prune event.
  // Running token tally for the turn currently in flight. Lives HERE and not in
  // readNewLinesOnce because a single turn's requests routinely arrive across
  // many reads — a per-read tally would reset mid-turn and undercount again.
  turnUsage: TurnUsageTally;
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
  startWatching(desktopSessionId: string, claudeSessionId: string, cwd: string, transcriptPath?: string): void {
    if (this.sessions.has(desktopSessionId)) {
      this.stopWatching(desktopSessionId);
    }

    // Prefer CC's own transcript_path from the hook payload (spec §5.0): no
    // character class to get wrong, no cap branch, no drift when CC changes its
    // encoding. The slug mirror below is the FALLBACK only (hook payload absent),
    // and the subagents dir always rides the transcript's parent.
    const jsonlPath = transcriptPath
      || path.join(this.claudeConfigDir, ccProjectSlug(cwd), `${claudeSessionId}.jsonl`);
    const subagentsDir = path.join(path.dirname(jsonlPath), claudeSessionId, 'subagents');

    const subagentIndex = new SubagentIndex();
    const subagentWatcher = new SubagentWatcher({
      sessionId: desktopSessionId,
      subagentsDir,
      index: subagentIndex,
      emit: (event) => this.emit('transcript-event', event),
    });

    // Perf (cycle 2): start at the END of an already-existing file. History is
    // delivered by the page reader (transcript-page.ts); the tailer carries only
    // genuinely new lines. This removes the whole-file re-read + re-emit that ran
    // on every resume and re-dock. A brand-new session's file does not exist yet
    // -> 0, exactly as before.
    let startOffset = 0;
    try { startOffset = fs.statSync(jsonlPath).size; } catch { startOffset = 0; }

    const session: WatchedSession = {
      desktopSessionId, claudeSessionId, cwd, jsonlPath,
      offset: startOffset,
      startOffset,
      partialBytes: Buffer.alloc(0),
      reading: false,
      rerunQueued: false,
      turnUsage: emptyTurnUsageTally(),
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
      void this.readNewLines(session);
      this.attachFsWatch(session);
    }
    this.ensureGlobalPoll();
  }

  /**
   * The byte offset the live tailer started at for this session — the END
   * boundary the first history page reads up to, so the page and the live
   * stream never overlap. 0 for a session whose file did not exist yet.
   */
  getStartOffset(desktopSessionId: string): number {
    return this.sessions.get(desktopSessionId)?.startOffset ?? 0;
  }

  /**
   * Everything the paged-history reader (transcript-page.ts) needs for a
   * session, or null when the session isn't watched. Returned as data rather
   * than exposing the sessions map — and read from HERE rather than importing
   * the reader, which would make transcript-watcher <-> transcript-page a
   * circular import (the reader needs parseTranscriptLine).
   */
  pageSourceFor(desktopSessionId: string): { jsonlPath: string; subagentsDir: string; startOffset: number } | null {
    const session = this.sessions.get(desktopSessionId);
    if (!session) return null;
    return {
      jsonlPath: session.jsonlPath,
      subagentsDir: path.join(path.dirname(session.jsonlPath), session.claudeSessionId, 'subagents'),
      startOffset: session.startOffset,
    };
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
      void this.readNewLines(session);
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
    // Replay-side uuid dedup, mirroring the live path's semantics exactly:
    // CC rewrites the same-uuid line as an assistant message grows, so
    // repeated uuids skip assistant-text (first write wins) while tool-use /
    // tool-result / turn-complete still emit (reducer Map.set absorbs them).
    // Without this, every re-dock/replay rendered duplicate text segments.
    const seenUuids = new Set<string>();
    // A tally of its own: a replay walks the file from the top, so sharing the
    // live tailer's in-flight tally would both double-count and reset it.
    const replayUsage = emptyTurnUsageTally();
    if (fs.existsSync(session.jsonlPath)) {
      let raw: string;
      try { raw = fs.readFileSync(session.jsonlPath, 'utf8'); }
      catch { raw = ''; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const parsed = parseTranscriptLine(line, desktopSessionId, replayUsage);
        if (parsed.length === 0) continue;
        const lineUuid = parsed[0].uuid;
        const isRepeat = !!lineUuid && seenUuids.has(lineUuid);
        if (lineUuid) seenUuids.add(lineUuid);
        for (const ev of parsed) {
          if (isRepeat && ev.type === 'assistant-text') continue;
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
        void this.readNewLines(session);
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
        void this.readNewLines(session);
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

  /**
   * Serialized entry point: one read runs per session at a time; any trigger
   * arriving mid-read (fs.watch fires multiple events per write on Windows,
   * the global poll and manual triggers overlap them) coalesces into a single
   * rerun. Without this, two overlapping invocations both computed
   * bytesToRead from the same stale offset — double-emitting every event in
   * the range — and worse: the read POSITION argument was re-evaluated after
   * the first invocation advanced the offset, so the second read could come
   * back short/empty while its zero-filled buffer was still decoded, wedging
   * NUL bytes into the partial-line carry and silently dropping the next
   * message at JSON.parse. (Root cause of "rare missing Claude message".)
   */
  private async readNewLines(session: WatchedSession): Promise<void> {
    if (session.reading) {
      session.rerunQueued = true;
      return;
    }
    session.reading = true;
    try {
      do {
        session.rerunQueued = false;
        await this.readNewLinesOnce(session);
      } while (session.rerunQueued);
    } catch (err) {
      // Never reject: all four call sites are fire-and-forget (fs.watch
      // callback, poll timer, startWatching, manual trigger), and the process
      // has no unhandledRejection handler — an EIO out of handle.read would
      // otherwise take down the main process under Node's default
      // --unhandled-rejections=throw. `reading` is cleared in the finally
      // below, so the next poll tick retries from the same offset.
      // eslint-disable-next-line no-console
      console.error('[TranscriptWatcher] read failed for', session.jsonlPath, err);
    } finally {
      session.reading = false;
    }
  }

  private async readNewLinesOnce(session: WatchedSession): Promise<void> {
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
      session.partialBytes = Buffer.alloc(0);
      this.emit('transcript-shrink', { sessionId: session.desktopSessionId, oldSize: oldOffset, newSize: fileSize });
      // Don't return — fall through and read from offset 0 if the file has content now
    }
    if (fileSize <= session.offset) return; // No new data

    const remaining = fileSize - session.offset;
    const bytesToRead = Math.min(remaining, MAX_TAIL_READ_BYTES);
    const buffer = Buffer.alloc(bytesToRead);

    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(session.jsonlPath, 'r');
    } catch {
      return;
    }

    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, bytesToRead, session.offset));
    } finally {
      await handle.close();
    }

    // Advance by what was ACTUALLY read, and never decode past it — a short
    // read must not stamp zero-fill from the untouched buffer tail into the
    // stream (the remainder is picked up by the next invocation).
    session.offset += bytesRead;
    if (bytesRead === 0) return;

    // Ask the serialized runner (readNewLines' do…while) for another pass only
    // when this pass made progress AND bytes remain past it (a capped or short
    // read). WHY only here, after a successful non-zero read: a failed open or
    // a 0-byte read makes no progress, so an immediate rerun would just repeat
    // the same stat+open as fast as the thread pool allows for as long as the
    // error lasts (EMFILE, or a Windows sharing violation during an antivirus
    // scan) — starving the 4 libuv threads that lease writes, transcript copies
    // and other reads share. Those failures wait for the next watch event or
    // poll tick instead, as they always did. Set BEFORE the "no complete line
    // yet" return below, because a capped read may end mid-line; the do…while
    // clears rerunQueued before each call, so a flag raised here is still
    // standing when the loop checks it after this pass returns.
    if (bytesRead < remaining) session.rerunQueued = true;

    // Stitch the byte carry-over BEFORE decoding so a multi-byte UTF-8 char
    // split across reads reassembles losslessly (decoding the halves
    // separately yields permanent U+FFFD replacement chars).
    const fresh = buffer.subarray(0, bytesRead);
    const combined = session.partialBytes.length
      ? Buffer.concat([session.partialBytes, fresh])
      : fresh;
    const lastNewline = combined.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      // No complete line yet — keep carrying bytes. Buffer.from copies so we
      // don't retain a view into the (potentially large) read buffer.
      session.partialBytes = Buffer.from(combined);
      return;
    }
    session.partialBytes = Buffer.from(combined.subarray(lastNewline + 1));

    const text = combined.subarray(0, lastNewline).toString('utf8');
    const chunks = text.split('\n');

    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;

      const events = parseTranscriptLine(trimmed, session.desktopSessionId, session.turnUsage);
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
      // - user-message: EMIT. NOTE: the reducer's dedup is the pending-flag
      //   scheme — a re-emit with no pending match APPENDS a duplicate
      //   bubble. Re-emitting is only safe because CC doesn't rewrite user
      //   lines in practice, and serialized reads (readNewLines) guarantee
      //   the same byte range is never read twice. Don't rely on the reducer
      //   to absorb duplicate user-message emits.
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
          // Event-driven kick: a subagent just started, so its JSONL is about
          // to appear — discover it now instead of waiting for the slow
          // safety-net dir poll.
          session.subagentWatcher.kickScan();
        }
        if (event.type === 'tool-result' && event.data.toolUseId) {
          // If this result completes a parent Agent tool call, that subagent
          // is done writing — settle its file poll (fire-and-forget; no-op
          // for non-Agent toolUseIds, fs.watch stays attached either way).
          void session.subagentWatcher.settleByParent(event.data.toolUseId);
        }
      }
    }
  }
}
