// A page's device connection: one device in the home, at the address the
// person allowed, and never anything on the internet.
//
// Home-device questions deck (2026-10-01): Q-kind "one kind for any home
// device", Q-address "page suggests, you can change it", S-only-home "only that
// one device, only home or Tailscale addresses", S-key-and-control "the key is
// kept like every other saved key". Each describe block pins one of those.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { getSecretStorage } from '../src/main/providers/secret-storage';
import { PageConnectionsStore, CONNECTIONS_FILE } from '../src/main/pages/connections-store';
import { initPagesService } from '../src/main/pages/pages-service';
import { covers, fingerprint, parseConnections } from '../src/main/pages/page-connections';
import { cleanDeviceAddress, deviceAddressProblem, urlMatchesDevice } from '../src/shared/page-device-address';
import { checkDeviceSocketAccess } from '../src/main/pages/page-socket';
import { assertHomeHttpUrl, NetGuardError } from '../src/main/harness/tools/net-guard';

const HA = {
  id: 'ha', kind: 'device', service: 'Home Assistant', address: 'homeassistant.local:8123',
  access: 'full', keyPage: '/profile/security',
};
const KEY = 'ha-long-lived-token-value';

describe('which addresses count as a device in the home', () => {
  it.each([
    ['192.168.4.54:8123', '192.168.4.54:8123'],
    ['10.77.0.3:8123', '10.77.0.3:8123'],
    ['172.20.1.5', '172.20.1.5'],
    ['100.99.234.114:8123', '100.99.234.114:8123'],
    ['HomeAssistant.Local:8123', 'homeassistant.local:8123'],
    ['destinpi.tail1234.ts.net:8123', 'destinpi.tail1234.ts.net:8123'],
    ['nas.lan', 'nas.lan'],
    ['http://192.168.4.54:8123/lovelace/0', '192.168.4.54:8123'],
    ['192.168.4.54:08123', '192.168.4.54:8123'],
  ])('%s is a home device', (raw, cleaned) => expect(cleanDeviceAddress(raw)).toBe(cleaned));

  it.each([
    'api.openweathermap.org', '8.8.8.8', '93.184.216.34:443', '127.0.0.1:8123', 'localhost:8123',
    '169.254.1.1', '172.32.0.1', '100.128.0.1', '192.168.4.54:0', '192.168.4.54:70000',
    '100.100.100.200', '100.100.100.200:8123', 'user@192.168.4.54', '192.168.4.54/path', '', '   ', 'homeassistant', 'evil.local.attacker.com',
  ])('%s is refused', (raw) => expect(cleanDeviceAddress(raw)).toBeNull());

  it('explains a refusal in words, never "fine"', () => {
    expect(deviceAddressProblem('api.example.com')).toContain('website');
    expect(deviceAddressProblem('127.0.0.1')).toContain('this computer');
    expect(deviceAddressProblem('8.8.8.8')).toContain('not a home');
    expect(deviceAddressProblem('')).toContain('Type the address');
    expect(deviceAddressProblem('100.100.100.200')).toContain('cloud service');
  });

  // F5: a cloud metadata address inside Tailscale's range is never "home", at approval or at dial time.
  it('refuses the Alibaba metadata address at approval and when dialled, but not its neighbours', async () => {
    expect(parseConnections([{ ...HA, address: '100.100.100.200:8123' }])).toEqual([]);
    await expect(assertHomeHttpUrl('http://100.100.100.200/')).rejects.toThrow(/not an address inside your home/);
    await expect(assertHomeHttpUrl('http://100.100.100.201/')).resolves.toBeInstanceOf(URL);
    const lookup = async () => [{ address: '100.100.100.200', family: 4 }];
    await expect(assertHomeHttpUrl('http://sneaky.local/', lookup)).rejects.toThrow(/outside your home network/);
  });

  it('matches a request on host AND port', () => {
    expect(urlMatchesDevice(new URL('http://192.168.4.54:8123/api/states'), '192.168.4.54:8123')).toBe(true);
    // Another service on the same box (Frigate on 5000) is not the device.
    expect(urlMatchesDevice(new URL('http://192.168.4.54:5000/api'), '192.168.4.54:8123')).toBe(false);
    expect(urlMatchesDevice(new URL('http://nas.lan/'), 'nas.lan')).toBe(true);
    expect(urlMatchesDevice(new URL('http://nas.lan:8080/'), 'nas.lan')).toBe(false);
  });
});

