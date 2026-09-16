// Reads a BOUNDED slice of a past conversation for the preview pane, on both
// lanes. Keyed by id: the renderer never names a path. Main looks the id up in
// the index it wrote itself, prefers the local transcript, and falls back to
// the mirror the index recorded.
//
// Deliberately NOT loadHistory (session-browser.ts): that keeps assistant text
// only where stop_reason === 'end_turn', which on a real 42 MB transcript
// discarded 1,135 of 1,405 assistant messages. A preview exists so someone can
// remember what was decided, and the deciding happens between the tool calls —
// so every assistant text block is kept, only tool activity is dropped, and
// the dropped calls are COUNTED so the pane can admit the gap instead of
// presenting an edited conversation as the whole one.
//
// Both the OUTPUT and the INPUT are bounded. This used to read and parse the
// WHOLE file to number the messages, and a click on a 42 MB conversation froze
// the main process — every live chat with it — for ~120 ms (measured
// 2026-09-11). It now reads backwards from the END of the file in growing
// chunks, the way the main chat's own history pager reads a window
// (transcript-page.ts), and stops as soon as it holds enough messages. Each
// chunk ends where the previous one began, so no byte is read or parsed twice.
// A message's `seq` is the byte offset of its line, so "Load older" is just
// another read ending at that offset.
import fs from 'node:fs';
import path from 'node:path';
import type { ChatsearchReadRequest, ChatsearchReadResponse, TranscriptMessage } from '../../shared/chatsearch-refs';
import { COPY, READ_TAIL_MAX } from '../../shared/chatsearch-refs';

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUL = String.fromCharCode(0);
const NEWLINE = 0x0a;

/** First chunk read off the end; each further chunk is ×4 the last. Forty
 *  messages of a tool-heavy real conversation took ~8.5 MB (2026-09-11), a
 *  chatty one far less — growing covers both without over-reading the small. */
export const FIRST_WINDOW_BYTES = 512 * 1024;
/** Enough for a native header line; the header is a few hundred bytes. */
const HEAD_BYTES = 64 * 1024;
const CACHE_MAX = 16;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

function toolUsesIn(content: unknown): number {
  return Array.isArray(content) ? content.filter((b: any) => b && b.type === 'tool_use').length : 0;
}

/** One JSONL line and the byte offset it starts at. */
interface ScannedLine { offset: number; text: string }
/** A line that parsed, and where it was. */
interface ParsedLine { offset: number; value: any }

/** Whole-text form, for callers that already hold the file. Offsets are BYTES,
 *  the same unit the chunked reader uses, so `seq` means one thing. */
function linesOf(text: string): ScannedLine[] {
  const out: ScannedLine[] = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    out.push({ offset, text: raw });
    offset += Buffer.byteLength(raw, 'utf8') + 1;
  }
  return out;
}

/** Complete lines in `buf`, which starts at byte `from` of the file. When
 *  `from > 0` the caller read one byte early, so the first segment is a partial
 *  (or empty) line by construction and is dropped — same trick as
 *  transcript-page.ts, which avoids guessing whether the cut hit a newline. */
function scanLines(buf: Buffer, from: number): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let start = 0;
  for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, start)) {
    lines.push({ offset: from + start, text: buf.toString('utf8', start, i) });
    start = i + 1;
  }
  // A fragment after the last newline is the file's final line (or a torn
  // write, which JSON.parse rejects below).
  if (start < buf.length) lines.push({ offset: from + start, text: buf.toString('utf8', start) });
  if (from > 0) lines.shift();
  return lines;
}

function parseLines(lines: ScannedLine[]): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const l of lines) {
    // Null-byte lines are NTFS pre-allocation gaps left by a killed process,
    // not data — a JSON.parse of one throws and would look like corruption.
    if (!l.text.trim() || l.text.includes(NUL)) continue;
    try { out.push({ offset: l.offset, value: JSON.parse(l.text) }); } catch { /* torn line at the tail of a file being written */ }
  }
  return out;
}

