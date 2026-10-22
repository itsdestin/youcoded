// The Claude Code half of the Browser: the deployed relay script, spoken to
// exactly as Claude Code speaks to it (newline JSON-RPC on stdio), relaying to
// the app's socket server. The browser itself is faked here; the live browser
// path is assistant-browser-live.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
  BROWSER_RELAY_JS, BrowserRelayServer, deployBrowserRelay,
} from '../src/main/assistant-browser/claude-code-browser-mcp';
import { BROWSER_TOOL_NAMES } from '../src/main/assistant-browser/browser-tool-specs';
import { browserToolOf } from '../src/shared/browser-types';
import { validateBrowserRequest } from '../src/main/assistant-browser/browser-tool-validation';

const isWin = process.platform === 'win32';
let root = '';
let server: BrowserRelayServer;
const calls: Array<{ sessionId: string; tool: string; args: unknown; signal: AbortSignal }> = [];
let configPath = '';
let serverId = '';
let shotPath = '';

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-relay-'));
  shotPath = path.join(root, 'shot.jpg');
  fs.writeFileSync(shotPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  server = new BrowserRelayServer({
    socketDir: isWin ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'ycs-')),
    isClaudeSession: (id) => id === 'cc-1',
    callTool: async (sessionId, tool, args, opts) => {
      calls.push({ sessionId, tool, args, signal: opts.signal });
      if (tool === 'BrowserScreenshot') return { text: 'a picture', imagePath: shotPath };
      if (tool === 'BrowserWait') {
        // Hold until cancelled, to prove cancellation reaches the app.
        await new Promise<void>((r) => opts.signal.addEventListener('abort', () => r(), { once: true }));
        return { text: 'cancelled', isError: true };
      }
      return { text: `ran ${tool}` };
    },
  });
  const socket = await server.start();
  const dep = await deployBrowserRelay(root, process.execPath, socket, server.token);
  configPath = dep.configPath;
  serverId = dep.serverId;
});

afterAll(async () => {
  await server.stop();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** Start the relay the way Claude Code would: the config's command/args/env. */
function startRelay(sessionEnv: Record<string, string>): { child: ChildProcess; send: (m: unknown) => void; next: (id: number) => Promise<any> } {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers[serverId];
  const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env, ...sessionEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map<number, (m: any) => void>();
  const got = new Map<number, any>();
  child.stdout!.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); } else got.set(m.id, m);
    }
  });
  return {
    child,
    send: (m) => child.stdin!.write(JSON.stringify(m) + '\n'),
    next: (id) => new Promise((r) => { const g = got.get(id); if (g) { got.delete(id); r(g); } else waiting.set(id, r); }),
  };
}

