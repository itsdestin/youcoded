import fs from 'fs';
import path from 'path';
import os from 'os';
import { PastSession, HistoryMessage, SessionFlagName } from '../shared/types';
import { isPlaceholderModelId } from '../shared/model-ids';
// ccProjectSlug drive-normalizes before slugifying, so a store originalPath with
// a lowercase Windows drive still maps to CC's uppercase-drive project dir.
// nativeStoreSlug is the FROZEN app-private rule for native rows (deliberately
// NOT ccProjectSlug — see harness/session-store.ts's slug-divergence comment).
// Both live on slug-encoding.ts; ipc-handlers.ts imports from there too.
import { ccProjectSlug, nativeStoreSlug, CC_SLUG_MAX } from './slug-encoding';
import type { NativeSessionListEntry } from './harness/session-store';
import { r1CwdForDir } from './transcript-cwd';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TOPICS_DIR = path.join(CLAUDE_DIR, 'topics');
const CONVERSATION_INDEX_PATH = path.join(CLAUDE_DIR, 'conversation-index.json');
// Mirrors NativeHome's sessionFilePath() convention (~/.youcoded/sessions/
// <slug>/<id>.jsonl) — captured at module load like CLAUDE_DIR above, which is
// why tests reset modules + re-stub os.homedir() before each listPastSessions
// call (see session-browser.test.ts).
const NATIVE_SESSIONS_DIR = path.join(os.homedir(), '.youcoded', 'sessions');

// WHY: fs.existsSync blocks the main thread; access() answers the same question off it.
const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);

/** The on-disk path for a native session's transcript on THIS device — the
 *  probe listPastSessions uses to decide notSyncedYet for a native row. */
function nativeJsonlPath(cwd: string, sessionId: string): string {
  return path.join(NATIVE_SESSIONS_DIR, nativeStoreSlug(cwd), `${sessionId}.jsonl`);
}

/** Read per-session metadata from conversation-index.json: the user-set flag
 *  map AND the topic (display name). Lifts v1 legacy `complete` into the flags
 *  shape so older entries still show up.
 *
 *  As of Plan 2c the conversation index is FROZEN (read-only) — the Conversation
 *  Store is now the durable, cross-device name/flag store. This read path stays
 *  purely for residual legacy-only rows that predate the store: it holds whatever
 *  topics/flags were written before the index was frozen. The `topics/topic-<id>`
 *  files are the *ephemeral* store — pruned by the auto-title hook and never
 *  synced. The Resume Browser reads the topic file first and falls back to this
 *  frozen index here when the file is gone (see readTopic), then the store
 *  overlay in listPastSessions wins over both for store-backed rows. */
// WHY (perf/main-thread-async-reads, Task 2): this ran on fs.readFileSync,
// blocking main once per browse. listPastSessions already awaits it below.
async function readIndexMeta(): Promise<{
  flags: Record<string, Record<string, boolean>>;
  topics: Record<string, string>;
}> {
  const flags: Record<string, Record<string, boolean>> = {};
  const topics: Record<string, string> = {};
  try {
    const raw = await fs.promises.readFile(CONVERSATION_INDEX_PATH, 'utf8');
    const index = JSON.parse(raw);
    for (const [sid, entry] of Object.entries<any>(index?.sessions || {})) {
      if (!entry) continue;
      const on: Record<string, boolean> = {};
      for (const [name, state] of Object.entries<any>(entry.flags || {})) {
        if (state?.value) on[name] = true;
      }
      // v1 legacy — tolerated on read until old devices are upgraded.
      if (!on.complete && entry.complete) on.complete = true;
      if (Object.keys(on).length > 0) flags[sid] = on;
      if (typeof entry.topic === 'string' && entry.topic.trim()) {
        topics[sid] = entry.topic.trim();
      }
    }
  } catch { /* index missing/corrupt — no flags or topic fallback available */ }
  return { flags, topics };
}

// Pure: turn a store record's flag map + note into the PastSession-facing shape.
// Reserved flags stay booleans; `tag:<id>` keys become the tags[] list; unknown
// flags (including retired `helpful`) are ignored. Exported for unit testing.
export function extractStoreMeta(rec: { flags: Record<string, { value: boolean }>; note?: string }): {
  flags: Partial<Record<SessionFlagName, boolean>>;
  tags: string[];
  note?: string;
} {
  const flags: Partial<Record<SessionFlagName, boolean>> = {};
  const tags: string[] = [];
  for (const [k, v] of Object.entries(rec.flags || {})) {
    if (!v?.value) continue;
    if (k === 'complete' || k === 'priority') flags[k] = true;
    else if (k.startsWith('tag:')) tags.push(k.slice(4));
  }
  return { flags, tags, ...(rec.note ? { note: rec.note } : {}) };
}

