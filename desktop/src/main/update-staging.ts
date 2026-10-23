// update-staging.ts — turn a verified download into something a quit or restart can install with
// one instant step (design rev 4 "staging moves to download time").
//
// WHY at download time: the exit hook may only do instant work, so everything slow — mounting the
// Mac disk image, copying 180 MB, hashing it again — happens here, right after the download
// verifies, in the background. Every command is injected so the Mac path (no Mac in this workspace)
// is pinned by argv on any runner. Everything is async.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { UpdateInstallError } from './update-installer';

interface RunResult { code: number | null; stdout: string; stderr: string }
export type RunCommand = (cmd: string, args: string[]) => Promise<RunResult>;

/** WHY a limit on every command (review of T2): a wedged disk image or a codesign stuck on a network
 *  volume would otherwise hold the single download slot forever. Attach/ditto copy ~180 MB, codesign
 *  walks the whole bundle, detach should be instant. */
export function commandTimeoutMs(cmd: string, args: string[]): number {
  if (cmd === 'codesign') return 2 * 60_000;
  if (cmd === 'hdiutil' && args[0] === 'detach') return 30_000;
  return 5 * 60_000; // hdiutil attach, ditto
}

/** Run one command with a time limit; never rejects. A timeout is a failure (code 1) with a stderr that says so. */
export function runWithTimeout(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      const timedOut = !!err && (err as { killed?: boolean }).killed === true;
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: timedOut ? `timed out after ${timeoutMs} ms\n${stderr ?? ''}` : String(stderr ?? '') });
    });
  });
}

/** Production runner. */
export const runCommand: RunCommand = (cmd, args) => runWithTimeout(cmd, args, commandTimeoutMs(cmd, args));

const SAFE_VERSION = /^[0-9A-Za-z.+-]+$/;
function assertSafeVersion(version: string): void {
  if (!SAFE_VERSION.test(version)) throw new UpdateInstallError('verify-failed', `unsafe version for a staging name: ${version}`);
}

/** Staged names are DERIVED here and re-validated here; a name read from disk is never trusted as a path. */
const APPIMAGE_NAME = /^\.YouCoded-update-[0-9A-Za-z.+-]+\.AppImage$/;
const MAC_USER_NAME = /^\.YouCoded-update-[0-9A-Za-z.+-]+\.app$/;
const MAC_TMP_NAME = /^youcoded-update-[0-9A-Za-z.+-]+$/;
export function isValidStagedName(name: unknown): name is string {
  return typeof name === 'string' && (APPIMAGE_NAME.test(name) || MAC_USER_NAME.test(name) || MAC_TMP_NAME.test(name));
}

export interface StagedPathContext {
  platform: NodeJS.Platform;
  runningAppImage?: string;
  /** The running `.app` bundle (macOS). */
  runningBundle?: string;
  tmpDir?: string;
}

/** Where a staged name lives, or null when this platform cannot have one. The only path builder. */
export function stagedPathFor(stagedName: string, ctx: StagedPathContext): string | null {
  if (!isValidStagedName(stagedName)) return null;
  if (ctx.platform === 'linux' && APPIMAGE_NAME.test(stagedName) && ctx.runningAppImage) {
    return path.join(path.dirname(ctx.runningAppImage), stagedName);
  }
  if (ctx.platform === 'darwin') {
    if (MAC_USER_NAME.test(stagedName) && ctx.runningBundle) return path.join(path.dirname(ctx.runningBundle), stagedName);
    if (MAC_TMP_NAME.test(stagedName)) return path.join(ctx.tmpDir ?? os.tmpdir(), stagedName, 'YouCoded.app');
  }
  return null;
}

// ─── Linux AppImage ─────────────────────────────────────────────────────────

export interface AppImageStageInput {
  filePath: string;
  runningAppImage: string;
  version: string;
  /** The signed file's hash for this asset: the copy must match it byte for byte. */
  expectedSha256: string;
  hashFile: (p: string) => Promise<string>;
}

/** Copy the verified AppImage to a hidden file beside the running one and re-hash the copy.
 *  Same folder = same file system, so the quit-time `rename` over the running image is atomic and
 *  instant (design D20). Returns the staged NAME. */
export async function stageAppImage(input: AppImageStageInput): Promise<string> {
  assertSafeVersion(input.version);
  const name = `.YouCoded-update-${input.version}.AppImage`;
  const finalPath = path.join(path.dirname(input.runningAppImage), name);
  const tmpPath = finalPath + '.partial';
  try {
    await fs.promises.copyFile(input.filePath, tmpPath);
    await fs.promises.chmod(tmpPath, 0o755);
    // WHY re-hash: a copy onto another disk is where a flipped bit or a full disk shows up, and this
    // is the last look before a file replaces the running app.
    const actual = await input.hashFile(tmpPath);
    if (actual.toLowerCase() !== input.expectedSha256.toLowerCase()) {
      throw new UpdateInstallError('verify-failed', 'staged copy hash mismatch');
    }
    await fs.promises.rename(tmpPath, finalPath);
  } catch (e) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    if (e instanceof UpdateInstallError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC') throw new UpdateInstallError('disk-full', String(e));
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new UpdateInstallError('appimage-not-writable', String(e));
    throw new UpdateInstallError('spawn-failed', String(e));
  }
  return name;
}

// ─── macOS ──────────────────────────────────────────────────────────────────

export interface MacStageInput {
  dmgPath: string;
  version: string;
  runningBundle: string;
  /** True when the bundle or its folder is not writable: stage in a private temp folder instead. */
  needsPassword: boolean;
  tmpDir?: string;
  run: RunCommand;
}

