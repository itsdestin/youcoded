// Spec §11: once per day, copy ALL synced spaces to each configured Drive /
// iCloud backend into a dated folder, then prune by age. Runs ALONGSIDE the
// legacy backup in 1a (legacy is untouched until conversations move in Phase 2).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DEFAULT_IGNORES, isIgnoredPath } from './guards';
import type { SyncSpace } from './types';
import { extractStderr } from '../sync-error-classifier';

const execFileAsync = promisify(execFile);
const RCLONE_TIMEOUT = 10 * 60 * 1000;

// ---- pure helpers (unit-tested) ----
export function datedFolderName(now: Date): string { return now.toISOString().slice(0, 10); }

export function isBackupDue(markerContent: string | null, now: Date): boolean {
  return markerContent !== datedFolderName(now);
}

export function foldersToPrune(names: string[], now: Date, keepDays: number): string[] {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  const dated = names.filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n));
  // WHY: the newest snapshot is the last known-good copy — kept past any age.
  const newest = dated.reduce((a, b) => (a > b ? a : b), '');
  return dated.filter(n => n !== newest && new Date(`${n}T00:00:00Z`).getTime() < cutoff);
}

async function rootExists(root: string): Promise<boolean> {
  try { return (await fs.promises.stat(root)).isDirectory(); } catch { return false; }
}

// ---- job ----
export interface BackupTarget {
  type: 'drive' | 'icloud';
  /** drive: rclone remote+root e.g. "gdrive:Claude"; icloud: absolute folder path */
  base: string;
}

/** What a run did, for a caller that must report it honestly ("Back up now"). */
export interface BackupRunResult {
  /** True when every destination received every space (a skipped, missing folder is not a failure). */
  ok: boolean;
  /** One entry per space copy that failed, with the tool's own words (classified by the caller). */
  failures: { target: BackupTarget; message: string }[];
}

export class DailyBackup {
  private markerPath: string;
  // Today's finished work: `copy|<type>|<base>|<space id>` and `prune|<type>|<base>`.
  // WHY in memory: a failed copy retries next hour without redoing the copies
  // that worked; a restart mid-day only costs a re-copy. The marker file still
  // closes the day, and only once every copy landed.
  private done = new Set<string>();
  private doneDate = '';
  // WHY one "active run" (backup fixes 2026-11-18, D-11): the hourly timer had no re-entry guard, so a first
  // big upload (over an hour) was started a second time on top of itself, and "Back up now" would have been a
  // third. Every run — timer or manual — is chained here: the timer skips its tick while anything is running;
  // a manual run waits its turn and then runs, so two copies of the same spaces never overlap.
  private active: Promise<void> | null = null;
  // Manual runs waiting or running, by destination set: a second tap on the same button joins the first.
  private manualRuns = new Map<string, Promise<BackupRunResult>>();

  // Destinations being copied to right now (`<type>|<base>`), for the "a backup copy is running" signal. WHY here: this
  // job runs outside the settings push's lock, so nothing else knows a conversations copy is under way (backup fixes
  // 2026-11-18, B-1).
  private copying = new Map<string, number>();

  /** Destinations (`<type>|<base>`) a copy is running to at this moment. */
  copyingTargets(): string[] { return [...this.copying.keys()]; }

  constructor(opts?: { markerPath?: string }) {
    this.markerPath = opts?.markerPath ?? path.join(os.homedir(), '.claude', '.spaces-backup-marker');
  }

  private track<T>(p: Promise<T>): Promise<T> {
    // The clean-up rides the SAME promise the caller awaits, so by the time a caller resumes, the run is
    // already off the books (a follow-up call is never refused for a run that has just ended).
    let tail: Promise<void>;
    const guarded = p.finally(() => { if (this.active === tail) this.active = null; });
    tail = guarded.then(() => {}, () => {});
    this.active = tail;
    return guarded;
  }