describe('Browser relay for Claude Code', () => {
  it('the embedded script has no template-literal syntax (it lives inside String.raw)', () => {
    expect(BROWSER_RELAY_JS).not.toContain('`');
    expect(BROWSER_RELAY_JS).not.toContain('${');
  });

  it('advertises all browser tools with the shared descriptions, and pre-approves them by name', async () => {
    const r = startRelay({ CLAUDE_DESKTOP_SESSION_ID: 'cc-1' });
    r.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    const init = await r.next(1);
    expect(init.result.serverInfo.name).toBe('youcoded-browser');
    expect(init.result.instructions).toContain('untrusted-content');
    r.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await r.next(2);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([...BROWSER_TOOL_NAMES]);
    const act = list.result.tools.find((t: { name: string }) => t.name === 'BrowserAct');
    expect(act.inputSchema.type).toBe('object');
    expect(act.inputSchema.additionalProperties).toBe(false);
    expect(act.inputSchema.required).toEqual(expect.arrayContaining(['action', 'element']));
    r.child.kill();
  });

  it('relays a call for its own session and returns text and pictures', async () => {
    const r = startRelay({ CLAUDE_DESKTOP_SESSION_ID: 'cc-1' });
    r.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'BrowserNavigate', arguments: { url: 'https://example.com' } } });
    const nav = await r.next(3);
    expect(nav.result.content[0].text).toBe('ran BrowserNavigate');
    expect(calls.at(-1)).toMatchObject({ sessionId: 'cc-1', tool: 'BrowserNavigate', args: { url: 'https://example.com' } });
    // WHY: the relay transports both new operations unchanged; semantics stay in the worker.
    for (const [id, name, args] of [[30, 'BrowserHistory', { direction: 'back' }], [31, 'BrowserZoom', { zoom: 50 }]] as const) {
      r.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      expect((await r.next(id)).result.content[0].text).toBe(`ran ${name}`);
      expect(calls.at(-1)).toMatchObject({ sessionId: 'cc-1', tool: name, args });
    }
    r.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'BrowserScreenshot', arguments: {} } });
    const shot = await r.next(4);
    expect(shot.result.content[1]).toEqual({ type: 'image', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'), mimeType: 'image/jpeg' });
    r.child.kill();
  });

  // WHY: coercing falsy payloads to {} bypasses the worker's shared semantic preflight.
  it.each([null, false, 0, ''])('preserves explicit invalid arguments %j for shared validation', async (args) => {
    const r = startRelay({ CLAUDE_DESKTOP_SESSION_ID: 'cc-1' });
    try {
      r.send({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'BrowserSnapshot', arguments: args } });
      await r.next(40);
      expect(calls.at(-1)?.args).toBe(args);
      expect(validateBrowserRequest('BrowserSnapshot', calls.at(-1)?.args)).toHaveProperty('error');
    } finally { r.child.kill(); }
  });

  it('defaults only omitted arguments to an empty object', async () => {
    const r = startRelay({ CLAUDE_DESKTOP_SESSION_ID: 'cc-1' });
    try {
      r.send({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'BrowserSnapshot' } });
      expect((await r.next(41)).result.content[0].text).toBe('ran BrowserSnapshot');
      expect(calls.at(-1)?.args).toEqual({});
      expect(validateBrowserRequest('BrowserSnapshot', calls.at(-1)?.args)).not.toHaveProperty('error');
    } finally { r.child.kill(); }
  });

  it('refuses a session that is not one of this app\'s Claude Code conversations', async () => {
    const before = calls.length;
    const r = startRelay({ CLAUDE_DESKTOP_SESSION_ID: 'someone-else' });
    r.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'BrowserSnapshot', arguments: {} } });
    const res = await r.next(5);
    expect(res.result.isError).toBe(true);
    expect(calls.length).toBe(before);
    r.child.kill();
  });

  it('refuses a wrong token without running anything', async () => {
    const before = calls.length;
    const r = startRelay({ CLAUDE_DESKTOP_SESSION_ID: 'cc-1', YOUCODED_BROWSER_TOKEN: 'x'.repeat(48) });
    r.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'BrowserSnapshot', arguments: {} } });
    const res = await r.next(6);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe('Not allowed.');
    expect(calls.length).toBe(before);
    r.child.kill();
  });

  it('a cancelled call (Esc in Claude Code) aborts the step in the app', async () => {
    const r = startRelay({ CLAUDE_DESKTOP_SESSION_ID: 'cc-1' });
    r.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'BrowserWait', arguments: { seconds: 30 } } });
    await expect.poll(() => calls.at(-1)?.tool).toBe('BrowserWait');
    const signal = calls.at(-1)!.signal;
    r.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    await expect.poll(() => signal.aborted).toBe(true);
    r.child.kill();
  });

  it('unknown tools are protocol errors', async () => {
    const r = startRelay({ CLAUDE_DESKTOP_SESSION_ID: 'cc-1' });
    r.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'Bash', arguments: {} } });
    const res = await r.next(8);
    expect(res.error.code).toBe(-32602);
    r.child.kill();
  });

  it('the deployed config is private and the tool names carry the random server id', () => {
    if (!isWin) expect(fs.statSync(configPath).mode & 0o077).toBe(0);
    expect(serverId).toMatch(/^youcoded-browser-[0-9a-f]{8}$/);
    expect(browserToolOf(`mcp__${serverId}__BrowserAct`)).toBe('BrowserAct');
    expect(browserToolOf('mcp__other__BrowserAct')).toBeNull();
    expect(browserToolOf('BrowserAct')).toBe('BrowserAct');
  });
});

// 2026-10-22: every Claude Code session's config points at one socket path for the
// whole run; a deleted file is re-created as sessions start (socket-repair.ts).
describe.skipIf(isWin)('BrowserRelayServer.ensureListening', () => {
  it('re-creates a deleted socket file, still private (0600)', async () => {
    const relay = new BrowserRelayServer({
      socketDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ycs-')),
      isClaudeSession: () => true,
      callTool: async () => ({ text: 'ok' }),
    });
    const p = await relay.start();
    fs.unlinkSync(p);
    await relay.ensureListening();
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    await new Promise<void>((resolve, reject) => {
      const c = net.createConnection(p, () => { c.end(); resolve(); });
      c.on('error', reject);
    });
    await relay.stop();
    expect(fs.existsSync(p)).toBe(false);
  });
});
