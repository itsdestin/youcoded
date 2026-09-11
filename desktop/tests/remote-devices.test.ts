import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteDeviceStore } from '../src/main/remote-devices';

// Real files, never ~/.claude: the store this replaces had no path seam, so a test of it
// would have written the running app's paired devices.
let dir: string;
let storePath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'remote-devices-')); storePath = join(dir, '.remote-devices.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

const reopen = () => new RemoteDeviceStore(storePath);

describe('paired device store', () => {
  it('unpairing keeps the device out after a host restart', () => {
    // Contract R7. The old code closed the socket and left the credential valid, so the
    // device reconnected immediately; nothing survived a restart because nothing was stored.
    const store = new RemoteDeviceStore(storePath);
    const phone = store.pair('My phone');
    expect(store.authenticate(phone.deviceId, phone.secret).ok).toBe(true);

    expect(store.revoke(phone.deviceId)).toBe(true);
    const afterRevoke = store.authenticate(phone.deviceId, phone.secret);
    expect(afterRevoke).toEqual({ ok: false, reason: 'revoked' });

    const restarted = reopen();
    expect(restarted.authenticate(phone.deviceId, phone.secret)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('unpairing one device leaves the other working, across a restart', () => {
    // The only invalidation that existed dropped EVERY device (password change). A test that
    // checked only the live sockets would pass even if that behaviour came back.
    const store = new RemoteDeviceStore(storePath);
    const phone = store.pair('My phone');
    const tablet = store.pair('My tablet');
    store.revoke(phone.deviceId);

    const restarted = reopen();
    expect(restarted.authenticate(tablet.deviceId, tablet.secret).ok).toBe(true);
    expect(restarted.authenticate(phone.deviceId, phone.secret).ok).toBe(false);
  });

  it('never writes the secret, only a hash, and keeps the file owner-only', () => {
    const store = new RemoteDeviceStore(storePath);
    const phone = store.pair('My phone');
    const raw = readFileSync(storePath, 'utf8');
    expect(raw).not.toContain(phone.secret);
    expect(raw).toContain('secretHash');
    expect(statSync(storePath).mode & 0o077).toBe(0);
  });

  it('tells an unknown credential apart from a revoked one', () => {
    // Both are terminal for the client, but they are different sentences to the user, and
    // "unknown" is what every device sees on upgrade day when the old token file is retired.
    const store = new RemoteDeviceStore(storePath);
    const phone = store.pair('My phone');
    expect(store.authenticate('no-such-device', 'x')).toEqual({ ok: false, reason: 'unknown' });
    expect(store.authenticate(phone.deviceId, 'wrong-secret')).toEqual({ ok: false, reason: 'bad-secret' });
    store.revoke(phone.deviceId);
    expect(store.authenticate(phone.deviceId, phone.secret)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('lists a paired device that is not connected, marked offline', () => {
    // Contract R11. Without this Unpair is useless: the row vanishes when the phone closes.
    const store = new RemoteDeviceStore(storePath);
    const phone = store.pair('My phone');
    const tablet = store.pair('My tablet');

    const listed = store.list(new Set([phone.deviceId]));
    expect(listed.find(d => d.name === 'My tablet')!.online).toBe(false);
    expect(listed.find(d => d.name === 'My phone')!.online).toBe(true);
    expect(listed).toHaveLength(2);

    store.revoke(tablet.deviceId);
    expect(reopen().list().map(d => d.name)).toEqual(['My phone']);
  });

  it('reuses the record when the same device authenticates again', () => {
    // The old server minted a fresh token per password auth, so one device accumulated
    // several credentials and could never be shown as one row.
    const store = new RemoteDeviceStore(storePath);
    const phone = store.pair('My phone', 1000);
    store.authenticate(phone.deviceId, phone.secret, 5000);
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].createdAt).toBe(1000);
    expect(listed[0].lastSeenAt).toBe(5000);
  });

  it('never exposes the hash to the panel', () => {
    const store = new RemoteDeviceStore(storePath);
    store.pair('My phone');
    expect(JSON.stringify(store.list())).not.toContain('secretHash');
  });

  it('falls back to a usable name rather than an empty row', () => {
    const store = new RemoteDeviceStore(storePath);
    const a = store.pair('   ');
    const b = store.pair(undefined);
    expect(store.list().map(d => d.name)).toEqual(['New device', 'New device']);
    expect(store.rename(a.deviceId, 'Kitchen tablet')).toBe(true);
    expect(reopen().list().find(d => d.id === a.deviceId)!.name).toBe('Kitchen tablet');
    expect(store.rename(b.deviceId, 'x'.repeat(200))).toBe(true);
    expect(reopen().list().find(d => d.id === b.deviceId)!.name).toHaveLength(60);
  });

  it('revokeAll is what a password change means, and it survives a restart', () => {
    const store = new RemoteDeviceStore(storePath);
    const phone = store.pair('My phone');
    const tablet = store.pair('My tablet');
    store.revokeAll();
    const restarted = reopen();
    expect(restarted.authenticate(phone.deviceId, phone.secret).ok).toBe(false);
    expect(restarted.authenticate(tablet.deviceId, tablet.secret).ok).toBe(false);
    expect(restarted.list()).toEqual([]);
  });
});