  /** Call from an hourly timer; no-ops until a new UTC day. Never throws. */
  async runIfDue(spaces: SyncSpace[], targets: BackupTarget[], log: (msg: string) => void): Promise<void> {
    if (this.active) { log('spaces-backup: a backup is already running; this check is skipped'); return; }
    await this.track(this.runIfDueInner(spaces, targets, log));
  }

  /**
   * Copy every space to the given destinations NOW, whatever today's marker says ("Back up now" /
   * "Upload now"). WHY (backup fixes 2026-11-18): the button only ran the settings-and-skills half, so
   * conversations and project files were left for the next day's timer while the screen said "finished".
   *
   * It never writes the day's marker: the caller may have named only one destination, and a one-destination
   * run must not close the day for the others. What it copies is remembered, so the next hourly check only
   * finishes the rest and writes the marker. Destinations are used as given — a paused one the person asked
   * for by name is included (the timer's own list leaves paused ones out).
   */
  runNow(spaces: SyncSpace[], targets: BackupTarget[], log: (msg: string) => void): Promise<BackupRunResult> {
    const key = targets.map((t) => `${t.type}|${t.base}`).join(';');
    const joined = this.manualRuns.get(key);
    if (joined) return joined;
    const before = this.active;
    const run = (async (): Promise<BackupRunResult> => {
      try {
        if (before) await before;
        return await this.copyAll(spaces, targets, log, true);
      }
      catch (e: any) { return { ok: false, failures: targets.map((t) => ({ target: t, message: String(e?.message ?? e) })) }; }
      finally { this.manualRuns.delete(key); }
    })();
    this.manualRuns.set(key, run);
    return this.track(run);
  }

  private async runIfDueInner(spaces: SyncSpace[], targets: BackupTarget[], log: (msg: string) => void): Promise<void> {
    let marker: string | null = null;
    try { marker = (await fs.promises.readFile(this.markerPath, 'utf8')).trim(); } catch { /* first run */ } // benign: no marker file just means the first day
    const now = new Date();
    if (!isBackupDue(marker, now) || targets.length === 0) return;
    const dated = datedFolderName(now);
    const { ok } = await this.copyAll(spaces, targets, log, false);
    if (!ok) {
      log(`spaces-backup incomplete for ${dated}; failed copies retry next hour`);
      return;
    }
    // Guarded so runIfDue honors its "never throws" contract — a missing or
    // read-only ~/.claude must not become an unhandled rejection in the timer.
    try { await fs.promises.writeFile(this.markerPath, dated); }
    catch (e: any) { log(`spaces-backup: could not write marker: ${String(e?.message ?? e)}`); }
    log(`spaces-backup completed for ${dated} (${spaces.length} spaces, ${targets.length} targets)`);
  }

  /** The copy-and-prune pass shared by the timer and "Back up now". `force` re-copies what today already did. */
  private async copyAll(spaces: SyncSpace[], targets: BackupTarget[], log: (msg: string) => void, force: boolean): Promise<BackupRunResult> {
    const now = new Date();
    const dated = datedFolderName(now);
    if (this.doneDate !== dated) { this.done.clear(); this.doneDate = dated; }
    const failures: BackupRunResult['failures'] = [];
    for (const target of targets) {
      const where = `${target.type}|${target.base}`;
      this.copying.set(where, (this.copying.get(where) ?? 0) + 1);
      try { await this.copyOne(target, where, spaces, dated, now, force, failures, log); } finally {
        const n = (this.copying.get(where) ?? 1) - 1;
        if (n <= 0) this.copying.delete(where); else this.copying.set(where, n);
      }
    }
    return { ok: failures.length === 0, failures };
  }

