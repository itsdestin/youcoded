// Attaching the six document-comment tools (design
// docs/active/specs/2026-09-26-doc-comments-build-design.md §5, §9) to a
// CLAUDE CODE session — T9a/T9b of the doc-comments build. Sibling to
// claude-code-mcp.ts (SendUserLink): its own server file, its own
// `--mcp-config` entry, deployed alongside it rather than folded into the
// same file (§5.3 allows either; kept separate here because these six tools
// carry real read/write logic — a dependency-free JSON store with its own
// mkdir-lock mutex, plus a pending-mutation queue client for Word/Excel
// targets — where SendUserLink is a single stateless validate-and-reply).
//
// WHY hand-rolled JSON-RPC, zero dependencies, and no template literals
// ANYWHERE in the embedded script (same three constraints as
// claude-code-mcp.ts's LINK_SERVER_JS): this file is executed by a PLAIN node
// process Claude Code spawns per session, with no node_modules beside it on
// either platform, and on Android it runs under Termux (§9.1 point 2). A
// backtick or `${` inside the embedded source would end the outer
// `String.raw` template early or interpolate into it — every string in the
// generated script is built with `+`/`.join(...)`, never a template literal.
//
// --- The permission-gate mechanism (§5.2a, decided option 1) on THIS surface ---
//
// Native tools (T8) get a real per-call `permissionSubject` because they run
// through this app's OWN `decidePermission()`, which knows the session's live
// permission mode. Claude Code's CLI has no equivalent per-argument gate: its
// `--allowedTools` flag pre-approves a TOOL NAME outright, with no way to
// condition that on an argument value — so a bare "allow-list ReplyToComment"
// would ALSO pre-approve it for a Word/Excel target, and "don't allow-list it"
// makes even a plain-text/markdown reply ask every time, contradicting §5.2a's
// "sparingly... frictionless" intent for the common case.
//
// The mechanism this build uses: `ReadFileComments` alone is allow-listed
// (DOC_COMMENTS_MCP_READ_TOOL, session-manager.ts) — a read never mutates
// anything, so it is safe unconditionally, the same posture the native tool's
// `permissionSubject: () => undefined` already gives it. The five mutation
// tools are deliberately NOT allow-listed; instead, main.ts's own
// `hookRelay.on('hook-event', ...)` — the SAME `PermissionRequest` hook path
// that already auto-approves a handful of other categories
// (permission-auto-approve.ts) — recognizes a call to one of them
// (DOC_COMMENTS_MCP_MUTATOR_TOOLS) and reads its OWN `path` argument straight
// out of the hook payload's `tool_input` (present because this is a generic
// hook Claude Code fires for ANY tool it decides needs asking, not a
// bespoke one): when `nativeFormatFor(path)` is `null` (plain-text/markdown/
// code), it auto-approves unconditionally — matching a plain-text mutation's
// "never prompt" requirement regardless of permission mode. When the target IS
// `.docx`/`.xlsx`, this hook deliberately does NOT auto-approve: the call
// falls through to Claude Code's own normal ask, so the user sees the same
// permission card any other unlisted tool would raise.
//
// --- The one gap this mechanism does NOT close (reported, not silently
//     patched, per this task's own instruction to stop and report rather
//     than invent a compromise) ---
//
// §5.2a's wording is "the same tier as Edit/Write... so in accept-edits/
// bypass modes it doesn't [prompt]." That holds for BYPASS: main.ts's own
// comment on this same hook path notes Claude Code's bypass mode already
// skips `PermissionRequest` for ordinary tools (an MCP tool call is not one
// of the handful of categories it still fires for under bypass), so a
// Word/Excel comment mutation is already frictionless there with no code
// needed here. It does NOT hold for ACCEPT-EDITS: that mode's own built-in
// auto-approval is scoped to Claude Code's native Edit/Write/NotebookEdit
// tools specifically — it does not extend to arbitrary MCP tool calls, and
// this app has no live channel carrying a Claude Code CLI session's CURRENT
// permission mode into the main process at all (`session-manager.ts`'s
// `SessionInfo.permissionMode` is written ONCE at spawn — 'bypass' or
// 'normal' — and never updated again; the mode a user cycles to afterward
// with Shift+Tab is detected only by the RENDERER scraping PTY text
// (`App.tsx`'s `permissionModes` map) and is never sent back to main).
// Building a faithful match for accept-edits specifically would mean adding a
// new renderer-to-main channel carrying that PTY-scraped (and therefore
// occasionally stale-for-a-tick, per desktop/CLAUDE.md's own note) mode value
// — real, cross-cutting plumbing well beyond "wire this task's permission
// gate," not a same-shaped fix. Left as a known, reported gap: a Word/Excel
// comment mutation still raises an ordinary permission ask in accept-edits
// mode, where an Edit/Write call to the same file would not.
import fs from 'fs';
import path from 'path';
import {
  DOC_COMMENTS_MCP_SERVER_ID,
  YOUCODED_PROJECT_ROOT_ENV,
  DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV,
  DOC_COMMENTS_MCP_READ_TOOL,
} from '../shared/doc-comments-mcp';
import {
  READ_FILE_COMMENTS_DESCRIPTION,
  REPLY_TO_COMMENT_DESCRIPTION,
  RESOLVE_COMMENT_DESCRIPTION,
  REOPEN_COMMENT_DESCRIPTION,
  ADD_COMMENT_DESCRIPTION,
  MOVE_COMMENT_DESCRIPTION,
} from '../shared/doc-comments-tool-text';

