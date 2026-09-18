// Attaching YouCoded's SendUserLink tool to a CLAUDE CODE session.
//
// Claude Code ships SendUserFile and no link equivalent, so the app gives each
// session it launches a one-tool MCP server of its own. Everything here is
// per-session and app-owned:
//
//   - the server source and its config are written into the app's OWN userData
//     dir, never into ~/.claude.json. The plugin-manifest route writes entries
//     into that shared file and NEVER removes them again (mcp-reconciler.ts:
//     "additive-only — never overwritten, never removed"), which would leave a
//     dead server pointing at a missing file behind after an uninstall, in
//     every Claude Code on the machine — including plain terminal ones, where
//     there is no YouCoded window to draw the card the tool promises.
//   - both flags are passed at spawn (--mcp-config, --allowedTools), so a
//     `claude` run outside YouCoded is completely unaffected.
//   - --allowedTools pre-approves exactly this one tool, so handing the user a
//     link never raises a permission prompt. It ADDS to the session's allowlist
//     rather than restricting anything else.
//
// The server source is embedded rather than shipped as a separate file so it
// needs no packaging step and no asar unpacking — the app writes it out, and
// the plain node process Claude Code spawns reads it from a real directory.
// Android keeps a byte-identical copy at app/src/main/assets/send-user-link-mcp.js;
// claude-code-mcp.test.ts fails if the two ever drift.
import fs from 'fs';
import path from 'path';
import { CLAUDE_CODE_LINK_TOOL, CLAUDE_CODE_MCP_SERVER_ID } from '../shared/send-user-link';

/** The MCP server, verbatim. Held in String.raw so the embedded copy stays
 *  byte-identical to the Android asset — the server source therefore may not
 *  contain a backtick or a `${`, which the parity test also checks. */
export const LINK_SERVER_JS = String.raw`// YouCoded's SendUserLink MCP server — the Claude Code half of the link
// deliverable (spec 2026-09-02, slice A).
//
// WHY this exists: YouCoded's own harness has a native SendUserLink tool, but
// Claude Code sessions run the real "claude" CLI, which has SendUserFile and no
// link equivalent. Rather than install anything into the user's shared Claude
// Code config (~/.claude.json entries written by the plugin path are never
// removed again — see mcp-reconciler.ts), the app deploys this file next to a
// tiny config and passes BOTH to the CLI per session via --mcp-config. Nothing
// persists: close the session and it is gone; uninstall the app and it is gone.
//
// WHY hand-rolled JSON-RPC instead of the MCP SDK: this file is executed by a
// PLAIN node process that Claude Code spawns — it has no node_modules beside it
// on either platform, and on Android it runs under Termux. Zero dependencies is
// the only shape that works in both places.
//
// MCP stdio framing is newline-delimited JSON-RPC 2.0. stdout carries protocol
// messages ONLY — anything else corrupts the stream, so diagnostics go to
// stderr (which Claude Code surfaces when a server misbehaves).
'use strict';

// Echoed back to the client when it does not state one. Claude Code always
// sends its own, so this is only a floor.
var PROTOCOL_FALLBACK = '2025-06-18';

var TOOL_NAME = 'SendUserLink';

var TOOL = {
  name: TOOL_NAME,
  description: [
    'Send finished URLs to the user — a deployed page, a preview, a localhost dev server, an API — as a "Deliverables" card with links they can open in the browser.',
    'Use it for links the user will want to visit, not for every URL mentioned in passing; do not re-send a link that has not changed.',
    'Only http:// and https:// URLs are accepted (use an absolute URL — localhost and LAN IPs are fine, e.g. http://localhost:5173).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      links: {
        type: 'array',
        minItems: 1,
        description: 'The links to hand to the user, in the order they should appear.',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The full URL to open — http:// or https://. localhost and LAN IPs are allowed.' },
            label: { type: 'string', description: 'Optional short label shown on the tile instead of the bare URL.' },
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
      caption: { type: 'string', description: 'One line of context for the links.' },
    },
    required: ['links'],
    additionalProperties: false,
  },
};

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function replyResult(id, res) {
  write({ jsonrpc: '2.0', id: id, result: res });
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}

// Narrow an unknown throw to its message without a blind cast — new URL()
// throws with a "message" worth surfacing, but a thrown non-Error has none.
function messageOf(err) {
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  return 'not a URL';
}

// Mirrors the native tool (main/harness/tools/send-user-link.ts) exactly: parse
// AND require an explicit http/https scheme, then fail the WHOLE call if any
// link is bad — half-delivering would leave the model believing a bad link
// reached the user. Each bad URL is named with ITS OWN reason so the model can
// tell "malformed" from "unsupported scheme" (docs/error-message-standards.md).
function validate(links) {
  var problems = [];
  for (var i = 0; i < links.length; i++) {
    var raw = links[i] && typeof links[i] === 'object' ? links[i].url : links[i];
    if (typeof raw !== 'string' || raw.length === 0) {
      problems.push('(empty): a link needs a url string');
      continue;
    }
    var parsed;
    try {
      parsed = new URL(raw);
    } catch (err) {
      problems.push(raw + ': ' + messageOf(err));
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      problems.push(raw + ': only http:// and https:// URLs can be sent');
    }
  }
  return problems;
}

function callTool(id, params) {
  var name = params && params.name;
  if (name !== TOOL_NAME) {
    replyError(id, -32602, 'Unknown tool: ' + String(name));
    return;
  }
  var args = (params && params.arguments) || {};
  var links = args.links;
  if (!Array.isArray(links) || links.length === 0) {
    replyResult(id, {
      content: [{ type: 'text', text: 'SendUserLink failed — nothing was sent: links must be a non-empty array of {url, label?}.' }],
      isError: true,
    });
    return;
  }
  var problems = validate(links);
  if (problems.length) {
    var lines = problems.map(function (p) { return '- ' + p; }).join('\n');
    replyResult(id, {
      content: [{ type: 'text', text: 'SendUserLink failed — nothing was sent:\n' + lines }],
      isError: true,
    });
    return;
  }
  var n = links.length;
  replyResult(id, {
    content: [{ type: 'text', text: 'Sent ' + n + ' link' + (n === 1 ? '' : 's') + ' to the user.' }],
    isError: false,
  });
}

function handle(msg) {
  var id = msg.id;
  var method = msg.method;
  // A notification (no id) gets no response, ever — answering one is a protocol
  // violation that some clients treat as a fatal stream error.
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    var asked = msg.params && typeof msg.params.protocolVersion === 'string'
      ? msg.params.protocolVersion
      : PROTOCOL_FALLBACK;
    replyResult(id, {
      protocolVersion: asked,
      capabilities: { tools: {} },
      serverInfo: { name: 'youcoded', version: '1.0.0' },
    });
    return;
  }
  if (method === 'ping') { replyResult(id, {}); return; }
  if (method === 'tools/list') { replyResult(id, { tools: [TOOL] }); return; }
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
        // Unparseable line: there is no id to answer with, so the only correct
        // move is to say so on stderr and keep reading the stream.
        process.stderr.write('send-user-link-mcp: ignoring unparseable line: ' + messageOf(err) + '\n');
      }
      if (msg && typeof msg === 'object') handle(msg);
    }
    idx = buffer.indexOf('\n');
  }
});
process.stdin.on('end', function () { process.exit(0); });
// Claude Code closing the pipe first is normal shutdown, not a crash.
process.stdout.on('error', function () { process.exit(0); });
`;

