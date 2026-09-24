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

// ---- job ----
export interface BackupTarget {
  type: 'drive' | 'icloud';
  /** drive: rclone remote+root e.g. "gdrive:Claude"; icloud: absolute folder path */
  base: string;
}

export class DailyBackup {
  private markerPath: string;
  // Today's finished work: `copy|<type>|<base>|<space id>` and `prune|<type>|<base>`.
  // WHY in memory: a failed copy retries next hour without redoing the copies
  // that worked; a restart mid-day only costs a re-copy. The marker file still
  // closes the day, and only once every copy landed.
  private done = new Set<string>();
  private doneDate = '';

  constructor(opts?: { markerPath?: string }) {
    this.markerPath = opts?.markerPath ?? path.join(os.homedir(), '.claude', '.spaces-backup-marker');
  }

  /** Call from an hourly timer; no-ops until a new UTC day. Never throws. */
  async runIfDue(spaces: SyncSpace[], targets: BackupTarget[], log: (msg: string) => void): Promise<void> {
    let marker: string | null = null;
    try { marker = (await fs.promises.readFile(this.markerPath, 'utf8')).trim(); } catch { /* first run */ }
    const now = new Date();
    if (!isBackupDue(marker, now) || targets.length === 0) return;
    const dated = datedFolderName(now);
    if (this.doneDate !== dated) { this.done.clear(); this.doneDate = dated; }
    let complete = true;
    for (const target of targets) {
      const where = `${target.type}|${target.base}`;
      let landed = true;
      for (const space of spaces) {
        const key = `copy|${where}|${space.id}`;
        if (this.done.has(key)) continue;
        try { await this.copySpace(space, target, dated); this.done.add(key); }
        catch (e: any) { landed = false; log(`spaces-backup failed for ${space.id} → ${target.type}: ${String(e?.message ?? e)}`); }
      }
      if (!landed) { complete = false; continue; }
      // WHY: pruning used to run after FAILED copies too — a month of failures
      // (an expired Drive sign-in) would delete every snapshot and add none.
      // Prune a destination only once today's snapshot fully landed there.
      if (!this.done.has(`prune|${where}`)) {
        try { await this.prune(target, now, log); this.done.add(`prune|${where}`); } catch { /* best-effort; retried next run */ }
      }
    }
    if (!complete) {
      log(`spaces-backup incomplete for ${dated}; failed copies retry next hour`);
      return;
    }
    // Guarded so runIfDue honors its "never throws" contract — a missing or
    // read-only ~/.claude must not become an unhandled rejection in the timer.
    try { await fs.promises.writeFile(this.markerPath, dated); }
    catch (e: any) { log(`spaces-backup: could not write marker: ${String(e?.message ?? e)}`); }
    log(`spaces-backup completed for ${dated} (${spaces.length} spaces, ${targets.length} targets)`);
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
