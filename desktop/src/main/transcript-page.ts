import * as fs from 'node:fs';
import { parseTranscriptLine, emptyTurnUsageTally } from './transcript-watcher';
import { SubagentIndex } from './subagent-index';
import { SubagentWatcher } from './subagent-watcher';
import type { PageCursor, TranscriptEvent, TranscriptPageResult } from '../shared/types';

/**
 * Paged conversation history (perf cycle 2).
 *
 * One job: given a transcript file and an optional end byte, return the LAST
 * <=PAGE_TURNS turns (<=PAGE_MAX_BYTES) that end before it, plus a cursor for
 * the page before that. Replaces "read the whole JSONL and replay it" on every
 * open/resume/re-dock, which cost ~22s on a huge conversation.
 *
 * The page is parsed with the SAME parseTranscriptLine the live tailer uses, so
 * a card rendered from history is byte-for-byte a card rendered live.
 */

/** User turns per page (Destin 2026-08-27). */
export const PAGE_TURNS = 30;
/** Hard byte cap per page; a turn-heavy page stops early (Destin 2026-08-27). */
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;

const NEWLINE = 0x0a;

export interface PageArgs {
  jsonlPath: string;
  sessionId: string;
  /** Read the turns ending strictly before this byte. null = end of file. */
  endOffset: number | null;
  /** `<transcriptDir>/<claudeSessionId>/subagents`. Omit for a session that has
   *  none (or in tests that do not care). */
  subagentsDir?: string;
  /** What the lines are. `claude` (default): Claude Code JSONL, parsed by the
   *  live tailer's parseTranscriptLine. `native`: a YouCoded assistant session
   *  file — a header line, then one TranscriptEvent per line, already in the
   *  shape the renderer takes. WHY here and not a second pager: the
   *  conversation preview (chatsearch-index/transcript-reader.ts) pages BOTH
   *  kinds from disk, and a second copy of the turn-boundary/byte-cap logic is
   *  exactly the kind of fork that made the old preview drift from the chat. */
  format?: 'claude' | 'native';
}

/**
 * True for a JSONL line that STARTS a user turn. Deliberately delegates to the
 * real parser rather than sniffing fields: a `tool_result` is also written as a
 * `type:"user"` line carrying a promptId, and snapping a page there would tear
 * a tool call away from its result. A line is a boundary exactly when the
 * parser would render it as the user's own message.
 */
function isTurnBoundary(line: string, sessionId: string, format: 'claude' | 'native'): boolean {
  if (format === 'native') return nativeLineEvents(line, sessionId)[0]?.type === 'user-message';
  // Cheap prefilter — the vast majority of lines are assistant lines.
  if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) return false;
  const parsed = parseTranscriptLine(line, sessionId);
  return parsed.length > 0 && parsed[0].type === 'user-message';
}

/** A native session line → its one event, re-keyed to `sessionId`, or nothing
 *  for the header (it has no `type`) and for junk. The same filter
 *  SessionStore.readEvents applies when a live native session replays. */
function nativeLineEvents(line: string, sessionId: string): TranscriptEvent[] {
  // Cheap prefilter, as above: only event lines carry a `type`.
  if (!line.includes('"type"')) return [];
  let e: any;
  try { e = JSON.parse(line); } catch { return []; }
  if (!e || typeof e !== 'object' || typeof e.type !== 'string' || !e.data || typeof e.data !== 'object') return [];
  return [{ ...e, sessionId } as TranscriptEvent];
}

interface ScannedLine { offset: number; text: string }

/**
 * Every complete line in [readFrom, end), with its absolute start offset.
 * When `readFrom > 0` we read one byte earlier so the first segment is
 * definitionally a partial (or empty) line and can be dropped without having to
 * guess whether the cut landed on a newline.
 *
 * WHY async (2026-09-24, blocking-call batch B1): this ran as one fs.readSync
 * of up to PAGE_MAX_BYTES on every conversation open, scroll-up and buddy open
 * — the main process serves every window, so each page froze all of them. The
 * read now goes through a FileHandle (only the needed byte range, never the
 * whole file); the newline scan uses Buffer.indexOf (native) instead of a JS
 * loop over every byte. Line boundaries and offsets are unchanged.
 */