// Exported so remote-server.ts can validate client-supplied session ids with
// the SAME guard loadHistory enforces below — a second hand-copied regex
// could silently drift.
export const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Retry an async operation up to `attempts` times with a short delay between tries. */
async function withRetry<T>(fn: () => Promise<T>, attempts: number = 3, delayMs: number = 100): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

/**
 * Resolves a project slug back to a real filesystem path via an inversion
 * chain (spec §5.4a), each option evidence-stronger than the naive split:
 *   1. R1 — the recorded cwd from the slug dir's own transcripts. Exact, not
 *      inferential, and the ONLY option that still works above CC_SLUG_MAX
 *      (a capped slug's suffix is a hash of the ORIGINAL path, not more of
 *      the path itself, so nothing filesystem-side can recover it).
 *   2. forwardResolveSlug — walk the filesystem forward, re-slugging real
 *      child directories and comparing, instead of guessing where the
 *      original separators were.
 *   3. walkSlugParts — legacy longest-first split, kept last so folders that
 *      already resolved correctly keep resolving identically.
 */
// WHY (perf/main-thread-async-reads, Task 2): resolveSlugToPath and its three
// helpers below ran on fs.*Sync — called ONCE PER PROJECT SLUG on every
// Resume Browser open, so a big ~/.claude/projects tree froze the main
// thread for the whole scan. listPastSessions's one call site now awaits.
async function resolveSlugToPath(slug: string): Promise<string> {
  const recorded = await r1CwdForDir(path.join(PROJECTS_DIR, slug));
  if (recorded) return recorded;

  const forward = await forwardResolveSlug(slug);
  if (forward) return forward;

  let root: string;
  let parts: string[];

  if (/^[A-Z]--/.test(slug)) {
    // Windows: C--Users-alice-project → root=C:\, parts=[Users, alice, project]
    root = slug[0] + ':\\';
    parts = slug.slice(3).split('-').filter(Boolean);
  } else {
    // Unix: -home-user-project → root=/, parts=[home, user, project]
    root = '/';
    parts = slug.slice(1).split('-').filter(Boolean);
  }

  if (parts.length === 0) return root;
  return await walkSlugParts(root, parts);
}

/**
 * Recursively resolves slug dash-segments against the filesystem, preferring the
 * LONGEST leading segment that exists as a directory.
 *
 * WHY longest-first: a slug can't distinguish a path separator from a hyphen
 * that's part of a folder's own name — `C--Users-desti-youcoded-dev` could mean
 * `…\desti\youcoded-dev` OR `…\desti\youcoded\dev`. The old walk tried the
 * SHORTEST segment first, so whenever a sibling `youcoded` directory also existed
 * it greedily descended into `…\youcoded\dev` (which doesn't exist) instead of
 * the real `…\youcoded-dev`. resolveSlugToPath then returned a nonexistent path,
 * and resume fell back to $HOME (sessions "resumed from the home directory").
 * Trying the longest existing segment first picks the real hyphenated folder.
 * Exported for unit testing. Fix 2026-07-12 (two-device dogfood).
 */
export async function walkSlugParts(base: string, parts: string[]): Promise<string> {
  for (let len = parts.length; len >= 1; len--) {
    const segment = parts.slice(0, len).join('-');
    const candidate = path.join(base, segment);
    // WHY: a single stat() replaces the existsSync+statSync pair — one fewer
    // disk round trip, and the "not there" case (ENOENT) is indistinguishable
    // from "not a directory" for this walk's purposes, so both collapse to null.
    const st = await fs.promises.stat(candidate).catch(() => null);
    const isDir = !!st && st.isDirectory();
    if (isDir) {
      return len === parts.length ? candidate : walkSlugParts(candidate, parts.slice(len));
    }
  }
  // Nothing at this level exists on disk — best-guess naive join (unchanged).
  return path.join(base, parts.join('-'));
}