describe('the manifest', () => {
  it('parses a device line with its suggestion and where keys are made', () => {
    const [c] = parseConnections([HA]);
    expect(c).toMatchObject({ kind: 'device', service: 'Home Assistant', address: 'homeassistant.local:8123', access: 'full', needsKey: true, keyPage: '/profile/security' });
  });

  it('drops a device whose suggestion is a website', () => {
    expect(parseConnections([{ ...HA, address: 'collector.example.com' }])).toEqual([]);
  });

  it('drops a key page that could point anywhere but the device', () => {
    for (const keyPage of ['//evil.example/x', 'https://evil.example', '/../../x', 'profile']) {
      expect(parseConnections([{ ...HA, keyPage }])[0]).not.toHaveProperty('keyPage');
    }
  });

  it('never sits on one page with the whole internet', () => {
    expect(parseConnections([HA, { id: 'o', kind: 'open' }])).toEqual([]);
    expect(parseConnections([{ ...HA, needsKey: false }, { id: 'o', kind: 'open' }])).toEqual([]);
  });

  it('keeps the allowed address out of the fingerprint, so a new suggestion does not re-ask', () => {
    const [a] = parseConnections([HA]);
    const [b] = parseConnections([{ ...HA, address: '192.168.1.20:8123' }]);
    expect(fingerprint(a)).toBe(fingerprint(b));
    // ...but widening access does.
    const [c] = parseConnections([{ ...HA, access: 'lookup' }]);
    expect(fingerprint(c)).not.toBe(fingerprint(a));
  });

  it('never covers a device from a bare hostname, only a whole URL', () => {
    const [c] = parseConnections([HA]);
    expect(covers(c, 'homeassistant.local')).toBe(false);
    expect(covers(c, new URL('http://homeassistant.local:8123/api/'))).toBe(true);
  });
});

describe('the home-only guard', () => {
  const lookup = (map: Record<string, string>) => async (host: string) => map[host] ? [{ address: map[host], family: 4 }] : [];

  it('allows a home address and a name that resolves to one', async () => {
    await expect(assertHomeHttpUrl('http://192.168.4.54:8123/api/', lookup({}))).resolves.toBeInstanceOf(URL);
    await expect(assertHomeHttpUrl('http://homeassistant.local:8123/', lookup({ 'homeassistant.local': '192.168.4.54' }))).resolves.toBeInstanceOf(URL);
  });

  it('refuses a name that resolves to the internet, and a public literal', async () => {
    await expect(assertHomeHttpUrl('http://pi.tail1.ts.net/', lookup({ 'pi.tail1.ts.net': '93.184.216.34' }))).rejects.toBeInstanceOf(NetGuardError);
    await expect(assertHomeHttpUrl('http://93.184.216.34/', lookup({}))).rejects.toBeInstanceOf(NetGuardError);
    await expect(assertHomeHttpUrl('http://127.0.0.1:8123/', lookup({}))).rejects.toBeInstanceOf(NetGuardError);
  });
});

// ── The service, end to end ─────────────────────────────────────────────────

let root: string;
let personal: string;
let userData: string;
let service: ReturnType<typeof initPagesService>;
let fetchMock: ReturnType<typeof vi.fn>;

