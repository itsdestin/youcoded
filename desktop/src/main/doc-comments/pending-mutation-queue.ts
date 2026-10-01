// The docx/xlsx pending-mutation queue's MAIN-PROCESS half — T9b of the
// doc-comments build (docs/active/specs/2026-09-26-doc-comments-build-
// design.md §9.2). The Claude Code MCP script (T9a,
// claude-code-doc-comments-mcp.ts) "never touches a .docx/.xlsx file
// directly" (§1.6): for any of the six tools against a Word/Excel target,
// including a plain read, it writes a `PendingMutationRequest` under
// `.youcoded/comments/.pending/<id>.json` and polls for a matching
// `<id>.result.json`. This module is the OTHER end: a chokidar watcher on
// that directory that applies a request through the real
// docx-comments.ts/xlsx-comments.ts code (via doc-comments-dispatch.ts —
// the SAME dispatch functions the desktop IPC surface and native tools use,
// never a second copy) and writes the result back.
//
// WHY this is its OWN watcher, not a reuse of doc-comments-watcher.ts's
// existing per-project instance (§1.5's UI-facing `docComments:watch`/
// `:unwatch`): that one is refcounted by RENDERER subscribers — it only runs
// while some window's comments pane is open for that project. The assistant
// must be able to add/reply/resolve a Word/Excel comment with NO comments
// pane open anywhere, so this queue is instead tied to CLAUDE CODE SESSION
// lifecycle (wired in ipc-handlers.ts, listening for session-manager.ts's
// `doc-comments-mcp-attached` event) — refcounted the same way, so two
// sessions sharing one project share ONE watcher, and it closes once the
// last such session ends. doc-comments-watcher.ts's own instance separately
// ignores `**/.pending/**` (review 2, F20) specifically so its UI-facing
// debounced push is never confused by this queue's own create-then-delete
// file churn.
//
// --- Authorization (adversarial review 2026-09-27, finding #1 — CRITICAL) ---
//
// `.pending/` is a plain, filesystem-level drop box: ANYTHING with ordinary
// write access to the project folder can place a file there — another tool
// call in the same session, a malicious skill, a compromised dependency, or
// a file already sitting in a cloned/downloaded project before this app ever
// opened it. Two independent defenses close this, neither alone sufficient:
//
// 1. **The applier never trusts a request's own `projectRoot` field.** Every
//    dispatch call below resolves against `entry.realRoot` — the SAME
//    realpathed root `startPendingMutationQueue` verified when the watcher
//    started (gated through `refuseUnknownProjectRoot`, the SAME authority
//    every other doc-comments surface uses) — never `req.projectRoot`, which
//    is advisory-only self-reported data from an untrusted file (see
//    `PendingMutationRequest.projectRoot`'s own doc comment,
//    shared/doc-comments-types.ts).
// 2. **Every request must carry this session's own per-deployment secret**
//    (`req.token`, compared in CONSTANT TIME against every session
//    currently sharing this entry's `refs` map) — a value generated fresh at
//    THIS session's own spawn time (`deployClaudeCodeDocCommentsMcp`), which
//    nothing planted before the session existed, and no OTHER tool running
//    in the same session (Bash, Write — unrelated to this feature's own
//    gate) has any reason to know, can possibly supply.
//
// A third, purely defense-in-depth check (`isFreshEnough`) refuses to
// process a request file whose own mtime predates the watcher's start —
// this is EXPLICITLY WEAK on its own (a `git clone` commonly stamps a
// planted file's mtime as "now," at checkout time, not at the original
// commit time — the review's own named attack scenario), so it is never
// relied on alone; the token check above is the real boundary.
import chokidar, { FSWatcher } from 'chokidar';
import { promises as fs } from 'fs';
import { timingSafeEqual } from 'crypto';
import os from 'os';
import path from 'path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import { refuseUnknownProjectRoot } from './doc-comments-gate';
import {
  listNativeComments,
  addNativeDocxComment,
  replyToNativeDocxComment,
  resolveNativeDocxComment,
  reopenNativeDocxComment,
  moveNativeDocxComment,
  addNativeXlsxComment,
  replyToNativeXlsxComment,
  resolveNativeXlsxComment,
  reopenNativeXlsxComment,
  moveNativeXlsxComment,
  type NativeFormat,
} from './doc-comments-dispatch';
import type {
  CommentReply,
  PendingMutationRequest,
  PendingMutationResult,
} from '../../shared/doc-comments-types';

const PENDING_SUBDIR = '.pending';

