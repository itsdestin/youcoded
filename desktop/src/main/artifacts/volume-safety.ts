// volume-safety.ts — "is this file on a disk we can trust to tell us the truth about missing files?"
// Used by sidecar-cleanup.ts. The cleanup archives history for files it judges gone; a file that is "missing"
// only because a USB drive is unplugged, a network share is offline or a cloud folder is not synced is NOT
// gone. Owner decision (2026-11-17): "The cleanup never touches projects on drives that are missing or
// removable". So the rule is CONSERVATIVE: only a path positively shown to be on a fixed, local, internal
// disk passes. Anything we cannot tell (a command fails, an odd filesystem, a missing drive) is "not safe".
//
// Cheap on purpose: reads /proc and /sys on Linux; one small `diskutil`/`df` on macOS and one PowerShell query
// on Windows, each at most once per volume per process (cached). It only ever runs inside the daily background
// cleanup pass, never on a hot path, and uses async child processes so the main thread never blocks.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

export type Verdict = { safe: true } | { safe: false; reason: string };
const no = (reason: string): Verdict => ({ safe: false, reason });
const yes: Verdict = { safe: true };

// ---------------------------------------------------------------------------
// 1. Cloud-sync folders (any platform): files there can be online-only or not yet synced.
// ---------------------------------------------------------------------------
const CLOUD_PREFIXES = ['onedrive', 'dropbox', 'icloud'];
const CLOUD_EXACT = new Set([
  'mobile documents',   // macOS iCloud Drive's real folder
  'cloudstorage',       // macOS ~/Library/CloudStorage (OneDrive, Google Drive, Dropbox, Box ...)
  'google drive', 'googledrive', 'my drive',
  'box', 'box sync', 'pcloud', 'pcloud drive', 'nextcloud', 'mega', 'megasync', 'sync.com',
]);

/** True when any folder name along the path is a known cloud-sync folder. Pure. */
export function isCloudSyncPath(p: string): boolean {
  return p.split(/[\\/]+/).some((seg) => {
    const s = seg.toLowerCase();
    return !!s && (CLOUD_EXACT.has(s) || CLOUD_PREFIXES.some((pre) => s.startsWith(pre)));
  });
}

// ---------------------------------------------------------------------------
// 2. Per-platform decisions. Each is pure (facts in, verdict out) so tests can feed it mocked facts.
// ---------------------------------------------------------------------------

/** Linux: what the kernel says about the mount holding the path. */
export interface LinuxMountFacts {
  mountPoint: string;
  fsType: string;
  /** The mount's source, e.g. /dev/nvme0n1p2, //server/share, pool/dataset. */
  source: string;
  /** Facts about the block device under it, when the source is a /dev node we could follow; null = could not tell. */
  device: LinuxDeviceFacts | null;
}
export interface LinuxDeviceFacts {
  /** The device's realpath under /sys (reveals the bus: .../usb2/..., .../mmc_host/..., .../virtual/...). */
  sysPath: string;
  /** Contents of the whole disk's `removable` file ("0" / "1"), or null when unreadable. */
  removable: string | null;
  /** For device-mapper / RAID: the devices underneath (each judged the same way). */
  slaves: LinuxDeviceFacts[];
}

const LINUX_FIXED_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'jfs', 'reiserfs', 'ntfs3', 'ntfs', 'vfat', 'exfat']);
/** Mount parents where removable media / network shares land: a path under one that is NOT its own mount is an
 *  unplugged drive's empty stub folder. */
const LINUX_MEDIA_PARENTS = [/^\/media\/[^/]+/, /^\/run\/media\/[^/]+\/[^/]+/, /^\/mnt\/[^/]+/, /^\/net\/[^/]+/, /^\/misc\/[^/]+/];