function claudeMessages(parsed: ParsedLine[]): { messages: TranscriptMessage[]; allSidechain: boolean } {
  // Last occurrence wins — loadHistory's rule — but a message keeps the offset
  // of its FIRST occurrence, so it stays where it first appeared and paging
  // before that offset can never return it again.
  const byUuid = new Map<string, { p: any; offset: number }>();
  for (const { offset, value: p } of parsed) {
    if (p && p.uuid && (p.type === 'user' || p.type === 'assistant')) {
      byUuid.set(p.uuid, { p, offset: byUuid.get(p.uuid)?.offset ?? offset });
    }
  }
  const out: TranscriptMessage[] = [];
  let dropped = 0, seen = 0, sidechain = 0;
  for (const { p, offset } of byUuid.values()) {
    seen++;
    if (p.isSidechain) sidechain++;
    const m = p.message;
    if (!m) continue;
    if (p.type === 'user') {
      // No promptId means the line is a tool result wearing the user role, not
      // something a person typed; isMeta lines are the harness talking to itself.
      if (p.isMeta || !p.promptId) continue;
      const t = textOf(m.content).trim();
      if (!t) continue;
      out.push({ role: 'user', content: t, timestamp: Date.parse(p.timestamp) || 0, seq: offset, droppedToolCalls: dropped });
      dropped = 0;
    } else {
      // Push this message's TEXT first — it closes the gap that came before it
      // — and only THEN count its own tool calls toward the gap before the
      // next message. The other order attributes a message's own tool calls to
      // itself, which reads as "3 tools not shown" above text that preceded them.
      const t = textOf(m.content).trim();
      if (t) {
        out.push({ role: 'assistant', content: t, timestamp: Date.parse(p.timestamp) || 0, seq: offset, droppedToolCalls: dropped });
        dropped = 0;
      }
      dropped += toolUsesIn(m.content);
    }
  }
  return { messages: out, allSidechain: seen > 0 && sidechain === seen };
}

function nativeMessages(parsed: ParsedLine[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let dropped = 0;
  for (const { offset, value: ev } of parsed) {
    if (!ev || typeof ev.type !== 'string') continue; // the header line has no type
    if (ev.type === 'tool-use') { dropped += 1; continue; }
    if (ev.type !== 'user-message' && ev.type !== 'assistant-text') continue;
    const t = typeof ev.data?.text === 'string' ? ev.data.text.trim() : '';
    if (!t) continue;
    out.push({
      role: ev.type === 'user-message' ? 'user' : 'assistant',
      content: t, timestamp: Number(ev.timestamp) || 0, seq: offset, droppedToolCalls: dropped,
    });
    dropped = 0;
  }
  return out;
}

/** Claude Code JSONL → messages (+ whether every line was a subagent sidechain). */
export function parseClaudeTranscript(text: string): { messages: TranscriptMessage[]; allSidechain: boolean } {
  return claudeMessages(parseLines(linesOf(text)));
}

/** Native session JSONL (header line + TranscriptEvent lines) → messages. */
export function parseNativeTranscript(text: string): TranscriptMessage[] {
  return nativeMessages(parseLines(linesOf(text)));
}

/** Is this native file a specialist's transcript rather than a conversation?
 *  The lane equivalent of a Claude sidechain: a specialist is spawned BY a
 *  conversation and reads as one on disk, but nobody ever talked to it. */
function isNativeSpecialist(head: string): boolean {
  const first = head.split('\n').find((l) => l.trim() && !l.includes(NUL));
  if (!first) return false;
  try {
    const h = JSON.parse(first);
    return !!h && typeof h === 'object' && (h.sessionKind === 'specialist' || !!h.parentSessionId);
  } catch {
    return false;
  }
}

/** realpath the candidate and require it under one of the roots, with a
 *  trailing separator so `root-evil/` cannot pass as being under `root`.
 *  Null means refuse — realpath is what catches a symlink pointing out. */
export async function containedTranscriptPath(candidate: string, roots: string[]): Promise<string | null> {
  let real: string;
  try { real = await fs.promises.realpath(candidate); } catch { return null; }
  for (const root of roots) {
    let realRoot: string;
    try { realRoot = await fs.promises.realpath(root); } catch { continue; }
    if (real.startsWith(realRoot + path.sep)) return real;
  }
  return null;
}

const isSubagentPath = (p: string) => p.split(/[\\/]/).includes('subagents');

async function readRangeFromDisk(file: string, start: number, end: number): Promise<Buffer> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return got === buf.length ? buf : buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}

export type SliceCacheEntry = Extract<ChatsearchReadResponse, { ok: true }>;

type Entry = { transcriptPath: string; tombstone: boolean };
type MaybeAsync<T> = T | Promise<T>;