/** Option 2 (spec §5.4a): FORWARD re-slug of on-disk candidates. Splitting a
 *  slug cannot recover ','/'&'/' ' (all collapse to '-'); slugging real child
 *  dirs forward and prefix-matching can. Longest-encoding-first WITH
 *  BACKTRACKING — a per-level match can dead-end levels down (siblings `a`
 *  vs `a-b`, the 57be5e14 shape), so unwind and try the next candidate.
 *  DECLINES (null) on a capped slug: past 200 chars the slug carries ZERO
 *  path information, and "search every descendant and hash each" is not a
 *  confirmation step. Capped slugs are option 1's (recorded cwd) or nothing. */
export async function forwardResolveSlug(
  slug: string,
  rootsOverride?: { posixRoot?: string; winRoot?: string },
): Promise<string | null> {
  if (slug.length > CC_SLUG_MAX && slug[CC_SLUG_MAX] === '-') return null; // capped — decline
  let base: string; let rest: string;
  if (/^[A-Z]--/.test(slug)) {
    base = rootsOverride?.winRoot ?? (slug[0] + ':\\');
    rest = slug.slice(3);
  } else if (slug.startsWith('-')) {
    base = rootsOverride?.posixRoot ?? '/';
    rest = slug.slice(1);
  } else return null;
  const found = await walkForward(base, rest);
  if (!found) return null;
  // Terminal confirmation: the WHOLE candidate must re-slug to the WHOLE slug
  // (lowercased — Windows folder-case drift tolerance, same as buildSlugToName).
  return ccProjectSlug(found).toLowerCase() === slug.toLowerCase() ? found : null;
}

async function walkForward(dir: string, rest: string): Promise<string | null> {
  if (rest === '') return dir;
  let entries: fs.Dirent[] = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return null; }
  const candidates = entries
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, enc: e.name.replace(/[^a-zA-Z0-9]/g, '-') }))
    .filter(c => c.enc.length > 0 && (rest === c.enc || rest.startsWith(c.enc + '-')))
    .sort((a, b) => b.enc.length - a.enc.length);   // longest-first, then backtrack
  for (const c of candidates) {
    const remaining = rest === c.enc ? '' : rest.slice(c.enc.length + 1);
    const hit = await walkForward(path.join(dir, c.name), remaining);
    if (hit) return hit;
  }
  return null;
}

/** Resolve a session's display name. The auto-title hook writes
 *  `topics/topic-<id>`, but those files are pruned (30-day) and never sync
 *  across devices — so when the file is missing, or still holds the pre-title
 *  "New Session" placeholder, fall back to the conversation index, which keeps
 *  the name longer and is synced. Without this fallback the Resume Browser
 *  showed "Untitled" for every session whose topic file had been pruned. */
async function readTopic(sessionId: string, indexTopics: Record<string, string>): Promise<string> {
  try {
    const content = (await fs.promises.readFile(path.join(TOPICS_DIR, `topic-${sessionId}`), 'utf8')).trim();
    // 'Untitled' in a file is a placeholder too (older clients synced such
    // files) — treating it as a real name would bypass the index fallback
    // AND the transcript-derived title, so reject it like 'New Session'.
    if (content && content !== 'New Session' && content !== 'Untitled') return content;
  } catch { /* topic file pruned or never written — fall through to the index */ }
  const indexed = indexTopics[sessionId];
  if (indexed && indexed !== 'New Session' && indexed !== 'Untitled') return indexed;
  return 'Untitled';
}

// Bounded reads so a 100MB transcript doesn't blow up the browse call.
const HEAD_CHUNK_BYTES = 256 * 1024;
const TAIL_CHUNK_BYTES = 64 * 1024;
const FALLBACK_TITLE_MAX = 48;

export interface SessionTranscriptMeta {
  /** Title derived from the first real user prompt, or null. */
  fallbackTitle: string | null;
  /** Timestamp (ms) of the last parseable transcript line, or null. */
  lastTimestampMs: number | null;
  /**
   * `message.model` from the last assistant line in the tail chunk that names a
   * REAL model — CC's `<synthetic>` placeholder lines are skipped — or null.
   *
   * This is how a CLAUDE CODE conversation gets a lastUsedModel at all. The
   * native side records one at bind time (conversations/service.ts
   * noteModelUsed), but CC has no binding to resolve — the model only exists as
   * a field on each assistant message in the transcript. Null when the tail
   * chunk holds no assistant line with a model, which a long run of tool
   * results can cause; the chunk is deliberately NOT grown to chase it, because
   * this runs once per transcript on every browse. Measured 2026-08-26 over 755
   * local transcripts: 39 hold no real model in the 64KB tail, and quadrupling
   * the read to 256KB recovers only 2 of them — not worth 4x the IO per browse.
   */
  lastModelId: string | null;
}

