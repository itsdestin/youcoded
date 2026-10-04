// A remote browser's live sockets: owned by that client alone, pushed to it
// alone, closed when it drops, and reported closed by the shim when ITS
// connection to the computer drops.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { PageConnectionsStore } from '../src/main/pages/connections-store';
import { initPagesService } from '../src/main/pages/pages-service';
import { handlePagesMessage, sendToClient, clientOwnerKey, type RemotePagesClient } from '../src/main/pages/pages-remote';
import { LIVE_LIMITS, type LiveWsLike } from '../src/main/pages/page-live-socket';
import { createRemotePagesBridge } from '../src/renderer/remote-pages-bridge';
import type { PageSocketEvent } from '../src/shared/pages-types';

const KEY = 'ha-long-lived-token-value';
const HOME = { id: 'ha', kind: 'device', service: 'Home Assistant', address: '192.168.4.54:8123', access: 'full', socketHello: '{"type":"auth","access_token":"{{key}}"}' };
const URL_HA = 'http://192.168.4.54:8123/api/websocket';

class FakeWs extends EventEmitter { sent: string[] = []; send(d: string) { this.sent.push(d); } terminate() { /* gone */ } }
const fakeClient = (id: string, over: Partial<RemotePagesClient['ws']> = {}) => {
  const sent: string[] = [];
  const client: RemotePagesClient = { id, ws: { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (d: string) => { sent.push(d); }, ...over } as RemotePagesClient['ws'] };
  return { client, sent };
};

