#!/usr/bin/env node
const net = require('net');
const os = require('os');
const path = require('path');
const PIPE_NAME = process.env.CLAUDE_DESKTOP_PIPE || (process.platform === 'win32' ? '\\\\.\\pipe\\claude-desktop-hooks' : path.join(os.tmpdir(), 'claude-desktop-hooks.sock'));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  // Inject our desktop session ID into the payload
  const desktopSessionId = process.env.CLAUDE_DESKTOP_SESSION_ID;
  if (desktopSessionId) {
    try {
      const parsed = JSON.parse(input);
      parsed._desktop_session_id = desktopSessionId;
      input = JSON.stringify(parsed);
    } catch {}
  }

  // Fire-and-forget: write payload + newline, then close
  const client = net.createConnection(PIPE_NAME, () => {
    client.end(input + '\n', () => {
      process.exit(0);
    });
  });

  client.setTimeout(5000, () => {
    client.destroy();
    process.exit(0);
  });

  client.on('error', () => {
    process.exit(0);
  });
});
