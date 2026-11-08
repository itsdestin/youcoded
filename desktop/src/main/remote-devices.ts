import fs from 'fs';
import { DEVICE_EXPIRY_DAYS } from '../shared/remote-close-codes';
import path from 'path';
import crypto from 'crypto';
import { remoteDeviceStorePath } from './remote-paths';

/**
 * Paired devices, replacing the opaque token list.
 *
 * WHY: the old store was a flat array of secrets in the clear with no device identity and no
 * dates, and `disconnectClient` closed the socket without removing anything — so "removing" a
 * device let it straight back in with the credential it still held. The only invalidation that
 * existed dropped every device at once. Contract row R7 promises the opposite.
 */
export interface RemoteDevice {
  id: string;
  secretHash: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  /**
   * When the device last got in (a sign-in, or a connection ending). Drives the 90-day sign-out.
   * Kept apart from lastSeenAt on purpose: records from before this existed have no value, and
   * their clock starts at the upgrade rather than at an old lastSeenAt (see load()).
   */
  lastUsedAt: number;
  /** 'expired' = signed out for 90 days of non-use (the phone is told so); null = unpaired by hand. */
  revokedReason: 'expired' | null;
}

/** Destin 2026-10-31: a paired device unused for 90 days must enter the password again. */
const DEVICE_EXPIRY_MS = DEVICE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

/** What the panel is allowed to see. Never the hash. */
export type RemoteDeviceView = Pick<RemoteDevice, 'id' | 'name' | 'createdAt' | 'lastSeenAt'> & { online: boolean };

export type PairedCredential = { deviceId: string; secret: string };

/**
 * WHY SHA-256 and not bcrypt: the secret is 32 machine-generated random bytes, not a human
 * password, so there is no low-entropy guess space to slow down — and bcrypt would add ~100 ms
 * inside the main process on every authentication. The host password itself stays bcrypt.
 */
function hash(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

const MAX_NAME = 60;

function cleanName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().slice(0, MAX_NAME) : '';
  return s || 'New device';
}

export class RemoteDeviceStore {
  private devices = new Map<string, RemoteDevice>();

  /** The path is injectable so tests never touch the real ~/.claude. */
  constructor(private storePath: string = remoteDeviceStorePath()) {
    this.load();
  }