/** Same 500ms non-default value doc-comments-watcher.ts uses for the SAME
 *  reason (review 2, F13): chokidar's own 2000ms default
 *  `awaitWriteFinish.stabilityThreshold` alone would consume most of the MCP
 *  script's poll budget before this watcher even reacted. The MCP script's
 *  own request write is a single atomic rename (never a partial write this
 *  watcher could observe mid-flight), so this could in principle be 0 — a
 *  small threshold is kept anyway as cheap insurance against a future
 *  request-writer that isn't purely atomic, at a cost the poll budget (8s
 *  default, benchmarked — claude-code-doc-comments-mcp.ts) comfortably
 *  affords. */
const STABILITY_THRESHOLD_MS = 200;

/** Defense-in-depth margin for the pre-existing-file check (see this file's
 *  own header, finding #1) — generous on purpose: the token check is the
 *  real boundary, so this only needs to catch an OBVIOUSLY stale file
 *  without false-refusing a genuine near-simultaneous write at session
 *  start. */
const FRESHNESS_MARGIN_MS = 5000;

/** How long an orphaned `.result.json` may sit before a sweep removes it
 *  (finding #4) — the MCP script's own poll bound is 8s by default, so
 *  anything still here minutes later was never going to be read by a live
 *  script; mirrors `cas-write.ts`'s own `sweepStaleTmp`/`STALE_TMP_MS`
 *  precedent (an hour, comfortably longer than any real wait) rather than
 *  inventing a new number. */
const STALE_RESULT_MS = 60 * 60 * 1000;

interface Entry {
  watcher: FSWatcher | null;
  realRoot: string;
  refs: Map<string, string>; // Claude Code session id -> that session's own request token
  pendingDir: string;
  inFlight: Set<string>; // request ids currently being applied — guards a duplicate chokidar 'add'
  startedAt: number;
  stopped: boolean;
}

const entries = new Map<string, Entry>(); // realpathed project root -> entry

function isRequestFile(absPath: string): boolean {
  return absPath.endsWith('.json') && !absPath.endsWith('.result.json');
}

function requestIdFromPath(absPath: string): string {
  return path.basename(absPath, '.json');
}

/** Constant-time string compare via `crypto.timingSafeEqual` — both sides
 *  are fixed-length hex tokens (`deployClaudeCodeDocCommentsMcp` mints
 *  32-hex-char values), but a forged or malformed request's `token` field
 *  could be any length or type, so length/type are checked BEFORE calling
 *  `timingSafeEqual` (which throws on a length mismatch) rather than after —
 *  the length itself is not secret, only the token's content is. */
