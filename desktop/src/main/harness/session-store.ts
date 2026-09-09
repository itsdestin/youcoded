// Native session persistence (Phase 0 spec §3): line 1 = header, lines 2+ =
// transcript events. Streaming deltas are coalesced per partId before hitting
// disk (one event per part — identical reducer state on replay, ~50x smaller
// files). 'session-error' is display-only and never persisted (a stale error
// banner on resume would describe a failure that isn't happening anymore); the
// streaming-watchdog heartbeats (stall warning + clear — a text-less, partId-less
// assistant-thinking) are display-only for the same reason.
import type { TranscriptEvent } from '../../shared/types';
import type { ModelBinding } from '../../shared/provider-types';
// WHY nativeStoreSlug (NOT the CC mirror): the slug is the FROZEN app-private
// rule (slug-encoding.ts) — deliberately NOT CC's; changing it orphans
// existing native transcripts. It disagrees with ccProjectSlug on a cwd like
// 'c:\Users\d\proj' (see session-store.test.ts's slug-divergence pin).
// conversations/service.ts's localJsonlPath mirrors this same convention for
// native paths.
import { nativeStoreSlug } from '../slug-encoding';
import { NativeHome } from '../native-home';

export interface NativeSessionHeader {
  v: 1;
  sessionId: string;
  harnessId: string;
  binding: ModelBinding;
  cwd: string;
  createdAt: number;
  title?: string;
  /** Optional creation-time snapshot for ordinary root sessions. */
  stepGuard?: number;
  // Specialists (spec 2026-08-11 §1): children are ordinary sessions marked
  // by parentage; additive so v1 files need no migration.
  parentSessionId?: string;
  sessionKind?: 'root' | 'specialist';
  agentType?: string;
}

export interface NativeSessionListEntry extends NativeSessionHeader {
  mtimeMs: number;
  sizeBytes: number;
  slug: string;
}

// The two streaming-delta event types that arrive as per-token fragments and
// get merged by partId in the chat reducer — so they can be merged the same
// way on disk without changing what a replay produces.
const COALESCED_TYPES = new Set(['assistant-text', 'assistant-thinking']);

// Resume Browser fallback title length — native sessions have no CC
// auto-title hook, so the first user message stands in (spec §2.6).
const DERIVED_TITLE_MAX = 60;

export class SessionStore {
  // One open (still-streaming) part per session, buffered until flushed by a
  // different partId, a non-delta event, or a turn boundary. The slug is
  // captured alongside the event because flush happens on a LATER append call
  // and must write to the same file the part started in.
  //
  // KNOWN LIMITATION (deliberate, do not fix here): a part still buffered at
  // process exit is lost unless a turn-boundary event flushed it first.
  // HarnessSession always ends turns with turn-complete / user-interrupt /
  // session-error — all three flush the open part (session-error flushes even
  // though its own line is never persisted) — so in practice parts flush every
  // turn, and a hard crash mid-stream loses at most the one in-flight part.
  private open = new Map<string, { slug: string; event: TranscriptEvent }>();

  constructor(private home: NativeHome) {}

  /** Write the session header as line 1 of a fresh session file. */
  async create(header: NativeSessionHeader): Promise<void> {
    await this.home.appendSessionLine(nativeStoreSlug(header.cwd), header.sessionId, header);
  }