async function readLines(handle: fs.promises.FileHandle, readFrom: number, end: number): Promise<ScannedLine[]> {
  const from = readFrom > 0 ? readFrom - 1 : 0;
  const span = end - from;
  if (span <= 0) return [];
  const buf = Buffer.alloc(span);
  // Loop until the range is filled: a positional read may return short. A
  // shortfall (file shrank under us) leaves zeros, exactly as the old single
  // readSync did, which the trailing-fragment rule below drops.
  let filled = 0;
  while (filled < span) {
    const { bytesRead } = await handle.read(buf, filled, span - filled, from + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  const lines: ScannedLine[] = [];
  let start = 0;
  for (let i = buf.indexOf(NEWLINE, start); i !== -1; i = buf.indexOf(NEWLINE, start)) {
    lines.push({ offset: from + start, text: buf.toString('utf8', start, i) });
    start = i + 1;
  }
  // A trailing fragment with no newline is an incomplete line (the tailer is
  // mid-write) — never parse it.
  if (from > 0) lines.shift();
  return lines;
}

/**
 * The last <=PAGE_TURNS turns (<=PAGE_MAX_BYTES) of `jsonlPath` ending before
 * `endOffset`.
 *
 * The whole scan window is bounded by PAGE_MAX_BYTES, so we read it in ONE
 * pread instead of walking backward chunk by chunk — 2 MB is nothing, and it
 * removes the chunk-edge offset arithmetic that is the easy place to be wrong.
 */
export async function readTranscriptPage(args: PageArgs): Promise<TranscriptPageResult> {
  const { jsonlPath, sessionId } = args;
  const format = args.format ?? 'claude';
  const empty: TranscriptPageResult = { events: [], cursor: null, hasMore: false };

  // WHY fs.promises (B1): this was `async` with no `await` — openSync/fstatSync
  // /readSync/closeSync all ran on the main thread. Same open-fail → empty page.
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(jsonlPath, 'r'); } catch { return empty; }

  try {
    const size = (await handle.stat()).size;
    // A cursor minted before a /clear or /compact rewrite points past the new
    // end. Treat it as "history is over" so the renderer drops the cursor
    // rather than serving turns from a file state the cursor never described —
    // the same way the live tailer resets on a shrink (transcript-watcher.ts).
    if (args.endOffset != null && args.endOffset > size) return empty;

    const end = args.endOffset == null ? size : Math.min(args.endOffset, size);
    if (end <= 0) return empty;

    // --- 1. Find the page's start byte ------------------------------------
    // Scan at most PAGE_MAX_BYTES back from `end`, counting user-prompt
    // boundaries. The start is the PAGE_TURNS-th boundary from the end; failing
    // that, the oldest boundary inside the byte budget; failing that (we saw the
    // whole remaining file), byte 0.
    const scanStart = Math.max(0, end - PAGE_MAX_BYTES);
    const lines = await readLines(handle, scanStart, end);
    const boundaries: number[] = []; // ascending absolute offsets
    for (const { offset, text } of lines) {
      if (!text.trim()) continue;
      if (isTurnBoundary(text, sessionId, format)) boundaries.push(offset);
    }

    let startByte: number;
    if (boundaries.length >= PAGE_TURNS) {
      startByte = boundaries[boundaries.length - PAGE_TURNS];
    } else if (scanStart === 0) {
      startByte = 0; // the whole remaining file is fewer than PAGE_TURNS turns
    } else {
      // Byte cap hit: start at the oldest boundary we saw, never mid-turn. With
      // no boundary at all in 2 MB (one colossal turn) fall back to the window
      // edge rather than returning nothing.
      startByte = boundaries.length ? boundaries[0] : scanStart;
    }
    const hasMore = startByte > 0;

    // --- 2. Parse [startByte, end) forward --------------------------------
    // Replay-side uuid dedup, mirroring the live tailer's semantics exactly:
    // CC rewrites the same-uuid line as an assistant message grows, so a
    // repeated uuid skips assistant-text (first write wins) while tool events
    // still emit.
    const events: TranscriptEvent[] = [];
    const seenUuids = new Set<string>();
    // One tally for the whole page, so a history turn reports the same summed
    // usage the live tailer would have reported for it. isTurnBoundary above
    // deliberately does NOT share it — that probe re-parses user lines and
    // would otherwise re-run this accounting on them.
    const pageUsage = emptyTurnUsageTally();
    for (const { offset, text } of lines) {
      if (offset < startByte) continue;
      const line = text.trim();
      if (!line) continue;
      const parsed = format === 'native' ? nativeLineEvents(line, sessionId) : parseTranscriptLine(line, sessionId, pageUsage);
      if (parsed.length === 0) continue;
      const lineUuid = parsed[0].uuid;
      const isRepeat = !!lineUuid && seenUuids.has(lineUuid);
      // A native line is one event with its own uuid; a repeat is a duplicate
      // write and is skipped whole — SessionStore.readEvents' rule.
      if (isRepeat && format === 'native') continue;
      if (lineUuid) seenUuids.add(lineUuid);
      for (const ev of parsed) {
        if (isRepeat && ev.type === 'assistant-text') continue;
        // Stamp the byte offset on user-message events only — the seed for a
        // future eviction cursor (cycle 3); harmless now.
        if (ev.type === 'user-message') ev.data.offset = offset;
        events.push(ev);
      }
    }

    // --- 3. Subagent files, ONLY for Agent tool_uses inside this page ------
    // A throwaway index primed with just the in-page parents: getHistory skips
    // any agent whose parent it cannot bind, so an older page's subagent
    // transcript is never dragged in. (TranscriptWatcher.getHistory, the
    // whole-transcript replay that used the same mechanism, was removed as dead
    // in blocking-call batch B1 — this is SubagentWatcher.getHistory's only
    // caller.)
    if (args.subagentsDir) {
      const replayIndex = new SubagentIndex();
      for (const ev of events) {
        if (ev.type === 'tool-use' && ev.data.toolName === 'Agent' && ev.data.toolUseId) {
          replayIndex.recordParentAgentToolUse(
            ev.data.toolUseId,
            (ev.data.toolInput?.description as string) || '',
            (ev.data.toolInput?.subagent_type as string) || '',
          );
        }
      }
      const watcher = new SubagentWatcher({
        sessionId,
        subagentsDir: args.subagentsDir,
        index: replayIndex,
        emit: () => { /* replay-only: this watcher never starts, so it never emits */ },
      });
      for (const ev of await watcher.getHistory(replayIndex)) events.push(ev);
    }

    const cursor: PageCursor | null = hasMore
      ? { path: jsonlPath, offset: startByte, sizeAtRead: size }
      : null;
    return { events, cursor, hasMore };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
