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
// Tier-2 backstop: 2h30m — deliberately 30m LONGER than the app's own 2h hold
// (hook-relay.ts APP_HOLD_MS: the app should answer first, it is the only party
// that can label the card accurately) and 30m SHORTER than the Claude Code hook
// timeout in settings.json (install-hooks.js, 10800s): if the app hangs, this
// relay must fire before Claude Code does. Relay timeout = exit 2 = a clean
// deny that unblocks the turn; a Claude Code hook-kill delivers NO decision,
// and AskUserQuestion then waits forever on Claude Code's default-"never"
// question timeout. Do NOT tidy these back to equal — equal values are the
// silent 5-minute wedge this replaced. Pinned by permission-timeout-margins.test.ts.
const TIMEOUT_MS = parseInt(process.env.CLAUDE_RELAY_TIMEOUT || '9000000', 10);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
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
