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
// lifecycle (wired in session-manager.ts, mirroring how that same module
// already computes the one project root a session's doc-comments MCP server
// is deployed with) — refcounted the same way, so two sessions sharing one
// project share ONE watcher, and it closes once the last such session ends.
// doc-comments-watcher.ts's own instance separately ignores `**/.pending/**`
// (review 2, F20) specifically so its UI-facing debounced push is never
// confused by this queue's own create-then-delete file churn.
import chokidar, { FSWatcher } from 'chokidar';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
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

interface Entry {
  watcher: FSWatcher | null;
  refs: Set<string>; // Claude Code session ids
  pendingDir: string;
  inFlight: Set<string>; // request ids currently being applied — guards a duplicate chokidar 'add'
  stopped: boolean;
}

const entries = new Map<string, Entry>(); // realpathed project root -> entry

function isRequestFile(absPath: string): boolean {
  return absPath.endsWith('.json') && !absPath.endsWith('.result.json');
}

function requestIdFromPath(absPath: string): string {
  return path.basename(absPath, '.json');
}

/** Applies one request through the SAME dispatch functions the desktop IPC
 *  surface and native tools use — never a second, queue-specific copy of
 *  "how to write a docx/xlsx comment." */
async function applyRequest(req: PendingMutationRequest): Promise<PendingMutationResult> {
  const format: NativeFormat = req.format;
  const base = { path: req.path, projectRoot: req.projectRoot };
  if (req.kind === 'list') {
    const result = await listNativeComments(format, base);
    return result.ok ? { ok: true, comments: result.comments } : { ok: false, error: result.error };
  }
  if (req.kind === 'add') {
    const args = { ...base, selector: req.selector!, text: req.text ?? '', author: req.author ?? 'assistant' };
    const result = format === 'docx' ? await addNativeDocxComment(args) : await addNativeXlsxComment(args);
    return result.ok ? { ok: true, id: result.id } : { ok: false, error: result.error };
  }
  if (req.kind === 'reply') {
    const args = { ...base, id: req.commentId!, text: req.text ?? '', author: req.author ?? 'assistant' };
    const result = format === 'docx' ? await replyToNativeDocxComment(args) : await replyToNativeXlsxComment(args);
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
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  if (req.kind === 'reopen') {
    const args = { ...base, id: req.commentId!, by: req.author ?? 'assistant' };
    const result = format === 'docx' ? await reopenNativeDocxComment(args) : await reopenNativeXlsxComment(args);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  // 'move'
  const args = { ...base, id: req.commentId!, newSelector: req.newSelector! };
  const result = format === 'docx' ? await moveNativeDocxComment(args) : await moveNativeXlsxComment(args);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Writes the result via the SAME mkdir-lock-plus-atomic-rename primitive
 *  every other write in this feature uses — no real contention exists on a
 *  freshly-and-uniquely-named result file, but reusing the shared primitive
 *  (rather than a bespoke `fs.writeFile`) keeps this one file fsync'd and
 *  torn-write-free the same way every sidecar write already is. */
async function writeResult(resultPath: string, result: PendingMutationResult): Promise<void> {
  await mutateFileUnderLock(resultPath, () => JSON.stringify(result));
}

async function handleNewRequest(entry: Entry, absPath: string): Promise<void> {
  const id = requestIdFromPath(absPath);
  if (entry.inFlight.has(id)) return; // a duplicate chokidar 'add' for the same file
  entry.inFlight.add(id);
  try {
    let raw: string;
    try {
      raw = await fs.readFile(absPath, 'utf8');
    } catch {
      return; // vanished (already handled, or the writer's rename hadn't landed yet) — nothing to do
    }
    let req: PendingMutationRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      // Malformed request: no `id` we can trust to build a result path from
      // safely, so this is a silent drop rather than a guessed response — the
      // MCP script's own poll times out and reports an honest, generic
      // failure rather than hanging forever.
      return;
    }
    const resultPath = path.join(entry.pendingDir, `${req.id}.result.json`);
    let result: PendingMutationResult;
    try {
      result = await applyRequest(req);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : 'apply-failed' };
    }
    await writeResult(resultPath, result);
    await fs.unlink(absPath).catch(() => { /* already gone */ });
  } finally {
    entry.inFlight.delete(id);
  }
}

/**
 * Start (or add a ref to) the pending-mutation watcher for `projectRoot` —
 * called once per Claude Code session that gets a doc-comments MCP server
 * (session-manager.ts, at spawn), keyed on `sessionId` so `stop` below can
 * drop exactly this session's ref without needing its caller to track a
 * refcount itself.
 */
export async function startPendingMutationQueue(sessionId: string, projectRoot: string): Promise<void> {
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
  const existing = entries.get(realRoot);
  if (existing) {
    existing.refs.add(sessionId);
    return;
  }
  const pendingDir = path.join(realRoot, '.youcoded', 'comments', PENDING_SUBDIR);
  const entry: Entry = { watcher: null, refs: new Set([sessionId]), pendingDir, inFlight: new Set(), stopped: false };
  entries.set(realRoot, entry);
  try { await fs.mkdir(pendingDir, { recursive: true }); } catch { /* best-effort, mirrors doc-comments-watcher.ts */ }
  try {
    const watcher = chokidar.watch(pendingDir, {
      // Catches a request written a moment before this watcher starts (the
      // MCP script and this queue race to be first at session start) — a
      // fresh session's very first Word/Excel comment must not be missed.
      ignoreInitial: false,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: STABILITY_THRESHOLD_MS, pollInterval: 50 },
    });
    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
      watcher.once('error', () => resolve());
    });
    if (entry.stopped) { await watcher.close(); return; }
    watcher.on('add', (absPath: string) => {
      if (isRequestFile(absPath)) void handleNewRequest(entry, absPath);
    });
    watcher.on('error', () => { /* degrade: no live queue processing until the next session start */ });
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
 *  this project ends. Called from session-manager.ts's `destroySession`. */
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
