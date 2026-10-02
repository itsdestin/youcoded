// Downloads the pinned Office add-on (itsdestin/youcoded-office, AGPL) into office-addon/ (dev),
// or, with --release, every arch pinned for this OS into office-build/<platform>-<arch>/.
// WHY at build and dev time, not first use: contract R2 — Office ships INSIDE the installer.
// WHY a separate program in a separate folder: the MIT app and the AGPL editors stay apart (R2).
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(here, '..');
const DEST = path.join(DESKTOP, 'office-addon');
// WHY a second folder for release builds (Task 9): one build machine can make installers for
// more than one platform — the Mac runner cuts both the Intel and the Apple-silicon dmg — and
// each must carry its own converter. electron-builder.yml takes each installer's add-on from
// office-build/${platform}-${arch}; office-addon/ stays the dev copy for this machine.
const RELEASE_DIR = path.join(DESKTOP, 'office-build');

// WHY Node's own platform and arch names (darwin, win32, x64, arm64): they are exactly what
// electron-builder's ${platform} and ${arch} expand to, so the pin's keys, the add-on's
// tarball names and the installer's resource folder all spell a platform the same way.
export function platformKey(platform = process.platform, arch = process.arch) {
  return ['linux', 'darwin', 'win32'].includes(platform) ? `${platform}-${arch}` : null;
}

/** The tar to unpack the add-on with.
 *  WHY not plain `tar` on Windows: a GitHub Windows runner (and many PCs) puts Git's GNU tar
 *  first on PATH, and GNU tar reads `C:\...` as host `C` and fails with "Cannot connect to C:
 *  resolve failed" (desktop-test-build run 36956706441). Windows' own tar (bsdtar, shipped in
 *  System32 since Windows 10 1803) takes drive-letter paths as files. */
export function tarCommand(platform = process.platform, env = process.env) {
  if (platform !== 'win32') return 'tar';
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe');
}

/** Where a release build puts `key`'s add-on (what electron-builder.yml's extraResources reads). */
export function releaseDest(key, root = RELEASE_DIR) {
  return path.join(root, key);
}

/** The pinned platforms a release build on `platform` installs: every arch pinned for this OS.
 *  WHY not just this machine's arch: see RELEASE_DIR. */
export function releaseKeys(pin, platform = process.platform) {
  return Object.keys(pin.platforms).filter((k) => k.startsWith(`${platform}-`)).sort();
}

export function planFetch(pin, manifest, key) {
  const entry = key && pin.platforms[key];
  if (!entry) return { action: 'unsupported' };
  if (manifest && manifest.version === pin.version) return { action: 'skip' };
  return { action: 'download', url: entry.url, sha256: entry.sha256 };
}

// WHY a pure function deciding exit codes, not inline process.exit() calls: 'ok' is always 0.
// 'unsupported' (no bundle is pinned for this platform) is always 0 too (Task 9): euro-office-lite
// publishes no converter for some platforms (ARM Linux), and those builds must still succeed —
// they ship without Office, and the app then opens Office files with the computer's default app.
// 'network-failed' is gated by --required: `dev:main` (no flag) must still start the app offline
// with Office reporting itself unavailable, while `build --required` (contract R2: Office ships
// INSIDE the installer of every platform that has a bundle) must fail loudly rather than silently
// ship without it. A checksum mismatch or extraction failure is neither: it means the download
// or the tarball itself is corrupt/tampered, which is a bug regardless of network state, so
// install() throws for those and the top-level catch always exits 1 — exitCodeFor is never
// consulted for them.
export function exitCodeFor(status, required) {
  if (status === 'ok' || status === 'unsupported') return 0;
  return required ? 1 : 0;
}

const STALE_STAGING_MS = 60 * 60 * 1000; // 1 hour

// WHY swept here, not left for each run to clean only its own pid's directory: a run killed
// mid-extraction (OOM, Ctrl-C, a killed CI job) never reaches its own `rm(staging)` cleanup,
// so that ~104MB directory would otherwise sit forever — nothing else is ever named after it.
// A directory is removed only when its pid is PROVABLY dead (process.kill(pid, 0) throws
// ESRCH) or it is simply old, never just because it isn't this run's own pid: two concurrent
// fetches (two worktrees, or a dev start racing a build) each get a distinct pid-suffixed
// staging directory, and one must never delete the other's still-extracting one.
export async function sweepStaleStaging(dest) {
  const dir = path.dirname(dest);
  const prefix = `${path.basename(dest)}.staging-`;
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return; // dest's parent doesn't exist yet (fresh checkout) — nothing to sweep
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = path.join(dir, name);
    const pid = Number(name.slice(prefix.length));
    let stale = !Number.isInteger(pid);
    if (!stale) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') stale = true; // no process has this pid — the run that made it is gone
      }
    }
    if (!stale) {
      const st = await stat(full).catch(() => null);
      if (!st || Date.now() - st.mtimeMs > STALE_STAGING_MS) stale = true;
    }
    if (stale) await rm(full, { recursive: true, force: true });
  }
}