/** Pull the `designated => …` requirement out of `codesign -d -r-` output (it may arrive on either stream). */
export function parseDesignatedRequirement(output: string): string | null {
  // `codesign -d -r-` prints the requirement as `designated => …` on some macOS versions and `# designated => …` on others
  const m = /^(?:# )?designated => (.+)$/m.exec(output);
  return m ? m[1].trim() : null;
}

/**
 * Mount the disk image read-only and invisible, copy the app out, unmount, and check that the copy
 * is signed by the SAME identity as the running app. Returns the staged NAME.
 *
 * WHY the running app's own designated requirement and not just "is validly signed": anyone can
 * sign an app; only ours satisfies the requirement our own bundle was built to. That is what makes a
 * swapped-in app fail here instead of being installed (design E6).
 */
export async function stageMacApp(input: MacStageInput): Promise<string> {
  assertSafeVersion(input.version);
  const tmpDir = input.tmpDir ?? os.tmpdir();
  // WHY beside the bundle whenever the user can write there (review): then the helper's two moves are renames
  // on one volume and the gap where the bundle path is missing is microseconds. Only the password case stages
  // in $TMPDIR (the bundle's folder is not ours to write), where the move can be a copy; update-exit.ts's helper
  // restores a lone `.bak` on its next run if that copy is ever interrupted.
  const stagedName = input.needsPassword ? `youcoded-update-${input.version}` : `.YouCoded-update-${input.version}.app`;
  const stagedApp = stagedPathFor(stagedName, { platform: 'darwin', runningBundle: input.runningBundle, tmpDir })!;
  const mountPoint = await fs.promises.mkdtemp(path.join(tmpDir, 'youcoded-mount-'));
  let attached = false;
  try {
    const attach = await input.run('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mountPoint, input.dmgPath]);
    if (attach.code !== 0) throw new UpdateInstallError('dmg-corrupt', attach.stderr.slice(0, 300));
    attached = true;
    const apps = (await fs.promises.readdir(mountPoint)).filter((n) => n.endsWith('.app'));
    const source = apps.includes('YouCoded.app') ? 'YouCoded.app' : apps[0];
    if (!source) throw new UpdateInstallError('dmg-corrupt', 'no app inside the disk image');

    // Private folder first (mode 700) for the password case: another user must not be able to swap
    // the staged copy between our check and the administrator-run move (design E5).
    if (input.needsPassword) {
      const folder = path.dirname(stagedApp);
      await fs.promises.rm(folder, { recursive: true, force: true });
      await fs.promises.mkdir(folder, { mode: 0o700 });
      await fs.promises.chmod(folder, 0o700);
    } else {
      await fs.promises.rm(stagedApp, { recursive: true, force: true });
    }
    const copy = await input.run('ditto', [path.join(mountPoint, source), stagedApp]);
    if (copy.code !== 0) throw new UpdateInstallError('spawn-failed', `ditto failed: ${copy.stderr.slice(0, 300)}`);
  } catch (e) {
    await removeStaged(stagedApp, input.needsPassword);
    throw e;
  } finally {
    if (attached) {
      const det = await input.run('hdiutil', ['detach', mountPoint]);
      if (det.code !== 0) await input.run('hdiutil', ['detach', '-force', mountPoint]);
    }
    // rmdir, never rm -r: if the image failed to detach this must not reach into its contents.
    await fs.promises.rmdir(mountPoint).catch(() => {});
  }

  try {
    const req = await input.run('codesign', ['-d', '-r-', input.runningBundle]);
    const requirement = parseDesignatedRequirement(req.stdout + '\n' + req.stderr);
    if (!requirement) throw new UpdateInstallError('verify-failed', 'could not read the running app\'s signing requirement');
    const check = await input.run('codesign', ['--verify', '--deep', '--strict', `-R=${requirement}`, stagedApp]);
    if (check.code !== 0) throw new UpdateInstallError('verify-failed', `staged app failed the signature check: ${check.stderr.slice(0, 300)}`);
  } catch (e) {
    await removeStaged(stagedApp, input.needsPassword);
    throw e;
  }
  return stagedName;
}

async function removeStaged(stagedApp: string, inPrivateFolder: boolean): Promise<void> {
  await fs.promises.rm(inPrivateFolder ? path.dirname(stagedApp) : stagedApp, { recursive: true, force: true }).catch(() => {});
}

/** Remove a staged update by name. Used when a newer release replaces it or pending is cleared. */
export async function removeStagedByName(stagedName: string, ctx: StagedPathContext): Promise<void> {
  const p = stagedPathFor(stagedName, ctx);
  if (!p) return;
  await removeStaged(p, MAC_TMP_NAME.test(stagedName));
}

/** Startup sweep of staging leftovers (a crash mid-copy), except the one `keep` names. */
export async function sweepStaging(ctx: StagedPathContext, keep: ReadonlySet<string>): Promise<void> {
  const dirs: string[] = [];
  if (ctx.platform === 'linux' && ctx.runningAppImage) dirs.push(path.dirname(ctx.runningAppImage));
  if (ctx.platform === 'darwin') {
    if (ctx.runningBundle) dirs.push(path.dirname(ctx.runningBundle));
    dirs.push(ctx.tmpDir ?? os.tmpdir());
  }
  for (const dir of dirs) {
    let entries: string[];
    try { entries = await fs.promises.readdir(dir); } catch { continue; }
    for (const entry of entries) {
      if (keep.has(entry)) continue;
      const isStaging = entry.startsWith('.YouCoded-update-') || entry.startsWith('youcoded-update-');
      if (isStaging) await fs.promises.rm(path.join(dir, entry), { recursive: true, force: true }).catch(() => {});
      else if (entry.startsWith('youcoded-mount-')) await fs.promises.rmdir(path.join(dir, entry)).catch(() => {});
    }
  }
}