async function writePage(slug: string, connections: unknown[]) {
  const dir = path.join(personal, 'Pages', slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'page.json'), JSON.stringify({ name: slug, description: 'd', icon: 'page', connections }));
  await fs.writeFile(path.join(dir, 'page.html'), '<!doctype html><html><body>hi</body></html>');
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'page-device-'));
  personal = path.join(root, 'Personal');
  userData = path.join(root, 'userData');
  fetchMock = vi.fn().mockImplementation(async () => new Response('[]', { status: 200 }));
  service = initPagesService({
    personalRoot: () => personal,
    listProjects: async () => [],
    deviceId: () => 'dev-1',
    localFallbackDir: () => path.join(root, 'local'),
    connections: new PageConnectionsStore(userData, new SecretsStore(userData, getSecretStorage())),
    broadcast: () => {},
    fetchImpl: fetchMock as unknown as typeof fetch,
    lookup: async (host) => host === 'homeassistant.local' ? [{ address: '192.168.4.54', family: 4 }] : [{ address: '93.184.216.34', family: 4 }],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  service.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('allowing a device', () => {
  it('records the address the person chose, not the suggestion', async () => {
    await writePage('home', [HA]);
    const r = await service.approve('personal:home', { ha: KEY }, { remote: false, addresses: { ha: '100.99.234.114:8123' } });
    expect(r.ok).toBe(true);
    const page = (await service.listAndWatch())[0];
    expect(page.connections).toMatchObject([{ kind: 'device', approved: true, address: '100.99.234.114:8123', savedKey: true }]);
    const file = readFileSync(path.join(userData, CONNECTIONS_FILE), 'utf8');
    expect(file).toContain('100.99.234.114:8123');
    expect(file).not.toContain(KEY);
  });

  it('refuses a website typed into the address box, and records nothing', async () => {
    await writePage('home', [HA]);
    const r = await service.approve('personal:home', { ha: KEY }, { remote: false, addresses: { ha: 'collector.example.com' } });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('not an address inside your home') });
    expect((await service.listAndWatch())[0].connections).toMatchObject([{ approved: false }]);
  });

  it('refuses a pasted key from a phone, like every other key', async () => {
    await writePage('home', [HA]);
    const r = await service.approve('personal:home', { ha: KEY }, { remote: true, addresses: { ha: '192.168.4.54:8123' } });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('computer running YouCoded') });
  });
});