/** Collapse whitespace and trim a derived title to a word boundary. */
function cleanTitle(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (collapsed.length <= FALLBACK_TITLE_MAX) return collapsed;
  const cut = collapsed.slice(0, FALLBACK_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  // Trim back to the last word boundary, but only when that leaves a
  // reasonable stub (>20 chars) — otherwise a long first word would shrink
  // the title to almost nothing, so we hard-cut mid-word instead.
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '…';
}

/**
 * Derive display metadata straight from the transcript JSONL.
 *
 * WHY: the topic/index naming pipeline has gaps (the auto-title hook only
 * fires on PostToolUse, so chat-only sessions are never titled; titles also
 * depend on the in-session model complying), and file mtimes are clobbered
 * by sync restores. The transcript content itself is the only source of
 * truth that survives both. See docs/PITFALLS.md → Resume Browser.
 *
 * CC-coupled: relies on the transcript JSONL line shape (`type`, `isMeta`,
 * `promptId`, `timestamp`, `message.content`) — same contract the
 * transcript-watcher parses. See youcoded/docs/cc-dependencies.md.
 */
export async function readSessionTranscriptMeta(jsonlPath: string, wantTitle: boolean): Promise<SessionTranscriptMeta> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(jsonlPath, 'r');
    const { size } = await fh.stat();

    // --- Tail: last parseable line's timestamp, and the last model used ---
    let lastTimestampMs: number | null = null;
    let lastModelId: string | null = null;
    const tailLen = Math.min(TAIL_CHUNK_BYTES, size);
    if (tailLen > 0) {
      const tailBuf = Buffer.alloc(tailLen);
      await fh.read(tailBuf, 0, tailLen, size - tailLen);
      // First "line" of the chunk is usually a partial JSON line — the
      // backwards scan just skips anything that doesn't parse.
      const tailLines = tailBuf.toString('utf8').split('\n');
      // Both values come from the SAME backwards pass over the SAME buffer, so
      // reading the model costs no extra IO — the tail was already being read
      // for the timestamp. The loop now runs until BOTH are found (or the chunk
      // is exhausted) instead of breaking on the first timestamp: the last line
      // is usually a tool result, and the assistant line carrying the model can
      // be several entries further back.
      for (let i = tailLines.length - 1; i >= 0; i--) {
        if (lastTimestampMs !== null && lastModelId !== null) break;
        const line = tailLines[i];
        if (!line.trim() || line.includes('\x00')) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; } // partial/corrupt
        if (lastTimestampMs === null) {
          const ts = Date.parse(parsed.timestamp);
          if (!Number.isNaN(ts)) lastTimestampMs = ts;
        }
        // Fix: skip Claude Code's own placeholder ids. CC stamps
        // `"model": "<synthetic>"` on assistant lines IT generated rather than
        // a model — "You've hit your session limit", "You're out of usage
        // credits", "Please run /login · API Error: 401". Those are almost
        // always the LAST assistant lines in a transcript, so taking the first
        // one found labelled a 308-turn Opus session `<synthetic>`. Any
        // `<...>`-wrapped id is treated the same way: CC brackets its
        // placeholders, and a real model id never has that shape. The scan
        // keeps walking backwards for a real id and settles for null if the
        // chunk holds none — the pre-existing "no model recorded" case, which
        // renders no chip rather than a wrong one.
        if (lastModelId === null && parsed.type === 'assistant'
            && typeof parsed.message?.model === 'string'
            && !isPlaceholderModelId(parsed.message.model)) {
          lastModelId = parsed.message.model;
        }
      }
    }

    // --- Head: first real user prompt → fallback title ---
    let fallbackTitle: string | null = null;
    if (wantTitle) {
      const headLen = Math.min(HEAD_CHUNK_BYTES, size);
      const headBuf = Buffer.alloc(headLen);
      await fh.read(headBuf, 0, headLen, 0);
      for (const line of headBuf.toString('utf8').split('\n')) {
        if (!line.trim() || line.includes('\x00')) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        // Same "real conversational prompt" gate as loadHistory: user-type,
        // has promptId, not meta.
        if (parsed.type !== 'user' || parsed.isMeta || !parsed.promptId || !parsed.message) continue;
        const c = parsed.message.content;
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            : '';
        // Skip injected wrappers (<command-name>…, <local-command-stdout>…,
        // <system-reminder>…) — they're plumbing, not what the user said.
        // Deliberately lossy: a real prompt that starts with '<' (pasted
        // HTML/XML) is also skipped, and the scan moves to the next prompt.
        if (!text.trim() || text.trim().startsWith('<')) continue;
        fallbackTitle = cleanTitle(text);
        if (fallbackTitle) break;
      }
    }

    return { fallbackTitle, lastTimestampMs, lastModelId };
  } catch {
    return { fallbackTitle: null, lastTimestampMs: null, lastModelId: null };
  } finally {
    try { await fh?.close(); } catch {}
  }
}

