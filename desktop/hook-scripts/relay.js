#!/usr/bin/env node
const net = require('net');
// WHY no shared-name fallback (security hardening 2026-10-30): these hooks are installed for EVERY
// `claude` on the machine. When the variable is missing (a plain terminal, or YouCoded could not set up
// a private socket) the old code connected to the fixed shared name /tmp/claude-desktop-hooks.sock, which
// another account on the computer could have created first to read the hook messages and answer permission
// asks. Now: no private socket name from YouCoded means do nothing, quietly, exactly like "app not running".
const PIPE_NAME = process.env.CLAUDE_DESKTOP_PIPE;
if (!PIPE_NAME) process.exit(0);

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
      // WHY (2026-09-23): CLAUDE_DESKTOP_SESSION_ID is inherited by EVERY
      // process the session starts, so a `claude` run from inside it (Bash
      // tool, script) reports its hooks under our id too. Claude Code puts its
      // own process id in every hook's env as CLAUDE_PID; the app accepts only
      // the first process it hears from for a session. Absent → not sent, and
      // the app fails open (older Claude Code).
      if (process.env.CLAUDE_PID) parsed._claude_pid = process.env.CLAUDE_PID;
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
