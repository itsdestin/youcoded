#!/usr/bin/env node
// PTY Worker — runs in a separate Node.js process (not Electron)
// so that node-pty uses Node's native binary, not Electron's.
// Communicates with the Electron main process via IPC (process.send).

const pty = require('node-pty');
const path = require('path');
const fs = require('fs');

// Resolve a command to its absolute path by searching PATH (+ PATHEXT on Windows).
// Uses only Node builtins — the `which` npm package is unavailable here because it
// lives inside the asar archive, which this child process can't read.
// On macOS/Linux, pty.spawn can resolve bare command names via execvp, but Windows
// ConPTY cannot — it needs an absolute path. This function handles both platforms.
function resolveCommand(cmd) {
  // On Windows, check PATHEXT extensions (.cmd, .exe, etc.)
  // On Unix, just check the bare name (extensions array = [''])
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const full = path.join(dir, cmd + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  return cmd; // fallback to bare name (works on macOS/Linux via execvp)
}

let ptyProcess = null;

process.on('message', (msg) => {
  switch (msg.type) {
    case 'spawn': {
      // Resolve full path — node-pty on Windows needs it (no shell lookup)
      const shell = resolveCommand(msg.command || 'claude');
      const args = msg.args || [];
      ptyProcess = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: msg.cols || 120,
        rows: msg.rows || 30,
        cwd: msg.cwd || require('os').homedir(),
        env: {
          ...process.env,
          // Pass our session ID so hook scripts can include it in payloads
          CLAUDE_DESKTOP_SESSION_ID: msg.sessionId || '',
          // Pass the unique pipe name so relay.js connects to the right instance
          CLAUDE_DESKTOP_PIPE: msg.pipeName || '',
        },
      });

      ptyProcess.onData((data) => {
        process.send({ type: 'data', data });
      });

      ptyProcess.onExit(({ exitCode }) => {
        process.send({ type: 'exit', exitCode });
        process.exit(0);
      });

      process.send({ type: 'spawned', pid: ptyProcess.pid });
      break;
    }
    case 'input': {
      if (ptyProcess) ptyProcess.write(msg.data);
      break;
    }
    case 'resize': {
      if (ptyProcess) ptyProcess.resize(msg.cols, msg.rows);
      break;
    }
    case 'kill': {
      if (ptyProcess) ptyProcess.kill();
      break;
    }
  }
});

process.on('disconnect', () => {
  if (ptyProcess) ptyProcess.kill();
  process.exit(0);
});
