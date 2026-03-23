/**
 * hook-relay-blocking.js — Bidirectional blocking relay for PermissionRequest hooks (Android).
 *
 * Protocol:
 *   1. Read hook JSON from stdin
 *   2. Connect to abstract-namespace Unix socket, write JSON + newline
 *   3. WAIT for response:
 *      - Server sends JSON decision → wrap in hookSpecificOutput, print to stdout, exit 0
 *      - Server closes without response → exit 0 (fire-and-forget)
 *      - Timeout → exit 2 (fail-closed: deny)
 *      - Connection error → exit 0 (fall through to terminal prompt)
 */
var net = require('net');
var socket = process.env.CLAUDE_MOBILE_SOCKET;
if (!socket) process.exit(0);
var TIMEOUT_MS = parseInt(process.env.CLAUDE_RELAY_TIMEOUT || '120000', 10);

var input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function(chunk) { input += chunk; });
process.stdin.on('end', function() {
  if (!input.trim()) process.exit(0);

  var conn = net.connect({ path: '\0' + socket });
  var response = '';

  conn.on('connect', function() {
    conn.write(input + '\n');
  });

  conn.on('data', function(chunk) {
    response += chunk;
    var nlIndex = response.indexOf('\n');
    if (nlIndex >= 0) {
      var line = response.substring(0, nlIndex).trim();
      conn.destroy();
      try {
        var appDecision = JSON.parse(line);
        var output = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: appDecision.decision,
          },
        };
        process.stdout.write(JSON.stringify(output) + '\n');
        process.exit(0);
      } catch (e) {
        process.exit(0);
      }
    }
  });

  conn.on('end', function() {
    process.exit(0);
  });

  conn.setTimeout(TIMEOUT_MS, function() {
    conn.destroy();
    process.exit(2);
  });

  conn.on('error', function() {
    process.exit(0);
  });
});
