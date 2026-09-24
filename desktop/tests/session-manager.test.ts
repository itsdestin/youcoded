import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { SessionManager, resolveShellCommand, shellDisplayName, prepareRunInTerminal } from '../src/main/session-manager';
import { createTransferredExitGate } from '../src/main/conversations/handoff-exit';
import { createResumeAdmission } from '../src/main/conversations/resume-admission';

const tmpDir = os.tmpdir();

// One fake PTY worker whose message handlers we can fire by hand — the real one
// is a child process, and the whole point of these tests is the ORDER in which
// SessionManager talks to it.
const handlers: Record<string, (...args: any[]) => void> = {};
// Typed loose on purpose: the SessionManager section reads handlers back out of
// on.mock.calls, which a (event, cb) signature would type as possibly undefined.
const captureOn = (...[event, cb]: any[]) => { handlers[event] = cb; };
const mockWorker = {
  send: vi.fn(),
  on: vi.fn(captureOn),
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

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // WHY captureOn and not a bare vi.fn(): this worker is shared with the shell
    // section below, whose tests fire handlers by hand. A bare vi.fn() would stay
    // installed after this section and leave `handlers` empty there.
    mockWorker.on = vi.fn(captureOn);
    mockWorker.send = vi.fn();
    mockWorker.disconnect = vi.fn();
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it.each(['window close', 'remote destroy'])('fences a transferred lease on direct manager destroy (%s)', async () => {
    const info = manager.createSession({ name: 'transferred', cwd: tmpDir, skipPermissions: false });
    const release = vi.fn(async () => {});
    const admission = createResumeAdmission({ acquire: vi.fn(async () => ({ ok: true })), release, getLive: () => undefined });
    const pinRelease = vi.fn();
    let pinned = true;
    const gate = createTransferredExitGate(admission, (id: string) => id === info.id && pinned, () => {
      pinned = false; pinRelease();
    });
    manager.on('session-stopped', gate.onStopped);
    manager.on('session-exit', (id: string) => {
      if (!gate.onExit(id, 'conversation', Promise.resolve())) admission.markExit('conversation');
    });
    // Both routes call SessionManager directly, bypassing SESSION_DESTROY.
    manager.destroySession(info.id);
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    expect(pinRelease).not.toHaveBeenCalled();
    expect(admission.isUnsafe('conversation')).toBe(true);
    handlers.disconnect();
    handlers.message({ type: 'exit', exitCode: 0 });
    expect(release).not.toHaveBeenCalled();
    expect(pinRelease).not.toHaveBeenCalled();
  });

  it('releases a direct destroy only if its worker reports PTY exit before disconnect', async () => {
    const info = manager.createSession({ name: 'transferred', cwd: tmpDir, skipPermissions: false });
    const release = vi.fn(async () => {});
    const admission = createResumeAdmission({ acquire: vi.fn(async () => ({ ok: true })), release, getLive: () => undefined });
    const pinRelease = vi.fn();
    let pinned = true;
    const gate = createTransferredExitGate(admission, () => pinned, () => { pinned = false; pinRelease(); });
    manager.on('session-stopped', gate.onStopped);
    manager.on('session-exit', (id: string) => {
      if (!gate.onExit(id, 'conversation', Promise.resolve())) admission.markExit('conversation');
    });
    manager.destroySession(info.id);
    expect(release).not.toHaveBeenCalled();
    handlers.message({ type: 'exit', exitCode: 0 });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(pinRelease).toHaveBeenCalledTimes(1);
    handlers.exit(0);
    gate.onStopped(info.id);
    gate.onExit(info.id, 'conversation', Promise.resolve());
    expect(release).toHaveBeenCalledTimes(1);
    expect(pinRelease).toHaveBeenCalledTimes(1);
  });

  it('retains a transferred lease when PTY proof arrives but teardown fails', async () => {
    const info = manager.createSession({ name: 'transferred', cwd: tmpDir, skipPermissions: false });
    const release = vi.fn(async () => {});
    const admission = createResumeAdmission({ acquire: vi.fn(async () => ({ ok: true })), release, getLive: () => undefined });
    let pinned = true;
    const gate = createTransferredExitGate(admission, () => pinned, () => { pinned = false; });
    manager.on('session-stopped', gate.onStopped);
    manager.on('session-exit', (id: string) => {
      if (!gate.onExit(id, 'conversation', Promise.reject(new Error('native teardown failed'))))
        admission.markExit('conversation');
    });
    manager.destroySession(info.id);
    handlers.message({ type: 'exit', exitCode: 0 });
    await vi.waitFor(() => expect(admission.isUnsafe('conversation')).toBe(true));
    expect(release).not.toHaveBeenCalled();
    expect(pinned).toBe(true);
  });

  it.each(['resolves', 'rejects'])('spontaneous PTY exit keeps the pin until teardown %s', async (outcome) => {
    const info = manager.createSession({ name: 'transferred', cwd: tmpDir, skipPermissions: false });
    const release = vi.fn(async () => {});
    const admission = createResumeAdmission({ acquire: vi.fn(async () => ({ ok: true })), release, getLive: () => undefined });
    const pinRelease = vi.fn();
    let pinned = true;
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const teardown = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const gate = createTransferredExitGate(admission, () => pinned, () => { pinned = false; pinRelease(); });
    manager.on('session-stopped', gate.onStopped);
    manager.on('session-exit', (id: string) => {
      if (!gate.onExit(id, 'conversation', teardown)) admission.markExit('conversation', teardown);
    });
    handlers.message({ type: 'exit', exitCode: 0 });
    expect(pinRelease).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(admission.isUnsafe('conversation')).toBe(true);
    gate.onStopped(info.id); // duplicate proof cannot settle twice
    gate.onExit(info.id, 'conversation', teardown); // duplicate exit cannot settle twice
    if (outcome === 'rejects') {
      fail(new Error('append chain failed'));
      await Promise.resolve(); await Promise.resolve();
      expect(pinRelease).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(admission.isUnsafe('conversation')).toBe(true);
    } else {
      finish();
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      expect(pinRelease).toHaveBeenCalledTimes(1);
      gate.onStopped(info.id);
      gate.onExit(info.id, 'conversation', teardown);
      expect(release).toHaveBeenCalledTimes(1);
      expect(pinRelease).toHaveBeenCalledTimes(1);
    }
  });

  it('releases transferred lease and pin exactly once on the PTY exit frame', async () => {
    const info = manager.createSession({ name: 'transferred', cwd: tmpDir, skipPermissions: false });
    const release = vi.fn(async () => {});
    const admission = createResumeAdmission({ acquire: vi.fn(async () => ({ ok: true })), release, getLive: () => undefined });
    const pinRelease = vi.fn();
    let pinned = true;
    const gate = createTransferredExitGate(admission, (id: string) => id === info.id && pinned, () => {
      pinned = false; pinRelease();
    });
    manager.on('session-stopped', gate.onStopped);
    manager.on('session-exit', (id: string) => {
      if (!gate.onExit(id, 'conversation', Promise.resolve())) admission.markExit('conversation');
    });
    expect(release).not.toHaveBeenCalled();
    handlers.message({ type: 'exit', exitCode: 0 });
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(pinRelease).toHaveBeenCalledTimes(1);
    handlers.exit(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not report a transferred writer stopped on early destroy exit', () => {
    const info = manager.createSession({ name: 'transferred', cwd: tmpDir, skipPermissions: false });
    const events: string[] = [];
    manager.on('session-exit', () => events.push('exit'));
    manager.on('session-stopped', () => events.push('stopped'));
    manager.destroySession(info.id);
    expect(events).toEqual(['exit']);
    handlers.disconnect();
    handlers.message({ type: 'exit', exitCode: 0 });
    expect(events).toEqual(['exit']);
  });

  it('confirms handoff only from captured PTY exit, sharing concurrent requests and blocking input', async () => {
    const info = manager.createSession({ name: 'handoff', cwd: tmpDir, skipPermissions: false });
    const exits = vi.fn();
    const stopped = vi.fn();
    manager.on('session-stopped', stopped);
    manager.on('session-exit', exits);
    const first = manager.stopSessionForHandoff(info.id);
    const second = manager.stopSessionForHandoff(info.id);
    expect(second).toBe(first);
    expect(mockWorker.send).toHaveBeenCalledWith({ type: 'stop-for-handoff' }, expect.any(Function));
    expect(mockWorker.disconnect).not.toHaveBeenCalled();
    expect(manager.sendInput(info.id, 'late turn\r')).toBe(false);
    expect(manager.listSessions()).toHaveLength(1);
    // A killed PTY reports a signal code; a deliberate handoff stop is still a clean exit.
    handlers.message({ type: 'exit', exitCode: 129 });
    expect(exits).toHaveBeenCalledWith(info.id, 0);
    expect(mockWorker.send).toHaveBeenCalledWith({ type: 'handoff-exit-received' });
    expect(await first).toEqual({ status: 'stopped' });
    expect(stopped).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledTimes(1);
    handlers.exit(0);
    expect(exits).toHaveBeenCalledTimes(1);
    expect(await manager.stopSessionForHandoff(info.id)).toEqual({ status: 'unknown' });
  });

  it('does not infer handoff proof from a natural exit before the stop request or a native record', async () => {
    const info = manager.createSession({ name: 'natural', cwd: tmpDir, skipPermissions: false });
    handlers.message({ type: 'exit', exitCode: 0 });
    expect(await manager.stopSessionForHandoff(info.id)).toEqual({ status: 'unknown' });
    const native = manager.createSession({ name: 'native', cwd: tmpDir, skipPermissions: false,
      provider: 'native', binding: { providerId: 'openrouter', modelId: 'test' } });
    expect(await manager.stopSessionForHandoff(native.id)).toEqual({ status: 'unknown' });
  });

  it.each(['exit', 'disconnect', 'error', 'send-error', 'kill-error', 'destroy', 'timeout'])(
    'does not certify handoff from %s without PTY exit', async (failure) => {
      vi.useFakeTimers();
      try {
        const info = manager.createSession({ name: 'handoff', cwd: tmpDir, skipPermissions: false });
        if (failure === 'kill-error') mockWorker.send.mockImplementationOnce(() => { throw new Error('send failed'); });
        const stop = manager.stopSessionForHandoff(info.id);
        if (failure === 'exit') handlers.exit(0);
        if (failure === 'disconnect') handlers.disconnect();
        if (failure === 'error') handlers.error(new Error('crash'));
        if (failure === 'send-error') mockWorker.send.mock.lastCall?.[1](new Error('send failed'));
        if (failure === 'destroy') manager.destroySession(info.id);
        if (failure === 'timeout') await vi.runAllTimersAsync();
        expect(await stop).toEqual({ status: 'unknown' });
        if (failure === 'timeout' || failure === 'send-error' || failure === 'kill-error') {
          expect(manager.sendInput(info.id, 'late turn\r')).toBe(false);
          expect(await manager.stopSessionForHandoff(info.id)).toEqual({ status: 'unknown' });
        }
        handlers.message({ type: 'exit', exitCode: 0 });
        // A queued exit frame delivered after worker death cannot resurrect proof.
        if (failure === 'exit') expect(mockWorker.send).not.toHaveBeenCalledWith({ type: 'handoff-exit-received' });
        expect(await stop).toEqual({ status: 'unknown' });
      } finally { vi.useRealTimers(); }
    },
  );

  it('creates a session and returns session info', () => {
    const info = manager.createSession({
      name: 'test-session',
      cwd: tmpDir,
      skipPermissions: false,
    });

    expect(info.id).toBeDefined();
    expect(info.name).toBe('test-session');
    expect(info.cwd).toBe(tmpDir);
    expect(info.status).toBe('active');
  });

  it('includes model in session info when provided', () => {
    const info = manager.createSession({
      name: 'model-test',
      cwd: tmpDir,
      skipPermissions: false,
      model: 'claude-sonnet-4-6',
    });
    expect(info.model).toBe('claude-sonnet-4-6');
  });

  it('has undefined model in session info when not provided', () => {
    const info = manager.createSession({
      name: 'no-model-test',
      cwd: tmpDir,
      skipPermissions: false,
    });
    expect(info.model).toBeUndefined();
  });

  it('lists all active sessions', () => {
    manager.createSession({ name: 's1', cwd: tmpDir, skipPermissions: false });
    manager.createSession({ name: 's2', cwd: tmpDir, skipPermissions: false });

    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it('destroys a session by id', () => {
    const info = manager.createSession({ name: 'test', cwd: tmpDir, skipPermissions: false });
    manager.destroySession(info.id);

    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(0);
  });

  it('sends spawn with --dangerously-skip-permissions when requested', () => {
    manager.createSession({ name: 'skip', cwd: tmpDir, skipPermissions: true });

    const spawnMsg = mockWorker.send.mock.calls[0][0];
    expect(spawnMsg.type).toBe('spawn');
    expect(spawnMsg.args).toContain('--dangerously-skip-permissions');
  });

  // Claude Code has no link deliverable of its own; the app attaches one per
  // session (claude-code-mcp.ts). These two flags are the whole mechanism —
  // if they stop being passed, the link tile silently never appears in a
  // Claude Code session and nothing else fails.
  it('attaches the SendUserLink MCP server to every Claude Code session', () => {
    manager.createSession({ name: 'mcp', cwd: tmpDir, skipPermissions: false });
    const args: string[] = mockWorker.send.mock.calls[0][0].args;

    const configIdx = args.indexOf('--mcp-config');
    expect(configIdx).toBeGreaterThanOrEqual(0);
    const configPath = args[configIdx + 1];
    // A FILE path (node-pty re-joins these into one command line on Windows,
    // where inline JSON would not survive), inside the app's OWN data dir —
    // never ~/.claude.json, which no code path can un-write.
    expect(configPath.startsWith(path.join(tmpDir, 'claude-code-mcp'))).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(Object.keys(config.mcpServers)).toEqual(['youcoded']);
    expect(fs.existsSync(config.mcpServers.youcoded.args[0])).toBe(true);

    // Pre-approved, so handing the user a link never raises a permission prompt.
    expect(args).toContain('--allowedTools');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__youcoded__SendUserLink');
  });

  it('emits pty-output when worker sends data', () => {
    manager.createSession({ name: 'test', cwd: tmpDir, skipPermissions: false });

    const messageHandler = mockWorker.on.mock.calls.find(
      (c: any) => c[0] === 'message'
    )?.[1];

    const received: string[] = [];
    manager.on('pty-output', (_id: string, data: string) => received.push(data));

    messageHandler({ type: 'data', data: 'hello world' });
    expect(received).toEqual(['hello world']);
  });

  it('emits session-exit when worker reports exit', () => {
    manager.createSession({ name: 'test', cwd: tmpDir, skipPermissions: false });

    const messageHandler = mockWorker.on.mock.calls.find(
      (c: any) => c[0] === 'message'
    )?.[1];

    const exits: string[] = [];
    manager.on('session-exit', (id: string) => exits.push(id));

    messageHandler({ type: 'exit', exitCode: 0 });
    expect(exits).toHaveLength(1);
    expect(manager.listSessions()).toHaveLength(0);
  });

  it('does not emit session-exit after explicit destroy', () => {
    manager.createSession({ name: 'test', cwd: tmpDir, skipPermissions: false });

    const exitHandler = mockWorker.on.mock.calls.find(
      (c: any) => c[0] === 'exit'
    )?.[1];

    manager.destroySession(manager.listSessions()[0].id);

    const exits: string[] = [];
    manager.on('session-exit', (id: string) => exits.push(id));

    exitHandler();
    expect(exits).toHaveLength(0);
  });

  // --- initialInput propagation (Task 10: dev:open-session-in) ---

  it('carries initialInput through to SessionInfo when provided', () => {
    const info = manager.createSession({
      name: 'prefill-test',
      cwd: tmpDir,
      skipPermissions: false,
      initialInput: 'hello from dev panel',
    });
    expect(info.initialInput).toBe('hello from dev panel');
  });

  it('leaves initialInput undefined when not provided', () => {
    const info = manager.createSession({
      name: 'no-prefill-test',
      cwd: tmpDir,
      skipPermissions: false,
    });
    // initialInput should be absent, not an empty string — keeps the object clean.
    expect(info.initialInput).toBeUndefined();
  });

  it('emits session-created event with initialInput in the info object', () => {
    const emitted: any[] = [];
    manager.on('session-created', (info) => emitted.push(info));
    manager.createSession({
      name: 'emit-prefill-test',
      cwd: tmpDir,
      skipPermissions: false,
      initialInput: 'prefill text',
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].initialInput).toBe('prefill text');
  });

  // --- broadcastReloadPlugins gating (stray-Enter fix) ---
  //
  // `/reload-plugins\r` typed into a session whose PTY is showing a live Ink
  // select menu (permission prompt / AskUserQuestion) presses Enter on the
  // highlighted option. The broadcast must defer per-session while a
  // permission request is pending there.

  describe('broadcastReloadPlugins gating', () => {
    const reloadSends = () =>
      mockWorker.send.mock.calls.filter(
        (c: any) => c[0].type === 'input' && c[0].data === '/reload-plugins\r',
      );

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends /reload-plugins to active sessions after the delay', () => {
      manager.createSession({ name: 's1', cwd: tmpDir, skipPermissions: false });
      manager.broadcastReloadPlugins(100);
      expect(reloadSends()).toHaveLength(0);
      vi.advanceTimersByTime(100);
      expect(reloadSends()).toHaveLength(1);
    });

    it('defers the send while the gate reports the session blocked', () => {
      manager.createSession({ name: 's1', cwd: tmpDir, skipPermissions: false });
      let blocked = true;
      manager.setReloadPluginsGate(() => blocked);

      manager.broadcastReloadPlugins(100);
      vi.advanceTimersByTime(100);
      expect(reloadSends()).toHaveLength(0);

      // Still blocked across one retry tick…
      vi.advanceTimersByTime(5000);
      expect(reloadSends()).toHaveLength(0);

      // …then the permission resolves and the next retry delivers the reload.
      blocked = false;
      vi.advanceTimersByTime(5000);
      expect(reloadSends()).toHaveLength(1);
    });

    it('gives up after the retry cap instead of retrying forever', () => {
      manager.createSession({ name: 's1', cwd: tmpDir, skipPermissions: false });
      manager.setReloadPluginsGate(() => true);

      manager.broadcastReloadPlugins(0);
      // Far beyond the cap window — nothing should ever be sent.
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(reloadSends()).toHaveLength(0);
    });

    it('drops the retry when the session is destroyed in the meantime', () => {
      const info = manager.createSession({ name: 's1', cwd: tmpDir, skipPermissions: false });
      let blocked = true;
      manager.setReloadPluginsGate(() => blocked);

      manager.broadcastReloadPlugins(0);
      vi.advanceTimersByTime(0);
      manager.destroySession(info.id);
      blocked = false;
      vi.advanceTimersByTime(5000);
      expect(reloadSends()).toHaveLength(0);
    });
  });
});

// The plain-shell session provider.
//
// A shell session is the user's own terminal running inside the app — no AI in
// it at all. It exists so "Run in terminal" can put a set-up command in front of
// the user instead of sending them off to find a terminal. Everything pinned
// here is a way that could go wrong SILENTLY: a command that never arrives, a
// command that runs itself, a hook pipe that makes a plain shell look like a
// Claude Code session, or the app typing "/reload-plugins" at someone's prompt.

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
  // WHY the source shapes are not here (Plan B, 2026-09-16): that both entry
  // points call the validator, that the initial command takes the chunked
  // channel, that ordinary typing keeps its single write, and that the remote
  // session:create case refuses a shell provider are ast-grep rules in
  // youcoded-dev's scripts/ast-grep/rules/ — run-in-terminal-entry-points-validate
  // (+ -remote), run-in-terminal-chunked-write, pty-worker-passthrough-single-write
  // and remote-session-create-refuses-shell-provider.
  describe('every way to open a shell goes through the validator', () => {
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
