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
    // Upper-case is lower-cased (not dropped), duplicates collapse, the rest sorted.
    expect(c.socketDeny).toEqual(['config/', 'zzz/']);
    expect(c.videoProfile).toEqual(VIDEO);
  });

  it('refuses the whole connection when a login reply type is present but not valid', () => {
    // A dropped socketAuthFailed meant a wrong key was never recognised and logins were retried for ten minutes.
    const raw = { id: 'ha', kind: 'device', service: 'Home Assistant', address: '192.168.4.54:8123', access: 'full', socketHello: HELLO };
    for (const bad of [5, 'x'.repeat(65), '', 'has space', null]) {
      expect(parseConnections([{ ...raw, socketReady: bad }]), `socketReady ${String(bad).slice(0, 8)}`).toEqual([]);
      expect(parseConnections([{ ...raw, socketAuthFailed: bad }]), `socketAuthFailed ${String(bad).slice(0, 8)}`).toEqual([]);
    }
    expect(parseConnections([{ ...raw, socketReady: 'auth_ok', socketAuthFailed: 'auth_invalid' }])).toHaveLength(1);
    expect(parseConnections([raw])).toHaveLength(1);
  });

  it('drops a video profile of the wrong type, keeping the connection', () => {
    const c = device({ videoProfile: 'camera.' });
    expect(c.videoProfile).toBeUndefined();
  });

  it('refuses the whole connection when the deny list is not wholly valid', () => {
    // The card lists exactly what main enforces, so a half-kept list is never allowed.
    const bad = (socketDeny: unknown) => parseConnections([{ id: 'ha', kind: 'device', service: 'Home Assistant', address: '192.168.4.54:8123', access: 'full', socketDeny }]);
    expect(bad([1, 'has space'])).toEqual([]);
    expect(bad(['ok/', 'has space'])).toEqual([]);
    expect(bad(['a'.repeat(65)])).toEqual([]);
    expect(bad(Array.from({ length: 17 }, (_, i) => `p${i}/`))).toEqual([]);
    expect(bad('config/')).toEqual([]);
    expect(bad(Array.from({ length: 16 }, (_, i) => `p${i}/`))).toHaveLength(1);
  });

  it('drops a video profile with a {{key}}, a too-big send, a bad path or a missing part', () => {
    expect(device({ videoProfile: { ...VIDEO, send: SEND.replace('{{target}}', '"{{key}}"') } }).videoProfile).toBeUndefined();
    expect(device({ videoProfile: { ...VIDEO, send: SEND + ' '.repeat(2100) } }).videoProfile).toBeUndefined();
    expect(device({ videoProfile: { ...VIDEO, answer: 'event..answer' } }).videoProfile).toBeUndefined();
    expect(device({ videoProfile: { ...VIDEO, failed: undefined } }).videoProfile).toBeUndefined();
    expect(device({ videoProfile: { ...VIDEO, targetPrefix: 'Camera.' } }).videoProfile).toBeUndefined();
  });

  it('requires the target prefix to end with a dot (step-1 review, item 5): a bare word would widen "a camera" to anything', () => {
    for (const targetPrefix of ['camera', 'c', 'a', '.x']) expect(device({ videoProfile: { ...VIDEO, targetPrefix } }).videoProfile, targetPrefix).toBeUndefined();
    expect(device({ videoProfile: { ...VIDEO, targetPrefix: '.' } }).videoProfile?.targetPrefix).toBe('.');
    expect(device({ videoProfile: VIDEO }).videoProfile?.targetPrefix).toBe('camera.');
  });

  it('keeps a sound socket path for video, drops an odd one, and asks again when it changes', () => {
    expect(device({ videoProfile: { ...VIDEO, socketPath: '/api/websocket' } }).videoProfile?.socketPath).toBe('/api/websocket');
    for (const socketPath of ['api/websocket', '/a/../b', '/a?b=1', '/a b', 'http://evil/x']) expect(device({ videoProfile: { ...VIDEO, socketPath } }).videoProfile?.socketPath, socketPath).toBeUndefined();
    expect(fingerprint(device({ videoProfile: { ...VIDEO, socketPath: '/other' } }))).not.toBe(fingerprint(device({ videoProfile: VIDEO })));
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
  const refused = (text: string, deny: string[] = []) => !checkOutgoingSocketMessage(text, deny).ok;

  it('refuses anything it cannot read as one JSON object with a string type', () => {
    for (const bad of ['not json', '[{"type":"ping"}]', '"ping"', '42', 'null', m(7), JSON.stringify({ id: 1 })]) {
      expect(refused(bad), bad).toBe(true);
    }
  });

  it('checks the value that is actually SENT when "type" appears twice, even written with escapes', () => {
    // JSON.parse keeps the last; the result's text is the re-serialised object, so the device
    // can never see a first key the check did not.
    const dup = checkOutgoingSocketMessage('{"type":"auth/long_lived_access_token","type":"ping"}');
    expect(dup).toEqual({ ok: true, text: '{"type":"ping"}' });
    expect(refused('{"type":"ping","type":"auth/long_lived_access_token"}')).toBe(true);
    expect(refused('{"type":"ping","\\u0074ype":"auth/long_lived_access_token"}')).toBe(true);
    const escaped = checkOutgoingSocketMessage('{"\\u0074ype":"auth/x","type":"ping"}');
    expect(escaped).toEqual({ ok: true, text: '{"type":"ping"}' });
  });

  it('lets a message with a nested "type" through', () => {
    const text = '{"type":"lovelace/config/save","config":{"views":[{"type":"entities"}]}}';
    expect(checkOutgoingSocketMessage(text)).toEqual({ ok: true, text });
  });

  it('refuses each built-in prefix, ignoring case and spaces', () => {
    for (const t of ['auth/long_lived_access_token', 'config/auth/create', 'config/auth_provider/x', 'person/create', '  AUTH/Login ', 'Config/Auth']) {
      expect(refused(m(t)), t).toBe(true);
    }
  });

  it('refuses a manifest addition and allows what is not listed', () => {
    expect(refused(m('config/core/update'), ['config/'])).toBe(true);
    expect(refused(m('config/core/update'))).toBe(false);
  });

  it('lets the Home page registry messages through the built-in floor', () => {
    for (const t of ['config/entity_registry/update', 'config/device_registry/update', 'config/area_registry/list', 'subscribe_entities', 'ping']) {
      expect(refused(m(t)), t).toBe(false);
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
    const got: string[] = [];
    wss.on('connection', (ws) => { connections++; ws.send('{"type":"auth_ok"}'); ws.on('message', (d) => { got.push(d.toString()); ws.send('{"type":"ack"}'); }); });
    const conn = device({ socketDeny: ['config/core'] });
    const ctx: PageSocketContext = {
      connections: [conn], approved: { ha: fingerprint(conn) },
      credential: async () => ({ in: 'header', param: 'authorization', value: 'Bearer k', secret: 'k' }),
      signal: new AbortController().signal,
      lookup: async () => { throw new Error('no DNS'); },
      connect: (url, headers) => new WebSocket(`ws://127.0.0.1:${port}`, { headers }),
    };
    const req: PageFetchRequest = { url: 'http://192.168.4.54:8123/api/websocket', socket: { send, until: send.length + 2 } };
    const result = await performPageSocket(req, ctx);
    await new Promise<void>((r) => wss.close(() => r()));
    return { result, connections, got };
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
    const rename = { id: 1, type: 'config/entity_registry/update', entity_id: 'light.a', name: 'B' };
    const { result, connections, got } = await run([JSON.stringify(rename)]);
    expect(result.ok).toBe(true);
    expect(connections).toBe(1);
    // The allowed message really reached the device (greeting first, JSON-equal).
    expect(got.map((g) => JSON.parse(g)).slice(-1)).toEqual([rename]);
  });
});