/** The MCP server, verbatim. String.raw so the embedded copy stays free of
 *  backticks/`${` (see this file's own header) — a future Android asset
 *  (T9c) is pinned byte-identical to this constant the same way
 *  claude-code-mcp.test.ts already pins LINK_SERVER_JS. */
export const DOC_COMMENTS_SERVER_JS = String.raw`// YouCoded's document-comments MCP server — the Claude Code half of T9a/T9b
// (docs/active/specs/2026-09-26-doc-comments-build-design.md §5, §9).
//
// WHY dependency-free: this file is executed by a PLAIN node process Claude
// Code spawns — no node_modules beside it on either platform, Termux on
// Android. It re-implements (never imports) the SAME mkdir-lock-plus-atomic-
// rename primitive desktop's cas-write.ts uses for the JSON comment sidecar,
// so this process and the app's main process genuinely exclude each other
// over the same file (§9.1) — ported from real behaviour, not from
// chatsearch.js, which has no mutex anywhere in it (design review 2, F12).
// The atomic tmp-write+rename SHAPE for the pending-mutation queue's request
// files IS chatsearch.js's own outbox precedent (submitRequest): each request
// is uniquely named, so two writers never race the same file there and no
// lock is needed for that half.
'use strict';

var fs = require('fs');
var fsp = fs.promises;
var path = require('path');
var crypto = require('crypto');

var PROTOCOL_FALLBACK = '2025-06-18';
var SERVER_ID = '__SERVER_ID__';
var PROJECT_ROOT = process.env.__PROJECT_ROOT_ENV__ || '';

// ---------------------------------------------------------------------------
// Path containment (design §1.5, review 2 F1's corrected algorithm: realpath
// the FULL joined path, walking up to the nearest existing ancestor for a
// not-yet-existing leaf, never falling through to the raw path on ENOENT).
// This is the SAME algorithm doc-comments-store.ts's TS implementation uses —
// ported here because this process cannot import that module.
// ---------------------------------------------------------------------------
var MAX_WALKUP_DEPTH = 200;

function realpathWithNonexistentTail(targetAbs) {
  return fsp.realpath(targetAbs).catch(function (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    var segments = [];
    var dir = targetAbs;
    function step(depth) {
      if (depth >= MAX_WALKUP_DEPTH) return null;
      var parent = path.dirname(dir);
      if (parent === dir) return null;
      segments.unshift(path.basename(dir));
      return fsp.realpath(parent).then(function (realParent) {
        return path.join.apply(path, [realParent].concat(segments));
      }, function (e2) {
        if (e2.code !== 'ENOENT' && e2.code !== 'ENOTDIR') throw e2;
        dir = parent;
        return step(depth + 1);
      });
    }
    return step(0);
  });
}

function checkContainment(realProjectRoot, abs) {
  return realpathWithNonexistentTail(abs).then(function (realAbs) {
    if (realAbs === null || realAbs === undefined) return null;
    var withSep = realProjectRoot.charAt(realProjectRoot.length - 1) === path.sep
      ? realProjectRoot
      : realProjectRoot + path.sep;
    return realAbs === realProjectRoot || realAbs.indexOf(withSep) === 0 ? realAbs : null;
  });
}

/** Windows strips a trailing '.'/' ' off a path component when it resolves
 *  one (design §3.2's own T8-review citation, F4) — mirrored here so this
 *  script's dispatch decision can never disagree with the main process's. */
function stripWindowsTrailingDotsAndSpaces(filePath) {
  return process.platform === 'win32' ? filePath.replace(/[. ]+$/, '') : filePath;
}

function nativeFormatFor(filePath) {
  var ext = path.extname(stripWindowsTrailingDotsAndSpaces(filePath)).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx') return 'xlsx';
  return null;
}

var SIDECAR_DIR = ['.youcoded', 'comments'];
var PENDING_DIR = ['.youcoded', 'comments', '.pending'];

/** Resolves filePath against the ONE trusted project root this process was
 *  spawned with (env, never model input — see this file's TS header) and
 *  returns every location a caller below needs: the JSON sidecar path, the
 *  realpathed root (for deriving the .pending/ queue path), and the source
 *  file's own containment-verified absolute path (for a docx/xlsx target). */
function locate(filePath) {
  if (!PROJECT_ROOT) {
    return Promise.resolve({ error: 'no-project-root' });
  }
  return fsp.realpath(PROJECT_ROOT).catch(function () {
    return null;
  }).then(function (realProjectRoot) {
    if (!realProjectRoot) return { error: 'path-outside-project' };
    var abs = path.resolve(realProjectRoot, filePath);
    return checkContainment(realProjectRoot, abs).then(function (realAbs) {
      if (realAbs === null) return { error: 'path-outside-project' };
      var rel = path.relative(realProjectRoot, realAbs);
      var sidecarPath = path.join.apply(path, [realProjectRoot].concat(SIDECAR_DIR, [rel + '.json']));
      var pendingDir = path.join.apply(path, [realProjectRoot].concat(PENDING_DIR));
      return { realProjectRoot: realProjectRoot, sidecarPath: sidecarPath, sourceAbsolutePath: realAbs, pendingDir: pendingDir };
    });
  });
}

// ---------------------------------------------------------------------------
// The JSON sidecar's own mkdir-lock + atomic-write mutex — a real,
// independent reimplementation of cas-write.ts's mutateFileUnderLock (design
// §9.1: "the mutual-exclusion half of T9a is novel work, not a port" — the
// SAME algorithm, same constants, so this process and the app's main process
// genuinely exclude each other over the identical lock path).
// ---------------------------------------------------------------------------
var LOCK_RETRY_MS = 10;
var LOCK_MAX_WAIT_MS = 3000;
var LOCK_STALE_MS = 30000;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function acquireLock(lock) {
  var start = Date.now();
  function attempt() {
    return fsp.mkdir(lock).then(function () {
      return true;
    }, function (e) {
      var contention = e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY';
      if (!contention) throw e;
      return fsp.stat(lock).then(function (stat) {
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          return fsp.rm(lock, { recursive: true, force: true }).then(attempt);
        }
        return afterWait();
      }, function () {
        return afterWait();
      });
    });
  }
  function afterWait() {
    if (Date.now() - start > LOCK_MAX_WAIT_MS) return false;
    return sleep(LOCK_RETRY_MS).then(attempt);
  }
  return attempt();
}

function atomicWrite(target, content) {
  var tmp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
  return fsp.writeFile(tmp, content, 'utf8').then(function () {
    return fsp.open(tmp, 'r+');
  }).then(function (fh) {
    return fh.sync().then(function () {
      return fh.close();
    });
  }).then(function () {
    return fsp.rename(tmp, target);
  }).catch(function (e) {
    return fsp.unlink(tmp).catch(function () {}).then(function () {
      throw e;
    });
  });
}

function mutateFileUnderLock(target, mutate) {
  return fsp.mkdir(path.dirname(target), { recursive: true }).then(function () {
    var lock = target + '.lock';
    return acquireLock(lock).then(function (acquired) {
      if (!acquired) return false;
      return fsp.readFile(target, 'utf8').catch(function (e) {
        if (e.code !== 'ENOENT') throw e;
        return null;
      }).then(function (onDisk) {
        var next = mutate(onDisk);
        return Promise.resolve(next).then(function (resolved) {
          if (resolved === null) return true;
          return atomicWrite(target, resolved).then(function () {
            return true;
          });
        });
      }).finally(function () {
        return fsp.rm(lock, { recursive: true, force: true }).catch(function () {});
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The JSON sidecar's own shape (§1.1/§1.3) — hand-copied, this script cannot
// import shared/doc-comments-types.ts.
// ---------------------------------------------------------------------------
function emptySidecar() {
  return { version: 1, comments: [] };
}

function parseSidecar(onDisk) {
  if (onDisk === null) return { ok: true, file: emptySidecar() };
  var parsed;
  try {
    parsed = JSON.parse(onDisk);
  } catch (e) {
    return { ok: false, error: 'sidecar-corrupt' };
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.comments)) {
    return { ok: false, error: 'sidecar-corrupt' };
  }
  return { ok: true, file: parsed };
}

function findComment(file, id) {
  for (var i = 0; i < file.comments.length; i++) {
    if (file.comments[i].id === id) return file.comments[i];
  }
  return undefined;
}

function replaceComment(file, id, next) {
  return {
    version: file.version,
    comments: file.comments.map(function (c) { return c.id === id ? next : c; }),
  };
}

function mutateSidecar(sidecarPath, apply) {
  var outcome = null;
  return mutateFileUnderLock(sidecarPath, function (onDisk) {
    var parsed = parseSidecar(onDisk);
    if (!parsed.ok) {
      outcome = parsed;
      return null;
    }
    var applied = apply(parsed.file);
    if (applied === 'not-found') {
      outcome = { ok: false, error: 'comment-not-found' };
      return null;
    }
    if (!applied.file) {
      outcome = applied;
      return null;
    }
    outcome = { ok: true };
    for (var k in applied.extra) if (Object.prototype.hasOwnProperty.call(applied.extra, k)) outcome[k] = applied.extra[k];
    return JSON.stringify(applied.file);
  }).then(function (acquired) {
    if (!acquired) return { ok: false, error: 'lock-timeout' };
    return outcome;
  });
}

// ---------------------------------------------------------------------------
// The pending-mutation queue client (§9.2, T9b) — for a docx/xlsx target,
// this script "never touches the file directly" (§1.6): it writes a request
// under .youcoded/comments/.pending/<id>.json (atomic tmp-then-rename, no
// lock needed — each request is uniquely named, chatsearch.js's own outbox
// precedent) and polls for the main process's <id>.result.json.
//
// POLL_TIMEOUT_MS is a benchmarked, explicitly-set value (design review 2,
// F13 retracted an earlier, unsupported "~3s" citation): a real add/reply/
// resolve/move round trip against docx-comments.ts (read+parse+mutate+write+
// verify) measured 6-11ms against a 6MB fixture padded with random-content
// media entries (images do not get re-parsed — only the touched XML parts
// do), so 8000ms leaves generous headroom for a slower disk, antivirus
// scanning, or a larger real-world file this session could not fabricate a
// fixture for, while still failing an honest, specific way on a genuine hang
// instead of waiting minutes.
// Overridable via env for tests ONLY (a pinning test proves the queue's own
// bounded-timeout behaviour without a real test waiting out the production
// value) — production launches (session-manager.ts) never set this.
var POLL_TIMEOUT_MS = parseInt(process.env.__POLL_TIMEOUT_ENV__ || '', 10) || 8000;
var POLL_INTERVAL_MS = 50;

function submitPendingMutation(kind, located, fields) {
  var id = crypto.randomUUID();
  var request = {
    id: id,
    kind: kind,
    format: fields.format,
    path: fields.path,
    projectRoot: located.realProjectRoot,
    createdAt: Date.now(),
  };
  if (fields.commentId !== undefined) request.commentId = fields.commentId;
  if (fields.text !== undefined) request.text = fields.text;
  if (fields.author !== undefined) request.author = fields.author;
  if (fields.selector !== undefined) request.selector = fields.selector;
  if (fields.newSelector !== undefined) request.newSelector = fields.newSelector;

  var requestPath = path.join(located.pendingDir, id + '.json');
  var resultPath = path.join(located.pendingDir, id + '.result.json');
  var tmp = requestPath + '.' + process.pid + '.tmp';

  return fsp.mkdir(located.pendingDir, { recursive: true }).then(function () {
    return fsp.writeFile(tmp, JSON.stringify(request), 'utf8');
  }).then(function () {
    return fsp.rename(tmp, requestPath);
  }).then(function () {
    var deadline = Date.now() + POLL_TIMEOUT_MS;
    function poll() {
      return fsp.readFile(resultPath, 'utf8').then(function (raw) {
        return fsp.unlink(resultPath).catch(function () {}).then(function () {
          try {
            return JSON.parse(raw);
          } catch (e) {
            return { ok: false, error: 'malformed-result' };
          }
        });
      }, function (e) {
        if (e.code !== 'ENOENT') throw e;
        if (Date.now() >= deadline) {
          return {
            ok: false,
            error: 'timed-out — YouCoded did not finish applying this within '
              + (POLL_TIMEOUT_MS / 1000) + 's. It may still complete; try ReadFileComments again in a moment.',
          };
        }
        return sleep(POLL_INTERVAL_MS).then(poll);
      });
    }
    return poll();
  });
}

// ---------------------------------------------------------------------------
// The six operations. Every one resolves the target first (project
// containment, §1.5) and then either touches the JSON sidecar directly (a
// plain-text/markdown/code target) or submits a pending-mutation request (a
// docx/xlsx target, §9.2) — the SAME by-extension dispatch decision every
// other surface in this feature makes (doc-comments-dispatch.ts's own
// nativeFormatFor, ported above).
// ---------------------------------------------------------------------------
function readFileComments(args) {
  return locate(args.path).then(function (located) {
    if (located.error) return { ok: false, error: located.error };
    var format = nativeFormatFor(args.path);
    if (format) {
      return submitPendingMutation('list', located, { format: format, path: args.path });
    }
    return fsp.readFile(located.sidecarPath, 'utf8').catch(function (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }).then(function (raw) {
      var parsed = parseSidecar(raw);
      if (!parsed.ok) return parsed;
      return { ok: true, comments: parsed.file.comments };
    });
  });
}

function replyToComment(args) {
  return locate(args.path).then(function (located) {
    if (located.error) return { ok: false, error: located.error };
    var format = nativeFormatFor(args.path);
    if (format) {
      return submitPendingMutation('reply', located, {
        format: format, path: args.path, commentId: args.commentId, text: args.text, author: 'assistant',
      });
    }
    return mutateSidecar(located.sidecarPath, function (file) {
      var comment = findComment(file, args.commentId);
      if (!comment) return 'not-found';
      var replyId = comment.id + '-r' + (comment.replies.length + 1);
      var next = {};
      for (var k in comment) if (Object.prototype.hasOwnProperty.call(comment, k)) next[k] = comment[k];
      next.replies = comment.replies.concat([{ id: replyId, author: 'assistant', text: args.text, createdAt: Date.now() }]);
      return { file: replaceComment(file, args.commentId, next), extra: {} };
    });
  });
}

function resolveComment(args) {
  return locate(args.path).then(function (located) {
    if (located.error) return { ok: false, error: located.error };
    var format = nativeFormatFor(args.path);
    if (format) {
      return submitPendingMutation('resolve', located, { format: format, path: args.path, commentId: args.commentId, author: 'assistant' });
    }
    return mutateSidecar(located.sidecarPath, function (file) {
      var comment = findComment(file, args.commentId);
      if (!comment) return 'not-found';
      var next = {};
      for (var k in comment) if (Object.prototype.hasOwnProperty.call(comment, k)) next[k] = comment[k];
      next.resolved = true;
      next.history = comment.history.concat([{ by: 'assistant', at: Date.now(), action: 'resolved' }]);
      return { file: replaceComment(file, args.commentId, next), extra: {} };
    });
  });
}

function reopenComment(args) {
  return locate(args.path).then(function (located) {
    if (located.error) return { ok: false, error: located.error };
    var format = nativeFormatFor(args.path);
    if (format) {
      return submitPendingMutation('reopen', located, { format: format, path: args.path, commentId: args.commentId, author: 'assistant' });
    }
    return mutateSidecar(located.sidecarPath, function (file) {
      var comment = findComment(file, args.commentId);
      if (!comment) return 'not-found';
      var next = {};
      for (var k in comment) if (Object.prototype.hasOwnProperty.call(comment, k)) next[k] = comment[k];
      next.resolved = false;
      next.history = comment.history.concat([{ by: 'assistant', at: Date.now(), action: 'reopened' }]);
      return { file: replaceComment(file, args.commentId, next), extra: {} };
    });
  });
}

function addComment(args) {
  return locate(args.path).then(function (located) {
    if (located.error) return { ok: false, error: located.error };
    var format = nativeFormatFor(args.path);
    if (format) {
      return submitPendingMutation('add', located, {
        format: format, path: args.path, selector: args.selector, text: args.text, author: 'assistant',
      });
    }
    var id = 'c-' + crypto.randomUUID();
    var comment = {
      id: id, path: args.path, selector: args.selector, text: args.text, author: 'assistant',
      createdAt: Date.now(), replies: [], resolved: false, history: [],
    };
    return mutateSidecar(located.sidecarPath, function (file) {
      return { file: { version: file.version, comments: file.comments.concat([comment]) }, extra: { id: id } };
    });
  });
}

function moveComment(args) {
  return locate(args.path).then(function (located) {
    if (located.error) return { ok: false, error: located.error };
    var format = nativeFormatFor(args.path);
    if (format) {
      return submitPendingMutation('move', located, { format: format, path: args.path, commentId: args.commentId, newSelector: args.newSelector });
    }
    return mutateSidecar(located.sidecarPath, function (file) {
      var comment = findComment(file, args.commentId);
      if (!comment) return 'not-found';
      var next = {};
      for (var k in comment) if (Object.prototype.hasOwnProperty.call(comment, k)) next[k] = comment[k];
      next.selector = args.newSelector;
      return { file: replaceComment(file, args.commentId, next), extra: {} };
    });
  });
}

// ---------------------------------------------------------------------------
// Tool definitions — descriptions copied VERBATIM from
// shared/doc-comments-tool-text.ts (this process cannot import it; a pinning
// test asserts the two copies agree). AddComment's wording is R4's own
// signed constraint (§5.1) — never paraphrased.
// ---------------------------------------------------------------------------
var TEXT_QUOTE_SELECTOR_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['TextQuoteSelector'] },
    exact: { type: 'string', description: 'The exact text being commented on.' },
    prefix: { type: 'string', description: '~32 chars of context immediately before the quote (whitespace-collapsed).' },
    suffix: { type: 'string', description: '~32 chars of context immediately after the quote (whitespace-collapsed).' },
    occurrence: { type: 'integer', minimum: 0, description: '0-indexed: which match of "exact" in the document this is.' },
  },
  required: ['type', 'exact', 'prefix', 'suffix', 'occurrence'],
  additionalProperties: false,
};

var CELL_SELECTOR_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['CellSelector'] },
    cell: { type: 'string', description: 'Spreadsheet cell reference, e.g. "C4".' },
    sheet: { type: 'string', description: 'Sheet tab name; omit if the workbook has only one sheet.' },
  },
  required: ['type', 'cell'],
  additionalProperties: false,
};

var COMMENT_SELECTOR_SCHEMA = {
  description: 'Where the comment attaches: a text quote (with surrounding context) for prose files, or a cell for spreadsheets.',
  oneOf: [
    { type: 'object', properties: { kind: { const: 'text' }, selector: TEXT_QUOTE_SELECTOR_SCHEMA }, required: ['kind', 'selector'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'cell' }, selector: CELL_SELECTOR_SCHEMA }, required: ['kind', 'selector'], additionalProperties: false },
  ],
};

var PATH_PROP = { type: 'string', description: 'Absolute or workspace-relative path of the commented file.' };
var COMMENT_ID_PROP = { type: 'string', description: 'The comment id — from a prior ReadFileComments call, or a reference the user handed you.' };

var TOOLS = [
  {
    name: 'ReadFileComments',
    description: '__READ_FILE_COMMENTS_DESCRIPTION__',
    inputSchema: { type: 'object', properties: { path: PATH_PROP }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'ReplyToComment',
    description: '__REPLY_TO_COMMENT_DESCRIPTION__',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP, commentId: COMMENT_ID_PROP, text: { type: 'string', description: 'The reply text.' } },
      required: ['path', 'commentId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ResolveComment',
    description: '__RESOLVE_COMMENT_DESCRIPTION__',
    inputSchema: { type: 'object', properties: { path: PATH_PROP, commentId: COMMENT_ID_PROP }, required: ['path', 'commentId'], additionalProperties: false },
  },
  {
    name: 'ReopenComment',
    description: '__REOPEN_COMMENT_DESCRIPTION__',
    inputSchema: { type: 'object', properties: { path: PATH_PROP, commentId: COMMENT_ID_PROP }, required: ['path', 'commentId'], additionalProperties: false },
  },
  {
    name: 'AddComment',
    description: '__ADD_COMMENT_DESCRIPTION__',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP, selector: COMMENT_SELECTOR_SCHEMA, text: { type: 'string', description: 'The comment text.' } },
      required: ['path', 'selector', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'MoveComment',
    description: '__MOVE_COMMENT_DESCRIPTION__',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP, commentId: COMMENT_ID_PROP, newSelector: COMMENT_SELECTOR_SCHEMA },
      required: ['path', 'commentId', 'newSelector'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC framing — same shape as claude-code-mcp.ts's LINK_SERVER_JS.
// ---------------------------------------------------------------------------
function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function replyResult(id, res) {
  write({ jsonrpc: '2.0', id: id, result: res });
}
function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}
function messageOf(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  return 'unknown error';
}

function textResult(text, isError) {
  return { content: [{ type: 'text', text: text }], isError: !!isError };
}

function formatOpError(name, result) {
  var detail = typeof result.error === 'string' ? result.error : 'unknown error';
  return textResult(name + ' failed: ' + detail, true);
}

function requireString(args, field) {
  return typeof args === 'object' && args !== null && typeof args[field] === 'string' && args[field].length > 0;
}

function callTool(id, params) {
  var name = params && params.name;
  var args = (params && params.arguments) || {};
  var tool = null;
  for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].name === name) tool = TOOLS[i];
  if (!tool) {
    replyError(id, -32602, 'Unknown tool: ' + String(name));
    return;
  }

  var handler = null;
  if (name === 'ReadFileComments') {
    handler = requireString(args, 'path')
      ? readFileComments(args).then(function (r) {
          if (!r.ok) return formatOpError('ReadFileComments', r);
          if (!r.comments || r.comments.length === 0) return textResult('No comments on ' + args.path + '.');
          return textResult(r.comments.length + ' comment(s) on ' + args.path + ' (JSON):\n' + JSON.stringify(r.comments, null, 2));
        })
      : Promise.resolve(textResult('ReadFileComments failed: path is required.', true));
  } else if (name === 'ReplyToComment') {
    handler = (requireString(args, 'path') && requireString(args, 'commentId') && requireString(args, 'text'))
      ? replyToComment(args).then(function (r) {
          if (!r.ok) return formatOpError('ReplyToComment', r);
          // A docx/xlsx reply's queue result MAY carry the persisted
          // CommentReply once docx-comments.ts's/xlsx-comments.ts's own reply
          // function returns one (its ordinal id can't be pre-computed) —
          // included here when present, never assumed.
          var replyId = r.reply && r.reply.id ? r.reply.id : null;
          return textResult((replyId ? 'Reply ' + replyId + ' added' : 'Reply added') + ' to comment ' + args.commentId + ' on ' + args.path + '.');
        })
      : Promise.resolve(textResult('ReplyToComment failed: path, commentId and text are required.', true));
  } else if (name === 'ResolveComment') {
    handler = (requireString(args, 'path') && requireString(args, 'commentId'))
      ? resolveComment(args).then(function (r) {
          return r.ok ? textResult('Comment ' + args.commentId + ' on ' + args.path + ' marked resolved.') : formatOpError('ResolveComment', r);
        })
      : Promise.resolve(textResult('ResolveComment failed: path and commentId are required.', true));
  } else if (name === 'ReopenComment') {
    handler = (requireString(args, 'path') && requireString(args, 'commentId'))
      ? reopenComment(args).then(function (r) {
          return r.ok ? textResult('Comment ' + args.commentId + ' on ' + args.path + ' reopened.') : formatOpError('ReopenComment', r);
        })
      : Promise.resolve(textResult('ReopenComment failed: path and commentId are required.', true));
  } else if (name === 'AddComment') {
    handler = (requireString(args, 'path') && args.selector && typeof args.selector === 'object' && requireString(args, 'text'))
      ? addComment(args).then(function (r) {
          return r.ok ? textResult('Comment added to ' + args.path + ' (id: ' + r.id + ').') : formatOpError('AddComment', r);
        })
      : Promise.resolve(textResult('AddComment failed: path, selector and text are required.', true));
  } else if (name === 'MoveComment') {
    handler = (requireString(args, 'path') && requireString(args, 'commentId') && args.newSelector && typeof args.newSelector === 'object')
      ? moveComment(args).then(function (r) {
          return r.ok ? textResult('Comment ' + args.commentId + ' on ' + args.path + ' repointed.') : formatOpError('MoveComment', r);
        })
      : Promise.resolve(textResult('MoveComment failed: path, commentId and newSelector are required.', true));
  } else {
    // Defensive: unreachable while TOOLS and this if-chain agree on names —
    // never leaves a request unanswered if they ever drift.
    handler = Promise.resolve(textResult('Internal error: no handler wired for ' + name + '.', true));
  }

  handler.then(function (result) {
    replyResult(id, result);
  }, function (err) {
    replyResult(id, textResult(name + ' failed: ' + messageOf(err), true));
  });
}

function handle(msg) {
  var id = msg.id;
  var method = msg.method;
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    var asked = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_FALLBACK;
    replyResult(id, {
      protocolVersion: asked,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_ID, version: '1.0.0' },
    });
    return;
  }
  if (method === 'ping') { replyResult(id, {}); return; }
  if (method === 'tools/list') { replyResult(id, { tools: TOOLS }); return; }
  if (method === 'tools/call') { callTool(id, msg.params); return; }
  replyError(id, -32601, 'Unknown method: ' + String(method));
}

var buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buffer += chunk;
  var idx = buffer.indexOf('\n');
  while (idx >= 0) {
    var line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.length) {
      var msg = null;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        process.stderr.write('doc-comments-mcp: ignoring unparseable line: ' + messageOf(err) + '\n');
      }
      if (msg && typeof msg === 'object') handle(msg);
    }
    idx = buffer.indexOf('\n');
  }
});
process.stdin.on('end', function () { process.exit(0); });
process.stdout.on('error', function () { process.exit(0); });
`
  .replace(/__SERVER_ID__/g, DOC_COMMENTS_MCP_SERVER_ID)
  .replace(/__PROJECT_ROOT_ENV__/g, YOUCODED_PROJECT_ROOT_ENV)
  .replace(/__POLL_TIMEOUT_ENV__/g, DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV)
  .replace('__READ_FILE_COMMENTS_DESCRIPTION__', jsStringEscape(READ_FILE_COMMENTS_DESCRIPTION))
  .replace('__REPLY_TO_COMMENT_DESCRIPTION__', jsStringEscape(REPLY_TO_COMMENT_DESCRIPTION))
  .replace('__RESOLVE_COMMENT_DESCRIPTION__', jsStringEscape(RESOLVE_COMMENT_DESCRIPTION))
  .replace('__REOPEN_COMMENT_DESCRIPTION__', jsStringEscape(REOPEN_COMMENT_DESCRIPTION))
  .replace('__ADD_COMMENT_DESCRIPTION__', jsStringEscape(ADD_COMMENT_DESCRIPTION))
  .replace('__MOVE_COMMENT_DESCRIPTION__', jsStringEscape(MOVE_COMMENT_DESCRIPTION));

