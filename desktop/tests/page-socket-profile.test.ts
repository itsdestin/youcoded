// The device profile in a page's manifest (spec 2026-10-04) and the check on
// every page-written socket message: profile cleaning, the fingerprint, the
// deny list, and the one-shot exchange refusing a denied message.
import { describe, it, expect } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { fingerprint, parseConnections } from '../src/main/pages/page-connections';
import { checkOutgoingSocketMessage, performPageSocket, type PageSocketContext } from '../src/main/pages/page-socket';
import { HOME_ASSISTANT_PAGE_JSON } from '../src/renderer/dev/workbench/fixtures/home-assistant-page';
import type { PageConnection, PageFetchRequest } from '../src/shared/pages-types';

const HELLO = '{"type":"auth","access_token":"{{key}}"}';
const SEND = '{"id":1,"type":"camera/webrtc/offer","entity_id":{{target}},"offer":{{offer}}}';
const VIDEO = { targetPrefix: 'camera.', send: SEND, answer: 'event.answer', candidate: 'event.candidate', failed: 'event.message' };
type Dev = Extract<PageConnection, { kind: 'device' }>;

function device(over: Record<string, unknown> = {}): Dev {
  const [c] = parseConnections([{ id: 'ha', kind: 'device', service: 'Home Assistant', address: '192.168.4.54:8123', access: 'full', socketHello: HELLO, ...over }]);
  return c as Dev;
}

describe('profile cleaning', () => {
  it('keeps a sound profile', () => {
    const c = device({ socketReady: 'auth_ok', socketAuthFailed: 'auth_invalid', socketDeny: ['Config/', 'zzz/', 'config/'], videoProfile: VIDEO });
    expect(c.socketReady).toBe('auth_ok');
    expect(c.socketAuthFailed).toBe('auth_invalid');
    // Bad (upper-case) entry dropped; the rest sorted.
    expect(c.socketDeny).toEqual(['config/', 'zzz/']);
    expect(c.videoProfile).toEqual(VIDEO);
  });

  it('drops wrong types and over-long values', () => {
    const c = device({ socketReady: 5, socketAuthFailed: 'x'.repeat(65), socketDeny: 'config/', videoProfile: 'camera.' });
    expect(c.socketReady).toBeUndefined();
    expect(c.socketAuthFailed).toBeUndefined();
    expect(c.socketDeny).toBeUndefined();
    expect(c.videoProfile).toBeUndefined();
    expect(device({ socketDeny: [1, 'has space', 'a'.repeat(65)] }).socketDeny).toBeUndefined();
  });

  it('drops a video profile with a {{key}}, a too-big send, a bad path or a missing part', () => {
    expect(device({ videoProfile: { ...VIDEO, send: SEND.replace('{{target}}', '"{{key}}"') } }).videoProfile).toBeUndefined();
    expect(device({ videoProfile: { ...VIDEO, send: SEND + ' '.repeat(2100) } }).videoProfile).toBeUndefined();
    expect(device({ videoProfile: { ...VIDEO, answer: 'event..answer' } }).videoProfile).toBeUndefined();
    expect(device({ videoProfile: { ...VIDEO, failed: undefined } }).videoProfile).toBeUndefined();
    expect(device({ videoProfile: { ...VIDEO, targetPrefix: 'Camera.' } }).videoProfile).toBeUndefined();
  });
});

describe('fingerprint', () => {
  it('is unchanged for a connection with no profile fields', () => {
    expect(fingerprint(device({ socketHello: undefined }))).toBe('device|Home Assistant|full|key');
  });

  it('changes when any one profile field changes', () => {
    const base = { socketReady: 'auth_ok', socketAuthFailed: 'auth_invalid', socketDeny: ['config/'], videoProfile: VIDEO };
    const seen = new Set([fingerprint(device(base))]);
    for (const change of [
      { socketHello: '{"type":"login","t":"{{key}}"}' }, { socketReady: 'ok' }, { socketAuthFailed: 'bad' },
      { socketDeny: ['config/', 'x/'] }, { videoProfile: { ...VIDEO, answer: 'event.sdp' } },
    ]) seen.add(fingerprint(device({ ...base, ...change })));
    expect(seen.size).toBe(6);
  });

  it('does not depend on the order keys or deny entries were written in', () => {
    const a = device({ socketReady: 'auth_ok', socketDeny: ['b/', 'a/'], videoProfile: VIDEO });
    const b = device({ videoProfile: { failed: 'event.message', candidate: 'event.candidate', answer: 'event.answer', send: SEND, targetPrefix: 'camera.' }, socketDeny: ['a/', 'b/'], socketReady: 'auth_ok' });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).toContain('|profile:{"socketDeny":["a/","b/"],"socketHello"');
  });
});