export interface ReadDeps {
  entryFor: (provider: 'claude' | 'native', id: string) => MaybeAsync<Entry | null>;
  localPathFor: (provider: 'claude' | 'native', id: string) => MaybeAsync<string | null>;
  /** Legal roots, resolved at call time — the space root is user-configurable. */
  roots: string[];
  /** Answered slices, keyed by real path + mtime + size + where the slice ends
   *  + how many — so re-opening a conversation, or hovering then clicking it,
   *  reads nothing at all while the file is unchanged. */
  cache: Map<string, SliceCacheEntry>;
  /** Seams for tests: observe the byte ranges read, or shrink the first chunk. */
  readRange?: (file: string, start: number, end: number) => Promise<Buffer>;
  firstWindowBytes?: number;
}

export async function readTranscriptSlice(req: ChatsearchReadRequest, deps: ReadDeps): Promise<ChatsearchReadResponse> {
  if (!SESSION_UUID_RE.test(req.id)) return { ok: false, error: COPY.errNotAnId };
  const entry = await deps.entryFor(req.provider, req.id);
  if (!entry) return { ok: false, error: COPY.errNotIndexed };
  if (entry.tombstone) return { ok: false, error: COPY.previewTombstone };
  // Local first (authoritative and current), then the mirror the index recorded.
  const candidates = [await deps.localPathFor(req.provider, req.id), entry.transcriptPath].filter((p): p is string => !!p);
  let chosen: string | null = null;
  for (const c of candidates) {
    if (isSubagentPath(c)) return { ok: false, error: COPY.errNotAConversation };
    const contained = await containedTranscriptPath(c, deps.roots);
    if (contained) { chosen = contained; break; }
    // A path that EXISTS but sits outside every root is a refusal, not a
    // fall-through: saying "not found" would be a lie about why.
    if (await fs.promises.access(c).then(() => true, () => false)) return { ok: false, error: COPY.errOutsideRoots };
  }
  if (!chosen) {
    try { await fs.promises.stat(entry.transcriptPath); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    return { ok: false, error: COPY.errOutsideRoots };
  }
  let st: fs.Stats;
  try { st = await fs.promises.stat(chosen); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }

  const n = Math.min(Math.max(1, Math.floor(req.tail) || 1), READ_TAIL_MAX);
  const end = req.before === undefined ? st.size : Math.max(0, Math.min(Math.floor(req.before) || 0, st.size));
  const key = `${chosen}|${st.mtimeMs}:${st.size}|${end}|${n}`;
  const hit = deps.cache.get(key);
  if (hit) return hit;

  const read = deps.readRange ?? readRangeFromDisk;
  try {
    if (req.provider === 'native' && isNativeSpecialist((await read(chosen, 0, Math.min(HEAD_BYTES, st.size))).toString('utf8'))) {
      return { ok: false, error: COPY.errNotAConversation };
    }
    // `parsed` holds every line in [cursor, end), in file order. Each chunk ends
    // at `cursor` — the start of the oldest complete line already held — so
    // lines are read and parsed exactly once however far back this has to go.
    let parsed: ParsedLine[] = [];
    let cursor = end;
    let result: SliceCacheEntry = { ok: true, messages: [], hasMore: false };
    for (let span = deps.firstWindowBytes ?? FIRST_WINDOW_BYTES; cursor > 0; span *= 4) {
      const windowStart = Math.max(0, cursor - span);
      const from = windowStart > 0 ? windowStart - 1 : 0;
      const lines = scanLines(await read(chosen, from, cursor), from);
      // No complete line in this chunk (one line longer than it): leave the
      // cursor where it is and read a bigger chunk.
      if (from > 0 && !lines.length) continue;
      parsed = parseLines(lines).concat(parsed);
      cursor = from === 0 ? 0 : lines[0].offset;
      let messages: TranscriptMessage[];
      if (req.provider === 'native') {
        messages = nativeMessages(parsed);
      } else {
        const r = claudeMessages(parsed);
        if (r.allSidechain) return { ok: false, error: COPY.errNotAConversation };
        messages = r.messages;
      }
      // The oldest message held has an unknown gap before it unless the read
      // reached the start of the file — the tool calls that closed that gap may
      // be just before the cursor. Never show that count: drop the message and
      // let the next chunk (or "Load older") supply it with its real count.
      const atStart = cursor === 0;
      const honest = atStart ? messages : messages.slice(1);
      if (honest.length >= n || atStart) {
        result = { ok: true, messages: honest.slice(-n), hasMore: !atStart || honest.length > n };
        break;
      }
    }
    if (deps.cache.size >= CACHE_MAX) deps.cache.delete(deps.cache.keys().next().value as string);
    deps.cache.set(key, result);
    return result;
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