/**
 * Scans all project directories for JSONL transcript files.
 * Returns sessions sorted by last modified (most recent first).
 * Excludes sessions that are currently active (matching activeSessionIds).
 * Uses async I/O with Promise.all for parallelism.
 *
 * `nativeEntries` (Task 5) is NativeSessionHost.list()'s output — passed in
 * rather than read from disk here so NativeSessionHost stays the one source of
 * truth for what native sessions exist. Native rows join the SAME store-overlay
 * enrichment pass CC rows get below (title/flags/tags/note/device precedence,
 * lastUsedModel), instead of being bare-concatenated by the caller afterward
 * (the pre-Task-5 shape, which meant a native session's tags/note/flags never
 * showed up in the Resume Browser even after Task 4 started persisting them).
 */
export async function listPastSessions(
  activeSessionIds?: Set<string>,
  nativeEntries?: (NativeSessionListEntry & { provider: 'native' })[],
  // Injectable ONLY so subagent-exclusion.test.ts can point the scan at a temp
  // tree. Production callers pass nothing and get the real projects folder.
  projectsDir: string = PROJECTS_DIR,
): Promise<PastSession[]> {
  let slugs: string[];
  try {
    const entries = await withRetry(() => fs.promises.readdir(projectsDir));
    const statResults = await Promise.all(
      entries.map(async (f) => {
        try {
          const stat = await withRetry(() => fs.promises.stat(path.join(projectsDir, f)));
          return stat.isDirectory() ? f : null;
        } catch { return null; }
      })
    );
    slugs = statResults.filter((s): s is string => s !== null);
  } catch (err) {
    // A missing/unreadable projects dir is NORMAL on a fresh secondary device
    // (store synced, but no local CC transcripts written here yet). Degrade to
    // an empty legacy scan and fall through to the store union below — remote
    // conversations must still appear so they're visible "everywhere". (Phase 2a)
    console.warn('[session-browser] Failed to read projects directory:', err);
    slugs = [];
  }

  // Join flag + topic metadata from the synced conversation index
  const indexMeta = await readIndexMeta();

  const allSessions: PastSession[] = [];

  for (const slug of slugs) {
    const slugDir = path.join(projectsDir, slug);
    let files: string[];
    try {
      files = (await withRetry(() => fs.promises.readdir(slugDir))).filter((f) => f.endsWith('.jsonl'));
    } catch (err) {
      console.warn(`[session-browser] Failed to read slug dir ${slug} after retries:`, err);
      continue;
    }

    // Fix (final review, IMPORTANT 3): resolve once per slug DIRECTORY, not
    // once per file inside it. resolveSlugToPath can fall through to R1's
    // tier-2 whole-file scan (transcript-cwd.ts), which reads every
    // top-level transcript in the dir — invoking it per-file inside
    // files.map turned that into an N×N full-file-read multiplier on
    // foreign-heavy directories, on the Resume Browser's hot path.
    const projectPath = await resolveSlugToPath(slug);

    const sessionPromises = files.map(async (file) => {
      const sessionId = file.replace('.jsonl', '');
      if (activeSessionIds?.has(sessionId)) return null;

      try {
        const stat = await withRetry(() => fs.promises.stat(path.join(slugDir, file)));
        if (stat.size < 500) return null;
        const topicName = await readTopic(sessionId, indexMeta.topics);

        // Transcript-derived metadata: content timestamp beats file mtime
        // (sync restores clobber mtimes), and the first user message names
        // sessions the title pipeline missed. readSessionTranscriptMeta returns
        // nulls on any failure, so this can only improve on the defaults.
        const meta = await readSessionTranscriptMeta(path.join(slugDir, file), topicName === 'Untitled');
        const name = topicName !== 'Untitled'
          ? topicName
          : (meta.fallbackTitle ?? 'Untitled');

        // Filter a stale legacy `helpful` (retired in Task 8) so it never reaches
        // the renderer. Collapse an empty result back to undefined to preserve the
        // "only attach flags when present" behavior below (an empty {} is truthy).
        const rawFlags = indexMeta.flags[sessionId];
        const filtered = rawFlags
          ? Object.fromEntries(Object.entries(rawFlags).filter(([k]) => k === 'complete' || k === 'priority'))
          : undefined;
        const joinedFlags = filtered && Object.keys(filtered).length ? filtered : undefined;
        return {
          sessionId,
          name,
          projectSlug: slug,
          projectPath,
          lastModified: meta.lastTimestampMs ?? stat.mtimeMs,
          size: stat.size,
          ...(joinedFlags ? { flags: joinedFlags } : {}),
          // Model chip on the Resume Browser card. providerType is the literal
          // 'claude-code' rather than one of the native provider types, which
          // matters: ModelPicker's resume prefill matches providerType+modelId
          // against the LOCAL native catalog, and this must never match there.
          // A CC session resumes on an alias, not on a provider binding.
          //
          // The store overlay below runs AFTER this and re-assigns
          // lastUsedModel when the record has one, so a synced record still
          // wins — this only fills the gap the store leaves for CC rows.
          ...(meta.lastModelId
            ? { lastUsedModel: { modelId: meta.lastModelId, providerType: 'claude-code', providerLabel: 'Claude Code' } }
            : {}),
        } as PastSession;
      } catch {
        console.warn(`[session-browser] Failed to stat ${slug}/${file} after retries`);
        return null;
      }
    });

    const results = await Promise.all(sessionPromises);
    allSessions.push(...results.filter((s): s is PastSession => s !== null));
  }

  // Deduplicate: aggregation symlinks/copies place project-specific .jsonl
  // files into the home slug for unified browsing. When the same sessionId
  // appears in both the home slug and a project slug, keep the project slug
  // entry so resume uses the correct working directory.
  const deduped = new Map<string, PastSession>();
  for (const s of allSessions) {
    const existing = deduped.get(s.sessionId);
    if (!existing || s.projectSlug.length > existing.projectSlug.length) {
      deduped.set(s.sessionId, s);
    }
  }

  // Task 5: fold native rows into the SAME index, BEFORE the store-union pass
  // below, so that pass's per-record enrichment (title/flags/tags/note/device
  // precedence) applies to native rows exactly the way it applies to CC rows —
  // one enrichment pass, not a second bolted-on copy. Native ids are
  // NativeSessionHost-minted UUIDs, a disjoint generator from CC's, so they
  // never collide with a legacy sessionId already in `deduped`. Live native
  // sessions are excluded the same way CC ones are (Bug 1 parity, 2026-07-13):
  // every live session gains a store record within seconds, and listing one
  // here too would offer resume on a transcript its own writer is still
  // appending to.
  for (const entry of nativeEntries ?? []) {
    if (activeSessionIds?.has(entry.sessionId)) continue;
    deduped.set(entry.sessionId, {
      sessionId: entry.sessionId,
      // Native sessions have no CC auto-title hook, so NativeSessionHost
      // already derived a title from the first user message when the header
      // itself had none; fall back to 'Untitled' when even that is absent.
      name: entry.title ?? 'Untitled',
      projectSlug: entry.slug,
      projectPath: entry.cwd,
      lastModified: entry.mtimeMs,
      size: entry.sizeBytes,
      provider: 'native',
      // Stored (raw) harness id from the header — drives the Resume Browser's
      // preset label. Not legacy-mapped here (a 'chat' header shows as
      // Assistant via the label's fallback), which is fine for a display badge.
      harnessId: entry.harnessId,
    });
  }

  const result = Array.from(deduped.values());

  // Store union (Phase 2a): the Conversation Store is the canonical record;
  // legacy transcript scanning stays as the fallback until Plan 2c deletes it.
  // Store rows WIN on display metadata (title/lastActive/flags/device) so a
  // conversation named on another device reads right here; legacy rows WIN on
  // projectSlug/projectPath because resume needs the LOCAL slug, which the store
  // doesn't know for a conversation that never ran on this device. A store
  // record with no local transcript becomes a NEW row (visible everywhere)
  // flagged missingProject (folder not on this device) or notSyncedYet
  // (folder here, transcript not materialized yet) — resume disabled either way.
  // `deduped` is already keyed by sessionId, so it doubles as the merge index;
  // mutating a legacy value mutates the same object already in `result`.
  //
  // Task 5: this pass now reads BOTH provider buckets (`claude` AND `native`)
  // instead of just `claude` — native records are real Conversation Store
  // entries as of Task 4, so leaving them out here would mean a native
  // session's tags/note/flags never actually reached the Resume Browser even
  // though they're durably persisted and readable via session:get-meta.
  try {
    const { getConversationStore, buildLocalProjectResolver } = await import('./conversations/service');
    const store = getConversationStore();
    if (store) {
      const records = [...await store.list('claude'), ...await store.list('native')];
      // Resolve a store record's project the SAME way the materialize sweep does
      // (originalPath → managed-by-name → saved-by-basename). Built ONCE per
      // browse. Load-bearing for CROSS-DEVICE / CROSS-OS resume: a session made
      // on another machine carries that machine's originalPath (e.g. a Linux
      // /home/destin/foo), which doesn't exist here — the old code then handed
      // resume that foreign path as the cwd, `claude --resume` launched into a
      // nonexistent dir (silently downgraded to $HOME → wrong slug), and the
      // session spawned blank and exited. Resolving to THIS device's copy of the
      // folder makes resume launch in the right cwd where the transcript
      // materialized. Fix 2026-07-12 (two-device dogfood). Provider-agnostic —
      // it only reads projectName/originalPath, common to both buckets.
      const resolveLocal = buildLocalProjectResolver();
      for (const rec of records) {
        // LIVE sessions are excluded for the same reason the legacy scan
        // excludes them: every live session gains a store record within
        // seconds (live intake upserts on transcript events), and offering
        // resume on one would spawn a SECOND `claude --resume` (or a second
        // native turn loop) against the transcript the live session is
        // actively appending to.
        if (activeSessionIds?.has(rec.id)) continue;
        const isNative = rec.provider === 'native';
        const legacy = deduped.get(rec.id);
        // Store flags are { value, updatedAt }; extractStoreMeta keeps the ON
        // reserved flags, turns `tag:<id>` keys into tags[], and passes the note.
        const { flags, tags, note } = extractStoreMeta(rec);
        if (legacy) {
          // Overlay store metadata onto the local row. TITLE PRECEDENCE for a
          // STORE-BACKED row (Plan 2c — store is authoritative for titles):
          //   1. record.title (the store)  ← FIRST, wins whenever it's a real name
          //   2. legacy.name (topic file > frozen index > transcript-derived > 'Untitled')
          // i.e. the store title wins outright; the topic/index/derived chain is
          // only a fallback when the store has no real title. A literal 'Untitled'
          // store title is a PLACEHOLDER, not a name — older clients synced such
          // topic files (see docs/PITFALLS.md → Resume Browser) — so it must never
          // clobber a real derived name; it falls through to legacy.name instead.
          // (Legacy, non-store rows below keep the pure topic>index>derived chain.
          // For a native row, "legacy.name" is nativeEntries' title/'Untitled'
          // fallback — same precedence, same reasoning.)
          legacy.name = rec.title && rec.title !== 'Untitled' ? rec.title : legacy.name;
          legacy.lastModified = Math.max(legacy.lastModified, Date.parse(rec.lastActive) || 0);
          if (Object.keys(flags).length) legacy.flags = flags;
          if (tags.length) legacy.tags = tags;
          if (note) legacy.note = note;
          legacy.device = rec.device || undefined;
          legacy.provider = rec.provider;
          if (rec.lastUsedModel) legacy.lastUsedModel = rec.lastUsedModel;
          // Prefer the store's UNAMBIGUOUS project resolution for the resume cwd.
          // The legacy projectPath came from resolveSlugToPath, a filesystem walk
          // that can misfire when a folder's name contains hyphens AND a shorter
          // sibling dir exists (e.g. 'youcoded-dev' vs a stray 'youcoded' → the
          // walk yielded a nonexistent '…\youcoded\dev' and resume fell back to
          // $HOME). The store knows the exact projectName, so resolveLocal maps
          // it by basename with no ambiguity. Only override when that folder
          // actually holds THIS transcript, so we never point resume elsewhere.
          // Native uses nativeStoreSlug + ~/.youcoded/sessions (its own frozen
          // slug convention, deliberately diverging from ccProjectSlug — see
          // harness/session-store.ts).
          const storeLocal = resolveLocal(rec);
          if (isNative) {
            if (storeLocal && await exists(nativeJsonlPath(storeLocal, rec.id))) {
              legacy.projectPath = storeLocal;
              legacy.projectSlug = nativeStoreSlug(storeLocal);
            }
          } else if (storeLocal && await exists(path.join(PROJECTS_DIR, ccProjectSlug(storeLocal), `${rec.id}.jsonl`))) {
            legacy.projectPath = storeLocal;
            legacy.projectSlug = ccProjectSlug(storeLocal);
          }
        } else {
          // Store-only conversation: resolve its project locally. Resume needs
          // BOTH the project folder AND a materialized transcript on this
          // device — a store-only row has no locally-scanned transcript by
          // construction, so check the JSONL explicitly; resuming (CC's
          // `--resume`, or the native host's persisted-session resume) on a
          // missing transcript just errors out. The probe path is
          // provider-specific: ~/.claude/projects for CC, ~/.youcoded/sessions
          // for native (see nativeJsonlPath).
          const localPath = resolveLocal(rec);
          const transcriptHere = localPath
            ? (isNative
                ? await exists(nativeJsonlPath(localPath, rec.id))
                : await exists(path.join(PROJECTS_DIR, ccProjectSlug(localPath), `${rec.id}.jsonl`)))
            : false;
          result.push({
            sessionId: rec.id,
            name: rec.title || 'Untitled',
            projectSlug: localPath ? (isNative ? nativeStoreSlug(localPath) : ccProjectSlug(localPath)) : '',
            projectPath: localPath ?? rec.originalPath,
            lastModified: Date.parse(rec.lastActive) || 0,
            size: 0,
            ...(Object.keys(flags).length ? { flags } : {}),
            ...(tags.length ? { tags } : {}),
            ...(note ? { note } : {}),
            device: rec.device || undefined,
            provider: rec.provider,
            ...(rec.lastUsedModel ? { lastUsedModel: rec.lastUsedModel } : {}),
            // Two distinct resume-blocked sub-cases so the renderer can word
            // the note accurately: folder absent vs. transcript not synced yet.
            ...(localPath ? {} : { missingProject: true }),
            ...(localPath && !transcriptHere ? { notSyncedYet: true } : {}),
          });
        }
      }
    }
  } catch { /* store unavailable — the legacy list stands alone */ }

  result.sort((a, b) => b.lastModified - a.lastModified);
  return result;
}

