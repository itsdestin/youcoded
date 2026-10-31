import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HookRelay, hookPipeName } from '../src/main/hook-relay';
import { randomUUID } from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

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
  // The app-owned hold: the app, not Claude Code, ends an unanswered ask — with
  // a labelled deny and a reason the card can use. (Ported from PR #278.)
  describe('app-owned hold', () => {
    async function connectAsk(r: HookRelay, sessionId: string) {
      const net = await import('net');
      const client = net.createConnection((r as any).pipeName);
      await new Promise<void>((res, rej) => { client.on('connect', res); client.on('error', rej); });
      const evt = new Promise<any>((resolve) => r.once('hook-event', resolve));
      const received = new Promise<string>((resolve) => {
        let buf = '';
        client.on('data', (c) => { buf += c; if (buf.includes('\n')) resolve(buf); });
      });
      client.write(JSON.stringify({ hook_event_name: 'PermissionRequest', _desktop_session_id: sessionId }) + '\n');
      return { client, event: await evt, received };
    }

    it('auto-denies in the nested shape the relay reads, with reason app-timeout', async () => {
      const short = new HookRelay((relay as any).pipeName + '-hold', 60);
      await short.start();
      const expired = new Promise<[string, string, string?]>((resolve) => {
        short.once('permission-expired', (sid, rid, reason) => resolve([sid, rid, reason]));
      });
      const { client, received } = await connectAsk(short, 'sess-h');
      const [sid, , reason] = await expired;
      expect(sid).toBe('sess-h');
      expect(reason).toBe('app-timeout');
      // relay-blocking.js reads appDecision.decision — a flat shape would be undefined there.
      const decision = JSON.parse((await received).trim());
      expect(decision.decision.behavior).toBe('deny');
      expect(decision.decision.message).toMatch(/auto-denied this request after/);
      short.stop();
      client.destroy();
    });

    it('an ask from a session this app does not own is handed straight back: socket ended with NOTHING written, no card, no hold', async () => {
      const r = new HookRelay((relay as any).pipeName + '-unowned', 60_000);
      r.setSessionGate((sid) => sid === 'ours');
      await r.start();
      const events: any[] = [];
      r.on('hook-event', (e) => events.push(e));
      const expiries: unknown[] = [];
      r.on('permission-expired', (...a) => expiries.push(a));
      const net = await import('net');
      const client = net.createConnection((r as any).pipeName);
      await new Promise<void>((res, rej) => { client.on('connect', res); client.on('error', rej); });
      let received = '';
      client.on('data', (c) => { received += c; });
      const ended = new Promise<void>((res) => client.on('end', () => res()));
      client.write(JSON.stringify({ hook_event_name: 'PermissionRequest', _desktop_session_id: 'someone-else', tool_name: 'AskUserQuestion' }) + '\n');
      await ended;
      // relay-blocking.js: 'end' with no data → exit 0, prints nothing → Claude
      // Code shows its own prompt. Any written line would be read as a decision.
      expect(received).toBe('');
      expect(events.filter((e) => e.type === 'PermissionRequest')).toEqual([]);
      expect(r.hasPendingPermission('someone-else')).toBe(false);
      expect((r as any).holdTimers.size).toBe(0);
      expect(expiries).toEqual([]);
      r.stop();
      client.destroy();
    });

    it('the real relay script exits 0 printing nothing for an unowned ask (Claude Code then prompts in its own terminal)', async () => {
      const r = new HookRelay((relay as any).pipeName + '-relayproc', 60_000);
      r.setSessionGate(() => false);
      await r.start();
      const { spawn } = await import('child_process');
      const pathMod = await import('path');
      const child = spawn(process.execPath, [pathMod.join(__dirname, '..', 'hook-scripts', 'relay-blocking.js')], {
        env: { ...process.env, CLAUDE_DESKTOP_PIPE: (r as any).pipeName, CLAUDE_DESKTOP_SESSION_ID: 'not-ours' },
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      const code = await new Promise<number | null>((res) => {
        child.on('exit', res);
        child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'cc-1', tool_name: 'Bash' }));
      });
      expect(code).toBe(0);
      expect(out).toBe('');
      r.stop();
    });

    it('an ask from a session this app owns is still held (card shown, hold armed)', async () => {
      const r = new HookRelay((relay as any).pipeName + '-owned', 60_000);
      r.setSessionGate((sid) => sid === 'ours');
      await r.start();
      const { client, event } = await connectAsk(r, 'ours');
      expect(event.type).toBe('PermissionRequest');
      expect(r.hasPendingPermission('ours')).toBe(true);
      expect((r as any).holdTimers.size).toBe(1);
      r.stop();
      client.destroy();
    });

    it("the far end going away first emits 'hook-closed' and cancels the hold", async () => {
      const short = new HookRelay((relay as any).pipeName + '-closed', 60_000);
      await short.start();
      const { client } = await connectAsk(short, 'sess-c');
      expect((short as any).holdTimers.size).toBe(1);
      const reason = new Promise<string | undefined>((resolve) => short.once('permission-expired', (_s, _r, why) => resolve(why)));
      client.destroy();
      expect(await reason).toBe('hook-closed');
      expect((short as any).holdTimers.size).toBe(0);
      short.stop();
    });

    it('an answer cancels the hold, and respond() itself emits no expiry', async () => {
      const short = new HookRelay((relay as any).pipeName + '-answered', 60_000);
      await short.start();
      const reasons: Array<string | undefined> = [];
      short.on('permission-expired', (_s, _r, why) => reasons.push(why));
      const { client, event, received } = await connectAsk(short, 'sess-d');
      expect((short as any).holdTimers.size).toBe(1);
      expect(short.respond(event.payload._requestId, {})).toBe(true);
      expect((short as any).holdTimers.size).toBe(0);
      // A decision-less release (what the plan card sends) reaches the relay as {}.
      expect(JSON.parse((await received).trim())).toEqual({});
      expect(reasons).toEqual([]);
      short.stop();
      client.destroy();
    });

    it('an ask auto-approved inside the request emit never gets a hold', async () => {
      const short = new HookRelay((relay as any).pipeName + '-auto', 60_000);
      await short.start();
      // main.ts auto-approves title hooks etc. from inside the hook-event emit.
      short.on('hook-event', (e: any) => { if (e.type === 'PermissionRequest') short.respond(e.payload._requestId, { decision: { behavior: 'allow' } }); });
      const { client } = await connectAsk(short, 'sess-a');
      expect((short as any).holdTimers.size).toBe(0);
      short.stop();
      client.destroy();
    });

    it('stop() clears every hold', async () => {
      const short = new HookRelay((relay as any).pipeName + '-stop', 60_000);
      await short.start();
      const { client } = await connectAsk(short, 'sess-s');
      expect((short as any).holdTimers.size).toBe(1);
      short.stop();
      expect((short as any).holdTimers.size).toBe(0);
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
  it('the first SessionStart owns the session; another pid is refused', async () => {
    const { HookOwnerGate } = await import('../src/main/hook-relay');
    const g = new HookOwnerGate();
    expect(g.accept('desk-1', '1000', true)).toBe(true);
    expect(g.accept('desk-1', '1000', false)).toBe(true);
    expect(g.accept('desk-1', '2000', false)).toBe(false);
    expect(g.accept('desk-1', '2000', true)).toBe(false); // a nested SessionStart cannot take over
    expect(g.accept('desk-2', '2000', true)).toBe(true);
  });
  // Review C2: the real SessionStart can be lost (relay.js tries once). Its
  // tool hooks then arrive first; a nested SessionStart must not claim.
  it('order A — real tool hooks, SessionStart lost, then a nested SessionStart: the real pid is claimed', async () => {
    const { HookOwnerGate } = await import('../src/main/hook-relay');
    const g = new HookOwnerGate();
    expect(g.accept('desk-1', '1000', false)).toBe(true);   // real, SessionStart was lost
    expect(g.accept('desk-1', '2000', true)).toBe(false);   // nested SessionStart refused
    expect(g.accept('desk-1', '1000', false)).toBe(true);
    expect(g.accept('desk-1', '2000', false)).toBe(false);
  });
  it('order B — real SessionStart first, then a nested one: the real pid is claimed', async () => {
    const { HookOwnerGate } = await import('../src/main/hook-relay');
    const g = new HookOwnerGate();
    expect(g.accept('desk-1', '1000', true)).toBe(true);
    expect(g.accept('desk-1', '1000', false)).toBe(true);
    expect(g.accept('desk-1', '2000', true)).toBe(false);
    expect(g.accept('desk-1', '1000', false)).toBe(true);
  });
  it('/clear (a second SessionStart from the owner) keeps the owner', async () => {
    const { HookOwnerGate } = await import('../src/main/hook-relay');
    const g = new HookOwnerGate();
    expect(g.accept('desk-1', '1000', true)).toBe(true);
    expect(g.accept('desk-1', '1000', true)).toBe(true);
  });
  it('fails open with no pid (older Claude Code or relay)', async () => {
    const { HookOwnerGate } = await import('../src/main/hook-relay');
    const g = new HookOwnerGate();
    expect(g.accept('desk-1', '1000', true)).toBe(true);
    expect(g.accept('desk-1', undefined, false)).toBe(true);
    expect(g.accept('desk-1', '', false)).toBe(true);
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

  const settle = () => new Promise((r) => setTimeout(r, 50));

  // B1: pins the relay's call site — only a real SessionStart may claim. If
  // the relay passed "is SessionStart" for every hook, the first tool hook
  // would claim and the second pid below would be dropped.
  it('before any SessionStart, tool hooks from two pids both get through', async () => {
    await relay.start();
    const events: any[] = [];
    relay.on('hook-event', (e) => events.push(e));
    await send({ hook_event_name: 'PostToolUse', session_id: 'a', _desktop_session_id: 'desk-1', _claude_pid: '2000' });
    await settle();
    await send({ hook_event_name: 'PostToolUse', session_id: 'b', _desktop_session_id: 'desk-1', _claude_pid: '1000' });
    await settle();
    expect(events.map((e) => e.payload.session_id)).toEqual(['a', 'b']);
  });

  it('C2 end to end: the real SessionStart was lost, a nested SessionStart is dropped', async () => {
    await relay.start();
    const events: any[] = [];
    relay.on('hook-event', (e) => events.push(e));
    await send({ hook_event_name: 'PostToolUse', session_id: 'ours', _desktop_session_id: 'desk-1', _claude_pid: '1000' });
    await settle();
    await send({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'nested', _desktop_session_id: 'desk-1', _claude_pid: '2000' });
    await settle();
    await send({ hook_event_name: 'PostToolUse', session_id: 'ours', _desktop_session_id: 'desk-1', _claude_pid: '1000' });
    await settle();
    expect(events.map((e) => e.payload.session_id)).toEqual(['ours', 'ours']);
  });

  it('drops a foreign process\'s events and ends its permission request with no decision', async () => {
    await relay.start();
    const events: any[] = [];
    relay.on('hook-event', (e) => events.push(e));
    // Our own claude (pid 1000) announces itself first.
    await send({ hook_event_name: 'SessionStart', session_id: 'ours', source: 'startup', _desktop_session_id: 'desk-1', _claude_pid: '1000' });
    await vi.waitFor(() => expect(events).toHaveLength(1));
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
    await vi.waitFor(() => expect(events.map((e) => e.payload.session_id)).toEqual(['ours', 'ours']));
  });

  // WHY: the owner gate (bugfix-integrations) and the unowned-ask pass-through
  // (plan-approval) were built on separate branches and meet only in the
  // combined tree. Pin all three outcomes through one relay with both gates on.
  it('with the session gate on too: nested ask ignored, unowned ask passed through, owned ask held', async () => {
    relay.setSessionGate((sid) => sid === 'desk-1');
    await relay.start();
    const events: any[] = [];
    relay.on('hook-event', (e) => events.push(e));
    await send({ hook_event_name: 'SessionStart', session_id: 'ours', _desktop_session_id: 'desk-1', _claude_pid: '1000' });
    await new Promise((r) => setTimeout(r, 50));

    const nested = await send({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', _desktop_session_id: 'desk-1', _claude_pid: '2000' }, true);
    expect(await nested.closedWithoutReply).toBe(true);
    const unowned = await send({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', _desktop_session_id: 'desk-9', _claude_pid: '3000' }, true);
    expect(await unowned.closedWithoutReply).toBe(true);
    expect(events.filter((e) => e.type === 'PermissionRequest')).toEqual([]);
    expect((relay as any).holdTimers.size).toBe(0);

    await send({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', _desktop_session_id: 'desk-1', _claude_pid: '1000' }, true);
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'PermissionRequest')).toHaveLength(1));
    expect(relay.hasPendingPermission('desk-1')).toBe(true);
    expect((relay as any).holdTimers.size).toBe(1);
  });
});

// WHY (2026-10-22): something deleted the live app's socket file in shared /tmp
// while the app kept running, so every new session sat on "Initializing session…".
// The socket moved to the private runtime folder, and a session start re-creates
// a deleted file.
describe('hookPipeName', () => {
  it('uses the private runtime folder on Linux, never shared /tmp', () => {
    expect(hookPipeName(42, 'linux', { XDG_RUNTIME_DIR: '/run/user/1000' }))
      .toBe('/run/user/1000/youcoded/claude-desktop-hooks-42.sock');
  });
  it('falls back to the temp folder without one (Android, macOS) and a named pipe on Windows', () => {
    expect(hookPipeName(42, 'linux', {})).toMatch(/claude-desktop-hooks-42\.sock$/);
    expect(hookPipeName(42, 'darwin', { XDG_RUNTIME_DIR: '/run/user/1000' })).not.toContain('/run/user');
    expect(hookPipeName(42, 'win32', {})).toBe('\\\\.\\pipe\\claude-desktop-hooks-42');
  });
});

// Security hardening 2026-10-30 (local-listeners audit F3/F4): no shared, guessable socket name.
describe.skipIf(process.platform === 'win32')('hook socket is never in a shared, guessable place', () => {
  it('without a runtime folder the socket sits in a per-user subfolder of the temp folder, not directly in it', () => {
    const p = hookPipeName(42, 'linux', {});
    expect(path.dirname(p)).not.toBe(os.tmpdir());
    expect(path.basename(path.dirname(p))).toMatch(/^youcoded-/);
  });

  it('start() refuses a socket folder that is really a link (or otherwise not ours) instead of listening there', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-hookdir-'));
    try {
      const real = path.join(base, 'real'); fs.mkdirSync(real);
      const link = path.join(base, 'youcoded-link'); fs.symlinkSync(real, link, 'dir');
      const r = new HookRelay(path.join(link, 'hooks.sock'));
      await expect(r.start()).rejects.toThrow(/not private/);
      expect(r.isRunning()).toBe(false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('start() tightens an own-but-loose youcoded folder to owner-only and listens', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-hookdir-'));
    try {
      const dir = path.join(base, 'youcoded-1000'); fs.mkdirSync(dir, { mode: 0o755 }); fs.chmodSync(dir, 0o755);
      const r = new HookRelay(path.join(dir, 'hooks.sock'));
      await r.start();
      expect(fs.statSync(dir).mode & 0o077).toBe(0);
      r.stop();
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it('the hook scripts do NOT fall back to a shared socket name when YouCoded gave them none', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-squat-'));
    const squatter = path.join(tmp, 'claude-desktop-hooks.sock');
    let connections = 0;
    const server = net.createServer((s) => { connections++; s.end(JSON.stringify({ decision: { behavior: 'allow' } })); });
    await new Promise<void>((res) => server.listen(squatter, res));
    try {
      const { spawn } = await import('child_process');
      for (const script of ['relay.js', 'relay-blocking.js']) {
        const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
        delete env.CLAUDE_DESKTOP_PIPE;
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'hook-scripts', script)], { env });
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        const code = await new Promise<number | null>((res) => {
          child.on('exit', res);
          child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash' }));
        });
        expect(code, script).toBe(0);
        expect(out, script).toBe('');
      }
      expect(connections).toBe(0);
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('HookRelay.ensureListening — a deleted socket file', () => {
  let dir: string;
  let relay: HookRelay;
  const sockPath = () => path.join(dir, 'nested', 'hooks.sock');
  const reach = (payload: object) => new Promise<void>((resolve, reject) => {
    const c = net.createConnection(sockPath(), () => c.end(JSON.stringify(payload) + '\n', () => resolve()));
    c.on('error', reject);
  });

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yc-hook-sock-'));
    relay = new HookRelay(sockPath());
  });
  afterEach(async () => {
    relay.stop();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('start() creates a missing socket folder', async () => {
    await relay.start();
    expect(fs.existsSync(sockPath())).toBe(true);
  });

  it('re-creates the file, and hooks reach the app again', async () => {
    await relay.start();
    const events: any[] = [];
    relay.on('hook-event', (e) => events.push(e));
    await fs.promises.unlink(sockPath());
    await expect(reach({ hook_event_name: 'SessionStart', session_id: 'a' })).rejects.toThrow();

    await relay.ensureListening();
    await reach({ hook_event_name: 'SessionStart', session_id: 'b' });
    await vi.waitFor(() => expect(events.map((e) => e.payload.session_id)).toEqual(['b']));
    // The replaced listener is left open: closing it would delete the new file.
    const before = (await fs.promises.lstat(sockPath())).ino;
    // Negative settle: nothing deletes or replaces the re-created file afterwards.
    await new Promise((r) => setTimeout(r, 50));
    expect((await fs.promises.lstat(sockPath())).ino).toBe(before);
  });

  it('re-creates the whole folder if that was deleted too', async () => {
    await relay.start();
    await fs.promises.rm(path.dirname(sockPath()), { recursive: true });
    await relay.ensureListening();
    expect(fs.existsSync(sockPath())).toBe(true);
  });

  it('leaves a present file alone and does nothing before start()', async () => {
    await relay.ensureListening();
    expect(fs.existsSync(sockPath())).toBe(false);
    await relay.start();
    const before = (await fs.promises.lstat(sockPath())).ino;
    await relay.ensureListening();
    expect((await fs.promises.lstat(sockPath())).ino).toBe(before);
  });

  it('a repair racing shutdown leaves no socket behind', async () => {
    await relay.start();
    await fs.promises.unlink(sockPath());
    const repair = relay.ensureListening();
    relay.stop();
    await repair;
    expect(fs.existsSync(sockPath())).toBe(false);
    expect((relay as any).server).toBeNull();
  });

  it('never deletes a file it did not make', async () => {
    await relay.start();
    await fs.promises.unlink(sockPath());
    await fs.promises.writeFile(sockPath(), 'someone else');
    await relay.ensureListening();
    expect(await fs.promises.readFile(sockPath(), 'utf8')).toBe('someone else');
  });
});
