// Page data, for the assistant (finance dashboard, 2026-10-05).
//
// Lets a Claude Code session read and change a YouCoded Page's saved data —
// "my Earnest balance is $14,200", "add eggs to my grocery page" — through a
// small dependency-free MCP server, the same way SendUserLink (claude-code-mcp.ts)
// and the document-comment tools (claude-code-doc-comments-mcp.ts) are given to
// a session. Decided on the finance questions deck: any page, and the change is
// "just a normal tool" — the update tool is NOT pre-approved, so Claude Code
// asks with its ordinary permission card; the two read tools are.
//
// Where pages are: the Personal space's Pages/ and, for a session opened in a
// project, that project's Pages/. Both are baked into this session's config by
// main, never taken from a tool argument, so a call cannot reach another folder.
//
// How a change lands: data.json is written with the SAME mkdir-lock + atomic
// rename the app uses (cas-write.ts mutateFileUnderLock), so the app and this
// process never interleave a write. The app's Pages watcher then sees the file
// change and hands the new data to an open page (youcoded.onData), which
// redraws in place.
//
// Desktop only: Pages do not run on Android yet.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const PAGES_MCP_SERVER_ID = 'youcoded-pages';
export const PAGES_MCP_READ_TOOLS = [`mcp__${PAGES_MCP_SERVER_ID}__ListPages`, `mcp__${PAGES_MCP_SERVER_ID}__ReadPageData`];
const ROOTS_ENV = 'YOUCODED_PAGES_ROOTS';