function deviceVerdict(d: LinuxDeviceFacts | null, depth = 0): Verdict {
  if (!d) return no('could not identify the disk under this folder');
  if (depth > 4) return no('disk stack too deep to check');
  const sp = d.sysPath;
  if (/\/usb\d*\//.test(sp) || sp.includes('/usb')) return no('on a USB disk');
  if (sp.includes('/mmc') || sp.includes('/mmc_host')) return no('on an SD or memory card');
  if (sp.includes('/ieee1394') || sp.includes('/firewire')) return no('on a FireWire disk');
  if (d.slaves.length > 0) {
    for (const s of d.slaves) { const v = deviceVerdict(s, depth + 1); if (!v.safe) return v; }
    return yes;
  }
  if (sp.includes('/virtual/')) return no('on a virtual or loop device');
  if (!sp.startsWith('/sys/devices/')) return no('not a recognised internal disk');
  if (d.removable !== '0') return no('on a removable disk');
  return yes;
}

/** Decide for a Linux mount. `pathUnderMountParent` = the path sits in /media, /mnt ... but its mount is "/" or
 *  some other mount that is not that folder (an unplugged drive's leftover folder). */
export function judgeLinuxMount(facts: LinuxMountFacts | null, targetPath: string): Verdict {
  if (!facts) return no('could not read the mount table');
  for (const re of LINUX_MEDIA_PARENTS) {
    const m = re.exec(targetPath);
    if (m && !(facts.mountPoint === m[0] || facts.mountPoint.startsWith(m[0] + '/'))) {
      return no('in a drive folder that is not mounted right now');
    }
  }
  if (!LINUX_FIXED_FS.has(facts.fsType)) return no(`filesystem type "${facts.fsType}" is not a plain local disk`);
  if (!facts.source.startsWith('/dev/')) return no('not backed by a local disk device');
  return deviceVerdict(facts.device);
}

/** macOS: the parts of `diskutil info -plist <mountpoint>` we trust, plus the mount point `df` gave. */
export interface MacVolumeFacts {
  mountPoint: string;
  /** null = diskutil failed (network share, unmounted, odd volume): not safe. */
  info: { internal: boolean; removableMedia: boolean; ejectable: boolean; network: boolean } | null;
}
export function judgeMacVolume(facts: MacVolumeFacts | null, targetPath: string): Verdict {
  if (!facts) return no('could not identify the volume');
  // An unplugged drive leaves /Volumes/<name> missing, so the nearest folder that exists is /Volumes itself,
  // which lives on the startup disk and would look perfectly fine.
  const vol = /^\/Volumes\/[^/]+/.exec(targetPath);
  if (vol && !(facts.mountPoint === vol[0] || facts.mountPoint.startsWith(vol[0] + '/'))) return no('in a drive folder that is not mounted right now');
  const i = facts.info;
  if (!i) return no('could not read the volume details');
  if (i.network) return no('a network volume');
  if (!i.internal) return no('on an external drive');
  if (i.removableMedia || i.ejectable) return no('on a removable drive');
  return yes;
}

/** Windows: what the drive reports. */
export interface WindowsDriveFacts {
  letter: string;
  /** Win32_LogicalDisk.DriveType: 2 removable, 3 fixed, 4 network, 5 optical, 6 RAM disk. null = query failed / drive absent. */
  driveType: number | null;
  /** Get-Disk BusType name (SATA, NVMe, USB, ...); '' when unknown. */
  busType: string;
}
// WHY a bus allow-list: a USB hard drive reports "fixed" (3) to Windows, so the type alone cannot tell it from
// the internal disk. Only buses that are inside the machine pass.
const WINDOWS_INTERNAL_BUSES = new Set(['sata', 'ata', 'nvme', 'sas', 'scsi', 'raid']);
export function judgeWindowsDrive(facts: WindowsDriveFacts | null, targetPath: string): Verdict {
  if (/^[\\/]{2}/.test(targetPath)) return no('a network (UNC) path');
  if (!facts || facts.driveType === null) return no('the drive is missing or could not be checked');
  if (facts.driveType !== 3) return no('a removable, network or optical drive');
  if (!WINDOWS_INTERNAL_BUSES.has(facts.busType.toLowerCase())) return no(`the drive is not known to be internal (${facts.busType || 'unknown connection'})`);
  return yes;
}

// ---------------------------------------------------------------------------
// 3. Gathering the facts (injectable so tests never touch the real machine)
// ---------------------------------------------------------------------------
export interface VolumeDeps {
  platform: NodeJS.Platform;
  realpath(p: string): Promise<string>;
  isDir(p: string): Promise<boolean>;
  readText(p: string): Promise<string | null>;
  readDir(p: string): Promise<string[]>;
  run(cmd: string, args: string[]): Promise<string | null>;
  /** Per-pass memo for the slow queries (diskutil per mount, PowerShell per drive letter). */
  memo?: Map<string, Promise<unknown>>;
}
const memoized = <T>(deps: VolumeDeps, key: string, make: () => Promise<T>): Promise<T> => {
  if (!deps.memo) return make();
  let hit = deps.memo.get(key) as Promise<T> | undefined;
  if (!hit) { hit = make(); deps.memo.set(key, hit); }
  return hit;
};

const realDeps = (): VolumeDeps => ({
  platform: process.platform,
  realpath: (p) => fs.promises.realpath(p),
  isDir: (p) => fs.promises.stat(p).then((s) => s.isDirectory(), () => false),
  readText: (p) => fs.promises.readFile(p, 'utf8').catch(() => null),
  readDir: (p) => fs.promises.readdir(p).catch(() => []),
  run: (cmd, args) => new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch { resolve(null); }
  }),
});