describe('checkOutgoingSocketMessage', () => {
  const m = (type: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ id: 1, type, ...extra });

  it('refuses anything it cannot read as one JSON object with one string type', () => {
    for (const bad of ['not json', '[{"type":"ping"}]', '"ping"', '42', 'null', m(7), JSON.stringify({ id: 1 }),
      '{"type":"ping","type":"auth/long_lived_access_token"}', '{"type" : "ping", "x":{"type":"y"}}']) {
      expect(checkOutgoingSocketMessage(bad), bad).not.toBeNull();
    }
  });

  it('refuses each built-in prefix, ignoring case and spaces', () => {
    for (const t of ['auth/long_lived_access_token', 'config/auth/create', 'config/auth_provider/x', 'person/create', '  AUTH/Login ', 'Config/Auth']) {
      expect(checkOutgoingSocketMessage(m(t)), t).not.toBeNull();
    }
  });

  it('refuses a manifest addition and allows what is not listed', () => {
    expect(checkOutgoingSocketMessage(m('config/core/update'), ['config/'])).not.toBeNull();
    expect(checkOutgoingSocketMessage(m('config/core/update'))).toBeNull();
  });

  it('lets the Home page registry messages through the built-in floor', () => {
    for (const t of ['config/entity_registry/update', 'config/device_registry/update', 'config/area_registry/list', 'subscribe_entities', 'ping']) {
      expect(checkOutgoingSocketMessage(m(t)), t).toBeNull();
    }
  });

  it('the shipped Home page connection carries its profile and denies nothing extra', () => {
    const c = parseConnections(HOME_ASSISTANT_PAGE_JSON.connections)[0] as Dev;
    expect(c.socketReady).toBe('auth_ok');
    expect(c.socketAuthFailed).toBe('auth_invalid');
    expect(c.videoProfile?.targetPrefix).toBe('camera.');
    expect(c.socketDeny).toBeUndefined();
  });
});

describe('the one-shot exchange refuses a denied message', () => {
  async function run(send: string[]) {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    let connections = 0;
    wss.on('connection', (ws) => { connections++; ws.send('{"type":"auth_ok"}'); });
    const conn = device({ socketDeny: ['config/core'] });
    const ctx: PageSocketContext = {
      connections: [conn], approved: { ha: fingerprint(conn) },
      credential: async () => ({ in: 'header', param: 'authorization', value: 'Bearer k', secret: 'k' }),
      signal: new AbortController().signal,
      lookup: async () => { throw new Error('no DNS'); },
      connect: (url, headers) => new WebSocket(`ws://127.0.0.1:${port}`, { headers }),
    };
    const req: PageFetchRequest = { url: 'http://192.168.4.54:8123/api/websocket', socket: { send, until: 1 } };
    const result = await performPageSocket(req, ctx);
    await new Promise<void>((r) => wss.close(() => r()));
    return { result, connections };
  }

  it('refuses the whole exchange and never opens the socket', async () => {
    const { result, connections } = await run([JSON.stringify({ id: 1, type: 'config/entity_registry/update' }), JSON.stringify({ id: 2, type: 'auth/long_lived_access_token' })]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('auth/long_lived_access_token');
    expect(connections).toBe(0);
  });

  it('refuses a manifest-denied type, and a non-JSON message', async () => {
    expect((await run([JSON.stringify({ id: 1, type: 'config/core/update' })])).result.ok).toBe(false);
    expect((await run(['hello'])).result.ok).toBe(false);
  });

  it('still allows a registry rename', async () => {
    const { result, connections } = await run([JSON.stringify({ id: 1, type: 'config/entity_registry/update', entity_id: 'light.a', name: 'B' })]);
    expect(result.ok).toBe(true);
    expect(connections).toBe(1);
  });
});
