const net = require('net');
const fs = require('fs');
const socket = process.env.CLAUDE_MOBILE_SOCKET;
if (!socket) process.exit(0);
const input = fs.readFileSync(0, 'utf8');
try {
  // Connect to Android abstract namespace socket (prefix with \0).
  // LocalServerSocket in Android creates abstract namespace sockets,
  // not filesystem sockets — Node.js needs the \0 prefix to match.
  const conn = net.connect({ path: '\0' + socket });
  conn.on('error', () => process.exit(0));
  conn.end(input + '\n');
} catch (e) {
  process.exit(0);
}
