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
// "never prompt" requirement regardless of permission mode.
//
// --- Matching "the same tier as Edit/Write" for a Word/Excel target ---
//
// §5.2a's wording is "the same tier as Edit/Write... so in accept-edits/
// bypass modes it doesn't [prompt]." An initial pass here left accept-edits
// as a reported, unclosed gap, reasoning that this app has no channel
// carrying a Claude Code CLI session's LIVE permission mode into main
// (`SessionInfo.permissionMode` is written once at spawn; the mode a user
// later cycles to is only ever scraped from PTY text in the renderer).
// That reasoning missed a simpler path: Claude Code's own hook payload
// ALREADY carries its live mode. Confirmed 2026-09-27 by reading the
// installed 2.1.283 CLI binary's own embedded Zod schema (no reachable
// official published doc for this specific field) — every hook event's
// common base shape includes an OPTIONAL `permission_mode` string
// ('default'|'acceptEdits'|'bypassPermissions'|'plan'|'dontAsk'|'auto', per
// the CLI's own describe() text for the equivalent CLI flag), ANDed into
// BOTH `PreToolUse` and `PermissionRequest`'s own schemas — the exact two
// hook events this app already relays. `relay-blocking.js` forwards the
// CLI's whole hook JSON verbatim (only adding `_desktop_session_id`/
// `_claude_pid`), and `hook-relay.ts`'s `parseHookPayload` keeps the whole
// parsed object as `event.payload` — so `permission_mode` was ALREADY
// reaching main.ts's hook-event handler, just unread until now. No new IPC,
// no new hook registration, no renderer-to-main channel: main.ts reads
// `event.payload.permission_mode` and passes it to
// `shouldAutoApproveDocComment` (permission-auto-approve.ts), which
// auto-approves a Word/Excel target when that mode is one Claude Code
// itself already treats as a frictionless file-edit mode (`acceptEdits`;
// `bypassPermissions` too, defensively, though bypass already gets this for
// free since Claude Code's own engine skips firing this hook at all for an
// ordinary tool under bypass — see the "PermissionRequest hook timeout"
// cc-dependencies.md entry). `plan` mode, `default` mode, an unrecognized
// future mode string, and a payload that omits the field altogether (it is
// the CLI's own schema that marks it `.optional()` — some hosts/versions may
// not send it) ALL fall through to the ordinary ask, never guessed into an
// approval. See cc-dependencies.md's own "hook payload permission_mode
// field" entry for the full evidence trail.
//
// --- The composed tool-name match is unambiguous per session, not a fixed
//     public string (adversarial review 2026-09-27, finding #2) ---
//
// `shouldAutoApproveDocComment` (permission-auto-approve.ts) decides purely
// from the hook payload's `tool_name` STRING. Using a single, fixed,
// module-level server id (`'youcoded-doc-comments'`, public in this
// open-source repo) would make that string guessable by anything else that
// could get an MCP server declared under the SAME name for the same
// project — e.g. a project-level `.mcp.json` checked into an untrusted repo
// the user opens, exposing its own `AddComment`/`ReplyToComment`/etc. tools
// with an arbitrary implementation. This session could not verify Claude
// Code's exact config-merge precedence for a same-named collision without a
// paid live CLI run (see youcoded/docs/cc-dependencies.md's own entry). What
// IS verifiable and fixable without one: `deployClaudeCodeDocCommentsMcp`
// below generates a FRESH random server id per deployment
// (`randomDocCommentsMcpServerId()`) — nothing checked into a repo AHEAD OF
// this session starting can predict it, closing the "static collision"
// version of this risk structurally. The script's own `SERVER_ID` constant
// below is purely cosmetic (shown in `/mcp`; Claude Code composes the actual
// `mcp__{server}__{tool}` prefix from the `--mcp-config` file's OWN
// `mcpServers` key, never from this script's self-reported name) — only the
// config's key needs to be the random value, so the embedded script itself
// stays a single, unparameterized `String.raw` constant.
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import {
  DOC_COMMENTS_MCP_SERVER_PREFIX,
  YOUCODED_PROJECT_ROOT_ENV,
  DOC_COMMENTS_MCP_POLL_TIMEOUT_ENV,
  YOUCODED_MCP_TOKEN_ENV,
  docCommentsMcpReadTool,
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
// Cosmetic only (shown in /mcp) — the actual mcp__{server}__{tool} prefix
// Claude Code composes comes from the --mcp-config file's OWN mcpServers
// key (a fresh random value per deployment, deployClaudeCodeDocCommentsMcp),
// never from this string. See this file's TS header, finding #2.
var SERVER_ID = 'youcoded-doc-comments';
var PROJECT_ROOT = process.env.__PROJECT_ROOT_ENV__ || '';
// This session's own per-deployment secret (finding #1) — included on every
// pending-mutation request so the main-process queue can refuse anything it
// didn't hand out to THIS session's own script.
var REQUEST_TOKEN = process.env.__TOKEN_ENV__ || '';

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
// Extra wait once the app has claimed a request (see giveUp below): it is
// actively applying it, so a little more patience beats a duplicate.
var CLAIMED_GRACE_MS = 30000;

// WHY the highest existing number + 1, never the reply count + 1
// (2026-09-28 PR review): after a middle reply was deleted (r1, r3 left), the
// count minted "-r3" again — two replies with one id, so editing the new one
// changed the old one and deleting it removed both. Mirrors
// doc-comments-store.ts's nextReplyId.
function nextReplyId(comment) {
  var prefix = comment.id + '-r';
  var max = 0;
  for (var i = 0; i < comment.replies.length; i++) {
    var rid = String(comment.replies[i].id || '');
    if (rid.indexOf(prefix) !== 0) continue;
    var n = parseInt(rid.slice(prefix.length), 10);
    if (n > max) max = n;
  }
  return prefix + (Math.max(max, comment.replies.length) + 1);
}

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
        if (Date.now() >= deadline) return giveUp();
        return sleep(POLL_INTERVAL_MS).then(poll);
      });
    }
    // WHY withdraw on timeout (2026-09-28 PR review): the request used to be
    // left in place, so a merely SLOW app applied it after the assistant had
    // been told it failed — and the assistant's retry then posted the same
    // comment or reply twice. The app now claims a request (renames it)
    // before acting on it, so deleting it here settles, atomically, which
    // side got it: deleted = never applied, safe to retry; already gone =
    // the app is applying it, so keep waiting a while longer instead of
    // inviting a duplicate.
    function giveUp() {
      return fsp.unlink(requestPath).then(function () {
        // Adversarial review 2026-09-27, finding #4: state only what is
        // actually known. The most common real cause is the app being
        // closed, which "try again" alone cannot fix.
        return {
          ok: false,
          error: 'timed-out — YouCoded did not pick this up within '
            + (POLL_TIMEOUT_MS / 1000) + 's, so nothing was changed. YouCoded may not be open.',
        };
      }, function (e) {
        if (e.code !== 'ENOENT') throw e;
        return waitForClaimed(Date.now() + CLAIMED_GRACE_MS);
      });
    }
    function waitForClaimed(graceDeadline) {
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
        if (Date.now() >= graceDeadline) {
          return {
            ok: false,
            error: 'still-running — YouCoded started this change but has not finished yet. It may still complete: check with ReadFileComments before trying again.',
          };
        }
        return sleep(POLL_INTERVAL_MS).then(function () { return waitForClaimed(graceDeadline); });
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
      var replyId = nextReplyId(comment);
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

// Finish plan Task 6: the file is open in Office and its editor could not take the change yet
// (still opening, or busy). The app keeps the change and makes it as soon as it can.
function queuedText(path) {
  return path + " is open in Office and its editor isn't ready yet. The change is queued and will be made as soon as it is.";
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
          if (r.ok && r.queued) return textResult(queuedText(args.path));
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
          if (r.ok && r.queued) return textResult(queuedText(args.path));
          return r.ok ? textResult('Comment ' + args.commentId + ' on ' + args.path + ' marked resolved.') : formatOpError('ResolveComment', r);
        })
      : Promise.resolve(textResult('ResolveComment failed: path and commentId are required.', true));
  } else if (name === 'ReopenComment') {
    handler = (requireString(args, 'path') && requireString(args, 'commentId'))
      ? reopenComment(args).then(function (r) {
          if (r.ok && r.queued) return textResult(queuedText(args.path));
          return r.ok ? textResult('Comment ' + args.commentId + ' on ' + args.path + ' reopened.') : formatOpError('ReopenComment', r);
        })
      : Promise.resolve(textResult('ReopenComment failed: path and commentId are required.', true));
  } else if (name === 'AddComment') {
    handler = (requireString(args, 'path') && args.selector && typeof args.selector === 'object' && requireString(args, 'text'))
      ? addComment(args).then(function (r) {
          if (r.ok && r.queued) return textResult(queuedText(args.path));
          return r.ok ? textResult('Comment added to ' + args.path + ' (id: ' + r.id + ').') : formatOpError('AddComment', r);
        })
      : Promise.resolve(textResult('AddComment failed: path, selector and text are required.', true));
  } else if (name === 'MoveComment') {
    handler = (requireString(args, 'path') && requireString(args, 'commentId') && args.newSelector && typeof args.newSelector === 'object')
      ? moveComment(args).then(function (r) {
          if (r.ok && r.queued) return textResult(queuedText(args.path));
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
`
  .replace(/__PROJECT_ROOT_ENV__/g, YOUCODED_PROJECT_ROOT_ENV)
  .replace(/__TOKEN_ENV__/g, YOUCODED_MCP_TOKEN_ENV)
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
  /** The fresh, per-deployment `mcpServers` config key (finding #2) — the
   *  caller (session-manager.ts) must hand this to main.ts's permission
   *  matching (via the `doc-comments-mcp-attached` event) so
   *  `shouldAutoApproveDocComment` recomposes the CORRECT tool names for
   *  THIS session, rather than matching a fixed, guessable string. */
  serverId: string;
  /** This session's own random secret (finding #1) — the caller must hand
   *  this to the pending-mutation queue (via the SAME event) so it can
   *  refuse any request that doesn't carry it. Never logged, never sent to
   *  the renderer/IPC — see session-manager.ts's own emit-site comment. */
  token: string;
  /** This deployment's own directory (T9c/T20 adversarial review, finding #3)
   *  — the caller (session-manager.ts) deletes it wholesale on session-exit;
   *  see `sweepStaleDeploysOnce` below for the crash/kill case this alone
   *  doesn't cover. */
  deployDir: string;
}

/** Own subdirectory, mirroring claude-code-mcp.ts's CLAUDE_CODE_MCP_DIR — its
 *  own folder so both deployments can be wiped/inspected independently. */
export const DOC_COMMENTS_MCP_DIR = 'claude-code-doc-comments-mcp';

/** A fresh, unpredictable `mcpServers` config key for one deployment
 *  (finding #2 — see this file's own header). 4 random bytes (8 hex chars)
 *  keeps the composed tool name reasonably short while being astronomically
 *  harder to guess or pre-declare than the old fixed constant. */
function randomDocCommentsMcpServerId(): string {
  return `${DOC_COMMENTS_MCP_SERVER_PREFIX}-${randomBytes(4).toString('hex')}`;
}

/** Guards the once-per-process leftover-deploy sweep (T9c/T20 adversarial
 *  review, finding #3) — every deployment directory this process has ever
 *  created lives under one parent with no PER-DEPLOYMENT cleanup guaranteed
 *  (a crash or a force-quit skips session-manager.ts's own on-exit delete).
 *  Swept once, the first time THIS process deploys anything: safe because no
 *  in-memory queue state from a PREVIOUS process life could possibly still
 *  reference one of those directories (this app persists no queue state
 *  across a restart), and never mid-process, since a sibling deployment
 *  created earlier in the SAME run is still live and must not be swept. */
let sweptStaleDeploysThisProcess = false;

/** Test-only: re-arms the sweep so a test can observe it firing against its
 *  own fresh temp directory, mirroring pending-mutation-queue.ts's own
 *  `__resetPendingMutationQueueForTest`. */
export function __resetDocCommentsMcpSweepForTest(): void {
  sweptStaleDeploysThisProcess = false;
}

function sweepStaleDeploysOnce(baseDir: string): void {
  if (sweptStaleDeploysThisProcess) return;
  sweptStaleDeploysThisProcess = true;
  try {
    fs.rmSync(path.join(baseDir, DOC_COMMENTS_MCP_DIR), { recursive: true, force: true });
  } catch {
    // Best-effort — a failed sweep never blocks a real deploy.
  }
}

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
  // Finding #3: sweep any directory a PREVIOUS process life left behind
  // before creating this deployment's own — see sweepStaleDeploysOnce's own
  // doc comment for why this is safe.
  sweepStaleDeploysOnce(baseDir);

  const serverId = randomDocCommentsMcpServerId();
  // 16 random bytes (32 hex chars), fixed-length so the applier's
  // constant-time comparison never has to handle a variable-length input
  // from a legitimate caller (finding #1).
  //
  // WHY this token is real, tested defense against SOME threats and not
  // others (T9c/T20 adversarial review, finding #1 — triage, review
  // 2026-09-27): it stops a request PLANTED before this session existed
  // (nothing before spawn time could know it) and a request from a
  // DIFFERENT session/process that never received it. It does NOT, and was
  // never meant to, stop code running INSIDE this already-live session
  // (this session's own Bash/Write tools, a skill file it runs, a
  // compromised dependency it executes) from reading its own token and
  // forging a request — that code already has the SAME filesystem access
  // needed to edit the target .docx/.xlsx directly, with no token required
  // at all, and in `default` permission mode that same Bash/Write access
  // would itself trigger an ordinary PermissionRequest prompt. The token's
  // job is closing the pre-planted-file and cross-session/cross-process
  // mix-up cases, never same-uid code execution — see the review file's own
  // triage section for the full reasoning.
  const token = randomBytes(16).toString('hex');

  // WHY a PER-SESSION subdirectory, unlike claude-code-mcp.ts's SendUserLink
  // deploy (one fixed path, overwritten every launch): that shape is fine
  // for a single, app-wide, stateless tool with no per-session secret, but
  // two Claude Code sessions created close together would otherwise
  // overwrite the SAME `mcp-config.json` before either one's spawned CLI
  // process has necessarily read it yet — session A's process could end up
  // reading session B's token/server id, silently defeating finding #2's
  // whole "unambiguous per session" point (caught by this file's own
  // deployment test: two sessions on the same host produced the SAME
  // observed server id because they raced onto the same file). Keying the
  // directory on the very serverId just minted makes every deployment its
  // own path, so no two sessions can ever collide on the same file.
  // Per-deployment cleanup is now real (finding #3, T9c/T20 review) — the
  // caller deletes `deployDir` on session-exit, and `sweepStaleDeploysOnce`
  // above catches whatever a crash/kill skips — so the earlier "these small
  // per-session directories are never individually cleaned up" tradeoff no
  // longer applies.
  const dir = path.join(baseDir, DOC_COMMENTS_MCP_DIR, serverId);
  // Owner-only (finding #1, cheap hardening — see the WHY note above the
  // token for what this can and can't defend against; it does not stop
  // this session's OWN uid, only other OS users/tools on a shared machine).
  // `mkdirSync`'s own `mode` alone can be weakened by the process umask, so
  // an explicit `chmodSync` follows it — mirrors chatgpt-request-diagnostics
  // .ts's own dir/file hardening shape.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const serverPath = path.join(dir, 'doc-comments-mcp.js');
  fs.writeFileSync(serverPath, DOC_COMMENTS_SERVER_JS, 'utf8');

  const configPath = path.join(dir, 'mcp-config.json');
  const config = {
    mcpServers: {
      [serverId]: {
        type: 'stdio',
        command: nodePath,
        args: [serverPath],
        env: { [YOUCODED_PROJECT_ROOT_ENV]: projectRoot, [YOUCODED_MCP_TOKEN_ENV]: token },
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  // Owner-only (finding #1) — this is the file that actually holds the
  // token; the directory-level 0700 above already blocks traversal by
  // another OS user, this is belt-and-suspenders on the file itself.
  fs.chmodSync(configPath, 0o600);

  return { serverPath, configPath, allowedTools: [docCommentsMcpReadTool(serverId)], serverId, token, deployDir: dir };
}