  private load(now = Date.now()): void {
    let migrated = false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      if (!Array.isArray(raw)) return;
      for (const d of raw) {
        if (!d || typeof d.id !== 'string' || typeof d.secretHash !== 'string') continue;
        this.devices.set(d.id, {
          id: d.id,
          secretHash: d.secretHash,
          name: cleanName(d.name),
          createdAt: Number(d.createdAt) || 0,
          lastSeenAt: Number(d.lastSeenAt) || 0,
          revokedAt: d.revokedAt == null ? null : Number(d.revokedAt),
          // WHY now when missing: a pairing made before this rule has no last-used date. Starting its
          // 90 days at the upgrade means nobody is signed out the day they update.
          lastUsedAt: d.lastUsedAt == null ? (migrated = true, now) : Number(d.lastUsedAt) || now,
          revokedReason: d.revokedReason === 'expired' ? 'expired' : null,
        });
      }
    } catch { /* no store yet */ }
    // Written back so the upgrade-day start is remembered, not re-set to "now" on every launch.
    if (migrated) this.save();
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath, JSON.stringify([...this.devices.values()], null, 0), { mode: 0o600 });
    } catch { /* best effort, same as the store it replaces */ }
  }

  /** Issue a credential after the password was verified. Returned once and never again. */
  pair(name?: unknown, now = Date.now()): PairedCredential {
    const secret = crypto.randomBytes(32).toString('base64url');
    const device: RemoteDevice = {
      id: crypto.randomUUID(),
      secretHash: hash(secret),
      name: cleanName(name),
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
      lastUsedAt: now,
      revokedReason: null,
    };
    this.devices.set(device.id, device);
    this.save();
    return { deviceId: device.id, secret };
  }

  /**
   * A password sign-in from a device that names the row it already has: the same row, a new key.
   *
   * WHY (Destin, 2026-09-11: "each sign in seems to create a new device entry in the remote access
   * menu? even though all the same device"): every password sign-in used to pair a NEW row, so a
   * phone that lost its key a few times was listed several times. The device, not the host, says
   * which row is its own (the host still never matches by name), and the password proves it may
   * have it. The old key stops working. The name stays, in case the owner renamed the row. An
   * unpaired or unknown row is not reused: null, and the caller pairs a new one.
   */
  pairAgain(deviceId: unknown, now = Date.now()): PairedCredential | null {
    if (typeof deviceId !== 'string') return null;
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt !== null) return null;
    const secret = crypto.randomBytes(32).toString('base64url');
    device.secretHash = hash(secret);
    device.lastSeenAt = now;
    device.lastUsedAt = now;
    this.save();
    return { deviceId: device.id, secret };
  }

  /**
   * WHY this returns a reason rather than a boolean: a revoked device must be told it was
   * unpaired so its client can stop retrying, and an unknown id must be told its credential was
   * retired — the migration case. Both are terminal; a wrong secret is not.
   */
  authenticate(deviceId: unknown, secret: unknown, now = Date.now()): { ok: true; device: RemoteDevice } | { ok: false; reason: 'unknown' | 'revoked' | 'expired' | 'bad-secret' } {
    if (typeof deviceId !== 'string' || typeof secret !== 'string') return { ok: false, reason: 'unknown' };
    const device = this.devices.get(deviceId);
    if (!device) return { ok: false, reason: 'unknown' };
    if (device.revokedAt !== null) return { ok: false, reason: device.revokedReason === 'expired' ? 'expired' : 'revoked' };
    const given = Buffer.from(hash(secret), 'hex');
    const known = Buffer.from(device.secretHash, 'hex');
    if (given.length !== known.length || !crypto.timingSafeEqual(given, known)) return { ok: false, reason: 'bad-secret' };
    // WHY after the secret check: only the holder of the right key learns it was timed out. Checked on
    // every connect so a device that comes back on day 91 is stopped even if nothing swept it first.
    if (now - device.lastUsedAt > DEVICE_EXPIRY_MS) {
      this.expire(device, now);
      this.save();
      return { ok: false, reason: 'expired' };
    }
    device.lastSeenAt = now;
    device.lastUsedAt = now;
    this.save();
    return { ok: true, device };
  }

  /**
   * Unpair. The record is KEPT rather than deleted so a device that comes back is told it was
   * unpaired instead of being treated as a stranger, and so revocation survives a host restart —
   * which is the whole promise of contract row R7.
   */
  revoke(deviceId: string, now = Date.now()): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt !== null) return false;
    device.revokedAt = now;
    this.save();
    return true;
  }

  private expire(device: RemoteDevice, now: number): void {
    device.revokedAt = now;
    device.revokedReason = 'expired';
  }

  /** Sign out every device unused for 90 days. Run at startup and whenever the list is read. Returns their ids.
   *  WHY `connected`: a device that is connected right now is in use by definition, whatever its last-used date says
   *  (the date only moves when it connects or disconnects), so a sweep must never sign it out. */
  expireStale(now = Date.now(), connected?: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const d of this.devices.values()) {
      if (connected?.has(d.id)) continue;
      if (d.revokedAt === null && now - d.lastUsedAt > DEVICE_EXPIRY_MS) { this.expire(d, now); out.push(d.id); }
    }
    if (out.length) this.save();
    return out;
  }

  /**
   * A connection ended: count the time it was connected as use. WHY: a phone left connected for months
   * is in use, and connecting is the only other moment the date moves.
   */
  touch(deviceId: string, now = Date.now()): void {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt !== null) return;
    device.lastUsedAt = now;
    device.lastSeenAt = now;
    this.save();
  }

  /** Mark several connected devices as used now with ONE disk write (the hourly refresh and the shutdown). */
  touchAll(deviceIds: Iterable<string>, now = Date.now()): void {
    let changed = false;
    for (const id of deviceIds) {
      const device = this.devices.get(id);
      if (!device || device.revokedAt !== null) continue;
      device.lastUsedAt = now;
      device.lastSeenAt = now;
      changed = true;
    }
    if (changed) this.save();
  }

  rename(deviceId: string, name: unknown): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt !== null) return false;
    device.name = cleanName(name);
    this.save();
    return true;
  }

  /** A device the computer removed — or never knew. The download route checks
   *  this per GET (batch 3, R10), so a link minted before an unpair dies with it. */
  isRevoked(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    return !device || device.revokedAt !== null;
  }

  /** Contract row R11: every device that has paired stays listed until it is unpaired. */
  list(onlineIds: ReadonlySet<string> = new Set()): RemoteDeviceView[] {
    return [...this.devices.values()]
      .filter(d => d.revokedAt === null)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(d => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, online: onlineIds.has(d.id) }));
  }

  /** Every device loses access — what a password change means. */
  revokeAll(now = Date.now()): void {
    for (const d of this.devices.values()) if (d.revokedAt === null) { d.revokedAt = now; d.revokedReason = null; }
    this.save();
  }
}