/** The nearest folder that exists at or above `p` (realpath'd), or null when none does (a drive that is gone). */
async function nearestExisting(p: string, deps: VolumeDeps): Promise<string | null> {
  let cur = p;
  for (let i = 0; i < 256; i++) {
    if (await deps.isDir(cur)) return deps.realpath(cur).catch(() => cur);
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

const unescapeMountField = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

async function sysDeviceFacts(deps: VolumeDeps, sysClassName: string, depth = 0): Promise<LinuxDeviceFacts | null> {
  if (depth > 4) return null;
  let sysPath: string;
  try { sysPath = await deps.realpath(`/sys/class/block/${sysClassName}`); } catch { return null; }
  // A partition's `removable` lives on its parent disk.
  const isPartition = (await deps.readText(`${sysPath}/partition`)) !== null;
  const diskPath = isPartition ? path.posix.dirname(sysPath) : sysPath;
  const removable = ((await deps.readText(`${diskPath}/removable`)) ?? '').trim() || null;
  const slaveNames = await deps.readDir(`${sysPath}/slaves`);
  const slaves: LinuxDeviceFacts[] = [];
  for (const n of slaveNames) {
    const f = await sysDeviceFacts(deps, n, depth + 1);
    if (!f) return null;   // a layer we cannot see: the whole stack is unknown
    slaves.push(f);
  }
  return { sysPath, removable, slaves };
}

async function linuxFacts(existing: string, deps: VolumeDeps): Promise<LinuxMountFacts | null> {
  const text = await deps.readText('/proc/self/mountinfo');
  if (!text) return null;
  let best: { mountPoint: string; fsType: string; source: string } | null = null;
  for (const line of text.split('\n')) {
    // id parent maj:min root mountpoint opts [optional fields] - fstype source superopts
    const parts = line.split(' ');
    const dash = parts.indexOf('-');
    if (dash < 6 || parts.length < dash + 3) continue;
    const mountPoint = unescapeMountField(parts[4]);
    const under = mountPoint === '/' || existing === mountPoint || existing.startsWith(mountPoint + '/');
    if (!under) continue;
    // The longest mount point wins; of equal ones the later line (what is on top).
    if (!best || mountPoint.length >= best.mountPoint.length) best = { mountPoint, fsType: parts[dash + 1], source: unescapeMountField(parts[dash + 2]) };
  }
  if (!best) return null;
  let device: LinuxDeviceFacts | null = null;
  if (best.source.startsWith('/dev/')) {
    const real = await deps.realpath(best.source).catch(() => best!.source);   // /dev/mapper/x -> /dev/dm-0
    device = await sysDeviceFacts(deps, path.posix.basename(real));
  }
  return { ...best, device };
}

function parsePlistBool(xml: string, key: string): boolean | null {
  const m = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`).exec(xml);
  return m ? m[1] === 'true' : null;
}

async function macFacts(existing: string, deps: VolumeDeps): Promise<MacVolumeFacts | null> {
  const df = await deps.run('/bin/df', ['-P', existing]);
  const last = df?.trim().split('\n').pop() ?? '';
  const m = /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.*)$/.exec(last);
  if (!m) return null;
  const mountPoint = m[1];
  const xml = await memoized(deps, `mac:${mountPoint}`, () => deps.run('/usr/sbin/diskutil', ['info', '-plist', mountPoint]));
  if (!xml) return { mountPoint, info: null };
  const internal = parsePlistBool(xml, 'Internal');
  const removableMedia = parsePlistBool(xml, 'RemovableMediaOrExternalDevice');
  const ejectable = parsePlistBool(xml, 'Ejectable');
  // A fact diskutil did not state is a fact we do not have: treat the volume as unknown.
  if (internal === null) return { mountPoint, info: null };
  return { mountPoint, info: { internal, removableMedia: removableMedia ?? true, ejectable: ejectable ?? false, network: /<key>NetworkVolume<\/key>\s*<true/.test(xml) } };
}

async function windowsFacts(letter: string, deps: VolumeDeps): Promise<WindowsDriveFacts> {
  // `letter` is one validated A-Z character, so nothing is injected into the script.
  const script = `$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'"; $b=''; try{$b=(Get-Partition -DriveLetter ${letter} -ErrorAction Stop|Get-Disk -ErrorAction Stop).BusType}catch{}; "$($d.DriveType)|$b"`;
  const out = await deps.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const m = out ? /^(\d*)\|(.*)$/m.exec(out.trim()) : null;
  if (!m || m[1] === '') return { letter, driveType: null, busType: '' };
  return { letter, driveType: Number(m[1]), busType: m[2].trim() };
}

/** Full verdict for one path. Never throws; anything unexpected is "not safe". */
export async function judgePathVolume(target: string, deps: VolumeDeps = realDeps()): Promise<Verdict> {
  try {
    if (isCloudSyncPath(target)) return no('inside a cloud-sync folder');
    if (deps.platform === 'win32') {
      const letter = /^([A-Za-z]):[\\/]/.exec(target)?.[1];
      if (!letter) return no('a network (UNC) path or an unrecognised drive');
      const L = letter.toUpperCase();
      return judgeWindowsDrive(await memoized(deps, `win:${L}`, () => windowsFacts(L, deps)), target);
    }
    const existing = await nearestExisting(target, deps);
    if (!existing) return no('the drive is missing');
    // A symlink may lead onto another disk: judge where the files really live (and re-check for cloud folders).
    if (isCloudSyncPath(existing)) return no('inside a cloud-sync folder');
    if (deps.platform === 'linux') return judgeLinuxMount(await linuxFacts(existing, deps), target);
    if (deps.platform === 'darwin') return judgeMacVolume(await macFacts(existing, deps), target);
    return no('unsupported platform');
  } catch (e) {
    return no(`volume check failed: ${String((e as Error)?.message ?? e)}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Cached front door for the cleanup pass
// ---------------------------------------------------------------------------
/** Memoises per run: callers pass a fresh cache each pass so an unplugged-then-replugged drive is looked at again. */
export function makeVolumeChecker(baseDeps?: VolumeDeps): (target: string) => Promise<Verdict> {
  const deps: VolumeDeps = { ...(baseDeps ?? realDeps()), memo: new Map() };
  const cache = new Map<string, Promise<Verdict>>();
  return (target) => {
    // One lookup per containing folder: thousands of records share a handful of folders.
    const key = path.dirname(target);
    let hit = cache.get(key);
    if (!hit) { hit = judgePathVolume(key, deps); cache.set(key, hit); }
    return hit;
  };
}