/** Escapes a description string for embedding inside a single-quoted JS
 *  string literal in the template above — every description text is plain
 *  prose (no backticks, no `${`, by construction of
 *  shared/doc-comments-tool-text.ts) but DOES contain apostrophes, which this
 *  substitution must not let break out of the surrounding quotes. */
function jsStringEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export interface DocCommentsMcpDeployment {
  serverPath: string;
  configPath: string;
  /** The tool name(s) safe to pre-approve unconditionally — just
   *  `ReadFileComments`; the five mutation tools are deliberately absent (see
   *  this file's own header). */
  allowedTools: string[];
}

/** Own subdirectory, mirroring claude-code-mcp.ts's CLAUDE_CODE_MCP_DIR — its
 *  own folder so both deployments can be wiped/inspected independently. */
export const DOC_COMMENTS_MCP_DIR = 'claude-code-doc-comments-mcp';

/**
 * Write the server + its config under `baseDir` and return what
 * session-manager.ts needs to attach it to one Claude Code session:
 * `configPath` (for `--mcp-config`) and `allowedTools` (for `--allowedTools`
 * — session-manager.ts combines this with SendUserLink's own tool name into
 * ONE `--allowedTools` flag; see its own comment for why, and this file's
 * header for why the five mutation tools are never in this list).
 *
 * `projectRoot` becomes the ONE trusted root every tool call on this surface
 * is contained to (§1.5) — baked into the deployed config's `env`, not read
 * from any tool argument, so this surface has no "unknown project root"
 * attack surface for a model-controlled value to exploit.
 */
export function deployClaudeCodeDocCommentsMcp(
  baseDir: string,
  nodePath: string,
  projectRoot: string
): DocCommentsMcpDeployment {
  const dir = path.join(baseDir, DOC_COMMENTS_MCP_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const serverPath = path.join(dir, 'doc-comments-mcp.js');
  fs.writeFileSync(serverPath, DOC_COMMENTS_SERVER_JS, 'utf8');

  const configPath = path.join(dir, 'mcp-config.json');
  const config = {
    mcpServers: {
      [DOC_COMMENTS_MCP_SERVER_ID]: {
        type: 'stdio',
        command: nodePath,
        args: [serverPath],
        env: { [YOUCODED_PROJECT_ROOT_ENV]: projectRoot },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  return { serverPath, configPath, allowedTools: [DOC_COMMENTS_MCP_READ_TOOL] };
}
