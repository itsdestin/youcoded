// The Browser tools for CLAUDE CODE sessions (spec §2 "Claude Code sessions").
//
// Claude Code runs the real `claude` CLI, which only learns tools through MCP.
// This file (1) runs a small local server in main that relays each tool call
// to the Browser worker through the SAME BrowserClient native sessions use,
// and (2) writes a dependency-free stdio MCP script + config that Claude Code
// spawns per session via `--mcp-config` (the SendUserLink / doc-comments
// pattern). The script advertises the tools from browser-tool-specs.ts
// (generated JSON Schema — never hand-copied) and forwards calls.
//
// WHY one deploy per app run, written at startup (not per session): the
// session-start path is synchronous and the main-process ratchet bans new
// blocking file writes (performance rule 1). The files are static for the run;
// a session that starts before they're ready simply starts without the Browser
// (logged), exactly like a failed SendUserLink deploy.
//
// Identity: every request carries the app's run token (a secret in the 0600
// config, never on argv) AND the desktop session id Claude Code inherited
// (CLAUDE_DESKTOP_SESSION_ID, set by pty-worker.js). Main accepts the call only
// for a live Claude Code session. A command the session's own Bash runs could
// read both — it is the same session, under the same Browser asks, so it gains
// nothing a model in that session lacks.
//
// Socket: Unix → a private 0700 directory ($XDG_RUNTIME_DIR/youcoded or
// /tmp/yc-<uid>), short enough for macOS's 104-byte socket path limit; Windows
// → a per-process named pipe. Token compared with timingSafeEqual.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { BROWSER_MCP_INSTRUCTIONS, BROWSER_TOOL_NAMES, browserToolsAsMcp } from './browser-tool-specs';
import type { RunResult } from './browser-tool-runners';

export const BROWSER_MCP_DIR = 'claude-code-browser-mcp';
/** Env names the deployed config passes to the script. */
const ENV_SOCKET = 'YOUCODED_BROWSER_SOCKET';
const ENV_TOKEN = 'YOUCODED_BROWSER_TOKEN';
const ENV_TOOLS = 'YOUCODED_BROWSER_TOOLS';
/** Requests larger than this are refused (args are small; images flow the other way). */
const MAX_REQUEST_BYTES = 256 * 1024;

