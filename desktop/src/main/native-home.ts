// NativeHome — the ONE writer for ~/.youcoded/ (platform roadmap ADR 008).
// All JSON files go through mutateFileUnderLock (dev instance + built app can
// both be running against the same home dir — same cross-process risk the
// artifact central index has, so the mkdir-based file lock is mandatory).
// Session JSONL appends are single-writer by design (only NativeSessionHost
// appends, and exactly one process owns a live session), so a plain
// fs.promises.appendFile is safe and correct there — no lock needed.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { mutateFileUnderLock } from './artifacts/cas-write';
import { transcriptSkipReason } from './conversations/lane-guards';

export interface SessionFileInfo {
  slug: string;
  sessionId: string;
  mtimeMs: number;
  sizeBytes: number;
  path: string;
}

// Mirrors central-index.ts MAX_RETRIES: each mutateFileUnderLock attempt waits
// up to 3s for the lock (cas-write LOCK_MAX_WAIT_MS), so five attempts ride out
// ~15s of contention before giving up loudly.
const LOCK_MAX_RETRIES = 5;

export class NativeHome {
  private readonly dir: string;

  /** homeRoot overridable for tests; production callers pass nothing. */
  constructor(homeRoot: string = os.homedir()) {
    this.dir = path.join(homeRoot, '.youcoded');
  }

  get root(): string {
    return this.dir;
  }

  /**
   * Read a JSON file relative to ~/.youcoded/. Returns null for a missing or
   * unparseable file — reads NEVER create the directory (lazy-creation
   * invariant: ~/.youcoded/ only materializes on the first write).
   */
  readJson(rel: string): unknown | null {
    const p = path.join(this.dir, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e: any) {
      // ONLY a missing file reads as null. Any other I/O error (EACCES, EIO,
      // EISDIR…) must RETHROW: a transient error that read as "file absent"
      // would let an initialize-on-null caller clobber real data on its next
      // write. Same rethrow-non-ENOENT precedent as central-index.ts readIndex.
      if (e?.code === 'ENOENT') return null;
      throw e;
    }
    try {
      return JSON.parse(raw);
    } catch {
      // Corrupt JSON reads as "nothing here yet" — the file exists but holds
      // no usable value, so callers rebuild it (mutateJson does the same).
      return null;
    }
  }

  async writeJson(rel: string, value: unknown): Promise<void> {
    // A plain write is just a mutate that ignores what's on disk — one code
    // path means one locking story.
    await this.mutateJson(rel, () => value);
  }

