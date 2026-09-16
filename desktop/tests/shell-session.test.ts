// The plain-shell session provider (local-engine upgrades §F, T5).
//
// A shell session is the user's own terminal running inside the app — no AI in
// it at all. It exists so "Run in terminal" can put a set-up command in front of
// the user instead of sending them off to find a terminal. Everything pinned
// here is a way that could go wrong SILENTLY: a command that never arrives, a
// command that runs itself, a hook pipe that makes a plain shell look like a
// Claude Code session, or the app typing "/reload-plugins" at someone's prompt.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { SessionManager, resolveShellCommand, shellDisplayName, prepareRunInTerminal } from '../src/main/session-manager';

const tmpDir = os.tmpdir();

// One fake PTY worker whose message handlers we can fire by hand — the real one
// is a child process, and the whole point of these tests is the ORDER in which
// SessionManager talks to it.
const handlers: Record<string, (...args: any[]) => void> = {};
const mockWorker = {
  send: vi.fn(),
  on: vi.fn((event: string, cb: (...args: any[]) => void) => { handlers[event] = cb; }),
  disconnect: vi.fn(),
  kill: vi.fn(),
  stderr: { on: vi.fn() },
};

vi.mock('child_process', () => ({
  fork: vi.fn(() => mockWorker),
  spawn: vi.fn(() => mockWorker),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => tmpDir) },
}));

/** The 'spawn' message SessionManager sent to the worker. */
function spawnMessage() {
  return mockWorker.send.mock.calls.map((c) => c[0]).find((m: any) => m?.type === 'spawn');
}
/** Every write to the PTY, in order — ordinary input AND the chunked channel the
 *  initial run-in-terminal command uses. */
function inputMessages() {
  return mockWorker.send.mock.calls.map((c) => c[0])
    .filter((m: any) => m?.type === 'input' || m?.type === 'input-chunked');
}

/** The token createSession demands for a shell session. Minting it through the
 *  real validator is the point: these tests take the same path the app does. */
function shellGate() {
  return { shellToken: prepareRunInTerminal('echo placeholder').shellToken };
}