export interface ClaudeCodeMcpDeployment {
  /** Where the server was written. */
  serverPath: string;
  /** The --mcp-config file naming that server. */
  configPath: string;
  /** The exact CLI flags to append when spawning `claude`. */
  args: string[];
}

/** Directory name under userData — its own folder so the two files are
 *  obviously ours and can be wiped as a unit. */
export const CLAUDE_CODE_MCP_DIR = 'claude-code-mcp';

/**
 * Write the server + its config under `baseDir` and return the flags that
 * attach them to one Claude Code session. Rewritten on every launch, so an app
 * update refreshes the server and a half-written file from a crash cannot
 * outlive the session that produced it.
 *
 * `nodePath` is the interpreter Claude Code will spawn the server with. The
 * caller passes the SAME resolved path it uses for the PTY worker rather than a
 * bare 'node': Claude Code spawns MCP servers with its own environment, and on
 * Windows a bare command name is not resolved for it.
 */
export function deployClaudeCodeLinkMcp(baseDir: string, nodePath: string): ClaudeCodeMcpDeployment {
  const dir = path.join(baseDir, CLAUDE_CODE_MCP_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const serverPath = path.join(dir, 'send-user-link-mcp.js');
  fs.writeFileSync(serverPath, LINK_SERVER_JS, 'utf8');

  const configPath = path.join(dir, 'mcp-config.json');
  const config = {
    mcpServers: {
      [CLAUDE_CODE_MCP_SERVER_ID]: { type: 'stdio', command: nodePath, args: [serverPath] },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  // A FILE path, not inline JSON: --mcp-config accepts either, but these args
  // reach node-pty, which re-joins them into a single command line on Windows.
  // A path carries no quotes or braces that have to survive that; JSON does.
  return { serverPath, configPath, args: ['--mcp-config', configPath, '--allowedTools', CLAUDE_CODE_LINK_TOOL] };
}