  /**
   * Read-modify-write inside the file lock. mutate receives the parsed current
   * value (null if absent).
   *
   * WHY the retry-then-THROW (mirrors central-index.ts mutateIndex): a
   * contended write that's silently dropped would surface as "saved" in the UI
   * with nothing actually on disk — for providers.json that means an API key
   * the user just entered evaporates. Failing loudly lets the caller show a
   * real error instead. opts.maxRetries exists only so the contention test can
   * run one ~3s lock-wait cycle instead of five (~15s); production callers
   * never pass it.
   */
  async mutateJson(
    rel: string,
    mutate: (current: unknown | null) => unknown,
    opts?: { maxRetries?: number }
  ): Promise<void> {
    const p = path.join(this.dir, rel);
    // Clamp to ≥1: a 0/negative override would fall straight through the loop
    // and throw "lock held" without ever probing the lock once.
    const maxRetries = Math.max(1, opts?.maxRetries ?? LOCK_MAX_RETRIES);
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // mutateFileUnderLock mkdirs the target's parent itself, so the directory
      // is created lazily here on first WRITE — never on read.
      const ok = await mutateFileUnderLock(p, (onDisk) => {
        let current: unknown | null = null;
        if (onDisk !== null) {
          try {
            current = JSON.parse(onDisk);
          } catch {
            // Corrupt file on disk: treat as absent so the mutate can rebuild it.
            current = null;
          }
        }
        return JSON.stringify(mutate(current), null, 2);
      });
      if (ok) return;
    }
    throw new Error(
      `Could not update ${rel} — another YouCoded process is holding its lock. Try again in a moment.`
    );
  }

  /** Absolute path of one session's JSONL. PUBLIC because the private
   *  continuation manifest must name the exact transcript file it describes
   *  (accepted-history-store.ts digests it) — SessionStore.transcriptPath is
   *  the one caller outside this class, so the path convention still lives
   *  here and nowhere else. */
  sessionFilePath(slug: string, sessionId: string): string {
    return path.join(this.dir, 'sessions', slug, `${sessionId}.jsonl`);
  }

  /**
   * Append one JSONL line to sessions/<slug>/<sessionId>.jsonl.
   * WHY no lock: session files are single-writer by design — only the one
   * process that owns the live session ever appends to it, so plain
   * appendFile is correct (and much cheaper than taking the file lock
   * per transcript event).
   */
  async appendSessionLine(slug: string, sessionId: string, obj: unknown): Promise<void> {
    const p = this.sessionFilePath(slug, sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Crash-torn-tail guard: if a previous process died mid-append, the file
    // can end WITHOUT a newline. Appending directly would fuse this record
    // onto the torn fragment — losing BOTH lines to JSON.parse. Writing a
    // newline first bounds the damage to the already-torn record.
    try {
      const st = await fs.promises.stat(p);
      if (st.size > 0) {
        const fh = await fs.promises.open(p, 'r');
        try {
          const buf = Buffer.alloc(1);
          await fh.read(buf, 0, 1, st.size - 1);
          if (buf[0] !== 0x0a /* \n */) await fs.promises.appendFile(p, '\n', 'utf8');
        } finally {
          await fh.close();
        }
      }
    } catch (e: any) {
      // ENOENT = first line of a new session file, nothing to guard.
      if (e?.code !== 'ENOENT') throw e;
    }
    await fs.promises.appendFile(p, JSON.stringify(obj) + '\n', 'utf8');
  }

  readSessionLines(slug: string, sessionId: string): unknown[] {
    const p = this.sessionFilePath(slug, sessionId);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      return []; // no such session yet — empty transcript, not an error
    }
    const out: unknown[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Unparseable line — skipped PERMANENTLY (a crash-torn record stays
        // torn on disk; appendSessionLine's tail guard only protects the NEXT
        // record from fusing into it). A mid-live-append read may also see a
        // torn tail transiently; that one heals on the next read.
      }
    }
    return out;
  }

  /**
   * Bounded head-read: parse at most maxBytes from the START of a session
   * file. Mirrors the CC Resume-Browser precedent (PITFALLS → Resume Browser:
   * 256KB head) — list/browse only needs the header (line 1) and the first
   * user-message (near the top), so reading the whole file is wasteful AND
   * dangerous: a file that exceeds Node's string cap makes readFileSync throw,
   * which readSessionLines swallows to [] — silently vanishing that session
   * from the Resume Browser. Reading a bounded head can't hit the cap.
   *
   * The last line in the window may be truncated mid-record, so it's DROPPED
   * (never parse a half-line); unparseable lines are skipped like
   * readSessionLines does.
   */
  readSessionHead(slug: string, sessionId: string, maxBytes = 262144): unknown[] {
    const p = this.sessionFilePath(slug, sessionId);
    let buf: Buffer;
    let bytesRead: number;
    let fileSize: number;
    try {
      const fd = fs.openSync(p, 'r');
      try {
        fileSize = fs.fstatSync(fd).size;
        buf = Buffer.alloc(Math.min(maxBytes, fileSize));
        bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return []; // no such session yet — empty transcript, not an error
    }
    const raw = buf.toString('utf8', 0, bytesRead);
    const lines = raw.split('\n');
    // If the read was TRUNCATED (didn't reach EOF), the last line is a
    // possibly-half record — drop it so we never parse a fragment. A full read
    // leaves a trailing '' after the final newline, which the trim guard below
    // skips anyway, so only the truncated case needs the pop.
    if (bytesRead < fileSize) lines.pop();
    const out: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Unparseable line — skipped (same policy as readSessionLines).
      }
    }
    return out;
  }

  /**
   * Overwrite-write a plain-text artifact at sessions/<slug>/<name> and return
   * its absolute path. Added ahead of its nominal owner (plan 1b Task 10,
   * "report overflow spills to a file") because Task 4's background-completion
   * handler needs it NOW: DelegationLedger.update() caps `rawReport` at
   * RAW_REPORT_CAP_CHARS on every write, and for a background run nothing else
   * ever sees the uncapped body again (the child is torn down right after) —
   * so the full text has to be spilled to disk BEFORE that cap silently
   * discards it, not later when Task 10 teaches formatSpecialistReport to read
   * it back. Signature matches what Task 10's plan already specifies, so it
   * can consume this rather than re-adding it.
   *
   * WHY no lock: same reasoning as appendSessionLine — exactly one process
   * ever writes a given child's spill file, exactly once (the completion
   * handler that owns that child's run), so a plain overwrite is correct.
   */
  writeSessionArtifact(slug: string, name: string, text: string): string {
    const p = path.join(this.dir, 'sessions', slug, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
    return p;
  }

  /**
   * Read back an artifact written by writeSessionArtifact(), given the
   * ABSOLUTE path it returned. Added for the Task 4 fix-pass (finding 1,
   * external review 2026-08-12): the completion handler spills an oversized
   * specialist report to disk, but delivery was formatting from the ledger's
   * own capped copy and never reading the spill file back — this is the read
   * half of that write. Returns null (never throws) on ANY read failure —
   * missing file, permission error, whatever — so a caller can fall back to
   * the capped in-ledger copy instead of failing delivery outright over a
   * spill file that's gone missing.
   */
  readSessionArtifact(absolutePath: string): string | null {
    try {
      return fs.readFileSync(absolutePath, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Create the parent directories and write `contents` to `rel`, but ONLY if
   * that file doesn't already exist. Returns true when it actually wrote
   * (first time ever), false when the file was already there (left
   * untouched, even if the user has since edited it).
   *
   * WHY this exists (Task 3, plan 1c, ADR 008): the personal specialists
   * folder (~/.youcoded/specialists/) and its starter file (example.md) are
   * the first non-JSON, non-session write under ~/.youcoded/ — SpecialistCatalog
   * needs a way to lazily create both on first use without a second writer
   * bypassing NativeHome. An existence check + write is enough here (unlike
   * writeJson/mutateJson) because the only conflict this file can ever have
   * is with a user's own edits, which must never be clobbered — there's no
   * concurrent-writer race to guard against the way providers.json has.
   */
  async ensureTextFile(rel: string, contents: string): Promise<boolean> {
    const p = path.join(this.dir, rel);
    if (fs.existsSync(p)) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, contents, 'utf8');
    return true;
  }

  /** Enumerate every sessions/<slug>/<id>.jsonl with stat info (for browse/resume UIs). */
  listSessionFiles(): SessionFileInfo[] {
    const base = path.join(this.dir, 'sessions');
    const out: SessionFileInfo[] = [];
    let slugs: string[] = [];
    try {
      slugs = fs.readdirSync(base);
    } catch {
      return out; // no sessions dir yet — nothing to list
    }
    for (const slug of slugs) {
      let files: string[] = [];
      try {
        files = fs.readdirSync(path.join(base, slug));
      } catch {
        continue; // stray file (not a dir) or deleted mid-scan — skip
      }
      for (const f of files) {
        // The .jsonl suffix is also what keeps DelegationLedger's per-parent
        // sidecar (sessions/<slug>/<parentId>.delegations.json — plan 1b Task
        // 2) OUT of this listing: it lives in the same slug directory as real
        // session files, and this listing feeds both the Resume Browser and
        // pruneNativePhantomRecords, either of which would show a sidecar as
        // a broken, unopenable "session" if it weren't filtered out here.
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(base, slug, f);
        try {
          // lstat, NOT stat: a symlinked session file must be skipped, not
          // followed. The native lane has no symlinks today (verified: 0 of 128
          // on a real machine), so this is defensive — but this listing is
          // consumed by pruneNativePhantomRecords (conversations/service.ts) to
          // detect phantom native records, and by harness/session-store.ts for
          // session lookups; the chatsearch builder does NOT go through here —
          // it resolves native transcript paths itself in index-service.ts. The
          // CC lane proved what following a symlink costs. No size floor here:
          // listSessionFiles must keep enumerating small native sessions.
          const st = fs.lstatSync(full);
          if (transcriptSkipReason(st)) continue;
          out.push({
            slug,
            sessionId: f.slice(0, -'.jsonl'.length),
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
            path: full,
          });
        } catch {
          // deleted between readdir and stat — skip
        }
      }
    }
    return out;
  }
}
