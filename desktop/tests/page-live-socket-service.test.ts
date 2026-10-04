// The service side of a page's live socket: the approval chain it runs on every
// connect, and the five things that must close a page's sockets — a connection
// removed, a new approval, a saved key deleted, the page's code changing and its
// manifest changing. Plus: live traffic never counts as "fresh".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { PageConnectionsStore } from '../src/main/pages/connections-store';
import { initPagesService } from '../src/main/pages/pages-service';
import type { LiveWsLike } from '../src/main/pages/page-live-socket';
import type { PageSocketEvent } from '../src/shared/pages-types';

const KEY = 'ha-long-lived-token-value';
const HOME = { id: 'ha', kind: 'device', service: 'Home Assistant', address: '192.168.4.54:8123', access: 'full', socketHello: '{"type":"auth","access_token":"{{key}}"}', socketReady: 'auth_ok' };
const WEATHER = { id: 'weather', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org', access: 'lookup', keyIn: 'query', keyParam: 'appid' };
const PAGE = 'personal:home';
const URL_HA = 'http://192.168.4.54:8123/api/websocket';

class FakeWs extends EventEmitter {
  sent: string[] = [];
  terminated = false;
  send(d: string) { this.sent.push(d); }
  terminate() { this.terminated = true; }
}

let root: string;
let personal: string;
let service: ReturnType<typeof initPagesService>;
let wss: FakeWs[];
let urls: string[];
let events: PageSocketEvent[];

async function writePage(connections: unknown[], html = '<!doctype html><html><body>hi</body></html>') {
  const dir = path.join(personal, 'Pages', 'home');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'page.json'), JSON.stringify({ name: 'Home', description: 'd', icon: 'page', connections }));
  await fs.writeFile(path.join(dir, 'page.html'), html);
  // A later modified time, so the page's code stamp moves even inside one millisecond.
  const when = new Date(Date.now() + (++stamp) * 5000);
  await fs.utimes(path.join(dir, 'page.html'), when, when);
}
let stamp = 0;

const owner = { key: 'window:1', push: (e: PageSocketEvent) => { events.push(e); return 'sent' as const; } };
async function openLive() {
  const r = await service.sockets.open(owner, { page: PAGE, frame: 'f1', url: URL_HA });
  if (!r.ok) throw new Error(r.message);
  wss.at(-1)!.emit('open');
  return r.socket;
}
const closedReason = () => events.filter((e) => e.kind === 'state' && e.state === 'closed').at(-1);

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'pages-live-'));
  personal = path.join(root, 'Personal');
  wss = []; urls = []; events = []; stamp = 0;
  const userData = path.join(root, 'userData');
  service = initPagesService({
    personalRoot: () => personal,
    listProjects: async () => [],
    deviceId: () => 'dev-1',
    localFallbackDir: () => path.join(root, 'local'),
    connections: new PageConnectionsStore(userData, new SecretsStore(userData)),
    broadcast: () => {},
    lookup: async () => { throw new Error('no DNS in this test'); },
    liveSocketConnect: (url) => { urls.push(url); const w = new FakeWs(); wss.push(w); return w as unknown as LiveWsLike; },
  });
  await writePage([HOME, WEATHER]);
});
afterEach(() => {
  service.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('a live socket and the approvals it stands on', () => {
  it('opens only after the page is allowed, with the saved key in the greeting', async () => {
    const before = await service.sockets.open(owner, { page: PAGE, frame: 'f1', url: URL_HA });
    expect(before.ok).toBe(false);
    expect((await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false })).ok).toBe(true);
    await openLive();
    expect(JSON.parse(wss[0].sent[0])).toEqual({ type: 'auth', access_token: KEY });
  });

  it('removing the connection closes its sockets, and only those', async () => {
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    await openLive();
    await service.removeConnection(PAGE, 'weather'); // another connection of the same page
    expect(service.sockets.count).toBe(1);
    await service.removeConnection(PAGE, 'ha');
    expect(service.sockets.count).toBe(0);
    expect(wss[0].terminated).toBe(true);
    expect(closedReason()).toMatchObject({ why: expect.stringContaining('removed') });
  });

  it('a new approval closes the page\'s sockets, so they are asked for again under the new yes', async () => {
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    await service.removeConnection(PAGE, 'weather');
    await openLive();
    expect((await service.approve(PAGE, { weather: 'saved' }, { remote: false })).ok).toBe(true);
    expect(service.sockets.count).toBe(0);
  });

  it('deleting the saved key closes the sockets that stood on it', async () => {
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    await openLive();
    await service.deleteSavedKey('OpenWeather', 'api.openweathermap.org');
    expect(service.sockets.count).toBe(1); // a different key
    await service.deleteSavedKey('Home Assistant', '192.168.4.54:8123');
    expect(service.sockets.count).toBe(0);
    expect(closedReason()).toMatchObject({ why: expect.stringContaining('key') });
  });

  it('a change to the page\'s code closes its sockets', async () => {
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    await openLive();
    await service.listAndWatch();
    expect(service.sockets.count).toBe(1);
    await writePage([HOME, WEATHER], '<!doctype html><html><body>edited</body></html>');
    await service.listAndWatch();
    expect(service.sockets.count).toBe(0);
  });

  it('a change to the page\'s connections closes its sockets', async () => {
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    await openLive();
    await writePage([{ ...HOME, socketDeny: ['config/core'] }, WEATHER]);
    await service.listAndWatch();
    expect(service.sockets.count).toBe(0);
  });

  it('a manifest change is noticed even when the page was never listed before its socket opened', async () => {
    // A remote client lists through the store, so the app can start with a socket open on a page that
    // listAndWatch has never seen. That first sighting used to only record, so the edit below closed nothing.
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    service.stop();
    const userData = path.join(root, 'userData');
    const fresh = initPagesService({
      personalRoot: () => personal, listProjects: async () => [], deviceId: () => 'dev-1', localFallbackDir: () => path.join(root, 'local'),
      connections: new PageConnectionsStore(userData, new SecretsStore(userData)), broadcast: () => {},
      lookup: async () => { throw new Error('no DNS in this test'); },
      liveSocketConnect: () => { const w = new FakeWs(); wss.push(w); return w as unknown as LiveWsLike; },
    });
    try {
      const r = await fresh.sockets.open(owner, { page: PAGE, frame: 'f1', url: URL_HA });
      expect(r.ok).toBe(true);
      await writePage([{ ...HOME, socketDeny: ['config/core'] }, WEATHER]); // the manifest loses nothing the person approved, but it changed
      await fresh.listAndWatch();
      expect(fresh.sockets.count).toBe(0);
    } finally { fresh.stop(); }
  });

  it('the page being deleted closes its sockets', async () => {
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    await openLive();
    await fs.rm(path.join(personal, 'Pages', 'home'), { recursive: true });
    await service.listAndWatch();
    expect(service.sockets.count).toBe(0);
  });

  it('live traffic never marks the page fresh', async () => {
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    const before = (await service.listAndWatch())[0].refresh;
    await openLive();
    wss[0].emit('message', Buffer.from('{"type":"auth_ok"}'), false);
    wss[0].emit('message', Buffer.from('{"type":"event"}'), false);
    expect((await service.listAndWatch())[0].refresh).toEqual(before);
  });

  it('stopping the service closes every socket', async () => {
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    await openLive();
    service.stop();
    expect(service.sockets.count).toBe(0);
  });
});

