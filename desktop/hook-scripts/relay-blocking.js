#!/usr/bin/env node
/**
 * relay-blocking.js — Bidirectional blocking relay for PermissionRequest hooks
 *
 * Protocol:
 *   1. Read hook JSON from stdin
 *   2. Connect to named pipe, write JSON + newline
 *   3. WAIT on the socket:
 *      - If server closes without writing back → exit 0 (fire-and-forget)
 *      - If server writes back JSON → wrap in hookSpecificOutput, exit 0
 *      - If timeout → exit 2 (fail-closed: deny)
 *
 * The SERVER decides whether a hook is blocking — relay doesn't need to know.
 */
const net = require('net');
const os = require('os');
const path = require('path');
const PIPE_NAME = process.env.CLAUDE_DESKTOP_PIPE || (process.platform === 'win32' ? '\\\\.\\pipe\\claude-desktop-hooks' : path.join(os.tmpdir(), 'claude-desktop-hooks.sock'));
// Default 300s to match the Claude Code hook timeout in settings.json.
// If the relay times out before Claude Code's hook timeout, it exits with
// code 2 (deny), causing an auto-deny before the user can respond.
const TIMEOUT_MS = parseInt(process.env.CLAUDE_RELAY_TIMEOUT || '300000', 10);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const desktopSessionId = process.env.CLAUDE_DESKTOP_SESSION_ID;
  if (desktopSessionId) {
    try {
      const parsed = JSON.parse(input);
      parsed._desktop_session_id = desktopSessionId;
      input = JSON.stringify(parsed);
    } catch {}
  }

  const client = net.createConnection(PIPE_NAME, () => {
    client.write(input + '\n');
  });

  let response = '';

  client.on('data', (chunk) => {
    response += chunk;
    const nlIndex = response.indexOf('\n');
    if (nlIndex >= 0) {
      const line = response.substring(0, nlIndex).trim();
      client.destroy();
      try {
        const appDecision = JSON.parse(line);
        const output = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: appDecision.decision,
          },
        };
        process.stdout.write(JSON.stringify(output) + '\n');
        process.exit(0);
      } catch {
        process.exit(0);
      }
    }
  });

  client.on('end', () => {
    process.exit(0);
  });

  client.setTimeout(TIMEOUT_MS, () => {
    client.destroy();
    process.exit(2);
  });

  client.on('error', () => {
    process.exit(0);
  });
});
