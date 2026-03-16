const net = require('net');
const fs = require('fs');
const socket = process.env.CLAUDE_MOBILE_SOCKET;
if (!socket) process.exit(0);
const input = fs.readFileSync(0, 'utf8');
if (!input.trim()) process.exit(0);

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