describe('reaching the device', () => {
  async function allowed(address = '192.168.4.54:8123') {
    await writePage('home', [HA]);
    const r = await service.approve('personal:home', { ha: KEY }, { remote: false, addresses: { ha: address } });
    expect(r.ok).toBe(true);
  }

  it('reaches the allowed address with the key attached', async () => {
    await allowed();
    const r = await service.fetch('personal:home', { url: 'http://192.168.4.54:8123/api/states' });
    expect(r).toMatchObject({ ok: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://192.168.4.54:8123/api/states');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('does not reach the suggestion once a different address was allowed', async () => {
    await allowed('192.168.4.54:8123');
    const r = await service.fetch('personal:home', { url: 'http://homeassistant.local:8123/api/states' });
    expect(r).toMatchObject({ ok: false, reason: 'not-approved' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not reach another port on the same box', async () => {
    await allowed();
    const r = await service.fetch('personal:home', { url: 'http://192.168.4.54:5000/api/events' });
    expect(r).toMatchObject({ ok: false, reason: 'not-approved' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a redirect off the device, without following it', async () => {
    await allowed();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://93.184.216.34/collect' } }));
    const r = await service.fetch('personal:home', { url: 'http://192.168.4.54:8123/api/states' });
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers a camera snapshot as a picture, and refuses a non-picture as one', async () => {
    await allowed();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const pic = await service.fetch('personal:home', { url: 'http://192.168.4.54:8123/api/camera_proxy/camera.door', as: 'picture' });
    expect(pic).toMatchObject({ ok: true, body: 'data:image/jpeg;base64,/9j/' });
    fetchMock.mockResolvedValueOnce(new Response(`{"token":"${KEY}"}`, { status: 200, headers: { 'content-type': 'application/json' } }));
    const sneaky = await service.fetch('personal:home', { url: 'http://192.168.4.54:8123/api/', as: 'picture' });
    expect(sneaky).toMatchObject({ ok: false });
    expect(JSON.stringify(sneaky)).not.toContain(KEY);
  });

  // F3: the header alone is not enough; the bytes must be that image type.
  it('refuses text labelled as an image, so a picture cannot read the key back', async () => {
    await allowed();
    fetchMock.mockResolvedValueOnce(new Response(`{"echo":"${KEY}"}`, { status: 200, headers: { 'content-type': 'image/png' } }));
    const r = await service.fetch('personal:home', { url: 'http://192.168.4.54:8123/api/echo', as: 'picture' });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain(Buffer.from(KEY).toString('base64').slice(0, 12));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), { status: 200, headers: { 'content-type': 'image/png' } }));
    expect(await service.fetch('personal:home', { url: 'http://192.168.4.54:8123/api/x.png', as: 'picture' })).toMatchObject({ ok: true });
  });

  // Recorded clips (spec 2026-10-04, Part 3): as:'video' answers a data: link
  // for a <video>, and refuses anything that is not a real, small mp4.
  describe('a recorded clip', () => {
    const URL_ = 'http://192.168.4.54:8123/api/nest/event_media/abc?authSig=x';
    /** A tiny valid-looking mp4: 4 size bytes, then 'ftyp'. */
    const mp4 = (extra = 8) => { const b = new Uint8Array(12 + extra); b.set([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70], 0); return b; };
    const clip = (body: Uint8Array, headers: Record<string, string> = { 'content-type': 'video/mp4' }) => new Response(body as unknown as BodyInit, { status: 200, headers });

    it('answers a real mp4 as a data link', async () => {
      await allowed();
      fetchMock.mockResolvedValueOnce(clip(mp4()));
      const r = await service.fetch('personal:home', { url: URL_, as: 'video' });
      expect(r).toMatchObject({ ok: true });
      if (r.ok) expect(r.body.startsWith('data:video/mp4;base64,AAAADGZ0eXA')).toBe(true);
    });

    it('refuses a non-mp4 type, and an mp4 type with no ftyp box', async () => {
      await allowed();
      fetchMock.mockResolvedValueOnce(clip(mp4(), { 'content-type': 'application/json' }));
      expect(await service.fetch('personal:home', { url: URL_, as: 'video' })).toMatchObject({ ok: false });
      fetchMock.mockResolvedValueOnce(clip(new TextEncoder().encode(`{"token":"${KEY}"}`)));
      const sneaky = await service.fetch('personal:home', { url: URL_, as: 'video' });
      expect(sneaky).toMatchObject({ ok: false });
      expect(JSON.stringify(sneaky)).not.toContain(KEY);
    });

    it('refuses a clip that is too big, by its header and by its body', async () => {
      await allowed();
      fetchMock.mockResolvedValueOnce(new Response(mp4() as unknown as BodyInit, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '5000000' } }));
      expect(await service.fetch('personal:home', { url: URL_, as: 'video' })).toMatchObject({ ok: false, message: expect.stringContaining('too large') });
      // No content-length at all: the body itself is counted.
      const big = new Uint8Array(4_000_001); big.set([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70], 0);
      fetchMock.mockResolvedValueOnce(clip(big));
      expect(await service.fetch('personal:home', { url: URL_, as: 'video' })).toMatchObject({ ok: false, message: expect.stringContaining('too large') });
    });

    it('allows one clip download at a time per page', async () => {
      await allowed();
      let release: (r: Response) => void = () => {};
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
      const first = service.fetch('personal:home', { url: URL_, as: 'video' });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(await service.fetch('personal:home', { url: URL_, as: 'video' })).toMatchObject({ ok: false, reason: 'too-many-requests' });
      release(clip(mp4()));
      expect(await first).toMatchObject({ ok: true });
      // The slot is free again afterwards.
      fetchMock.mockResolvedValueOnce(clip(mp4()));
      expect(await service.fetch('personal:home', { url: URL_, as: 'video' })).toMatchObject({ ok: true });
    });
  });

  it('stops working when the saved key is deleted', async () => {
    await allowed();
    await service.deleteSavedKey('Home Assistant', '192.168.4.54:8123');
    expect((await service.listAndWatch())[0].connections).toMatchObject([{ approved: false }]);
    const r = await service.fetch('personal:home', { url: 'http://192.168.4.54:8123/api/states' });
    expect(r).toMatchObject({ ok: false, reason: 'not-approved' });
  });
});


// F4: a video names its connection; the check must use THAT one, not the first at the same address.
describe('two device lines at one address', () => {
  it('a named connection is the one used', async () => {
    const conns = parseConnections([
      { id: 'a', kind: 'device', service: 'First', address: '192.168.4.54:8123', access: 'full', socketHello: '{"type":"auth","access_token":"{{key}}"}' },
      { id: 'b', kind: 'device', service: 'Second', address: '192.168.4.54:8123', access: 'full' },
    ]);
    expect(conns.map((c) => c.id)).toEqual(['a', 'b']);
    const approved = Object.fromEntries(conns.map((c) => [c.id, fingerprint(c)]));
    const ctx = { signal: new AbortController().signal, connections: conns, approved, credential: async () => ({ in: 'header' as const, param: 'authorization', value: 'Bearer k', secret: 'k' }), lookup: async () => [] as never };
    const first = await checkDeviceSocketAccess('http://192.168.4.54:8123/api/websocket', ctx);
    expect(first.ok && first.connection.id).toBe('a');
    const named = await checkDeviceSocketAccess('http://192.168.4.54:8123/api/websocket', ctx, 'b');
    expect(named.ok && named.connection.id).toBe('b');
  });
});
