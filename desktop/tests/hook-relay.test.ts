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

    it('holds an ask for no live session only for the short cap, reason unroutable', async () => {
      const short = new HookRelay((relay as any).pipeName + '-unroutable', 60_000, 40);
      short.setSessionGate(() => false);
      await short.start();
      const expired = new Promise<string | undefined>((resolve) => {
        short.once('permission-expired', (_s, _r, reason) => resolve(reason));
      });
      const { client, received } = await connectAsk(short, 'ghost');
      expect(await expired).toBe('unroutable');
      expect(JSON.parse((await received).trim()).decision.message).toMatch(/could not show this request/);
      short.stop();
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