  /**
   * Persist one transcript event, coalescing streaming deltas.
   * Takes cwd (not slug) because callers naturally hold the session's cwd —
   * the slug is derived here so the CC-compatible encoding stays in one place.
   */
  async append(cwd: string, event: TranscriptEvent): Promise<void> {
    // Display-only: never persisted (see module comment). But it IS a turn
    // boundary — flush the open part first, or a turn that ends in a provider
    // error would strand its partial assistant text in memory (lost on exit).
    // The user already saw that text live; resume must show it too.
    if (event.type === 'session-error') {
      await this.flush(event.sessionId);
      return;
    }

    // Manual stall Retry: the attempt that wrote these parts is being abandoned
    // and its text is being erased on screen. Discard the buffer WITHOUT
    // writing it — this is the only path that drops a buffered part instead of
    // flushing it, and it must run BEFORE the display-only filter below, which
    // would otherwise return early and leave the abandoned text to be flushed
    // by the next event.
    //
    // KNOWN LIMITATION (deliberate, not an oversight): this can only discard a
    // part still BUFFERED here — and only ONE part is ever buffered, because
    // the coalescing branch below flushes the moment ANY different part opens.
    // Two shapes therefore commit earlier text to the JSONL before the stall:
    //   1. the attempt emitted a tool call (a non-delta event → flush), or
    //   2. the attempt switched parts mid-prose — most commonly a reasoning
    //      block giving way to visible text, which is the ordinary shape on
    //      the model in the 2026-08-16 incident, so this is the COMMON case,
    //      not the exotic one. (The buffer keys off type AND partId, so
    //      reasoning→text flushes on both counts.)
    // In either shape dropPart can't reach back and unwrite the committed
    // line. A re-run can then duplicate that earlier text ON DISK even though
    // the live screen (which erased via the renderer's own dropPart handling)
    // stays correct. The transcript is append-only; rewriting already-committed
    // lines is out of scope here.
    if (event.type === 'assistant-thinking' && event.data?.dropPart) {
      const open = this.open.get(event.sessionId);
      if (open && event.data.dropPart.partIds.includes(String(open.event.data?.partId))) {
        this.open.delete(event.sessionId);
      }
      return;
    }

    // Streaming-watchdog heartbeats (the stall warning and its clear) are
    // transient UI signals — an assistant-thinking with NO text and NO partId.
    // Display-only: never persisted (a replayed stall countdown on a long-since
    // completed turn is meaningless), and — unlike session-error — NOT a turn
    // boundary, so it must NOT flush the open streaming part. (Reasoning deltas
    // always carry text + partId, so they never match here.)
    if (event.type === 'assistant-thinking' && !event.data?.text && !event.data?.partId) {
      return;
    }

    const slug = nativeStoreSlug(cwd);
    const partId = event.data?.partId;

    if (COALESCED_TYPES.has(event.type) && partId) {
      const open = this.open.get(event.sessionId);
      if (open && open.event.type === event.type && open.event.data?.partId === partId) {
        // Same still-streaming part: concatenate into the buffered CLONE.
        // The clone (made below when the part opened) is what makes this safe
        // — we never mutate an object the caller still owns.
        open.event.data.text = String(open.event.data.text ?? '') + String(event.data?.text ?? '');
        return;
      }
      // A different part started: the previous one is complete — flush it,
      // then buffer a CLONE of this event ({...} on both levels so later
      // caller-side mutation can't reach into what we'll persist). The inner
      // spread is a SHALLOW clone — safe because delta data is text+partId
      // only; revisit if a coalesced delta ever gains a nested field.
      // slug is captured on the entry so flush writes to the file this part
      // opened in (cwd is header-fixed per session, so it never actually
      // differs, but pinning it keeps flush self-contained).
      await this.flush(event.sessionId);
      this.open.set(event.sessionId, {
        slug,
        event: { ...event, data: { ...event.data } },
      });
      return;
    }

    // Any non-delta event is a part boundary: flush the open part first so
    // on-disk ordering matches the order the reducer saw events live. That
    // guarantee holds under SERIALIZED appends only — callers must await each
    // append before firing the next for a session (the host serializes per
    // session); un-awaited overlapping appends could interleave the underlying
    // file writes and scramble on-disk order.
    await this.flush(event.sessionId);
    await this.home.appendSessionLine(slug, event.sessionId, event);
  }

  /** Write the buffered open part (if any) and clear it. */
  private async flush(sessionId: string): Promise<void> {
    const open = this.open.get(sessionId);
    if (!open) return;
    // Delete BEFORE the async write so a re-entrant append during the await
    // can't double-flush the same part.
    this.open.delete(sessionId);
    await this.home.appendSessionLine(open.slug, sessionId, open.event);
  }

  /**
   * Host is destroying ONE session mid-stream (graceful teardown, not a crash):
   * persist its in-flight part so the partial text the user saw live survives,
   * and — since flush() deletes the map entry — drop the buffered reference so
   * the open map can't leak. Must NOT silently discard the part.
   */
  async dispose(sessionId: string): Promise<void> {
    await this.flush(sessionId);
  }

  /**
   * App-shutdown path: flush every session's open part before quit so nothing
   * in-flight is lost. Snapshot the key set first — flush() mutates the map.
   */
  async flushAll(): Promise<void> {
    for (const id of [...this.open.keys()]) {
      await this.flush(id);
    }
  }

  /**
   * Does a persisted native session file exist for this id, in any project?
   * Deliberately a readdir-only check (listSessionFiles stats names; it does NOT
   * read file contents like list() does) so callers on user-initiated paths —
   * flagging/noting a session — can ask "is this id native?" without paying a
   * 256KB head-read per session. Used by the phantom-record gate in ipc-handlers.
   */
  has(sessionId: string): boolean {
    return this.home.listSessionFiles().some((f) => f.sessionId === sessionId);
  }

