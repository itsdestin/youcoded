// desktop/src/main/sync-spaces/device-registry.ts
// Per-device registry that stores a friendly, editable name for each device
// (Plan 2b Task 4, spec §10a). One JSON file per device, synced INSIDE the
// always-present Personal space so every device sees the same "Your devices"
// list (surfaced in Task 12).
//
// Layout mirrors the Conversation Store + Project Registry
// (Personal/<Kind>/<id>.json): a VISIBLE per-file folder under Personal. That
// convention sidesteps the reserved `.youcoded/` basename (the transport's
// hidden git dir AND a DEFAULT_IGNORES entry — anything under it never syncs).
//
// The filename is `<deviceId>.json` where `deviceId` is a UUID (Task 3's device
// identity). Because a UUID can NEVER contain the " (from " substring, this is
// exactly the Conversation Store's situation — we can use isConflictCopyName /
// extractConflictBase DIRECTLY and do NOT need Project Registry's
// canonicalBaseFor precedence hack (that existed only because project filenames
// are user-chosen folder names that may contain parentheses).
//
// Records are MUTABLE (a device can be renamed on any device), so this is a
// convergent record set: per-file, fail-soft parse, locked read-modify-write,
// and fold-on-read that resolves the transport's conflict copies. Since each
// device normally writes only its OWN file, conflicts arise only from
// cross-device renames of the same device — healed by fold-on-read.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import { laterOf, isConflictCopyName, extractConflictBase } from '../conversations/store-core';

export const DEVICE_REGISTRY_SCHEMA = 1;

export interface DeviceRecord {
  schemaVersion: number;
  id: string;        // stable device id (UUID) — the immutable filename identity
  name: string;      // synced, user-editable friendly label; defaults to os.hostname()
  platform: string;  // process.platform of the device (win32 / darwin / linux / ...)
  lastSeen: number;  // ms epoch — last heartbeat; merges as MAX
  updatedAt: number; // ms epoch — last NAME edit; drives last-writer-wins for name
}

function registryDir(personalRoot: string): string {
  return path.join(personalRoot, 'Devices');
}

// FAIL-SOFT parse: corrupt / partial / unknown-schema files return null so a bad
// file damages exactly one device row, never the whole list (dev instance + built
// app share the tree). `id` and `name` are the core identity — a record missing
// either is treated as invalid.
function parseEntry(json: string): DeviceRecord | null {
  let raw: any;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schemaVersion !== DEVICE_REGISTRY_SCHEMA) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  return {
    schemaVersion: DEVICE_REGISTRY_SCHEMA,
    id: raw.id,
    name: raw.name,
    platform: typeof raw.platform === 'string' ? raw.platform : '',
    lastSeen: typeof raw.lastSeen === 'number' && Number.isFinite(raw.lastSeen) ? raw.lastSeen : 0,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
}

