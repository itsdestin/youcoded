// Per-conversation record of background commands (audit 2026-10-22, D2/D3/D4).
//
// WHY it exists: a background command's state lived only in memory
// (ShellRegistry). After an app restart every card whose finished-notice the
// chat had not recorded read "Stopped when the app quit" — losing the real exit
// code and the real stop reason — and after a CRASH the process groups survive
// (a dev server still holding its port) while the card claimed they were gone.
// This sidecar, `sessions/<slug>/<sessionId>.shells.json` next to the
// conversation's own files, keeps one small record per command so the next
// start can report what really happened and re-attach to what is still running.
//
// Writes are async and coalesced (never a sync fs call on the main thread):
// start / exit / stop write at once; output-driven refreshes of the stored tail
// are throttled to one write per OUTPUT_WRITE_INTERVAL_MS. A failed write is
// logged and retried a couple of times; losing it only costs fidelity on the
// next restart, never the live session.
import * as fs from 'fs';
import * as path from 'path';
import type { NativeHome } from '../native-home';
import { nativeStoreSlug } from '../slug-encoding';
import { log } from '../logger';
import type { ShellStopReason } from '../../shared/types';

/** At most one output-refresh write per run per this long (start/exit are immediate). */
const OUTPUT_WRITE_INTERVAL_MS = 5_000;
/** Records kept per conversation (oldest finished ones dropped first). */
const MAX_RECORDS = 100;
/** Retries of a failed write before giving up (each waits OUTPUT_WRITE_INTERVAL_MS). */
const MAX_WRITE_RETRIES = 2;

export interface PersistedShellRun {
  shellId: string;
  toolUseId: string;
  command: string;
  description?: string;
  cwd: string;
  status: 'running' | 'exited' | 'stopped';
  exitCode?: number;
  signal?: string;
  stopReason?: ShellStopReason;
  detached: boolean;
  startedAt: number;
  endedAt?: number;
  logPath: string;
  /** The last lines of output as of the last write (ANSI-stripped). */
  tail: string;
  /** Root pid of the command's process group (POSIX: also the group id). */
  pid?: number;
  /** Linux only: the root process's start time (/proc stat field 22). Lets a later
   *  start tell "our command's group is still alive" from "that pid was reused". */
  procStart?: string;
  /** Which app process wrote this (OWNER.instanceId); a running record from a
   *  DIFFERENT instance is an orphan candidate. */
  ownerInstance: string;
  /** Set by a restart that found the command ended without us seeing it (see ShellRunView). */
  exitUnknown?: boolean;
  maybeStillRunning?: boolean;
}

interface SidecarFile { v: 1; runs: PersistedShellRun[] }

function shellSidecarRel(cwd: string, sessionId: string): string {
  return path.join('sessions', nativeStoreSlug(cwd), `${sessionId}.shells.json`);
}

/** Async read of a conversation's records ([] when none / unreadable). */
export async function readPersistedShells(home: NativeHome, cwd: string, sessionId: string): Promise<PersistedShellRun[]> {
  try {
    const raw = await fs.promises.readFile(path.join(home.root, shellSidecarRel(cwd, sessionId)), 'utf8');
    const parsed = JSON.parse(raw) as SidecarFile;
    return Array.isArray(parsed?.runs) ? parsed.runs : [];
  } catch {
    return []; // missing or corrupt: "nothing recorded", exactly like the ledger's coerce()
  }
}

/** What ShellRegistry needs from a sidecar (a test can pass a fake). */
export interface ShellPersistence {
  /** `urgent` = start/exit/stop (write now); otherwise an output refresh (throttled). */
  upsert(rec: PersistedShellRun, urgent: boolean): void;
}

export class ShellSidecar implements ShellPersistence {
  private pending = new Map<string, PersistedShellRun>();
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failures = 0;

  constructor(
    private readonly home: NativeHome,
    private readonly cwd: string,
    private readonly sessionId: string,
    private readonly outputIntervalMs: number = OUTPUT_WRITE_INTERVAL_MS,
  ) {}

  upsert(rec: PersistedShellRun, urgent: boolean): void {
    this.pending.set(rec.shellId, rec);
    if (urgent) { void this.flush(); return; }
    if (this.timer) return;
    // unref'd: a pending refresh must never hold the process open at quit.
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.outputIntervalMs);
    this.timer.unref();
  }

  /** Write everything pending; resolves when it is on disk (or has failed for good). */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const batch = [...this.pending.values()];
    if (batch.length === 0) return this.chain;
    this.pending.clear();
    this.chain = this.chain.then(async () => {
      try {
        await this.home.mutateJson(shellSidecarRel(this.cwd, this.sessionId), (cur) => {
          const runs = Array.isArray((cur as SidecarFile | null)?.runs) ? [...(cur as SidecarFile).runs] : [];
          for (const rec of batch) {
            const i = runs.findIndex((r) => r.shellId === rec.shellId);
            if (i >= 0) runs[i] = rec; else runs.push(rec);
          }
          // Bounded: drop the oldest FINISHED records first, never a running one.
          while (runs.length > MAX_RECORDS) {
            const drop = runs.findIndex((r) => r.status !== 'running');
            runs.splice(drop >= 0 ? drop : 0, 1);
          }
          return { v: 1, runs } satisfies SidecarFile;
        });
        this.failures = 0;
      } catch (err) {
        // Put the batch back (a newer record for the same run wins) and retry later.
        for (const rec of batch) if (!this.pending.has(rec.shellId)) this.pending.set(rec.shellId, rec);
        if (++this.failures <= MAX_WRITE_RETRIES) {
          if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.outputIntervalMs); this.timer.unref(); }
        } else {
          log('WARN', 'ShellSidecar', 'could not record background commands for this conversation — a restart will not know their outcome', { sessionId: this.sessionId, error: String(err) });
          this.pending.clear();
          this.failures = 0;
        }
      }
    });
    return this.chain;
  }
}

/** Linux: the process's start time in clock ticks since boot, or undefined where
 *  /proc is unavailable (macOS, Windows) or the process is gone. */
export async function processStartStamp(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
    // Field 2 (the command name) may contain spaces/parens, so split after the LAST ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return rest[19]; // field 22 overall = index 19 after state (field 3)
  } catch {
    return undefined;
  }
}

/** Is any process of this command's group still alive? POSIX: signal 0 to the
 *  group (EPERM still means "exists"). Windows has no groups: signal 0 to the pid. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export type OrphanVerdict = 'running' | 'maybe-running' | 'gone';

/** Judge a record that said "running" when its writer (a previous app process)
 *  went away. 'running' = verified ours and alive (Stop may signal it);
 *  'maybe-running' = something holds that pid/group but we cannot prove it is
 *  ours (no /proc here) — reported, never signalled; 'gone' = nothing there. */
export async function judgeOrphan(rec: Pick<PersistedShellRun, 'pid' | 'procStart'>): Promise<OrphanVerdict> {
  if (!rec.pid || !groupAlive(rec.pid)) return 'gone';
  if (process.platform !== 'linux' || !rec.procStart) return 'maybe-running';
  const now = await processStartStamp(rec.pid);
  // Leader gone but group members alive: the kernel never hands a live group's id
  // to a new process, so the group is still ours. Leader present with a different
  // start time: the pid was reused by something unrelated.
  if (now === undefined) return 'running';
  return now === rec.procStart ? 'running' : 'gone';
}
