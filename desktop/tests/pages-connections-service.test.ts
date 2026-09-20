// Approving a page's connections, and where "Updated 2m" comes from.
//
// The store and the door have their own files (page-connections-store,
// page-fetch); this pins the part that joins them — what Allow writes, what it
// refuses to write, and the rule that only a request that actually worked may
// move the time on the band.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { PageConnectionsStore, CONNECTIONS_FILE } from '../src/main/pages/connections-store';
import { initPagesService } from '../src/main/pages/pages-service';
import type { PageSummary } from '../src/shared/pages-types';

const WEATHER = {
  id: 'weather', kind: 'key', service: 'OpenWeather', address: 'api.openweathermap.org',
  access: 'lookup', keyIn: 'query', keyParam: 'appid',
};
const KEY = 'sk-page-secret-value';

let root: string;
let personal: string;
let userData: string;
let broadcasts: PageSummary[][];
let service: ReturnType<typeof initPagesService>;
let fetchMock: ReturnType<typeof vi.fn>;

async function writePage(slug: string, connections: unknown[]) {
  const dir = path.join(personal, 'Pages', slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'page.json'), JSON.stringify({ name: slug, description: 'd', icon: 'page', connections }));
  await fs.writeFile(path.join(dir, 'page.html'), '<!doctype html><html><body>hi</body></html>');
}

function start() {
  fetchMock = vi.fn().mockResolvedValue(new Response('{"temp":7}', { status: 200 }));
  broadcasts = [];
  service = initPagesService({
    personalRoot: () => personal,
    listProjects: async () => [],
    deviceId: () => 'dev-1',
    localFallbackDir: () => path.join(root, 'local'),
    connections: new PageConnectionsStore(userData, new SecretsStore(userData)),
    broadcast: (pages) => { broadcasts.push(pages); },
    fetchImpl: fetchMock as unknown as typeof fetch,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pages-connections-'));
  personal = path.join(root, 'Personal');
  userData = path.join(root, 'userData');
  start();
});
afterEach(() => {
  vi.restoreAllMocks();
  service.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('a page that wants something', () => {
  it('lists as waiting until it is allowed, then as allowed', async () => {
    await writePage('weather', [WEATHER]);
    const before = (await service.listAndWatch())[0];
    expect(before.connections).toMatchObject([{ id: 'weather', approved: false, savedKey: false }]);
    expect(before.refresh).toBeUndefined();

    const result = await service.approve('personal:weather', { weather: KEY }, { remote: false });
    expect(result.ok).toBe(true);
    const after = (await service.listAndWatch())[0];
    expect(after.connections).toMatchObject([{ id: 'weather', approved: true, savedKey: true }]);
    // The band appears only once the page can actually reach something.
    expect(after.refresh).toEqual({ at: null, failed: false });
  });

  it('records no approval at all when the computer cannot store the key', async () => {
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
    await writePage('weather', [WEATHER]);
    const result = await service.approve('personal:weather', { weather: KEY }, { remote: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toBeTruthy();
    expect((await service.listAndWatch())[0].connections).toMatchObject([{ approved: false }]);
  });

  it('refuses a pasted key from a phone, and never writes one', async () => {
    await writePage('weather', [WEATHER]);
    const result = await service.approve('personal:weather', { weather: KEY }, { remote: true });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('computer running YouCoded') });
    expect((await service.listAndWatch())[0].connections).toMatchObject([{ approved: false }]);
  });

  it('lets a phone reuse a key the computer already holds', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    await service.removeConnection('personal:weather', 'weather');
    const again = await service.approve('personal:weather', { weather: 'saved' }, { remote: true });
    expect(again.ok).toBe(true);
  });

  it('says so when it is asked to reuse a key nothing has saved', async () => {
    await writePage('weather', [WEATHER]);
    const result = await service.approve('personal:weather', { weather: 'saved' }, { remote: false });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('OpenWeather') });
  });

  it('never writes the key itself into the approvals file', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    expect(readFileSync(path.join(userData, CONNECTIONS_FILE), 'utf8')).not.toContain(KEY);
  });
});

describe('the time on the band', () => {
  it('moves only on a request that actually worked', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });

    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await service.fetch('personal:weather', { url: 'https://api.openweathermap.org/data' });
    expect((await service.listAndWatch())[0].refresh).toEqual({ at: null, failed: true });

    fetchMock.mockResolvedValue(new Response('{"temp":7}', { status: 200 }));
    await service.fetch('personal:weather', { url: 'https://api.openweathermap.org/data' });
    const fresh = (await service.listAndWatch())[0].refresh!;
    expect(fresh.failed).toBe(false);
    expect(fresh.at).toBeTruthy();

    // A later refusal keeps the last true time and marks the failure; it does
    // not pretend the page was updated just now.
    fetchMock.mockResolvedValue(new Response('nope', { status: 403 }));
    await service.fetch('personal:weather', { url: 'https://api.openweathermap.org/data' });
    expect((await service.listAndWatch())[0].refresh).toEqual({ at: fresh.at, failed: true });
  });

  it('is not written to disk, because a fetch may happen sixty times a minute', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    await service.fetch('personal:weather', { url: 'https://api.openweathermap.org/data' });
    const saved = JSON.parse(readFileSync(path.join(userData, CONNECTIONS_FILE), 'utf8'));
    expect(JSON.stringify(saved)).not.toContain('failed');
    expect(Object.keys(saved)).toEqual(['version', 'pages', 'keys']);
  });
});

describe('a connections file this build cannot read', () => {
  it('pauses every page rather than guessing at a grant', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    await fs.writeFile(path.join(userData, CONNECTIONS_FILE), JSON.stringify({ version: 99, pages: {}, keys: {} }));

    expect((await service.listAndWatch())[0].connections).toMatchObject([{ approved: false }]);
    const blocked = await service.fetch('personal:weather', { url: 'https://api.openweathermap.org/data' });
    expect(blocked).toMatchObject({ ok: false, reason: 'not-approved' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('managing saved keys', () => {
  it('names each key by service and address and says which pages use it', async () => {
    await writePage('weather', [WEATHER]);
    await writePage('second', [{ ...WEATHER, id: 'w2' }]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    await service.approve('personal:second', { w2: 'saved' }, { remote: false });
    expect(await service.savedKeys()).toEqual([{
      service: 'OpenWeather', address: 'api.openweathermap.org',
      usedBy: [{ id: 'personal:second', name: 'second' }, { id: 'personal:weather', name: 'weather' }],
    }]);
  });

  it('deleting one cuts off every page that stood on it', async () => {
    await writePage('weather', [WEATHER]);
    await service.approve('personal:weather', { weather: KEY }, { remote: false });
    expect(await service.deleteSavedKey('OpenWeather', 'api.openweathermap.org')).toEqual([]);
    const after = (await service.listAndWatch())[0];
    expect(after.connections).toMatchObject([{ approved: false, savedKey: false }]);
    expect(after.refresh).toBeUndefined();
  });
});
