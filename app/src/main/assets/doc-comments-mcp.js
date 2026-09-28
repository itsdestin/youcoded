// YouCoded's document-comments MCP server — the Claude Code half of T9a/T9b
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
// Cosmetic only (shown in /mcp) — the actual mcp__{server}__{tool} prefix
// Claude Code composes comes from the --mcp-config file's OWN mcpServers
// key (a fresh random value per deployment, deployClaudeCodeDocCommentsMcp),
// never from this string. See this file's TS header, finding #2.
var SERVER_ID = 'youcoded-doc-comments';
var PROJECT_ROOT = process.env.YOUCODED_PROJECT_ROOT || '';
// This session's own per-deployment secret (finding #1) — included on every
// pending-mutation request so the main-process queue can refuse anything it
// didn't hand out to THIS session's own script.
var REQUEST_TOKEN = process.env.YOUCODED_MCP_TOKEN || '';

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
var POLL_TIMEOUT_MS = parseInt(process.env.YOUCODED_DOC_COMMENTS_MCP_POLL_TIMEOUT_MS || '', 10) || 8000;
var POLL_INTERVAL_MS = 50;

function submitPendingMutation(kind, located, fields) {
  var id = crypto.randomUUID();
  var request = {
    id: id,
    kind: kind,
    format: fields.format,
    path: fields.path,
    projectRoot: located.realProjectRoot,
    // The applier NEVER trusts this field for authorization (design note on
    // PendingMutationRequest.projectRoot, shared/doc-comments-types.ts) — the
    // token below is the real boundary. Sent anyway for shape-compat/
    // diagnostics only.
    token: REQUEST_TOKEN,
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
          // Adversarial review 2026-09-27, finding #4: state only what is
          // actually known. The most common real cause of an 8s timeout in
          // practice is the app being closed, which "try again" cannot fix —
          // this wording names that possibility instead of promising a
          // remedy that may not apply.
          return {
            ok: false,
            error: 'timed-out — YouCoded did not respond within '
              + (POLL_TIMEOUT_MS / 1000) + 's. It may still be running a slow operation, or YouCoded may not be open.',
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
    // Review finding #5: decided on located.sourceAbsolutePath (the
    // REALPATH'd, containment-verified target locate() already computed
    // above), never the caller's raw args.path -- a .txt-named symlink
    // pointing at a real .docx is judged as the .docx it actually is.
    var format = nativeFormatFor(located.sourceAbsolutePath);
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
    // Review finding #5: decided on located.sourceAbsolutePath (the
    // REALPATH'd, containment-verified target locate() already computed
    // above), never the caller's raw args.path -- a .txt-named symlink
    // pointing at a real .docx is judged as the .docx it actually is.
    var format = nativeFormatFor(located.sourceAbsolutePath);
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
    // Review finding #5: decided on located.sourceAbsolutePath (the
    // REALPATH'd, containment-verified target locate() already computed
    // above), never the caller's raw args.path -- a .txt-named symlink
    // pointing at a real .docx is judged as the .docx it actually is.
    var format = nativeFormatFor(located.sourceAbsolutePath);
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
    // Review finding #5: decided on located.sourceAbsolutePath (the
    // REALPATH'd, containment-verified target locate() already computed
    // above), never the caller's raw args.path -- a .txt-named symlink
    // pointing at a real .docx is judged as the .docx it actually is.
    var format = nativeFormatFor(located.sourceAbsolutePath);
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
    // Review finding #5: decided on located.sourceAbsolutePath (the
    // REALPATH'd, containment-verified target locate() already computed
    // above), never the caller's raw args.path -- a .txt-named symlink
    // pointing at a real .docx is judged as the .docx it actually is.
    var format = nativeFormatFor(located.sourceAbsolutePath);
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
    // Review finding #5: decided on located.sourceAbsolutePath (the
    // REALPATH'd, containment-verified target locate() already computed
    // above), never the caller's raw args.path -- a .txt-named symlink
    // pointing at a real .docx is judged as the .docx it actually is.
    var format = nativeFormatFor(located.sourceAbsolutePath);
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
    description: 'Every comment on a file, with status (anchored/detached), replies, and resolve history. Read this before replying to, resolving, reopening, or moving any comment — the ids and current state it returns are what those tools need.',
    inputSchema: { type: 'object', properties: { path: PATH_PROP }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'ReplyToComment',
    description: 'Reply to a comment the user (or a previous turn) left on this file — for a plain-text/markdown/code comment thread, or a real Word/Excel comment. Use it to answer a question they left, or to say what you did about something they flagged.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP, commentId: COMMENT_ID_PROP, text: { type: 'string', description: 'The reply text.' } },
      required: ['path', 'commentId', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ResolveComment',
    description: 'Mark a comment resolved — recorded in its history as resolved by the assistant. Use this once you\'ve addressed what a comment asked for; R6 (nothing silently lost) is why the resolve/reopen history stays visible.',
    inputSchema: { type: 'object', properties: { path: PATH_PROP, commentId: COMMENT_ID_PROP }, required: ['path', 'commentId'], additionalProperties: false },
  },
  {
    name: 'ReopenComment',
    description: 'Reopen a comment that was marked resolved — clears its resolved state so it shows as open again. Use this if a resolved comment\'s issue turns out not to be fully addressed.',
    inputSchema: { type: 'object', properties: { path: PATH_PROP, commentId: COMMENT_ID_PROP }, required: ['path', 'commentId'], additionalProperties: false },
  },
  {
    name: 'AddComment',
    description: 'Leave a comment on this file — sparingly. Use this only for something that clearly needs the user\'s attention or a decision from them, never to narrate what you just did or are about to do. If you\'re explaining your own edit, say so in your reply to them instead; if nothing needs their decision, don\'t add a comment at all.',
    inputSchema: {
      type: 'object',
      properties: { path: PATH_PROP, selector: COMMENT_SELECTOR_SCHEMA, text: { type: 'string', description: 'The comment text.' } },
      required: ['path', 'selector', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'MoveComment',
    description: 'Repoint a comment to a new location in the file, after the text or cell it was attached to moved or changed. This is the re-anchor half of R6 (nothing silently lost): after you fix what a comment asked for, use this — together with ReplyToComment/ResolveComment as appropriate — so the comment keeps pointing at something real instead of going quietly detached.',
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
          if (!r.ok) return formatOpError('MoveComment', r);
          // Code review 2026-09-27, desktop F1: an xlsx move's queue result
          // carries the FRESH id (its old id's embedded-cell hint goes stale
          // the instant the comment moves — pending-mutation-queue.ts's own
          // WHY on its 'move' branch); stating it here is what lets a
          // follow-up ReplyToComment/ResolveComment call use the new id
          // instead of paying for the full-workbook fallback scan. A docx
          // move (or a plain-text sidecar move, neither of which changes its
          // id) never sets r.id, so this falls back to the unchanged text
          // exactly as before — same shape as ReplyToComment's own replyId
          // handling just above.
          var newId = r.id || null;
          return textResult('Comment ' + args.commentId + ' on ' + args.path + ' repointed.' + (newId ? ' New id: ' + newId + '.' : ''));
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