function tokensMatch(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** True when `req.token` matches ANY session currently sharing this entry's
 *  queue — several Claude Code sessions can share one project root, each
 *  with its own independently-generated token. */
function hasValidToken(entry: Entry, req: PendingMutationRequest): boolean {
  for (const token of entry.refs.values()) {
    if (tokensMatch(req.token, token)) return true;
  }
  return false;
}

/** Applies one request through the SAME dispatch functions the desktop IPC
 *  surface and native tools use — never a second, queue-specific copy of
 *  "how to write a docx/xlsx comment." `trustedProjectRoot` is ALWAYS the
 *  watcher's own verified `entry.realRoot` — see this file's own header,
 *  finding #1: `req.projectRoot` (self-reported, unauthenticated) is never
 *  used for authorization, and is not even read here. */
/** Finish plan Task 6: the file is open in Office and its editor could not take the change yet
 *  (still opening, or busy); the change is kept and made as soon as it can be (live-comments.ts).
 *  The assistant is told so (claude-code-doc-comments-mcp.ts) rather than told it failed. */
const isQueued = (r: object): boolean => 'queued' in r && (r as { queued?: unknown }).queued === true;

async function applyRequest(req: PendingMutationRequest, trustedProjectRoot: string): Promise<PendingMutationResult> {
  const format: NativeFormat = req.format;
  const base = { path: req.path, projectRoot: trustedProjectRoot };
  if (req.kind === 'list') {
    const result = await listNativeComments(format, base);
    return result.ok ? { ok: true, comments: result.comments } : { ok: false, error: result.error };
  }
  if (req.kind === 'add') {
    const args = { ...base, selector: req.selector!, text: req.text ?? '', author: req.author ?? 'assistant' };
    const result = format === 'docx' ? await addNativeDocxComment(args) : await addNativeXlsxComment(args);
    if (isQueued(result)) return { ok: true, queued: true };
    return result.ok ? { ok: true, id: (result as { id: string }).id } : { ok: false, error: result.error };
  }
  if (req.kind === 'reply') {
    const args = { ...base, id: req.commentId!, text: req.text ?? '', author: req.author ?? 'assistant' };
    const result = format === 'docx' ? await replyToNativeDocxComment(args) : await replyToNativeXlsxComment(args);
    if (isQueued(result)) return { ok: true, queued: true };
    if (!result.ok) return { ok: false, error: result.error };
    // Design commit 6c612cb9 (§1.5/§1.6/§7): a reply's ordinal id can't be
    // pre-computed client-side, so the persisted CommentReply is meant to
    // ride the response once docx-comments.ts's/xlsx-comments.ts's own reply
    // function is enriched to return it (T3's own row owns that upstream
    // change, not this one). `result` doesn't declare a `reply` field today
    // (it still returns a bare `{ok:true}`) — this narrow, well-scoped cast
    // is how this queue forwards it the moment it DOES appear, without
    // needing a second edit here when that upstream change lands, and is a
    // no-op today (`reply` reads `undefined`, so this returns plain
    // `{ok:true}` exactly as before).
    const reply = (result as { ok: true; reply?: CommentReply }).reply;
    return reply !== undefined ? { ok: true, reply } : { ok: true };
  }
  if (req.kind === 'resolve') {
    const args = { ...base, id: req.commentId!, by: req.author ?? 'assistant' };
    const result = format === 'docx' ? await resolveNativeDocxComment(args) : await resolveNativeXlsxComment(args);
    if (isQueued(result)) return { ok: true, queued: true };
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  if (req.kind === 'reopen') {
    const args = { ...base, id: req.commentId!, by: req.author ?? 'assistant' };
    const result = format === 'docx' ? await reopenNativeDocxComment(args) : await reopenNativeXlsxComment(args);
    if (isQueued(result)) return { ok: true, queued: true };
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  if (req.kind === 'move') {
    const args = { ...base, id: req.commentId!, newSelector: req.newSelector! };
    const result = format === 'docx' ? await moveNativeDocxComment(args) : await moveNativeXlsxComment(args);
    if (isQueued(result)) return { ok: true, queued: true };
    if (!result.ok) return { ok: false, error: result.error };
    // Code review 2026-09-27, desktop F1: an xlsx move's OWN id changes (its
    // old id's embedded-cell hint goes stale the instant the comment moves —
    // xlsx-comments.ts's own WHY on `moveNativeXlsxComment`'s return type),
    // and this queue is one of only two real callers of that function
    // (the other is MoveCommentTool.execute, fixed alongside this). Before
    // this fix, the fresh id was computed and then silently dropped right
    // here, so a follow-up Reply/Resolve on the same comment always paid for
    // the full-workbook fallback scan the fix existed to avoid — the
    // optimization was dead at both of its call sites. `moveNativeDocxComment`
    // never sets `id` (a docx comment's id doesn't embed position, so it
    // never changes), so the narrow cast below reads `undefined` there and
    // this returns plain `{ok:true}` exactly as before — same no-op-when-
    // absent shape as the adjacent 'reply' branch's own `result.reply` cast.
    const id = (result as { ok: true; id?: string }).id;
    return id !== undefined ? { ok: true, id } : { ok: true };
  }
  // Adversarial review 2026-09-27, finding #3: an unrecognized or malformed
  // `kind` (a bug in a future caller, a truncated/corrupted write racing the
  // rename, or a forged request that didn't even bother with a real kind)
  // gets an honest, typed refusal — never silently falls through into the
  // `move` path with `req.commentId`/`req.newSelector` as `undefined`.
  return { ok: false, error: 'unknown-mutation-kind' };
}

/** Writes the result via the SAME mkdir-lock-plus-atomic-rename primitive
 *  every other write in this feature uses — no real contention exists on a
 *  freshly-and-uniquely-named result file, but reusing the shared primitive
 *  (rather than a bespoke `fs.writeFile`) keeps this one file fsync'd and
 *  torn-write-free the same way every sidecar write already is. */
async function writeResult(resultPath: string, result: PendingMutationResult): Promise<void> {
  await mutateFileUnderLock(resultPath, () => JSON.stringify(result));
}

/** Adversarial review 2026-09-27, finding #4: `.result.json` is otherwise
 *  only ever deleted by the MCP script's OWN successful poll — if that
 *  script gave up (its own timeout) or its whole process was killed (the
 *  session ended) before reading a slow request's result, nothing else ever
 *  removes the file. Best-effort, never blocks or fails request handling. */
async function sweepStaleResults(pendingDir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(pendingDir);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(names
    // Also leftover requests (a session killed mid-wait) and claims (the app
    // killed mid-apply, or a malformed request set aside) — an hour old is
    // never still wanted, and they otherwise pile up in the project folder.
    .filter((name) => name.endsWith('.json') || name.endsWith('.claimed'))
    .map(async (name) => {
      const full = path.join(pendingDir, name);
      try {
        const stat = await fs.stat(full);
        if (now - stat.mtimeMs > STALE_RESULT_MS) await fs.unlink(full);
      } catch {
        // vanished, or a races-with-someone-else's-unlink — nothing to sweep
      }
    }));
}

/** Finding #1's defense-in-depth freshness check — see this file's own
 *  header for why this is weak ALONE (git-checkout mtimes) and why the token
 *  check above it is the real boundary. */
async function isFreshEnough(entry: Entry, absPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    return stat.mtimeMs >= entry.startedAt - FRESHNESS_MARGIN_MS;
  } catch {
    return false; // vanished before we could even check — nothing to process
  }
}

async function handleNewRequest(entry: Entry, absPath: string): Promise<void> {
  const id = requestIdFromPath(absPath);
  if (entry.inFlight.has(id)) return; // a duplicate chokidar 'add' for the same file
  entry.inFlight.add(id);
  try {
    if (!(await isFreshEnough(entry, absPath))) {
      // Pre-existing at watcher start (or vanished) — never processed, and
      // left in place rather than guessed at: a legitimate cold-start race
      // is covered by FRESHNESS_MARGIN_MS; anything older is either a
      // planted file (finding #1) or genuinely stale litter a future sweep
      // handles. Deleting it here would be indistinguishable, from a
      // security standpoint, from silently applying a stale one.
      return;
    }
    // Claim before acting (2026-09-28 PR review): renaming `<id>.json` to
    // `<id>.claimed` is atomic, so exactly one side wins. When the MCP script
    // times out it withdraws its request by deleting `<id>.json`; if that
    // happened first, this rename fails and nothing is applied. Before, a
    // slow request was applied AFTER the assistant had been told it failed,
    // so its retry posted the same comment or reply twice.
    const claimedPath = path.join(entry.pendingDir, `${id}.claimed`);
    try {
      await fs.rename(absPath, claimedPath);
    } catch {
      return; // withdrawn by its sender, or vanished — nothing to do
    }
    let raw: string;
    try {
      raw = await fs.readFile(claimedPath, 'utf8');
    } catch {
      return;
    }
    let req: PendingMutationRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      // Malformed request: no `id` we can trust to build a result path from
      // safely, so this is a silent drop rather than a guessed response — the
      // MCP script's own poll times out and reports an honest, generic
      // failure rather than hanging forever.
      await fs.unlink(claimedPath).catch(() => { /* already gone */ });
      return;
    }
    const resultPath = path.join(entry.pendingDir, `${req.id}.result.json`);
    let result: PendingMutationResult;
    if (!hasValidToken(entry, req)) {
      // Finding #1: the REAL authorization boundary. A mismatched or
      // missing token means this file did not come from a session this
      // queue is currently serving — refuse honestly (a live, legitimate
      // caller whose token somehow mismatched due to a real bug gets an
      // informative error instead of a silent hang; a forged request's
      // author already had filesystem write access to the project, so a
      // typed refusal here reveals nothing they didn't already have).
      result = { ok: false, error: 'invalid-request-token' };
    } else {
      try {
        result = await applyRequest(req, entry.realRoot);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : 'apply-failed' };
      }
    }
    await writeResult(resultPath, result);
    await fs.unlink(claimedPath).catch(() => { /* already gone */ });
    void sweepStaleResults(entry.pendingDir);
  } finally {
    entry.inFlight.delete(id);
  }
}