/**
 * Loads the last N conversational messages from a session's JSONL file.
 * "Conversational" = user prompts (with promptId, not meta) and assistant
 * end_turn responses (text content only, no tool calls).
 *
 * Uses async I/O with single-pass deduplication (Map overwrite pattern)
 * and null-byte line filtering.
 */
export async function loadHistory(
  sessionId: string,
  projectSlug: string,
  count: number = 10,
  all: boolean = false,
): Promise<HistoryMessage[]> {
  if (!SAFE_ID_RE.test(projectSlug) || !SAFE_ID_RE.test(sessionId)) return [];
  const jsonlPath = path.join(PROJECTS_DIR, projectSlug, `${sessionId}.jsonl`);

  let content: string;
  try {
    content = await fs.promises.readFile(jsonlPath, 'utf8');
  } catch {
    return [];
  }

  // Filter null-byte corrupted lines (NTFS pre-allocation gaps from process kills)
  const lines = content.trim().split('\n').filter(line =>
    line.trim() && !line.includes('\x00')
  );

  // Single-pass: overwrite Map by UUID (last occurrence wins for dedup)
  const lastParsedByUuid = new Map<string, any>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.uuid && (parsed.type === 'user' || parsed.type === 'assistant')) {
        lastParsedByUuid.set(parsed.uuid, parsed);
      }
    } catch {}
  }

  // Extract conversational messages from deduplicated set (preserves insertion order)
  const messages: HistoryMessage[] = [];
  for (const parsed of lastParsedByUuid.values()) {
    const message = parsed.message;
    if (!message) continue;

    if (parsed.type === 'user') {
      if (parsed.isMeta) continue;
      if (!parsed.promptId) continue;
      const c = message.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
          : '';
      if (!text.trim()) continue;
      messages.push({ role: 'user', content: text.trim(), timestamp: parsed.timestamp || 0 });
    } else if (parsed.type === 'assistant' && message.stop_reason === 'end_turn') {
      const c = message.content;
      const texts = Array.isArray(c)
        ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        : typeof c === 'string' ? c : '';
      if (!texts.trim()) continue;
      messages.push({ role: 'assistant', content: texts.trim(), timestamp: parsed.timestamp || 0 });
    }
  }

  if (all) return messages;
  return messages.slice(-count);
}