  /** Line 1 of the session file, validated as a v1 header for this session. */
  readHeader(sessionId: string, cwd: string): NativeSessionHeader | null {
    const lines = this.home.readSessionLines(nativeStoreSlug(cwd), sessionId);
    return this.validateHeader(lines[0], sessionId);
  }

  /**
   * Lines 2+ of the session file. Dedups by uuid on read — the chat reducer
   * does NOT dedup native events, so a torn write or a future double-append
   * must never produce duplicate reducer entries on replay.
   */
  readEvents(sessionId: string, cwd: string): TranscriptEvent[] {
    const lines = this.home.readSessionLines(nativeStoreSlug(cwd), sessionId);
    const seen = new Set<string>();
    const out: TranscriptEvent[] = [];
    for (const line of lines.slice(1)) {
      const e = line as TranscriptEvent;
      // Skip anything that isn't a typed event (e.g. a stray header written
      // by a buggy future writer, or junk that happens to parse as JSON).
      if (!e || typeof e !== 'object' || typeof (e as any).type !== 'string') continue;
      // Only dedup when a uuid is present — events without one can't be told
      // apart, and dropping ALL uuid-less events after the first would eat
      // legitimate lines.
      if (e.uuid) {
        if (seen.has(e.uuid)) continue;
        seen.add(e.uuid);
      }
      out.push(e);
    }
    return out;
  }

  /**
   * Every persisted session with header metadata, newest first (Resume Browser).
   * `options.includeChildren` (default false) controls whether specialist
   * child sessions are included: by default they're hidden from the Resume
   * Browser (a child is a normal session file marked by parentage, spec
   * 2026-08-11 §1), so callers must opt in with `{ includeChildren: true }`
   * to see them.
   * WHY bounded head-read (mirrors CC's Resume Browser, 256KB head): we need
   * only the header (line 1) and the first user-message (near the top), so a
   * full read is wasteful — and worse, a file exceeding Node's string cap
   * makes a full read throw, which reads back as [] and would silently drop
   * the session from the list. The tradeoff: a derived title is unavailable if
   * the first user-message somehow sits past 256KB of transcript, which no real
   * session does. readEvents (replay) still reads all lines — it genuinely
   * needs them.
   */
  list(options?: { includeChildren?: boolean }): NativeSessionListEntry[] {
    const includeChildren = options?.includeChildren ?? false;
    const out: NativeSessionListEntry[] = [];
    for (const file of this.home.listSessionFiles()) {
      const lines = this.home.readSessionHead(file.slug, file.sessionId);
      const header = this.validateHeader(lines[0], file.sessionId);
      if (!header) continue; // torn/foreign file — not a native session we can resume
      // Specialists (spec 2026-08-11 §1): a specialist child is a normal
      // session file, hidden from the default list unless asked for. Guard on
      // BOTH fields — a future writer setting only one must not leak a child.
      if (!includeChildren && (header.sessionKind === 'specialist' || header.parentSessionId)) continue;
      // Title precedence (spec §2.6): explicit header title, else derive from
      // the FIRST user-message event — native sessions have no CC auto-title
      // hook, so the opening prompt is the best available label.
      let title = header.title;
      if (!title) {
        for (const line of lines.slice(1)) {
          const e = line as TranscriptEvent;
          if (e && typeof e === 'object' && e.type === 'user-message' && e.data?.text != null) {
            title = String(e.data.text).slice(0, DERIVED_TITLE_MAX);
            break;
          }
        }
      }
      out.push({
        ...header,
        ...(title !== undefined ? { title } : {}),
        mtimeMs: file.mtimeMs,
        sizeBytes: file.sizeBytes,
        slug: file.slug,
      });
    }
    // Newest activity first — mtime moves on every append, which is exactly
    // "last active" for a single-writer JSONL file.
    out.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return out;
  }

  /** A line only counts as a header if it's v1 AND names this exact session. */
  private validateHeader(line: unknown, sessionId: string): NativeSessionHeader | null {
    if (!line || typeof line !== 'object') return null;
    const h = line as NativeSessionHeader;
    if (h.v !== 1 || h.sessionId !== sessionId) return null;
    // WHY normalize additive fields at the persistence boundary: a malformed
    // hand-edited header must resume as the legacy no-guard behavior.
    if (h.stepGuard !== undefined && !(Number.isSafeInteger(h.stepGuard) && h.stepGuard > 0)) {
      const { stepGuard: _invalid, ...safe } = h;
      return safe;
    }
    return h;
  }
}
