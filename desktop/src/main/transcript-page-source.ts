// DEFAULT imports, deliberately. A namespace import (`import * as os`) reads
// through a live binding that a test's own `vi.spyOn(os, 'homedir')` does not
// reach — measured both ways, either specifier, 2026-09-07. The suite-wide HOME
// sandbox still applies, so this is not a "reads production" hazard; what it
// costs is that a test pointing homedir at its OWN fixture directory is
// silently ignored, and the module reads the shared sandbox instead — a test
// that passes or fails for a reason unrelated to what it meant to check.
// Pinned by tests/home-sandbox-import-style.test.ts.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SAFE_ID_RE } from './session-browser';

/**
 * Where a session's transcript lives, for paged history, when the transcript
 * WATCHER cannot say.
 *
 * WHY this exists. `TranscriptWatcher.pageSourceFor` only answers for a session
 * it is actively tailing, and there are three ordinary moments when it is not:
 *
 *  1. Between resuming a Claude Code session and CC's SessionStart hook
 *     reporting its transcript path (a second or two).
 *  2. After the session's process exits — session-exit tears the watcher down,
 *     but the conversation stays on screen and is still scrollable.
 *  3. In the buddy floater, which asks for a page of a session it never watched.
 *
 * Only the FIRST page request carries a fallback locator (the resume handler
 * has the ids; the scroll-up sentinel and the floater have only a cursor), so
 * before this the answer to every later request in those windows was
 * `{events: [], cursor: null, hasMore: false}` — byte-for-byte the answer for
 * "you have reached the beginning of the conversation". The reducer believed it,
 * dropped the cursor and stopped rendering the scroll-up sentinel, and the rest
 * of the conversation became permanently unreachable in that window.
 * (Destin, 2026-09-07: "the first handful of messages load fine, but then
 * nothing before those loads.")
 *
 * So: remember the file, from whichever source spoke first, and answer from
 * memory whenever the watcher cannot.
 */
export interface RememberedPageSource {
  jsonlPath: string;
  subagentsDir: string;
}

/** Shaped like `TranscriptWatcher.pageSourceFor`'s return, so callers can use
 *  either interchangeably. `startOffset` is always 0: nothing is tailing a
 *  remembered file, so its first page must read all the way to EOF. */
export interface ResolvedPageSource extends RememberedPageSource {
  startOffset: number;
}

export class TranscriptPageSources {
  private readonly bySession = new Map<string, RememberedPageSource>();

  /**
   * Remember the authoritative path — the one CC's hook reported, already
   * resolved by the watcher. Overwrites a guess made from a locator, which
   * matters through a symlink: CC slugs its own post-realpath cwd, so a path
   * derived from ours can name a different directory.
   */
  remember(sessionId: string, source: RememberedPageSource): void {
    this.bySession.set(sessionId, source);
  }

  /**
   * Remember the file a renderer-supplied locator names. Returns false — and
   * remembers nothing — when either id is not a plain id: both shape a
   * filesystem path, so a traversal-shaped one must never reach `path.join`.
   */
  rememberLocator(sessionId: string, claudeSessionId: unknown, projectSlug: unknown): boolean {
    if (typeof claudeSessionId !== 'string' || typeof projectSlug !== 'string') return false;
    if (!SAFE_ID_RE.test(claudeSessionId) || !SAFE_ID_RE.test(projectSlug)) return false;
    const dir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
    this.remember(sessionId, {
      jsonlPath: path.join(dir, `${claudeSessionId}.jsonl`),
      subagentsDir: path.join(dir, claudeSessionId, 'subagents'),
    });
    return true;
  }

  /**
   * The remembered source, or null. Existence is checked HERE rather than at
   * remember time: a file that has been deleted (or was never written) must
   * read as "could not locate it", never as an empty conversation.
   */
  get(sessionId: string): ResolvedPageSource | null {
    const source = this.bySession.get(sessionId);
    if (!source) return null;
    if (!fs.existsSync(source.jsonlPath)) return null;
    return { ...source, startOffset: 0 };
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