// WHY staging + rm/rename, not extracting straight into DEST: a `tar` that dies partway
// (disk full, a killed build) used to leave office-addon/ holding SOME files with no correct
// manifest — the next run's officeAvailable() check then either wrongly reports available (a
// stale old manifest survives untouched) or leaves a half-installed folder with no way to
// know it's broken. Extracting into a sibling staging directory first, verifying its
// manifest.json matches the pinned version, THEN swapping (rm old DEST, rename staging over
// it) means any failure before the swap begins leaves DEST exactly as it was — either the
// previous complete install, or nothing. The swap itself is NOT atomic across its own two
// steps (rm, then rename): a crash in the narrow window between them leaves DEST absent
// rather than unchanged — the next run's planFetch then sees no manifest and re-downloads,
// which is safe (never a silently broken "unchanged" install) but is not a guarantee that
// DEST is untouched across every possible crash point.
export async function stageAndReplace({ dest, pin, extract }) {
  await sweepStaleStaging(dest);
  const staging = `${dest}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await extract(staging);
    const manifest = await readFile(path.join(staging, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
    if (!manifest || manifest.version !== pin.version) {
      throw new Error(`office add-on staged bundle missing manifest.json or wrong version (expected ${pin.version})`);
    }
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
}

// Installs `key`'s pinned bundle into `dest` (skipping it when the right version is there).
async function install(pin, key, dest) {
  const manifest = await readFile(path.join(dest, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
  const plan = planFetch(pin, manifest, key);
  const where = path.relative(DESKTOP, dest);

  if (plan.action === 'skip') {
    console.log(`office add-on ${pin.version} (${key}) present in ${where}/`);
    return 'ok';
  }
  if (plan.action === 'unsupported') {
    console.log(`office add-on: no bundle for ${key} — Office will say it is not available`);
    return 'unsupported';
  }

  // WHY caught here instead of left to the top-level catch: this is the ONE failure mode an
  // offline developer is expected to hit, and exitCodeFor needs it as a returned status (not a
  // throw) to apply the --required gate. Checksum and staging/extraction failures below are
  // NOT caught here — they always propagate and always exit 1, required or not.
  let buf;
  try {
    const res = await fetch(plan.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.log(`office add-on: download of ${key} failed (${e.message}) — Office will say it is not available`);
    return 'network-failed';
  }

  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== plan.sha256) throw new Error(`office add-on ${key} checksum mismatch: expected ${plan.sha256}, got ${got}`);

  // WHY the key in the temp name: a release build fetches two bundles one after the other.
  const tgz = path.join(os.tmpdir(), `youcoded-office-${pin.version}-${key}-${process.pid}.tar.gz`);
  await writeFile(tgz, buf);
  try {
    await mkdir(path.dirname(dest), { recursive: true });
    await stageAndReplace({
      dest,
      pin,
      extract: (stagingDir) => promisify(execFile)(tarCommand(), ['-xzf', tgz, '-C', stagingDir]),
    });
  } finally {
    await rm(tgz, { force: true });
  }
  console.log(`office add-on ${pin.version} (${key}) installed in ${where}/`);
  return 'ok';
}

async function main({ required, release }) {
  const pin = JSON.parse(await readFile(path.join(DESKTOP, 'office-pin.json'), 'utf8'));
  if (!release) return install(pin, platformKey(), DEST);
  const keys = releaseKeys(pin);
  if (keys.length === 0) {
    console.log(`office add-on: no bundle pinned for ${process.platform} — this build ships without Office`);
    return 'unsupported';
  }
  // WHY one at a time, worst status wins: a release must not ship one arch with Office and
  // quietly drop it from the other.
  let status = 'ok';
  for (const key of keys) {
    const s = await install(pin, key, releaseDest(key));
    if (s !== 'ok') status = s;
  }
  return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // WHY --required only on `build`: contract R2 says a release must never silently ship
  // without Office; `dev:main` omits it so starting the app offline still works.
  // WHY --release on `build`: it fills office-build/<platform>-<arch>/ for every arch pinned
  // for this OS (the installers' copies) instead of this machine's office-addon/ dev copy.
  const required = process.argv.includes('--required');
  const release = process.argv.includes('--release');
  main({ required, release })
    .then((status) => process.exit(exitCodeFor(status, required)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