describe('shell sessions', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(handlers)) delete handlers[k];
    manager = new SessionManager();
    manager.setPipeName('\\\\.\\pipe\\youcoded-test');
  });

  afterEach(() => { manager.destroyAll(); });

  describe('what gets spawned', () => {
    it('spawns the user\'s own shell with no arguments', () => {
      manager.createSession({ name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', ...shellGate() });
      const msg = spawnMessage();
      expect(msg.command).toBe(resolveShellCommand());
      expect(msg.command).not.toBe('claude');
      expect(msg.args).toEqual([]);
    });

    it('passes NO hook pipe and NO session id, so nothing watches it', () => {
      // If these carried real values and the user started Claude Code inside the
      // terminal, its hooks would report against THIS session — attaching a
      // transcript, and a chat view, to a plain shell.
      manager.createSession({ name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', ...shellGate() });
      const msg = spawnMessage();
      expect(msg.pipeName).toBe('');
      expect(msg.sessionId).toBe('');
    });

    it('still passes the pipe and id for a Claude session', () => {
      // Guards the guard: if the shell branch above were accidentally applied to
      // every session, Claude Code sessions would lose their hook relay and the
      // test above would still pass.
      const info = manager.createSession({ name: 'cc', cwd: tmpDir, skipPermissions: false });
      const msg = spawnMessage();
      expect(msg.command).toBe('claude');
      expect(msg.pipeName).toBe('\\\\.\\pipe\\youcoded-test');
      expect(msg.sessionId).toBe(info.id);
    });

    it('takes none of the Claude CLI flags', () => {
      manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: true, provider: 'shell', ...shellGate(),
        model: 'claude-sonnet-4-6', resumeSessionId: 'abc',
      });
      expect(spawnMessage().args).toEqual([]);
    });

    it('carries no model and labels itself with the shell name', () => {
      const info = manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', ...shellGate(), model: 'claude-sonnet-4-6',
      });
      expect(info.provider).toBe('shell');
      expect(info.model).toBeUndefined();
      expect(info.shellName).toBe(shellDisplayName(resolveShellCommand()));
    });
  });

  describe('the command is typed, not run', () => {
    const COMMAND = 'sudo pacman -S rocm-hip-runtime';

    it('writes NOTHING before the PTY has produced output', () => {
      // The rule this pins: a command written at spawn time can be swallowed by
      // the shell before its line editor is ready, and the terminal then opens
      // empty with no sign of what the user was meant to run.
      manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', ...shellGate(), initialCommand: COMMAND,
      });
      expect(inputMessages()).toEqual([]);
    });

    it('writes it on the first output, with NO trailing carriage return', () => {
      manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', ...shellGate(), initialCommand: COMMAND,
      });
      handlers.message({ type: 'data', data: '$ ' });
      const inputs = inputMessages();
      expect(inputs).toHaveLength(1);
      expect(inputs[0].data).toBe(COMMAND);
      // The carriage return is the difference between "here is the command" and
      // "I ran a sudo command on your machine".
      expect(inputs[0].data.endsWith('\r')).toBe(false);
      expect(inputs[0].data).not.toContain('\n');
    });

    it('writes it exactly once, however much output follows', () => {
      manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', ...shellGate(), initialCommand: COMMAND,
      });
      handlers.message({ type: 'data', data: 'welcome\r\n' });
      handlers.message({ type: 'data', data: '$ ' });
      handlers.message({ type: 'data', data: 'more' });
      expect(inputMessages()).toHaveLength(1);
    });

    it('writes nothing when no command was given', () => {
      manager.createSession({ name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', ...shellGate() });
      handlers.message({ type: 'data', data: '$ ' });
      expect(inputMessages()).toEqual([]);
    });

    it('never types into a Claude session, which has its own input path', () => {
      manager.createSession({
        name: 'cc', cwd: tmpDir, skipPermissions: false, initialCommand: COMMAND,
      });
      handlers.message({ type: 'data', data: 'hello' });
      expect(inputMessages()).toEqual([]);
    });
  });

  describe('the app never types at a shell prompt on its own', () => {
    it('does not broadcast /reload-plugins to a shell session', async () => {
      vi.useFakeTimers();
      try {
        const shell = manager.createSession({
          name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', ...shellGate(),
        });
        expect(shell.provider).toBe('shell');
        mockWorker.send.mockClear();
        manager.broadcastReloadPlugins(0);
        await vi.advanceTimersByTimeAsync(10);
        // A shell session HAS a PTY, so without the provider guard the literal
        // text "/reload-plugins" plus an Enter would be typed into — and run by
        // — the user's shell.
        expect(inputMessages()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // THE property this feature rests on. The app deliberately does not APPEND a
  // carriage return, because pressing Enter is the user's decision — but "we
  // didn't add one" is not the same as "there isn't one". Measured on real
  // bash, zsh and fish: a \r ALREADY INSIDE the command runs it with nobody at
  // the keyboard. The command reaches this validator from a WebSocket frame a
  // remote browser controls, and (in future) from a prerequisite table that
  // could be CRLF-shaped on Windows.
  // The validator only protects what routes through it. This is the assertion
  // that nothing builds a shell session around it.
  describe('every way to open a shell goes through the validator', () => {
    const mainSrc = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');

    it('both entry points call it', () => {
      expect(mainSrc('ipc-handlers.ts')).toContain('prepareRunInTerminal(command)');
      expect(mainSrc('remote-server.ts')).toContain('prepareRunInTerminal(payload?.command ?? payload)');
    });

    it('and there is no third way to build one — the gate is the token, not a grep', () => {
      // This used to be a source scan for the exact string `provider: 'shell',`,
      // which two evasions walked straight past while staying green: a whole new
      // file in main/, and a second site in this same file written as
      // `const SHELL_PROVIDER = 'shell' as const; … provider: SHELL_PROVIDER`.
      // Different quoting, no trailing comma, a one-line object or a spread
      // evaded it identically. createSession now DEMANDS a Symbol only
      // prepareRunInTerminal mints, so however the call is written, a site that
      // skipped the validator throws instead of opening an unchecked shell.
      expect(() => manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell',
        initialCommand: 'echo hi',
      })).toThrow(/must be created through prepareRunInTerminal/);

      // A Symbol cannot survive JSON, so a remote payload cannot carry one...
      expect(() => manager.createSession(JSON.parse(JSON.stringify({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell',
        shellToken: 'run-in-terminal',
      })))).toThrow(/must be created through prepareRunInTerminal/);
      // ...and neither does a look-alike Symbol minted anywhere else.
      expect(() => manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell',
        shellToken: Symbol('run-in-terminal'),
      })).toThrow(/must be created through prepareRunInTerminal/);

      // The real path still works.
      const ok = prepareRunInTerminal('echo hi');
      expect(manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell',
        initialCommand: ok.command, shellToken: ok.shellToken,
      }).provider).toBe('shell');
    });

    it('the initial command goes out on the chunked channel, not ordinary input', () => {
      // Windows ConPTY silently truncates a single write over ~600 chars, which
      // is why the two submit paths in pty-worker chunk at 56. A run-in-terminal
      // command carries no trailing \r, so it would otherwise take the plain
      // passthrough and could land HALF-TYPED on the prompt for the user to run.
      expect(mainSrc('session-manager.ts')).toContain("send({ type: 'input-chunked', data: command })");
    });

    it('...and ordinary typing and paste keep their single unchunked write', () => {
      // The regression this replaced: chunking the general passthrough made a
      // 10 KB terminal paste 179 writes 30 ms apart. Behaviour pinned for real
      // in tests/pty-worker-writes.test.ts; this is the shape, here because this
      // is the file someone reads when changing how the command is written.
      const worker = mainSrc('pty-worker.js');
      const passthrough = worker.slice(worker.indexOf('if (!endsCR) {'));
      expect(passthrough.slice(0, passthrough.indexOf('return;'))).toContain('ptyProcess.write(text);');
    });

    it('the remote session:create case refuses a client-supplied shell provider', () => {
      // Pinned behaviourally in tests/remote-server.test.ts; pinned here as the
      // shape, because this file is where someone looks when adding a caller.
      expect(mainSrc('remote-server.ts')).toContain("if (payload?.provider === 'shell')");
    });
  });

  describe('refusing a command that would run itself', () => {
    it('refuses a carriage return, and says so', () => {
      expect(() => prepareRunInTerminal('echo a\recho b'))
        .toThrow(/carriage return at character 7/);
    });

    it('refuses a line feed, which submits the line just like a carriage return', () => {
      // NOT a formatting nicety: GNU readline binds C-j to accept-line exactly
      // as it binds C-m, so `\n` RUNS the line on bash and zsh (measured on
      // both). An earlier comment here claimed LF was safe; it is not, and that
      // claim is precisely what would talk someone into allowing it.
      expect(() => prepareRunInTerminal('echo a\necho b')).toThrow(/line feed/);
    });

    it('refuses every other control character too', () => {
      expect(() => prepareRunInTerminal('echo a\techo b')).toThrow(/tab/);
      expect(() => prepareRunInTerminal('echo \x1b[31m')).toThrow(/control character \(U\+001B\)/);
      expect(() => prepareRunInTerminal('echo \x00')).toThrow(/control character \(U\+0000\)/);
      expect(() => prepareRunInTerminal('echo \x7f')).toThrow(/control character \(U\+007F\)/);
    });

    it('refuses nothing at all', () => {
      expect(() => prepareRunInTerminal('')).toThrow(/no command/);
      expect(() => prepareRunInTerminal('   ')).toThrow(/no command/);
      expect(() => prepareRunInTerminal(undefined)).toThrow(/no command/);
      expect(() => prepareRunInTerminal({ command: 'x' })).toThrow(/no command/);
    });

    it('accepts everything a real install command needs', () => {
      // None of these submits a line, and refusing them would make the feature
      // useless for the commands it exists to run.
      const commands = [
        'sudo pacman -S --needed rocm-hip-runtime hipblas; echo "done"',
        'sudo apt-get update && sudo apt-get install -y rocm-hip-runtime',
        'curl -fsSL https://example.com/key | sudo gpg --dearmor -o /etc/keyring.gpg',
        'echo "deb [arch=$(dpkg --print-architecture)] https://repo.example.com jammy main"',
        "sudo dnf install -y 'rocm-hip*'",
        'cd "/home/user/My Documents/setup" && ./install.sh',
        'echo naïve —  ✅',
      ];
      for (const cmd of commands) {
        expect(prepareRunInTerminal(cmd).command).toBe(cmd);
      }
      expect(prepareRunInTerminal(commands[0]).shell).toBe(resolveShellCommand());
    });

    it('refuses when the resolved shell is not installed, naming the path', () => {
      // Otherwise createSession returns before the spawn is confirmed, the IPC
      // call RESOLVES, and the user sees a pill flash and vanish with no error.
      if (process.platform === 'win32') return;   // Windows spawns a bare name
      const realShell = process.env.SHELL;
      process.env.SHELL = '/definitely/not/a/shell';
      try {
        expect(() => prepareRunInTerminal('echo hi')).toThrow(/\/definitely\/not\/a\/shell.*does not exist/);
      } finally {
        if (realShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = realShell;
      }
    });
  });

  describe('a shell that never says anything', () => {
    it('types the command anyway after the fallback wait', async () => {
      // A $SHELL that reads input before it writes would otherwise leave the
      // command untyped and the terminal blank forever.
      vi.useFakeTimers();
      try {
        manager.createSession({
          name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', ...shellGate(),
          initialCommand: 'echo hi',
        });
        expect(inputMessages()).toEqual([]);
        await vi.advanceTimersByTimeAsync(3100);
        expect(inputMessages()).toHaveLength(1);
        expect(inputMessages()[0].data).toBe('echo hi');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not type it twice when output arrives after the fallback fired', async () => {
      vi.useFakeTimers();
      try {
        manager.createSession({
          name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', ...shellGate(),
          initialCommand: 'echo hi',
        });
        await vi.advanceTimersByTimeAsync(3100);
        handlers.message({ type: 'data', data: '$ ' });
        expect(inputMessages()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('resolving the shell', () => {
    const realShell = process.env.SHELL;
    afterEach(() => {
      if (realShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = realShell;
    });

    it('prefers $SHELL on this platform', () => {
      if (process.platform === 'win32') return;   // Windows has no $SHELL
      process.env.SHELL = '/usr/bin/fish';
      expect(resolveShellCommand()).toBe('/usr/bin/fish');
    });

    it('falls back to /bin/sh when $SHELL is unset', () => {
      if (process.platform === 'win32') return;
      delete process.env.SHELL;
      expect(resolveShellCommand()).toBe('/bin/sh');
    });

    it('reads a display name off a path', () => {
      expect(shellDisplayName('/usr/bin/fish')).toBe('fish');
      expect(shellDisplayName('/bin/zsh')).toBe('zsh');
      // 'powershell.exe' is the bare name Windows actually spawns — there is no
      // Windows path to test here, and path.basename on POSIX would not split
      // one anyway (it is path.win32.basename that knows about backslashes).
      expect(shellDisplayName('powershell.exe')).toBe('powershell');
    });
  });
});
