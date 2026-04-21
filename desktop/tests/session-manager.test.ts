import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import { SessionManager } from '../src/main/session-manager';

const tmpDir = os.tmpdir();

// Mock child_process.fork to return a fake worker
const mockWorker = {
  send: vi.fn(),
  on: vi.fn(),
  disconnect: vi.fn(),
  kill: vi.fn(),
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
    mockWorker.on = vi.fn();
    mockWorker.send = vi.fn();
    mockWorker.disconnect = vi.fn();
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.destroyAll();
  });

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
});