const PAGES_SERVER_JS = String.raw`// YouCoded's page-data MCP server (claude-code-pages-mcp.ts). Dependency-free:
// a plain node process Claude Code spawns, with nothing beside it.
'use strict';
var fs = require('fs');
var fsp = fs.promises;
var path = require('path');

var PROTOCOL_FALLBACK = '2025-06-18';
var MAX_BYTES = 1000000;           // pages-types.ts MAX_PAGE_DATA_BYTES
var LONG_TEXT = 600;               // longer strings are summarised when read (logos, pictures)
var LOCK_RETRY_MS = 10, LOCK_MAX_WAIT_MS = 3000, LOCK_STALE_MS = 30000; // cas-write.ts
var ROOTS = [];
try { ROOTS = JSON.parse(process.env.YOUCODED_PAGES_ROOTS || '[]').filter(function (r) { return typeof r === 'string' && r; }); } catch (e) { ROOTS = []; }

var PATH_HELP = 'A path is a list of steps into the data: a field name ("accounts"), a position in a list (0), or {"field": value} to pick the item in a list whose field has that value ({"id": "m1"}).';
var TOOLS = [
  {
    name: 'ListPages',
    description: 'List the user\'s YouCoded Pages (small apps inside YouCoded: a money dashboard, a grocery list, a workout log...). Returns each page\'s name, its id for the other page tools, what it is for, and the top-level fields of its saved data. Use it to find which page the user means.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ReadPageData',
    description: 'Read the saved data of one YouCoded Page, to answer a question about it ("how much do I owe in total?") or before changing it. Very long text (pictures) is shown as a short placeholder. ' + PATH_HELP,
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'The page id from ListPages (or its exact name).' },
        path: { type: 'array', description: 'Optional: read only this part of the data.', items: {} },
      },
      required: ['page'],
      additionalProperties: false,
    },
  },
  {
    name: 'UpdatePageData',
    description: 'Change a YouCoded Page\'s saved data when the user asks ("my Earnest balance is $14,200", "add eggs to my grocery page", "mark the phone bill paid"). Read the page first: ReadPageData shows the page\'s own data guide when it has one, which says exactly what each item looks like, so there is no need to read the page\'s code. An open page updates immediately. Changes: "set" puts a value at a path (making missing fields), "append" adds a value to the end of a list, "remove" deletes a field or list item. ' + PATH_HELP + ' Keep any "updatedAt" style field current when the page has one.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'The page id from ListPages (or its exact name).' },
        changes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set', 'append', 'remove'] },
              path: { type: 'array', items: {} },
              value: {},
            },
            required: ['op', 'path'],
          },
        },
      },
      required: ['page', 'changes'],
      additionalProperties: false,
    },
  },
];

function messageOf(err) { return err && err.message ? err.message : String(err); }
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function replyResult(id, result) { send({ jsonrpc: '2.0', id: id, result: result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); }
function text(id, t, isError) { replyResult(id, { content: [{ type: 'text', text: t }], isError: !!isError }); }

// ── Finding a page ───────────────────────────────────────────────────────
function readJson(file) {
  return fsp.readFile(file, 'utf8').then(function (raw) { try { return JSON.parse(raw); } catch (e) { return null; } }, function () { return null; });
}
function listPages() {
  var out = [];
  return ROOTS.reduce(function (p, root, ri) {
    return p.then(function () {
      return fsp.readdir(root, { withFileTypes: true }).then(function (ents) {
        return Promise.all(ents.filter(function (e) { return e.isDirectory() && !e.name.startsWith('.'); }).map(function (e) {
          var dir = path.join(root, e.name);
          return readJson(path.join(dir, 'page.json')).then(function (j) {
            if (!j || typeof j !== 'object') return;
            // dataHelp: the page's own note on how its saved data is shaped (a string, or a list of lines), so a change
            // can match it even when a list is still empty and there is no example to copy.
            var help = Array.isArray(j.dataHelp) ? j.dataHelp.filter(function (x) { return typeof x === 'string'; }).join('\n') : typeof j.dataHelp === 'string' ? j.dataHelp : '';
            out.push({ id: (ri === 0 ? '' : 'project:') + e.name, slug: e.name, dir: dir, name: typeof j.name === 'string' ? j.name : e.name, description: typeof j.description === 'string' ? j.description : '', help: help.slice(0, 4000) });
          });
        }));
      }, function () { /* no Pages folder here */ });
    });
  }, Promise.resolve()).then(function () { return out; });
}
function findPage(ref) {
  var r = String(ref || '').trim();
  return listPages().then(function (pages) {
    var lower = r.toLowerCase();
    return pages.filter(function (p) { return p.id === r; })[0]
      || pages.filter(function (p) { return p.slug === r; })[0]
      || pages.filter(function (p) { return p.name.toLowerCase() === lower; })[0]
      || null;
  });
}
function readData(dir) {
  return readJson(path.join(dir, 'data.json')).then(function (env) {
    return env && typeof env === 'object' && 'data' in env ? env.data : null;
  });
}

// ── Paths and changes ───────────────────────────────────────────────────
function stepName(s) { return typeof s === 'object' && s ? '[' + Object.keys(s).map(function (k) { return k + '=' + JSON.stringify(s[k]); }).join(',') + ']' : typeof s === 'number' ? '[' + s + ']' : '.' + s; }
function pathName(p) { return p.map(stepName).join('').replace(/^\./, '') || '(all of it)'; }
function matches(item, sel) { return item && typeof item === 'object' && Object.keys(sel).every(function (k) { return item[k] === sel[k]; }); }
// Walks to the parent of the last step; makes missing objects only when asked.
function walk(root, p, make) {
  var cur = root;
  for (var i = 0; i < p.length - 1; i++) {
    var s = p[i], next;
    if (typeof s === 'string') {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new Error(pathName(p.slice(0, i + 1)) + ' is not inside an object');
      next = cur[s];
      if ((next === undefined || next === null) && make) { next = typeof p[i + 1] === 'string' ? {} : []; cur[s] = next; }
    } else if (typeof s === 'number') {
      if (!Array.isArray(cur)) throw new Error(pathName(p.slice(0, i)) + ' is not a list');
      next = cur[s];
    } else if (s && typeof s === 'object') {
      if (!Array.isArray(cur)) throw new Error(pathName(p.slice(0, i)) + ' is not a list');
      next = cur.filter(function (x) { return matches(x, s); })[0];
    } else throw new Error('A path step must be a field name, a number or {"field": value}');
    if (next === undefined) throw new Error('Nothing at ' + pathName(p.slice(0, i + 1)));
    cur = next;
  }
  return cur;
}
function getAt(root, p) {
  if (!p.length) return root;
  var parent = walk(root, p, false), last = p[p.length - 1];
  if (typeof last === 'object' && last) return Array.isArray(parent) ? parent.filter(function (x) { return matches(x, last); })[0] : undefined;
  return parent == null ? undefined : parent[last];
}
function short(v) { var s = JSON.stringify(v); return s === undefined ? 'nothing' : s.length > 80 ? s.slice(0, 77) + '...' : s; }
function apply(root, c) {
  if (!c || !Array.isArray(c.path)) throw new Error('Each change needs a path (a list of steps)');
  var p = c.path;
  if (c.op === 'append') {
    var list = p.length ? getAt(root, p) : root;
    if (list === undefined && p.length) { var par = walk(root, p, true); par[p[p.length - 1]] = list = []; }
    if (!Array.isArray(list)) throw new Error(pathName(p) + ' is not a list');
    list.push(c.value);
    return 'added ' + short(c.value) + ' to ' + pathName(p);
  }
  if (!p.length) throw new Error('The path is empty; name the field to change');
  var parent = walk(root, p, c.op === 'set'), last = p[p.length - 1];
  if (typeof last === 'object' && last) {
    if (!Array.isArray(parent)) throw new Error(pathName(p.slice(0, -1)) + ' is not a list');
    var idx = -1; parent.forEach(function (x, i) { if (idx < 0 && matches(x, last)) idx = i; });
    if (c.op === 'remove') { if (idx < 0) throw new Error('Nothing at ' + pathName(p)); parent.splice(idx, 1); return 'removed ' + pathName(p); }
    if (idx < 0) throw new Error('Nothing at ' + pathName(p) + ' (use append to add an item)');
    var before = parent[idx]; parent[idx] = c.value; return pathName(p) + ': ' + short(before) + ' -> ' + short(c.value);
  }
  if (parent === null || typeof parent !== 'object') throw new Error(pathName(p.slice(0, -1)) + ' is not an object or list');
  if (typeof last === 'number' && !Array.isArray(parent)) throw new Error(pathName(p.slice(0, -1)) + ' is not a list');
  if (c.op === 'remove') {
    if (!(last in parent)) throw new Error('Nothing at ' + pathName(p));
    if (Array.isArray(parent)) parent.splice(last, 1); else delete parent[last];
    return 'removed ' + pathName(p);
  }
  if (c.op === 'set') {
    if (c.value === undefined) throw new Error('A set change needs a value');
    var was = parent[last]; parent[last] = c.value;
    return pathName(p) + ': ' + short(was) + ' -> ' + short(c.value);
  }
  throw new Error('Unknown change "' + c.op + '" (use set, append or remove)');
}
// Long text (a logo as a data: address) would only fill the conversation.
function trimmed(v) {
  if (typeof v === 'string') return v.length > LONG_TEXT ? '[' + v.length + ' characters, not shown]' : v;
  if (Array.isArray(v)) return v.map(trimmed);
  if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = trimmed(v[k]); }); return o; }
  return v;
}

// ── The locked write (cas-write.ts mutateFileUnderLock, ported) ──────────
function acquireLock(lock) {
  var start = Date.now();
  function attempt() {
    return fsp.mkdir(lock).then(function () { return true; }, function (e) {
      if (['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].indexOf(e.code) < 0) throw e;
      return fsp.stat(lock).then(function (st) {
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) return fsp.rm(lock, { recursive: true, force: true }).then(attempt);
        return null;
      }, function () { return null; }).then(function (r) {
        if (r !== null) return r;
        if (Date.now() - start > LOCK_MAX_WAIT_MS) return false;
        return new Promise(function (res) { setTimeout(res, LOCK_RETRY_MS); }).then(attempt);
      });
    });
  }
  return attempt();
}
function mutateUnderLock(target, mutate) {
  var lock = target + '.lock';
  return acquireLock(lock).then(function (got) {
    if (!got) return { ok: false };
    return fsp.readFile(target, 'utf8').catch(function (e) { if (e.code === 'ENOENT') return null; throw e; }).then(function (onDisk) {
      var next = mutate(onDisk);
      if (next === null) return { ok: true, wrote: false };
      var tmp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
      return fsp.writeFile(tmp, next, 'utf8').then(function () { return fsp.rename(tmp, target); })
        .catch(function (e) { return fsp.unlink(tmp).catch(function () {}).then(function () { throw e; }); })
        .then(function () { return { ok: true, wrote: true }; });
    }).then(function (r) { return fsp.rm(lock, { recursive: true, force: true }).then(function () { return r; }); },
      function (e) { return fsp.rm(lock, { recursive: true, force: true }).then(function () { throw e; }); });
  });
}

// ── Tools ────────────────────────────────────────────────────────────────
function callTool(id, params) {
  var name = params && params.name, a = (params && params.arguments) || {};
  if (!ROOTS.length) return text(id, 'No Pages folder is available to this session.', true);
  if (name === 'ListPages') {
    return listPages().then(function (pages) {
      if (!pages.length) return text(id, 'The user has no pages yet.');
      return Promise.all(pages.map(function (p) {
        return readData(p.dir).then(function (d) {
          var fields = d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d).join(', ') : d === null ? 'nothing saved yet' : typeof d;
          return '- ' + p.name + ' (id: ' + p.id + ')' + (p.description ? ': ' + p.description : '') + '\n  saved data: ' + fields + (p.help ? '\n  has a data guide (shown by ReadPageData)' : '');
        });
      })).then(function (lines) { text(id, lines.join('\n')); });
    }).catch(function (e) { text(id, 'Could not list pages: ' + messageOf(e), true); });
  }
  if (name === 'ReadPageData') {
    return findPage(a.page).then(function (p) {
      if (!p) return text(id, 'No page called "' + String(a.page) + '". Use ListPages to see them.', true);
      return readData(p.dir).then(function (d) {
        var at = Array.isArray(a.path) && a.path.length ? getAt(d, a.path) : d;
        var guide = p.help ? 'How this page keeps its data (from the page itself; follow it when changing anything):\n' + p.help + '\n\nData:\n' : '';
        text(id, guide + JSON.stringify(trimmed(at === undefined ? null : at), null, 1));
      });
    }).catch(function (e) { text(id, 'Could not read that page: ' + messageOf(e), true); });
  }
  if (name === 'UpdatePageData') {
    if (!Array.isArray(a.changes) || !a.changes.length) return text(id, 'Nothing was changed: give at least one change.', true);
    return findPage(a.page).then(function (p) {
      if (!p) return text(id, 'No page called "' + String(a.page) + '". Use ListPages to see them.', true);
      var target = path.join(p.dir, 'data.json'), said = [], problem = null;
      return mutateUnderLock(target, function (onDisk) {
        var env = null; try { env = onDisk ? JSON.parse(onDisk) : null; } catch (e) { env = null; }
        // One change failing leaves the file exactly as it was: all of them, or none.
        var data = JSON.parse(JSON.stringify(env && typeof env === 'object' && 'data' in env && env.data !== null ? env.data : {}));
        try { a.changes.forEach(function (c) { said.push(apply(data, c)); }); }
        catch (e) { problem = messageOf(e); return null; }
        var body = JSON.stringify({ savedAt: new Date().toISOString(), data: data });
        if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) { problem = 'that would make the page keep more than 1 MB'; return null; }
        return body;
      }).then(function (r) {
        if (problem) return text(id, 'Nothing was changed on ' + p.name + ': ' + problem + '.', true);
        if (!r.ok) return text(id, 'Nothing was changed: ' + p.name + '\'s data file is busy. Try again in a moment.', true);
        text(id, 'Updated ' + p.name + ':\n' + said.map(function (s) { return '- ' + s; }).join('\n'));
      });
    }).catch(function (e) { text(id, 'Nothing was changed: ' + messageOf(e), true); });
  }
  replyError(id, -32602, 'Unknown tool: ' + String(name));
}

function handle(msg) {
  var id = msg.id, method = msg.method;
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    var asked = msg.params && typeof msg.params.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_FALLBACK;
    replyResult(id, { protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: 'youcoded-pages', version: '1.0.0' } });
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
      try { msg = JSON.parse(line); } catch (err) { process.stderr.write('youcoded-pages-mcp: ignoring unparseable line: ' + messageOf(err) + '\n'); }
      if (msg && typeof msg === 'object') handle(msg);
    }
    idx = buffer.indexOf('\n');
  }
});
process.stdin.on('end', function () { process.exit(0); });
process.stdout.on('error', function () { process.exit(0); });
`;

