// claude-code-mcp — the SendUserLink MCP server the app attaches to Claude Code
// sessions: the deployed server spoken to over real JSON-RPC, and the desktop copy's
// parity with the Android asset and Kotlin constants.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { deployClaudeCodeLinkMcp, CLAUDE_CODE_MCP_DIR, LINK_SERVER_JS } from '../src/main/claude-code-mcp';
import { CLAUDE_CODE_LINK_TOOL, CLAUDE_CODE_MCP_SERVER_ID, SEND_USER_LINK_TOOL } from '../src/shared/send-user-link';
import { readSource } from './helpers/guard-scope';

// Functional test of the SendUserLink MCP server the app attaches to CLAUDE
// CODE sessions: it deploys the real files and then speaks real JSON-RPC to a
// real node subprocess over stdio, exactly as Claude Code does. A unit test of
// the source string would have proved nothing about whether the server starts,
// frames its messages, or answers the handshake.
describe('the deployed server over stdio', () => {
  let baseDir: string;
  let deployment: ReturnType<typeof deployClaudeCodeLinkMcp>;
  let server: ChildProcessWithoutNullStreams;

  /** One in-flight request per id; the server answers on stdout, newline-framed. */
  const pending = new Map<number, (msg: any) => void>();
  let nextId = 1;
  let stderrText = '';

  function request(method: string, params?: unknown): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method} within 5s; stderr: ${stderrText}`)), 5000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function callTool(args: unknown): Promise<any> {
    return request('tools/call', { name: 'SendUserLink', arguments: args });
  }

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-link-mcp-'));
    deployment = deployClaudeCodeLinkMcp(baseDir, process.execPath);
    server = spawn(process.execPath, [deployment.serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    server.stderr.setEncoding('utf8');
    server.stderr.on('data', (c: string) => { stderrText += c; });
    let buf = '';
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          const msg = JSON.parse(line);
          pending.get(msg.id)?.(msg);
          pending.delete(msg.id);
        }
        i = buf.indexOf('\n');
      }
    });
  });

  afterAll(() => {
    server?.kill();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe('deployment', () => {
    it('writes the server and a config naming it, under the app dir only', () => {
      expect(fs.existsSync(deployment.serverPath)).toBe(true);
      expect(deployment.serverPath.startsWith(path.join(baseDir, CLAUDE_CODE_MCP_DIR))).toBe(true);
      const config = JSON.parse(fs.readFileSync(deployment.configPath, 'utf8'));
      expect(config.mcpServers[CLAUDE_CODE_MCP_SERVER_ID]).toEqual({
        type: 'stdio',
        command: process.execPath,
        args: [deployment.serverPath],
      });
    });

    it('returns a config FILE path plus the one pre-approved tool', () => {
      // A path, never inline JSON: these args are re-joined into a command line
      // by node-pty on Windows, where braces and quotes do not survive.
      expect(deployment.args).toEqual(['--mcp-config', deployment.configPath, '--allowedTools', CLAUDE_CODE_LINK_TOOL]);
    });

    it('re-deploying is idempotent — an app update just refreshes the files', () => {
      const again = deployClaudeCodeLinkMcp(baseDir, process.execPath);
      expect(again.serverPath).toBe(deployment.serverPath);
      expect(fs.readFileSync(again.serverPath, 'utf8')).toBe(fs.readFileSync(deployment.serverPath, 'utf8'));
    });
  });

  describe('the server speaks MCP over stdio', () => {
    it('answers initialize with the protocol version the client asked for', async () => {
      const res = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      expect(res.result.protocolVersion).toBe('2025-06-18');
      expect(res.result.capabilities.tools).toBeDefined();
      expect(res.result.serverInfo.name).toBe(CLAUDE_CODE_MCP_SERVER_ID);
    });

    it('lists exactly one tool, SendUserLink, with a links array', async () => {
      const res = await request('tools/list');
      expect(res.result.tools).toHaveLength(1);
      const tool = res.result.tools[0];
      expect(tool.name).toBe('SendUserLink');
      expect(tool.inputSchema.required).toEqual(['links']);
      expect(tool.inputSchema.properties.links.items.properties.url).toBeDefined();
      // The same guidance the native tool gives, so the model behaves the same
      // in a Claude Code session as in a YouCoded one.
      expect(tool.description).toContain('http://localhost:5173');
    });

    it('sends links and reports the count', async () => {
      const res = await callTool({ links: [{ url: 'http://localhost:5173', label: 'Dev server' }], caption: 'local' });
      expect(res.result.isError).toBe(false);
      expect(res.result.content[0].text).toBe('Sent 1 link to the user.');
      const many = await callTool({ links: [{ url: 'https://example.com' }, { url: 'http://192.168.1.9:8080' }] });
      expect(many.result.content[0].text).toBe('Sent 2 links to the user.');
    });

    it('fails the WHOLE call and names every bad URL with its own reason', async () => {
      const res = await callTool({ links: [{ url: 'https://ok.example' }, { url: 'javascript:alert(1)' }, { url: 'localhost:5173' }] });
      expect(res.result.isError).toBe(true);
      const text: string = res.result.content[0].text;
      expect(text).toContain('nothing was sent');
      expect(text).toContain('javascript:alert(1): only http:// and https:// URLs can be sent');
      // A bare host:port parses as the scheme "localhost:", so it is rejected as
      // an unsupported scheme rather than as malformed — identical wording to the
      // native tool, whose own suite pins the same case.
      expect(text).toContain('localhost:5173: only http:// and https:// URLs can be sent');
      expect(text).not.toContain('https://ok.example:');
    });

    it('rejects an empty or missing links array instead of claiming success', async () => {
      const res = await callTool({ links: [] });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toContain('non-empty array');
    });

    it('answers an unknown tool and an unknown method with JSON-RPC errors', async () => {
      const badTool = await request('tools/call', { name: 'SomethingElse', arguments: {} });
      expect(badTool.error.code).toBe(-32602);
      const badMethod = await request('resources/list');
      expect(badMethod.error.code).toBe(-32601);
    });

    it('never answers a notification, and survives an unparseable line', async () => {
      // Both are things a real client does; either one answered (or crashing the
      // server) would break the session's whole MCP connection.
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      server.stdin.write('this is not json\n');
      const res = await request('ping');
      expect(res.result).toEqual({});
      // WAIT for it. `request()` resolves on STDOUT; this asserts on STDERR, and
      // they are separate pipes with independent buffering — so the server's
      // parse-error write can still be in flight when the ping reply lands. The
      // failure is `expected '' to contain …` (empty, not partial), it only
      // shows under CI's parallel load, and it cost a red ubuntu leg on
      // youcoded#386. The assertion itself is right and stays: an unparseable
      // line must be survived AND reported.
      // 5s to match request()'s own reply timeout above: latency here is
      // microseconds, so a real regression should surface fast rather than
      // costing waitFor's 15s default (measured: with the server's report
      // removed, this fails — the wait tolerates arrival, it does not mask
      // absence).
      await vi.waitFor(() => expect(stderrText).toContain('unparseable line'), { timeout: 5000 });
    });
  });
});

// Guard: the SendUserLink MCP server exists in TWO places — embedded in
// claude-code-mcp.ts (desktop writes it into userData at session start) and as
// an Android asset (PtyBridge writes it into .claude-mobile). They must stay
// byte-identical, and the three name literals must agree across TypeScript and
// Kotlin. Drift here is invisible until a phone silently loses the link tool.
describe('desktop and Android copies', () => {
  const ANDROID_ASSET = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'send-user-link-mcp.js');
  const ANDROID_KT = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'ClaudeCodeMcp.kt');

  describe('SendUserLink MCP server parity', () => {
    it('the embedded desktop copy is byte-identical to the Android asset', () => {
      // WHY: byte-identical comparison — LINK_SERVER_JS is a TS string constant,
      // never a disk read, so it cannot be run through readSource; normalising
      // only the Android side would compare a stripped string against a raw one
      // and mask real drift. Left as a raw read on purpose (Task 2 clarification).
      expect(LINK_SERVER_JS).toBe(fs.readFileSync(ANDROID_ASSET, 'utf8'));
    });

    it('the server source stays String.raw-safe', () => {
      // A backtick would end the template early and a ${ would interpolate —
      // either one corrupts the embedded copy silently at build time.
      expect(LINK_SERVER_JS.includes('`')).toBe(false);
      expect(LINK_SERVER_JS.includes('${')).toBe(false);
    });

    it('the server advertises the tool under the name the renderer matches', () => {
      // The server declares a bare tool name; Claude Code prefixes it. Both
      // halves of the composed name have to be right or the tile never draws.
      expect(LINK_SERVER_JS).toContain(`var TOOL_NAME = '${SEND_USER_LINK_TOOL}';`);
      expect(CLAUDE_CODE_LINK_TOOL).toBe(`mcp__${CLAUDE_CODE_MCP_SERVER_ID}__${SEND_USER_LINK_TOOL}`);
      expect(LINK_SERVER_JS).toContain(`serverInfo: { name: '${CLAUDE_CODE_MCP_SERVER_ID}', version:`);
    });

    it('Kotlin declares the same server id and tool name', () => {
      const kt = readSource(ANDROID_KT);
      expect(kt).toContain(`const val SERVER_ID = "${CLAUDE_CODE_MCP_SERVER_ID}"`);
      expect(kt).toContain(`const val TOOL_NAME = "${CLAUDE_CODE_LINK_TOOL}"`);
      expect(kt).toContain('const val SERVER_FILE = "send-user-link-mcp.js"');
    });
  });
});
