const net = require('net');
const fs = require('fs');
const socket = process.env.CLAUDE_MOBILE_SOCKET;
if (!socket) process.exit(0);
const input = fs.readFileSync(0, 'utf8');
try {
  const conn = net.connect(socket);
  conn.on('error', () => process.exit(0));
  conn.end(input + '\n');
} catch (e) {
  process.exit(0);
}