/**
 * Start (or add a ref to) the pending-mutation watcher for `projectRoot` —
 * called once per Claude Code session that gets a doc-comments MCP server
 * (ipc-handlers.ts, on session-manager.ts's `doc-comments-mcp-attached`
 * event), keyed on `sessionId` so `stop` below can drop exactly this
 * session's ref without needing its caller to track a refcount itself.
 * `token` is that session's own request-authentication secret (finding #1),
 * added to `entry.refs` so a request carrying it is accepted for as long as
 * ANY session sharing this root is still alive.
 */
export async function startPendingMutationQueue(sessionId: string, projectRoot: string, token: string): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(projectRoot);
  } catch {
    return; // the project directory vanished before this could start — nothing to watch
  }
  // Never watch the bare OS temp directory itself as a "project" — no real
  // project ever legitimately IS `os.tmpdir()` (a real one always lives in
  // some subdirectory of it, at worst), and several test suites use the bare
  // temp dir as a stand-in "some real, existing directory" for an unrelated
  // session's `cwd` (e.g. ipc-handlers-create-ownership.test.ts's `/tmp`).
  // Without this guard those tests would leave a real, permanent
  // `.youcoded/comments/.pending/` under the machine's actual shared temp
  // root — harmless in content, but exactly the "real output touches a
  // shared, non-disposable directory" class this codebase's test-suite
  // hygiene rule warns against. A genuine Claude Code session's cwd is never
  // literally the temp root either (SessionManager falls back to the user's
  // HOME directory, not the temp dir, when a requested cwd doesn't exist).
  if (realRoot === (await fs.realpath(os.tmpdir()).catch(() => os.tmpdir()))) return;
  // Adversarial review 2026-09-27, finding #1: reuse the SAME allowlist
  // authority every other doc-comments surface gates on, rather than a
  // fourth independently-invented check — mirrors doc-comments-tools.ts's
  // own `gateProjectRoot` (native T8), which passes a session's own live cwd
  // as BOTH the root being checked and its own sole extra allowed root for
  // the identical reason (design §1.4's `useActiveProject.ts` fallback: the
  // assistant must be able to act on the project it is actually running in,
  // registered or not). This is intentionally the SAME shape, not a
  // deeper check invented for this call site.
  const gated = await refuseUnknownProjectRoot(realRoot, [realRoot]);
  if (gated) return;
  const existing = entries.get(realRoot);
  if (existing) {
    existing.refs.set(sessionId, token);
    return;
  }
  const pendingDir = path.join(realRoot, '.youcoded', 'comments', PENDING_SUBDIR);
  const entry: Entry = {
    watcher: null,
    realRoot,
    refs: new Map([[sessionId, token]]),
    pendingDir,
    inFlight: new Set(),
    startedAt: Date.now(),
    stopped: false,
  };
  entries.set(realRoot, entry);
  try { await fs.mkdir(pendingDir, { recursive: true }); } catch { /* best-effort, mirrors doc-comments-watcher.ts */ }
  void sweepStaleResults(pendingDir); // opportunistic, on every watcher start (finding #4)
  try {
    const watcher = chokidar.watch(pendingDir, {
      // Catches a request written a moment before this watcher starts (the
      // MCP script and this queue race to be first at session start) — a
      // fresh session's very first Word/Excel comment must not be missed.
      // `isFreshEnough`'s own margin (above) is what keeps this from also
      // re-processing a genuinely pre-existing, planted file.
      ignoreInitial: false,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: STABILITY_THRESHOLD_MS, pollInterval: 50 },
    });
    // WHY registered BEFORE awaiting 'ready' (bug found while testing this
    // review's own cold-start-race fix): with `ignoreInitial: false`,
    // chokidar fires 'add' for every file already present DURING its
    // initial scan — which happens BEFORE 'ready'. The previous code
    // registered this listener AFTER awaiting 'ready', so a request that won
    // the exact race this option exists to catch was silently dropped (its
    // own event fired into an EventEmitter with no 'add' listener yet) —
    // that race is the ordinary "session just started, assistant's first
    // Word/Excel comment" case, not an edge case.
    watcher.on('add', (absPath: string) => {
      if (isRequestFile(absPath)) void handleNewRequest(entry, absPath);
    });
    watcher.on('error', () => { /* degrade: no live queue processing until the next session start */ });
    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
      watcher.once('error', () => resolve());
    });
    if (entry.stopped) { await watcher.close(); return; }
    entry.watcher = watcher;
  } catch {
    // No live processing — an MCP script's own poll will time out honestly
    // (claude-code-doc-comments-mcp.ts) rather than this throwing into
    // session-manager.ts's own session-creation path.
  }
}

function closeEntry(realRoot: string, entry: Entry): void {
  entry.stopped = true;
  entries.delete(realRoot);
  void entry.watcher?.close().catch(() => { /* already dead */ });
}

/** Drop `sessionId`'s ref; closes the watcher once the last session sharing
 *  this project ends. Called from ipc-handlers.ts's own `session-exit`
 *  listener. */
export async function stopPendingMutationQueue(sessionId: string, projectRoot: string): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(projectRoot);
  } catch {
    return;
  }
  const entry = entries.get(realRoot);
  if (!entry) return;
  entry.refs.delete(sessionId);
  if (entry.refs.size === 0) closeEntry(realRoot, entry);
}

/** Test helper: tear everything down between cases. */
export function __resetPendingMutationQueueForTest(): void {
  for (const [realRoot, entry] of entries) closeEntry(realRoot, entry);
}