// PURE. Field-wise merge. Commutative + associative (a lattice join), so a plain
// reduce over any copy order converges:
//   - name  : last-writer-wins by updatedAt (content-tiebroken via laterOf so two
//             devices resolve an exact-updatedAt tie identically → merge(a,b)===merge(b,a)).
//   - platform : rides with the name-winner (deterministic; for one device they match anyway).
//   - lastSeen : MAX (the most recent heartbeat from any copy).
//   - updatedAt: MAX (equals the name-winner's updatedAt).
export function mergeDeviceEntries(a: DeviceRecord, b: DeviceRecord): DeviceRecord {
  const winner = laterOf(a, b, a.updatedAt, b.updatedAt); // name + platform LWW winner
  return {
    schemaVersion: DEVICE_REGISTRY_SCHEMA,
    id: winner.id,
    name: winner.name,
    platform: winner.platform,
    lastSeen: Math.max(a.lastSeen, b.lastSeen),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

export function foldDeviceEntries(entries: DeviceRecord[]): DeviceRecord {
  return entries.reduce((acc, e) => mergeDeviceEntries(acc, e));
}

/** Read + fold every device record. FAIL-SOFT: corrupt / partial / unknown-schema
 *  files are skipped, never thrown. Conflict copies are folded into their
 *  canonical `<id>.json` in memory (fold-on-read is load-bearing — a cross-device
 *  rename left as a transport copy must not lose to the stale canonical). Copy
 *  files are left on disk (rare, inert). */
export function readDevices(personalRoot: string): DeviceRecord[] {
  const dir = registryDir(personalRoot);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const groups = new Map<string, DeviceRecord[]>();
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const full = path.join(dir, n);
    let e: DeviceRecord | null = null;
    try { if (fs.lstatSync(full).isFile()) e = parseEntry(fs.readFileSync(full, 'utf8')); }
    catch { /* corrupt / vanished — skip */ }
    if (!e) continue;
    // Group by the canonical `<id>.json`. A UUID id can't contain " (from ", so
    // this grouping is unambiguous (unlike Project Registry's paren-able names).
    const base = isConflictCopyName(n) ? extractConflictBase(n) : n;
    // Guard: the filename must map to the record's own id. Rejects a hand-mangled
    // file whose name doesn't match its content — keeps a stray file from folding
    // into the wrong device.
    if (!base || base !== `${e.id}.json`) continue;
    const arr = groups.get(base) ?? [];
    arr.push(e);
    groups.set(base, arr);
  }
  const out: DeviceRecord[] = [];
  for (const arr of groups.values()) out.push(foldDeviceEntries(arr));
  return out;
}

// Locked read-modify-write on the CANONICAL `<id>.json`. The lock
// (mutateFileUnderLock) guards the SAME-DEVICE race (dev instance + built app
// writing this file concurrently) where there is no git conflict copy to fold.
// The callback may return null to SKIP the write (no-op — avoids watcher churn +
// a redundant push).
async function mutateCanonical(
  personalRoot: string, id: string,
  fn: (cur: DeviceRecord | null) => DeviceRecord | null,
): Promise<void> {
  if (!id || typeof id !== 'string') throw new Error(`device-registry: invalid id '${id}'`);
  const dir = registryDir(personalRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const committed = await mutateFileUnderLock(file, (onDisk) => {
    const cur = onDisk ? parseEntry(onDisk) : null;
    const next = fn(cur);
    return next === null ? null : JSON.stringify(next, null, 2) + '\n'; // null → skip write
  });
  if (!committed) throw new Error(`device-registry: could not write ${id} (lock timeout)`);
}

/** Heartbeat + create-if-absent for THIS device's own file. Absent → create with
 *  `name = name ?? os.hostname()` (a friendly default). Present → ALWAYS bump
 *  lastSeen, but only change `name` + bump `updatedAt` when a `name` arg is given
 *  AND actually differs — so a bare heartbeat never clobbers a newer synced name
 *  from another device nor churns updatedAt. `platform` is kept fresh from the arg. */
export function upsertSelf(
  personalRoot: string, input: { id: string; name?: string; platform: string },
): Promise<void> {
  return mutateCanonical(personalRoot, input.id, (cur) => {
    const now = Date.now();
    if (!cur) {
      return {
        schemaVersion: DEVICE_REGISTRY_SCHEMA,
        id: input.id,
        name: input.name ?? os.hostname(), // default friendly name
        platform: input.platform,
        lastSeen: now,
        updatedAt: now,
      };
    }
    // Only a provided-and-different name is a real rename.
    const nameChanged = input.name !== undefined && input.name !== cur.name;
    const next: DeviceRecord = {
      schemaVersion: DEVICE_REGISTRY_SCHEMA,
      id: cur.id,
      name: nameChanged ? input.name! : cur.name,
      platform: input.platform, // keep fresh
      lastSeen: now,            // liveness always advances
      updatedAt: nameChanged ? now : cur.updatedAt,
    };
    // Skip only if truly nothing changed (same-ms heartbeat with identical fields).
    if (next.name === cur.name && next.platform === cur.platform
      && next.lastSeen === cur.lastSeen && next.updatedAt === cur.updatedAt) return null;
    return next;
  });
}

/** Rename: set `name` + bump `updatedAt` (the LWW stamp), PRESERVE lastSeen /
 *  platform. Seeds a record (platform from process.platform, lastSeen = now) if
 *  somehow absent. Skips the write when the name already matches (no churn). */
export function renameDevice(personalRoot: string, id: string, name: string): Promise<void> {
  return mutateCanonical(personalRoot, id, (cur) => {
    // Refuse an empty name: empty names are rejected on read (parseEntry requires
    // a non-empty name), so writing one would silently disappear on the next read.
    if (!name.trim()) return null;
    if (cur && cur.name === name) return null; // no change — skip
    const now = Date.now();
    return {
      schemaVersion: DEVICE_REGISTRY_SCHEMA,
      id,
      name,
      platform: cur?.platform ?? process.platform,
      lastSeen: cur?.lastSeen ?? now,
      updatedAt: now,
    };
  });
}

/** Remove a device row entirely: the canonical `<id>.json` AND every conflict copy
 *  that folds into it.
 *
 *  Deleting the conflict copies is load-bearing, not tidiness: readDevices groups
 *  by extractConflictBase and only checks that the base matches the record's own
 *  id — it does NOT require the canonical file to exist. Leaving a copy behind
 *  keeps the device listed after a "remove".
 *
 *  Deliberately a plain delete, not a tombstone (unlike the Project Registry's
 *  stopped-dominates state). "Remove" means "forget this device"; a device that
 *  is still alive re-registering on its next launch is CORRECT. Only a device
 *  that never comes back — the case this exists for — stays gone.
 *
 *  Fail-soft: an unknown id or a missing dir is a silent no-op.
 *  Known race, accepted: a rename of this device on ANOTHER machine in the same
 *  sync window survives as a conflict copy created by a LATER merge (after this
 *  delete ran), which resurrects the row. Pressing Remove again heals it.
 *  Same-machine variant, also accepted: this deliberately does NOT take the
 *  mutateFileUnderLock lock, so a concurrent local write in flight (dev instance +
 *  built app) can re-create the file after we delete it — benign for the same
 *  reason, and it heals the same way. */
export async function removeDevice(personalRoot: string, id: string): Promise<void> {
  // Guard the empty id: `${''}.json` would match nothing here, but an empty id is
  // always a caller bug — surface it rather than silently no-op.
  if (!id || typeof id !== 'string') throw new Error(`device-registry: invalid id '${id}'`);
  const dir = registryDir(personalRoot);
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return; } // no dir — nothing to remove
  const targets = names.filter((n) => n.endsWith('.json')
    && (isConflictCopyName(n) ? extractConflictBase(n) : n) === `${id}.json`);
  // WHY: one surviving copy keeps the device listed, so a locked file (Windows
  // antivirus, a second app process) used to leave a "removed" device on
  // screen. Retry once, then fail honestly so the UI does not claim success.
  let left: string[] = targets;
  for (let attempt = 0; attempt < 2 && left.length; attempt++) {
    const failed: string[] = [];
    for (const n of left) {
      try { await fs.promises.rm(path.join(dir, n), { force: true }); } catch { failed.push(n); }
    }
    left = failed;
  }
  if (left.length) throw new Error(`device-registry: could not remove ${left.length} file(s) for ${id}`);
}