// Camera video: the same approval chain, run fresh for the connection a page names by id.
describe('camera video and the approvals it stands on', () => {
  const CAMERA = { ...HOME, videoProfile: { targetPrefix: 'camera.', socketPath: '/api/websocket', send: '{"id":1,"type":"camera/webrtc/offer","entity_id":{{target}},"offer":{{offer}}}', answer: 'event.answer', candidate: 'event.candidate', failed: 'event.message' } };
  const ask = (over: Record<string, unknown> = {}) => service.videos.start(owner, { page: PAGE, frame: 'f1', connection: 'ha', target: 'camera.living_room', offer: 'v=0', ...over });

  it('is refused until the page is allowed, for a name it does not have, and for a plain lookup-only approval', async () => {
    await writePage([CAMERA, WEATHER]);
    expect((await ask()).ok).toBe(false);
    expect(wss).toHaveLength(0);
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    expect((await ask({ connection: 'nope' })).ok).toBe(false);
    expect((await ask({ connection: 'weather' })).ok).toBe(false);
    expect(wss).toHaveLength(0);
  });

  it('opens its own socket at the approved address and the profile\'s path, and greets with the saved key', async () => {
    await writePage([CAMERA, WEATHER]);
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    const r = await ask();
    expect(r.ok).toBe(true);
    expect(urls).toEqual(['ws://192.168.4.54:8123/api/websocket']);
    wss[0].emit('open');
    expect(JSON.parse(wss[0].sent[0])).toEqual({ type: 'auth', access_token: KEY });
  });

  it('every way a page\'s approval can change stops its videos, and a window going away stops them too', async () => {
    await writePage([CAMERA, WEATHER]);
    await service.approve(PAGE, { ha: KEY, weather: 'w-key-12345' }, { remote: false });
    await ask();
    await service.removeConnection(PAGE, 'weather');
    expect(service.videos.count).toBe(1);
    await service.removeConnection(PAGE, 'ha');
    expect(service.videos.count).toBe(0);
    expect(wss[0].terminated).toBe(true);
    await service.approve(PAGE, { ha: KEY }, { remote: false });
    await ask();
    await service.deleteSavedKey('Home Assistant', '192.168.4.54:8123');
    expect(service.videos.count).toBe(0);
    await service.approve(PAGE, { ha: KEY }, { remote: false });
    await ask();
    service.closeOwner('window:1');
    expect(service.videos.count).toBe(0);
    await ask();
    service.stop();
    expect(service.videos.count).toBe(0);
  });
});
