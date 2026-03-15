const net = require('net');
const { approval, toolCall, ansiStrip } = require('./patterns');

const SOCKET_PATH = process.env.PARSER_SOCKET
  || `${process.env.HOME}/.claude-mobile/parser.sock`;

const fs = require('fs');
try { fs.unlinkSync(SOCKET_PATH); } catch {}
fs.mkdirSync(require('path').dirname(SOCKET_PATH), { recursive: true });

let clientSocket = null;
let buffer = '';

function emit(event) {
  if (clientSocket && !clientSocket.destroyed) {
    clientSocket.write(JSON.stringify(event) + '\n');
  }
}

function processLine(rawLine) {
  const cleanLine = rawLine.replace(ansiStrip, '').trim();
  if (!cleanLine) return;

  for (const pattern of approval) {
    const match = cleanLine.match(pattern);
    if (match) {
      emit({
        type: 'approval_prompt',
        summary: match[1] || cleanLine,
        raw: rawLine,
      });
      return;
    }
  }

  for (const pattern of toolCall) {
    const match = cleanLine.match(pattern);
    if (match) {
      emit({
        type: 'tool_call',
        tool: match[1],
        raw: rawLine,
      });
      return;
    }
  }

  emit({
    type: 'raw',
    text: cleanLine,
    raw: rawLine,
  });
}

function processBuffer() {
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    processLine(line);
  }
}

const server = net.createServer((socket) => {
  clientSocket = socket;

  socket.on('data', (data) => {
    buffer += data.toString();
    processBuffer();
  });

  socket.on('end', () => {
    clientSocket = null;
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
    clientSocket = null;
  });
});

server.listen(SOCKET_PATH, () => {
  console.error(`Parser listening on ${SOCKET_PATH}`);
});

process.on('SIGTERM', () => {
  server.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch {}
  process.exit(0);
});