export const BROWSER_RELAY_JS = String.raw`// YouCoded's Browser MCP server (claude-code-browser-mcp.ts). Dependency-free:
// a plain node process Claude Code spawns, with nothing beside it but the
// tools.json the app wrote. It relays each tool call to the YouCoded app over a
// private local socket; the app runs the browser and answers.
// stdout carries MCP protocol messages ONLY; diagnostics go to stderr.
'use strict';
var fs = require('fs');
var net = require('net');

var PROTOCOL_FALLBACK = '2025-06-18';
var SOCKET = process.env.YOUCODED_BROWSER_SOCKET || '';
var TOKEN = process.env.YOUCODED_BROWSER_TOKEN || '';
var SESSION = process.env.CLAUDE_DESKTOP_SESSION_ID || '';
var TOOLS = [];
var INSTRUCTIONS = '';
try {
  var spec = JSON.parse(fs.readFileSync(process.env.YOUCODED_BROWSER_TOOLS || '', 'utf8'));
  TOOLS = spec.tools || [];
  INSTRUCTIONS = spec.instructions || '';
} catch (e) {
  process.stderr.write('youcoded-browser: could not read the tool list: ' + (e && e.message) + '\n');
}

var inflight = {};

function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function result(id, res) { write({ jsonrpc: '2.0', id: id, result: res }); }
function failure(id, code, message) { write({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }); }
function errorResult(id, text) { result(id, { content: [{ type: 'text', text: text }], isError: true }); }

function callTool(id, params) {
  var name = params && params.name;
  var known = false;
  for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].name === name) known = true;
  if (!known) { failure(id, -32602, 'Unknown tool: ' + String(name)); return; }
  if (!SOCKET || !TOKEN || !SESSION) {
    errorResult(id, 'The browser is only available inside the YouCoded app.');
    return;
  }
  var sock = net.connect(SOCKET);
  var buf = '';
  var done = false;
  inflight[String(id)] = sock;
  function finish(fn) {
    if (done) return;
    done = true;
    delete inflight[String(id)];
    try { sock.destroy(); } catch (e) { /* closed */ }
    fn();
  }
  sock.on('connect', function () {
    // WHY: preserve invalid falsy payloads for shared worker validation; only omission means {}.
    sock.write(JSON.stringify({ token: TOKEN, session: SESSION, tool: name, args: params.arguments === undefined ? {} : params.arguments }) + '\n');
  });
  sock.on('data', function (d) {
    buf += d.toString('utf8');
    var nl = buf.indexOf('\n');
    if (nl < 0) return;
    var line = buf.slice(0, nl);
    finish(function () {
      var r;
      try { r = JSON.parse(line); } catch (e) { errorResult(id, 'The YouCoded app sent an unreadable answer.'); return; }
      var content = [{ type: 'text', text: String(r.text || '') }];
      if (r.image && r.image.data) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType || 'image/jpeg' });
      result(id, r.isError ? { content: content, isError: true } : { content: content });
    });
  });
  sock.on('error', function (e) {
    finish(function () { errorResult(id, 'The YouCoded app is not reachable (' + (e && e.code ? e.code : 'error') + '). Is the app still open?'); });
  });
  sock.on('close', function () {
    finish(function () { errorResult(id, 'The YouCoded app closed the connection before answering.'); });
  });
}

function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  var id = msg.id;
  var method = msg.method;
  if (method === 'initialize') {
    var pv = msg.params && msg.params.protocolVersion;
    result(id, {
      protocolVersion: typeof pv === 'string' ? pv : PROTOCOL_FALLBACK,
      capabilities: { tools: {} },
      serverInfo: { name: 'youcoded-browser', version: '1.0.0' },
      instructions: INSTRUCTIONS,
    });
    return;
  }
  if (method === 'notifications/cancelled') {
    // Closing the socket tells the app to abort the step.
    var rid = msg.params && msg.params.requestId;
    var s = inflight[String(rid)];
    if (s) { try { s.destroy(); } catch (e) { /* closed */ } }
    return;
  }
  if (typeof method === 'string' && method.indexOf('notifications/') === 0) return;
  if (method === 'ping') { result(id, {}); return; }
  if (method === 'tools/list') { result(id, { tools: TOOLS }); return; }
  if (method === 'tools/call') { callTool(id, msg.params); return; }
  if (id !== undefined && id !== null) failure(id, -32601, 'Method not found: ' + String(method));
}

var pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  pending += chunk;
  var nl;
  while ((nl = pending.indexOf('\n')) >= 0) {
    var line = pending.slice(0, nl).trim();
    pending = pending.slice(nl + 1);
    if (!line) continue;
    var msg;
    try { msg = JSON.parse(line); } catch (e) { process.stderr.write('youcoded-browser: bad JSON from client\n'); continue; }
    handle(msg);
  }
});
process.stdin.on('end', function () { process.exit(0); });
`;

export interface RelayAttachment {
  configPath: string;
  allowedTools: string[];
  serverId: string;
}

export interface RelayServerOptions {
  /** Run a Browser tool for a conversation (BrowserClient.callTool). */
  callTool: (sessionId: string, tool: string, args: unknown, opts: { signal: AbortSignal; vision: boolean }) => Promise<RunResult>;
  /** Is this a live Claude Code session of this app? */
  isClaudeSession: (sessionId: string) => boolean;
  log?: (level: 'INFO' | 'WARN' | 'ERROR', msg: string, data?: Record<string, unknown>) => void;
  platform?: NodeJS.Platform;
  /** Test seam: where the Unix socket directory goes. */
  socketDir?: string;
}

/** A short, private socket path (Unix) or a per-process pipe name (Windows). */
export async function relaySocketPath(platform: NodeJS.Platform, socketDir?: string): Promise<string> {
  const tag = randomBytes(4).toString('hex');
  if (platform === 'win32') return `\\\\.\\pipe\\youcoded-browser-${process.pid}-${tag}`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const dir = socketDir ?? (process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'youcoded') : path.join('/tmp', `yc-${uid}`));
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(dir, 0o700);
  const p = path.join(dir, `br-${process.pid}-${tag}.sock`);
  // macOS limits a socket path to 104 bytes (Linux 108).
  if (Buffer.byteLength(p) >= 100) throw new Error(`Browser relay socket path too long: ${p}`);
  return p;
}

export class BrowserRelayServer {
  private server: net.Server | null = null;
  readonly token = randomBytes(24).toString('hex');
  socketPath = '';

  constructor(private readonly opts: RelayServerOptions) {}

