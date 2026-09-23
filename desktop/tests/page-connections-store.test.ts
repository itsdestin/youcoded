// The approvals and saved keys behind YouCoded Pages Phase 2.
//
// These pin the promises the approval screen makes on the person's behalf: a
// grant belongs to ONE page (and one project clone), a key is never a loose
// blob nobody can name, and a file this build does not understand is refused
// whole rather than half-read.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeStorage } from 'electron';
import { SecretsStore } from '../src/main/providers/secrets-store';
import {
  PageConnectionsStore, ConnectionsUnreadableError, CONNECTIONS_FILE, UNKNOWN_VERSION_MESSAGE,
  approvalKey, savedKeyId, splitSavedKeyId, hashHtml,
} from '../src/main/pages/connections-store';

let dir: string;
let secrets: SecretsStore;
let store: PageConnectionsStore;

const approval = (fingerprint: string) => ({ fingerprint, approvedAt: '2026-09-20T00:00:00.000Z', htmlHash: hashHtml('<p>x</p>') });
const fileOnDisk = () => JSON.parse(readFileSync(path.join(dir, CONNECTIONS_FILE), 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'page-connections-'));
  secrets = new SecretsStore(dir);
  store = new PageConnectionsStore(dir, secrets);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('where an approval is filed', () => {
  it('keys a project page by the project path, so two clones of one name do not share a grant', () => {
    const a = approvalKey({ kind: 'project', path: '/home/d/work/dashboard', name: 'dashboard' }, 'weather');
    const b = approvalKey({ kind: 'project', path: '/home/d/archive/dashboard', name: 'dashboard' }, 'weather');
    expect(a).not.toBe(b);
    expect(a).toContain('/home/d/work/dashboard');
    // The same folder spelled differently is still the same grant.
    expect(approvalKey({ kind: 'project', path: '/home/d/work/./dashboard/', name: 'dashboard' }, 'weather')).toBe(a);
  });

  it('keys a personal page by its slug alone', () => {
    expect(approvalKey({ kind: 'personal' }, 'weather')).toBe('personal:weather');
  });

  it('identifies a key by service AND address, and can split it back apart', () => {
    expect(savedKeyId('OpenWeather', 'api.openweathermap.org')).toBe('OpenWeather|api.openweathermap.org');
    expect(splitSavedKeyId('OpenWeather|api.openweathermap.org')).toEqual({ service: 'OpenWeather', address: 'api.openweathermap.org' });
    expect(splitSavedKeyId('nonsense')).toBeNull();
  });
});

describe('reading a file this build does not understand', () => {
  it('refuses everything with a plain message instead of half-parsing it', async () => {
    writeFileSync(path.join(dir, CONNECTIONS_FILE), JSON.stringify({
      version: 99, pages: { 'personal:weather': { w: approval('key|X|api.x.com|lookup') } }, keys: {},
    }));
    await expect(store.read()).rejects.toBeInstanceOf(ConnectionsUnreadableError);
    await expect(store.approvalsFor('personal:weather')).rejects.toThrow(UNKNOWN_VERSION_MESSAGE);
    // And it refuses to WRITE over it, rather than replacing what it cannot read.
    await expect(store.recordApprovals('personal:weather', { w: approval('key|X|api.x.com|lookup') }))
      .rejects.toBeInstanceOf(ConnectionsUnreadableError);
    expect(fileOnDisk().version).toBe(99);
  });

  it('reads a missing file as nothing approved', async () => {
    expect(await store.read()).toEqual({ pages: {}, keys: {} });
  });
});

