// Reads one PAGE of a past conversation for the preview pane, on both lanes.
// Keyed by id: the renderer never names a path. Main looks the id up in the
// index it wrote itself, prefers the local transcript, and falls back to the
// mirror the index recorded.
//
// The page itself comes from readTranscriptPage (transcript-page.ts) — the
// SAME reader a resumed chat pages its history with — so a preview holds the
// same events, and the renderer replays them through the same chat reducer.
// WHY (2026-09-16): this file used to flatten a conversation into plain
// user/assistant text with its own rules for which lines were "real", and
// dropped every tool call. Previews then showed background notes as the user's
// bubbles and "3 tools — not shown" where the chat draws a tool group. Destin
// asked for previews that look like the conversation will after it resumes;
// sharing the chat's reader is the only way that stays true.
//
// The read is bounded: a page is at most PAGE_TURNS turns and PAGE_MAX_BYTES,
// read off the END of the file, so a click on a 42 MB conversation reads 2 MB,
// not 42. "Older" is another page ending where this one began.
import fs from 'node:fs';
import path from 'node:path';
import type { ChatsearchReadRequest, ChatsearchReadResponse } from '../../shared/chatsearch-refs';
import { COPY, previewSessionKey } from '../../shared/chatsearch-refs';
import { readTranscriptPage } from '../transcript-page';

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUL = String.fromCharCode(0);
/** Enough for a native header line or Claude Code's first message line. */
const HEAD_BYTES = 64 * 1024;
const CACHE_MAX = 16;

/** The first line of `head` that parses, or null. */
function firstParsedLine(head: string, want: (v: any) => boolean): any {
  for (const l of head.split('\n')) {
    if (!l.trim() || l.includes(NUL)) continue;
    try {
      const v = JSON.parse(l);
      if (want(v)) return v;
    } catch { /* a line cut by the head window */ }
  }
  return null;
}

/** Is this native file a specialist's transcript rather than a conversation?
 *  The lane equivalent of a Claude sidechain: a specialist is spawned BY a
 *  conversation and reads as one on disk, but nobody ever talked to it. */
function isNativeSpecialist(head: string): boolean {
  const h = firstParsedLine(head, () => true);
  return !!h && typeof h === 'object' && (h.sessionKind === 'specialist' || !!h.parentSessionId);
}

/** Is this Claude Code file a subagent's own transcript (every message a
 *  sidechain)? Its first message line says so — a conversation's never does. */
function isClaudeSidechain(head: string): boolean {
  const m = firstParsedLine(head, (v) => !!v && !!v.uuid && (v.type === 'user' || v.type === 'assistant'));
  return !!m && m.isSidechain === true;
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

async function readHead(file: string, size: number): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, bytesRead);
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
  /** Answered pages, keyed by real path + mtime + size + where the page ends —
   *  so re-opening a conversation, or hovering then clicking it, reads nothing
   *  at all while the file is unchanged. */
  cache: Map<string, SliceCacheEntry>;
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

  const before = req.before === undefined ? null : Math.max(0, Math.floor(Number(req.before)) || 0);
  const key = `${chosen}|${st.mtimeMs}:${st.size}|${before ?? 'end'}`;
  const hit = deps.cache.get(key);
  if (hit) return hit;

  try {
    const head = await readHead(chosen, st.size);
    if (req.provider === 'native' ? isNativeSpecialist(head) : isClaudeSidechain(head)) {
      return { ok: false, error: COPY.errNotAConversation };
    }
    // Before byte 0 there is nothing: answer the empty first page rather than
    // letting `endOffset: 0` fall through to "read from the end".
    const page = before === 0
      ? { events: [], cursor: null, hasMore: false }
      : await readTranscriptPage({
        jsonlPath: chosen,
        sessionId: previewSessionKey(req.id),
        endOffset: before,
        format: req.provider,
        // Claude Code keeps a conversation's helper transcripts beside it, in
        // <id>/subagents — the same place the live pager looks
        // (transcript-page-source.ts), so a helper's card fills in here too.
        ...(req.provider === 'claude' ? { subagentsDir: path.join(path.dirname(chosen), req.id, 'subagents') } : {}),
      });
    const result: SliceCacheEntry = { ok: true, ...page };
    if (deps.cache.size >= CACHE_MAX) deps.cache.delete(deps.cache.keys().next().value as string);
    deps.cache.set(key, result);
    return result;
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