  async start(): Promise<string> {
    const platform = this.opts.platform ?? process.platform;
    this.socketPath = await relaySocketPath(platform, this.opts.socketDir);
    this.server = net.createServer((sock) => this.onConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath, () => resolve());
    });
    if (platform !== 'win32') await fs.promises.chmod(this.socketPath, 0o600).catch(() => undefined);
    return this.socketPath;
  }

  private tokenOk(given: unknown): boolean {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private onConnection(sock: net.Socket): void {
    let buf = '';
    let handled = false;
    const ac = new AbortController();
    const reply = (r: { text: string; isError?: boolean; image?: { data: string; mimeType: string } }) => {
      if (sock.destroyed) return;
      sock.end(JSON.stringify(r) + '\n');
    };
    // The script closes the socket when Claude Code cancels the call (Esc) or
    // exits — abort the step so the worker stops waiting.
    sock.on('close', () => ac.abort());
    sock.on('error', () => ac.abort());
    sock.on('data', (d) => {
      if (handled) return;
      buf += d.toString('utf8');
      if (buf.length > MAX_REQUEST_BYTES) { handled = true; reply({ text: 'Request too large.', isError: true }); return; }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      handled = true;
      let req: { token?: unknown; session?: unknown; tool?: unknown; args?: unknown };
      try { req = JSON.parse(buf.slice(0, nl)); } catch { reply({ text: 'Unreadable request.', isError: true }); return; }
      if (!this.tokenOk(req.token)) { reply({ text: 'Not allowed.', isError: true }); return; }
      const sessionId = typeof req.session === 'string' ? req.session : '';
      if (!sessionId || !this.opts.isClaudeSession(sessionId)) {
        reply({ text: 'The browser is only available to conversations running in this YouCoded window.', isError: true });
        return;
      }
      const tool = typeof req.tool === 'string' ? req.tool : '';
      void this.opts.callTool(sessionId, tool, req.args, { signal: ac.signal, vision: true }).then(async (r) => {
        let image: { data: string; mimeType: string } | undefined;
        if (r.imagePath) {
          try { image = { data: (await fs.promises.readFile(r.imagePath)).toString('base64'), mimeType: 'image/jpeg' }; } catch { /* reported below */ }
        }
        reply({ text: r.text, ...(r.isError ? { isError: true } : {}), ...(image ? { image } : {}) });
      }, (e) => reply({ text: `The browser tool failed: ${(e as Error).message}`, isError: true }));
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
    if ((this.opts.platform ?? process.platform) !== 'win32' && this.socketPath) await fs.promises.rm(this.socketPath, { force: true }).catch(() => undefined);
  }
}

/** Write the relay script, tool list and config for this app run. Returns what
 *  session-manager attaches to each Claude Code session. Async (startup only). */
export async function deployBrowserRelay(baseDir: string, nodePath: string, socketPath: string, token: string): Promise<RelayAttachment> {
  const root = path.join(baseDir, BROWSER_MCP_DIR);
  // Earlier runs' folders hold dead tokens; clear them (best effort).
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  // WHY a random server id per run (doc-comments precedent): the composed tool
  // names mcp__<id>__Browser* can't be pre-declared by a repository's own
  // .mcp.json to borrow this server's pre-approval.
  const serverId = `youcoded-browser-${randomBytes(4).toString('hex')}`;
  const dir = path.join(root, serverId);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(dir, 'browser-mcp.js');
  const toolsPath = path.join(dir, 'tools.json');
  const configPath = path.join(dir, 'mcp-config.json');
  await fs.promises.writeFile(scriptPath, BROWSER_RELAY_JS, 'utf8');
  await fs.promises.writeFile(toolsPath, JSON.stringify({ tools: browserToolsAsMcp(), instructions: BROWSER_MCP_INSTRUCTIONS }), 'utf8');
  const config = {
    mcpServers: {
      [serverId]: {
        type: 'stdio',
        command: nodePath,
        args: [scriptPath],
        env: { [ENV_SOCKET]: socketPath, [ENV_TOKEN]: token, [ENV_TOOLS]: toolsPath },
      },
    },
  };
  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (os.platform() !== 'win32') await fs.promises.chmod(configPath, 0o600).catch(() => undefined);
  return { configPath, serverId, allowedTools: BROWSER_TOOL_NAMES.map((n) => `mcp__${serverId}__${n}`) };
}

// ── this app run's attachment (set once at startup by main.ts) ──────────────

let attachment: RelayAttachment | null = null;

export function setBrowserRelayAttachment(a: RelayAttachment | null): void { attachment = a; }

/** What session-manager attaches to a new Claude Code session, or null when the
 *  relay isn't ready (that session starts without the Browser). */
export function browserRelayAttachment(): RelayAttachment | null { return attachment; }