  /** One destination's share of copyAll: every space, then (only if all landed) the prune. */
  private async copyOne(target: BackupTarget, where: string, spaces: SyncSpace[], dated: string, now: Date, force: boolean, failures: BackupRunResult['failures'], log: (msg: string) => void): Promise<void> {
    let landed = true;
    for (const space of spaces) {
      const key = `copy|${where}|${space.id}`;
      if (!force && this.done.has(key)) continue;
      // WHY (backup fixes 2026-11-18, D-7): one space whose folder is gone (a project deleted on this
      // device) failed the copy every hour, so the destination never pruned and the day never closed.
      // A folder that is not there has nothing to back up: say so in the log and carry on.
      if (!(await rootExists(space.root))) { log(`spaces-backup: skipping ${space.id} — its folder is missing (${space.root})`); continue; }
      try { await this.copySpace(space, target, dated); this.done.add(key); }
      catch (e: any) {
        landed = false;
        failures.push({ target, message: extractStderr(e, RCLONE_TIMEOUT) || String(e) });
        log(`spaces-backup failed for ${space.id} → ${target.type}: ${String(e?.message ?? e)}`);
      }
    }
    if (!landed) return;
    // WHY: pruning used to run after FAILED copies too — a month of failures
    // (an expired Drive sign-in) would delete every snapshot and add none.
    // Prune a destination only once today's snapshot fully landed there.
    if (force || !this.done.has(`prune|${where}`)) {
      try { await this.prune(target, now, log); this.done.add(`prune|${where}`); } catch { /* best-effort; retried next run */ } // benign: pruning old copies is housekeeping; the next run retries and the copy itself already succeeded
    }
  }

  private async copySpace(space: SyncSpace, target: BackupTarget, dated: string): Promise<void> {
    if (target.type === 'drive') {
      const dest = `${target.base}/Backup/spaces/${dated}/${space.id.replace(':', '-')}`;
      const excludes = DEFAULT_IGNORES.flatMap(p => ['--exclude', p.endsWith('/') ? `${p}**` : p]);
      // --update: devices share today's folder; an older copy never replaces a newer one.
      await execFileAsync('rclone', ['copy', '--update', space.root, dest, ...excludes], { timeout: RCLONE_TIMEOUT });
    } else {
      const dest = path.join(target.base, 'Backup', 'spaces', dated, space.id.replace(':', '-'));
      // Why async fs: this runs in the Electron main process — a synchronous
      // deep copy would freeze UI/IPC/PTY for the duration of a large space
      // copy. The Drive path is already async via rclone.
      await fs.promises.mkdir(dest, { recursive: true });
      await fs.promises.cp(space.root, dest, {
        recursive: true,
        // Kept so the newer-wins check below compares edit times, not copy times.
        preserveTimestamps: true,
        // Backups scrub exactly what sync scrubs (DEFAULT_IGNORES) — secrets
        // like *.pem / id_rsa* must not land in iCloud any more than in a repo.
        filter: async (src, dst) => {
          if (isIgnoredPath(path.relative(space.root, src))) return false;
          // Same rule as Drive's --update: devices share today's folder.
          try {
            const [from, to] = await Promise.all([fs.promises.stat(src), fs.promises.stat(dst)]);
            return !(from.isFile() && to.isFile() && to.mtimeMs > from.mtimeMs);
          } catch { return true; }
        },
      });
    }
  }

  private async prune(target: BackupTarget, now: Date, log: (m: string) => void): Promise<void> {
    if (target.type === 'drive') {
      const { stdout } = await execFileAsync('rclone', ['lsf', '--dirs-only', `${target.base}/Backup/spaces/`], { timeout: RCLONE_TIMEOUT });
      const names = stdout.split('\n').map(s => s.replace(/\/$/, '')).filter(Boolean);
      for (const name of foldersToPrune(names, now, 30)) {
        await execFileAsync('rclone', ['purge', `${target.base}/Backup/spaces/${name}`], { timeout: RCLONE_TIMEOUT });
        log(`spaces-backup pruned ${name}`);
      }
    } else {
      const dir = path.join(target.base, 'Backup', 'spaces');
      let names: string[] = [];
      // Async fs for the same main-process reason as the copy above.
      try { names = await fs.promises.readdir(dir); } catch { return; }
      for (const name of foldersToPrune(names, now, 30)) {
        await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
        log(`spaces-backup pruned ${name}`);
      }
    }
  }
}