describe('saving a key', () => {
  it('keeps only a pointer in the connections file; the key itself goes to the secrets store', async () => {
    await store.saveKey('OpenWeather', 'api.openweathermap.org', 'sk-page-key-123', { in: 'query', param: 'appid', scheme: 'none' });
    const raw = readFileSync(path.join(dir, CONNECTIONS_FILE), 'utf8');
    expect(raw).not.toContain('sk-page-key-123');
    const record = await store.savedKey('OpenWeather', 'api.openweathermap.org');
    expect(record).toMatchObject({ in: 'query', param: 'appid', scheme: 'none' });
    expect(await store.keyValue(record!)).toBe('sk-page-key-123');
  });

  it('rotates in place, so pages pointing at the key keep working', async () => {
    const first = await store.saveKey('OpenWeather', 'api.openweathermap.org', 'old', { in: 'header', param: 'authorization', scheme: 'none' });
    const second = await store.saveKey('OpenWeather', 'api.openweathermap.org', 'new', { in: 'header', param: 'authorization', scheme: 'none' });
    expect(second.secretRef).toBe(first.secretRef);
    expect(await store.keyValue(second)).toBe('new');
  });

  it('throws — and writes nothing — on a computer with no keychain', async () => {
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(false);
    await expect(store.saveKey('OpenWeather', 'api.openweathermap.org', 'sk-x', { in: 'header', param: 'authorization', scheme: 'none' }))
      .rejects.toThrow();
    expect(await store.savedKey('OpenWeather', 'api.openweathermap.org')).toBeNull();
  });
});

describe('deleting a saved key', () => {
  it('takes the secret and every approval standing on it, so no page looks connected without one', async () => {
    const record = await store.saveKey('OpenWeather', 'api.openweathermap.org', 'sk-x', { in: 'query', param: 'appid', scheme: 'none' });
    await store.recordApprovals('personal:weather', {
      w: approval('key|OpenWeather|api.openweathermap.org|lookup'),
      f: approval('public|hnrss.org'),
    });
    await store.deleteSavedKey('OpenWeather', 'api.openweathermap.org');
    const after = await store.read();
    expect(after.keys).toEqual({});
    expect(Object.keys(after.pages['personal:weather'])).toEqual(['f']);
    expect(await secrets.get(record.secretRef)).toBeNull();
  });
});

describe('pruning what nothing points at', () => {
  it('drops a gone page\'s approvals, and the last user of a key takes its secret with it', async () => {
    const record = await store.saveKey('OpenWeather', 'api.openweathermap.org', 'sk-x', { in: 'query', param: 'appid', scheme: 'none' });
    await store.recordApprovals('personal:gone', { w: approval('key|OpenWeather|api.openweathermap.org|lookup') });
    await store.recordApprovals('personal:here', { f: approval('public|hnrss.org') });

    await store.prune(new Set(['personal:here']), new Set());

    const after = await store.read();
    expect(Object.keys(after.pages)).toEqual(['personal:here']);
    expect(after.keys).toEqual({});
    expect(await secrets.get(record.secretRef)).toBeNull();
  });

  it('keeps a key another page still uses', async () => {
    await store.saveKey('OpenWeather', 'api.openweathermap.org', 'sk-x', { in: 'query', param: 'appid', scheme: 'none' });
    await store.prune(new Set(), new Set([savedKeyId('OpenWeather', 'api.openweathermap.org')]));
    expect(await store.savedKey('OpenWeather', 'api.openweathermap.org')).not.toBeNull();
  });
});

describe('removing one connection', () => {
  it('leaves the page\'s other approvals alone', async () => {
    await store.recordApprovals('personal:weather', { w: approval('key|X|api.x.com|lookup'), f: approval('public|hnrss.org') });
    await store.removeApproval('personal:weather', 'w');
    expect(Object.keys((await store.read()).pages['personal:weather'])).toEqual(['f']);
  });

  it('records the page document\'s hash, so a later build can ask about a rewrite', async () => {
    await store.recordApprovals('personal:weather', { w: approval('key|X|api.x.com|lookup') });
    const stored = (await store.approvalsFor('personal:weather')).w;
    expect(stored.htmlHash).toBe(hashHtml('<p>x</p>'));
    expect(stored.htmlHash).not.toBe(hashHtml('<p>y</p>'));
  });
});

describe('a file written by another process', () => {
  it('folds a new approval in rather than replacing what is already there', async () => {
    await fs.writeFile(path.join(dir, CONNECTIONS_FILE), JSON.stringify({
      version: 1, pages: { 'personal:other': { a: approval('public|hnrss.org') } }, keys: {},
    }));
    await store.recordApprovals('personal:weather', { w: approval('key|X|api.x.com|lookup') });
    expect(Object.keys((await store.read()).pages).sort()).toEqual(['personal:other', 'personal:weather']);
  });
});
