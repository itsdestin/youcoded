const net = require('net');
const fs = require('fs');
const socket = process.env.CLAUDE_MOBILE_SOCKET;
if (!socket) process.exit(0);
const rawInput = fs.readFileSync(0, 'utf8');
if (!rawInput.trim()) process.exit(0);

// Inject mobile session ID so EventBridge can map to Claude Code's session_id
var input = rawInput;
if (process.env.CLAUDE_MOBILE_SESSION_ID) {
  try {
    var parsed = JSON.parse(rawInput);
    parsed.mobileSessionId = process.env.CLAUDE_MOBILE_SESSION_ID;
    input = JSON.stringify(parsed);
  } catch(e) { /* send raw if parse fails */ }
}

function send(attempt) {
  const conn = net.connect({ path: '\0' + socket });
  conn.on('connect', function() {
    conn.end(input + '\n', function() {
      process.exit(0);
    });
  });
  conn.on('error', function(err) {
    if (attempt < 3) {
      // Retry after short delay — socket may not be ready yet
      setTimeout(function() { send(attempt + 1); }, 100 * attempt);
    } else {
      process.stderr.write('hook-relay: failed after 3 attempts: ' + err.message + '\n');
      process.exit(0);
    }
  });
}
send(1);
