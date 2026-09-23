import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HookRelay } from '../src/main/hook-relay';
import { randomUUID } from 'crypto';

describe('HookRelay', () => {
  let relay: HookRelay;

  beforeEach(() => {
    // Use a unique pipe name per test to avoid EADDRINUSE
    const pipeName = `\\\\.\\pipe\\claude-desktop-hooks-test-${randomUUID()}`;
    relay = new HookRelay(pipeName);
  });

  afterEach(() => {
    relay.stop();
  });

  it('starts a named pipe server', async () => {
    await relay.start();
    expect(relay.isRunning()).toBe(true);
  });

  it('parses incoming hook JSON and emits events via simulateEvent', async () => {
    const events: any[] = [];
    relay.on('hook-event', (event) => events.push(event));

    const hookPayload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'test-session',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.ts', content: 'hello' },
      tool_response: 'File written',
    });

    await relay.simulateEvent(hookPayload);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('PostToolUse');
    expect(events[0].payload.tool_name).toBe('Write');
  });

  // hasPendingPermission is the main-process side of the stray-Enter fix:
  // while a PermissionRequest socket is held open, the session's PTY has a
  // live Ink select menu, so automated writers (the /reload-plugins
  // broadcast) must not type into it.
  describe('hasPendingPermission', () => {
    it('is false when nothing is pending', () => {
      expect(relay.hasPendingPermission('sess-1')).toBe(false);
    });

    it('tracks a held PermissionRequest socket by session and clears on close', async () => {
      await relay.start();

      const eventPromise = new Promise<any>((resolve) => {
        relay.once('hook-event', resolve);
      });

      const net = await import('net');
      const client = net.createConnection((relay as any).pipeName);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });
      client.write(
        JSON.stringify({
          hook_event_name: 'PermissionRequest',
          _desktop_session_id: 'sess-1',
          tool_name: 'Bash',
        }) + '\n',
      );

      const event = await eventPromise;
      expect(event.type).toBe('PermissionRequest');
      expect(relay.hasPendingPermission('sess-1')).toBe(true);
      expect(relay.hasPendingPermission('other-session')).toBe(false);

      // Socket close (relay timeout / TUI-side answer) must clear the flag.
      const expired = new Promise<void>((resolve) => {
        relay.once('permission-expired', () => resolve());
      });
      client.destroy();
      await expired;
      expect(relay.hasPendingPermission('sess-1')).toBe(false);
    });

    it('clears when the request is answered via respond()', async () => {
      await relay.start();

      const eventPromise = new Promise<any>((resolve) => {
        relay.once('hook-event', resolve);
      });

      const net = await import('net');
      const client = net.createConnection((relay as any).pipeName);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });
      client.write(
        JSON.stringify({
          hook_event_name: 'PermissionRequest',
          _desktop_session_id: 'sess-2',
        }) + '\n',
      );

      const event = await eventPromise;
      expect(relay.hasPendingPermission('sess-2')).toBe(true);

      relay.respond(event.payload._requestId, { decision: { behavior: 'deny' } });
      expect(relay.hasPendingPermission('sess-2')).toBe(false);
      client.destroy();
    });
  });
});

// Roadmap (claude-code-integration, security, 2026-07-26): the session id the
// app hands Claude Code leaks into every process that session starts, so a
// `claude` run from inside it reported its hooks under the parent's id. The
// relay now forwards Claude Code's own CLAUDE_PID; only the first process
// heard from owns the session.
describe('HookOwnerGate', () => {
  it('the first process to report owns the session; another pid is refused', async () => {
    const { HookOwnerGate } = await import('../src/main/hook-relay');
    const g = new HookOwnerGate();
    expect(g.accept('desk-1', '1000')).toBe(true);
    expect(g.accept('desk-1', '1000')).toBe(true);
    expect(g.accept('desk-1', '2000')).toBe(false);
    // Another session has its own owner.
    expect(g.accept('desk-2', '2000')).toBe(true);
  });
  it('fails open with no pid (older Claude Code or relay)', async () => {
    const { HookOwnerGate } = await import('../src/main/hook-relay');
    const g = new HookOwnerGate();
    expect(g.accept('desk-1', '1000')).toBe(true);
    expect(g.accept('desk-1', undefined)).toBe(true);
    expect(g.accept('desk-1', '')).toBe(true);
  });
});

describe('HookRelay — hooks from a nested claude', () => {
  let relay: HookRelay;
  beforeEach(() => { relay = new HookRelay(`\\\\.\\pipe\\claude-desktop-hooks-test-${randomUUID()}`); });
  afterEach(() => { relay.stop(); });

  async function send(payload: object, keepOpen = false): Promise<{ closedWithoutReply: Promise<boolean> }> {
    const net = await import('net');
    const client = net.createConnection((relay as any).pipeName);
    await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('error', reject); });
    let reply = '';
    client.on('data', (d) => { reply += d; });
    const closedWithoutReply = new Promise<boolean>((resolve) => client.on('close', () => resolve(reply === '')));
    client.write(JSON.stringify(payload) + '\n');
    if (!keepOpen) client.end();
    return { closedWithoutReply };
  }

  it('drops a foreign process\'s events and ends its permission request with no decision', async () => {
    await relay.start();
    const events: any[] = [];
    relay.on('hook-event', (e) => events.push(e));
    // Our own claude (pid 1000) announces itself first.
    await send({ hook_event_name: 'SessionStart', session_id: 'ours', source: 'startup', _desktop_session_id: 'desk-1', _claude_pid: '1000' });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(1);
    // A nested `claude` (pid 2000) inherits desk-1 and asks for permission.
    const { closedWithoutReply } = await send({
      hook_event_name: 'PermissionRequest', session_id: 'nested', tool_name: 'Bash',
      _desktop_session_id: 'desk-1', _claude_pid: '2000',
    }, true);
    expect(await closedWithoutReply).toBe(true);
    expect(events).toHaveLength(1);
    expect(relay.hasPendingPermission('desk-1')).toBe(false);
    // Our own process is still heard.
    await send({ hook_event_name: 'PostToolUse', session_id: 'ours', _desktop_session_id: 'desk-1', _claude_pid: '1000' });
    await new Promise((r) => setTimeout(r, 50));
    expect(events.map((e) => e.payload.session_id)).toEqual(['ours', 'ours']);
  });
});