const PAGES_MCP_DIR = 'claude-code-pages-mcp';

// WHY a provider set by the pages service rather than an import of the sync service: session-manager would then
// load the whole sync stack (and its child-process helpers) just to learn one folder path.
let personalPagesProvider: () => string | null = () => null;
export function setPersonalPagesRoot(fn: () => string | null): void { personalPagesProvider = fn; }
/** The Personal space's Pages/ folder, or null before sync spaces are set up. */
export function personalPagesRoot(): string | null { try { return personalPagesProvider(); } catch { return null; } }

export interface PagesMcpDeployment { serverPath: string; configPath: string; allowedTools: string[] }

/** Configs from an earlier run of the app are swept once per process; a crash
 *  would otherwise leave one behind per session. */
let sweptThisProcess = false;

/**
 * Write the server (shared) and this session's config (its own file, because
 * the Pages folders it may touch differ per project) under `baseDir`.
 * `roots` are absolute Pages/ folders: the Personal space's first, then the
 * session's project's, when it has one. Returns null when there are none.
 */
export function deployClaudeCodePagesMcp(baseDir: string, nodePath: string, roots: string[]): PagesMcpDeployment | null {
  const clean = [...new Set(roots.filter((r) => typeof r === 'string' && path.isAbsolute(r)))];
  if (!clean.length) return null;
  const dir = path.join(baseDir, PAGES_MCP_DIR);
  if (!sweptThisProcess) {
    sweptThisProcess = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  fs.mkdirSync(dir, { recursive: true });
  const serverPath = path.join(dir, 'pages-mcp.js');
  fs.writeFileSync(serverPath, PAGES_SERVER_JS, 'utf8');
  const configPath = path.join(dir, `mcp-config-${randomBytes(4).toString('hex')}.json`);
  const config = { mcpServers: { [PAGES_MCP_SERVER_ID]: { type: 'stdio', command: nodePath, args: [serverPath], env: { [ROOTS_ENV]: JSON.stringify(clean) } } } };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return { serverPath, configPath, allowedTools: [...PAGES_MCP_READ_TOOLS] };
}