let root: string;
let service: ReturnType<typeof initPagesService>;
let wss: FakeWs[];
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'pages-remote-'));
  const personal = path.join(root, 'Personal');
  const userData = path.join(root, 'userData');
  wss = [];
  service = initPagesService({
    personalRoot: () => personal, listProjects: async () => [], deviceId: () => 'dev-1', localFallbackDir: () => path.join(root, 'local'),
    connections: new PageConnectionsStore(userData, new SecretsStore(userData)), broadcast: () => {},
    lookup: async () => { throw new Error('no DNS'); },
    liveSocketConnect: () => { const w = new FakeWs(); wss.push(w); return w as unknown as LiveWsLike; },
  });
  const dir = path.join(personal, 'Pages', 'home');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'page.json'), JSON.stringify({ name: 'Home', description: 'd', icon: 'page', connections: [HOME] }));
  await fs.writeFile(path.join(dir, 'page.html'), '<p>hi</p>');
  await service.approve('personal:home', { ha: KEY }, { remote: false });
});
afterEach(() => { service.stop(); rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

const ask = async (client: RemotePagesClient, type: string, payload: unknown) => {
  let answer: any;
  expect(await handlePagesMessage(client, type, payload, (a) => { answer = a; })).toBe(true);
  return answer;
};

describe('the remote host\'s live sockets', () => {
  it('belongs to the client that opened it: another client cannot send, ping or close it', async () => {
    const a = fakeClient('A'); const b = fakeClient('B');
    const opened = await ask(a.client, 'pages:socket-open', { page: 'personal:home', frame: 'f', url: URL_HA });
    expect(opened.ok).toBe(true);
    wss[0].emit('open');
    const mine = { page: 'personal:home', frame: 'f', socket: opened.socket };
    expect((await ask(b.client, 'pages:socket-send', { ...mine, text: '{"type":"ping"}' })).ok).toBe(false);
    expect((await ask(b.client, 'pages:socket-ping', mine)).ok).toBe(false);
    expect((await ask(b.client, 'pages:socket-close', mine)).ok).toBe(false);
    expect((await ask(a.client, 'pages:socket-send', { ...mine, text: '{"type":"ping"}' })).ok).toBe(true);
    expect(service.sockets.count).toBe(1);
  });

  it('pushes events to that client only, as pages:socket-event', async () => {
    const a = fakeClient('A'); const b = fakeClient('B');
    const opened = await ask(a.client, 'pages:socket-open', { page: 'personal:home', frame: 'f', url: URL_HA });
    wss[0].emit('open');
    const pushed = a.sent.map((s) => JSON.parse(s));
    expect(pushed).toEqual([{ type: 'pages:socket-event', payload: { socket: opened.socket, kind: 'state', state: 'open' } }]);
    expect(b.sent).toEqual([]);
  });

  it('closes a socket whose client is backed up, never the client', async () => {
    const slow = fakeClient('A', { bufferedAmount: LIVE_LIMITS.remoteBacklogBytes + 1 });
    expect(sendToClient(slow.client, { socket: 's', kind: 'messages', texts: ['x'] })).toBe('backed-up');
    expect(slow.sent).toEqual([]);
    expect(sendToClient(fakeClient('B', { readyState: WebSocket.CLOSED }).client, { socket: 's', kind: 'messages', texts: [] })).toBe('gone');
    // End to end: the next batch for a backed-up client ends that socket.
    const c = fakeClient('C');
    await ask(c.client, 'pages:socket-open', { page: 'personal:home', frame: 'f', url: URL_HA });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    wss[0].emit('open');
    (c.client.ws as { bufferedAmount: number }).bufferedAmount = LIVE_LIMITS.remoteBacklogBytes + 1;
    wss[0].emit('message', Buffer.from('hello'), false);
    await vi.advanceTimersByTimeAsync(LIVE_LIMITS.batchMs);
    vi.useRealTimers();
    expect(service.sockets.count).toBe(0);
  });

  it('closeOwner on the client key (the host\'s drop path) closes everything it held', async () => {
    const a = fakeClient('A');
    await ask(a.client, 'pages:socket-open', { page: 'personal:home', frame: 'f', url: URL_HA });
    await ask(a.client, 'pages:socket-open', { page: 'personal:home', frame: 'f', url: URL_HA });
    expect(service.sockets.count).toBe(2);
    service.sockets.closeOwner(clientOwnerKey('A'));
    expect(service.sockets.count).toBe(0);
  });

  it('leaves other pages:* types to their own answers and refuses nothing it does not know', async () => {
    let answered = false;
    expect(await handlePagesMessage(fakeClient('A').client, 'pages:nope', {}, () => { answered = true; })).toBe(false);
    expect(answered).toBe(false);
  });
});

describe('the remote shim\'s live sockets', () => {
  const rig = () => {
    const invoke = vi.fn(async (type: string) => (type === 'pages:socket-open' ? { ok: true, socket: `m${++n}` } : { ok: true }));
    let n = 0;
    const r = createRemotePagesBridge(invoke, (_c, cb) => cb, () => {});
    const heard: PageSocketEvent[] = [];
    r.bridge.onSocketEvent!((e) => heard.push(e));
    return { r, heard, invoke };
  };

  it('reports closed for every live socket when its own connection to the computer drops', async () => {
    const { r, heard } = rig();
    const a = await r.bridge.socketOpen!({ page: 'p', frame: 'f', url: 'u' });
    const b = await r.bridge.socketOpen!({ page: 'p', frame: 'f', url: 'u' });
    r.push({ socket: (b as any).socket, kind: 'state', state: 'closed', why: 'x' }); // one already closed
    heard.length = 0;
    r.connectionLost();
    expect(heard).toEqual([{ socket: (a as any).socket, kind: 'state', state: 'closed', why: 'Lost the connection to your computer.' }]);
    r.connectionLost();
    expect(heard).toHaveLength(1); // told once
  });

  it('forgets a socket the page closed, and passes pushed events to listeners', async () => {
    const { r, heard } = rig();
    const a = (await r.bridge.socketOpen!({ page: 'p', frame: 'f', url: 'u' })) as any;
    r.push({ socket: a.socket, kind: 'messages', texts: ['hi'] });
    expect(heard).toEqual([{ socket: a.socket, kind: 'messages', texts: ['hi'] }]);
    await r.bridge.socketClose!({ page: 'p', frame: 'f', socket: a.socket });
    heard.length = 0;
    r.connectionLost();
    expect(heard).toEqual([]);
  });
});
