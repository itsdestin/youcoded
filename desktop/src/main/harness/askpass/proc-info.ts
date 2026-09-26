// proc-info.ts — reads the process facts verify.ts's chain needs (real exe,
// exact argv/environ, ppid, start time, TracerPid, and the setuid/ownership
// chain up to a genuine sudo), behind an injectable `ProcReader` interface so
// askpass-verify.test.ts can drive every refusal with fakes instead of real
// /proc state (design §3, §9).
//
// Every read here is ASYNC (fs.promises / a promisified koffi call) — this
// runs on a connection to a listening socket, which is exactly the kind of
// "IPC call reached this" path .claude/rules/performance.md rule 1 bans
// blocking calls on.
'use strict';

import { promises as fs } from 'fs';

export interface ProcStat {
  uid: number;
  mode: number;
  isFile: boolean;
  isDirectory: boolean;
}

/** A pinned process instance (design §3 item 0, review 2 E7). Holding this
 *  open prevents the KERNEL from recycling the pid number for as long as it
 *  stays open, on platforms where pidfd_open (or the moral equivalent) is
 *  available. Callers MUST close() every handle they open, in a `finally`,
 *  regardless of verification outcome. */
export interface PidHandle {
  close(): void;
}

export interface ProcReader {
  /** Real absolute path of `pid`'s executable (Linux `readlink
   *  /proc/pid/exe`; macOS `proc_pidpath`/sysctl). Null if unreadable or the
   *  pid is gone — never throws. */
  exePath(pid: number): Promise<string | null>;
  /** argv, in order, NUL-split (never `ps` text — design §3 item 1, review 2
   *  E3: NUL-separated is the only unambiguous representation). Null if
   *  unreadable. */
  cmdline(pid: number): Promise<string[] | null>;
  /** name → value, NUL-split (same reasoning as cmdline). Null if
   *  unreadable. */
  environ(pid: number): Promise<Map<string, string> | null>;
  /** Parent pid, or null if unreadable / the pid is gone. */
  ppid(pid: number): Promise<number | null>;
  /** Monotonic identity of THIS pid incarnation (Linux `/proc/pid/stat`
   *  field 22; macOS `kinfo_proc.kp_proc.p_starttime`) — the standard way to
   *  detect a recycled pid number between two reads of it (design §3 item 0,
   *  review 2 E7). Null if unreadable / the pid is gone. */
  startTime(pid: number): Promise<number | null>;
  /** Linux `TracerPid` from `/proc/pid/status`; 0 = untraced. Always 0 on
   *  platforms with no such concept, so callers can uniformly treat
   *  "non-zero" as a refusal reason without a platform branch. */
  tracerPid(pid: number): Promise<number>;
  /** `stat()` of an arbitrary filesystem path — a parent's real exe, or a
   *  directory on the walk up to `/` — for the setuid/owner/writability
   *  chain (design §3 item 2). Null if unreadable/missing. */
  statPath(targetPath: string): Promise<ProcStat | null>;
  /** Best-effort pin of `pid` (design §3 item 0). Returns null when the
   *  primitive is unavailable on this platform/kernel — callers fall back to
   *  the startTime re-check, which is why this is optional rather than
   *  required for correctness. */
  pidfdOpen(pid: number): Promise<PidHandle | null>;
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

/** Parse `/proc/<pid>/stat`'s fields AFTER `comm)` — comm itself can contain
 *  spaces and parens, so the only safe split point is the LAST `)` on the
 *  line (proc(5); the kernel never emits a bare `)` after the real one
 *  because it prints comm inside one open/close paren pair verbatim, but a
 *  process can name itself with a `)` earlier — lastIndexOf handles both).
 *  Returned array is 0-indexed starting at proc(5) field 3 (`state`), so
 *  `fields[1]` is field 4 (`ppid`) and `fields[19]` is field 22
 *  (`starttime`). */
async function readStatFields(pid: number): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open === -1 || close === -1 || close < open) return null;
  const rest = raw.slice(close + 1).trim();
  if (!rest) return null;
  return rest.split(/\s+/);
}

async function linuxPpid(pid: number): Promise<number | null> {
  const fields = await readStatFields(pid);
  if (!fields || fields.length < 2) return null;
  const ppid = Number.parseInt(fields[1], 10);
  return Number.isInteger(ppid) ? ppid : null;
}

async function linuxStartTime(pid: number): Promise<number | null> {
  const fields = await readStatFields(pid);
  if (!fields || fields.length < 20) return null;
  const starttime = Number.parseInt(fields[19], 10);
  return Number.isInteger(starttime) ? starttime : null;
}

async function linuxTracerPid(pid: number): Promise<number> {
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^TracerPid:\s*(\d+)/m);
    // Unreadable or missing field: fail closed, i.e. report "traced" rather
    // than assume the best — same posture as askpass.cjs's own isTraced().
    if (!match) return -1;
    return Number.parseInt(match[1], 10);
  } catch {
    return -1;
  }
}

async function linuxExePath(pid: number): Promise<string | null> {
  try {
    return await fs.readlink(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

// knip: not exported — only used within this file's own environ()/cmdline() readers.
function splitNulRecords(buf: Buffer): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      if (i > start) out.push(buf.toString('utf8', start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.toString('utf8', start));
  return out;
}

async function linuxCmdline(pid: number): Promise<string[] | null> {
  try {
    const buf = await fs.readFile(`/proc/${pid}/cmdline`);
    return splitNulRecords(buf);
  } catch {
    return null;
  }
}

async function linuxEnviron(pid: number): Promise<Map<string, string> | null> {
  try {
    const buf = await fs.readFile(`/proc/${pid}/environ`);
    const entries = splitNulRecords(buf);
    const map = new Map<string, string>();
    for (const entry of entries) {
      const eq = entry.indexOf('=');
      if (eq === -1) continue; // malformed entry — never happens for a real environ, ignore rather than guess
      map.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
    return map;
  } catch {
    return null;
  }
}

async function statPathImpl(targetPath: string): Promise<ProcStat | null> {
  try {
    const st = await fs.stat(targetPath);
    return { uid: st.uid, mode: st.mode, isFile: st.isFile(), isDirectory: st.isDirectory() };
  } catch {
    return null;
  }
}

// pidfd_open(2) — Linux 5.3+, wrapped by glibc since 2.36. Loaded lazily and
// disabled outright (pidfdOpen resolves null forever after) the first time
// it fails for ANY reason: wrong kernel, wrong libc, sandboxed seccomp
// profile, whatever — design §3 item 0 explicitly allows falling back to the
// startTime re-check alone when this primitive isn't available, so there is
// nothing to gain from retrying a call that has already failed once.
type PidfdOpenFn = (pid: number, flags: number) => number;
let pidfdOpenFn: PidfdOpenFn | null | undefined;
function loadPidfdOpen(): PidfdOpenFn | null {
  if (pidfdOpenFn !== undefined) return pidfdOpenFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const libc = koffi.load('libc.so.6');
    const fn = libc.func('int pidfd_open(int pid, unsigned int flags)') as PidfdOpenFn;
    pidfdOpenFn = fn;
    return fn;
  } catch {
    pidfdOpenFn = null;
    return null;
  }
}

async function linuxPidfdOpen(pid: number): Promise<PidHandle | null> {
  const fn = loadPidfdOpen();
  if (!fn) return null;
  try {
    const fd = fn(pid, 0);
    if (fd < 0) return null;
    let closed = false;
    return {
      close(): void {
        if (closed) return;
        closed = true;
        // A pidfd is an ordinary fd from the kernel's point of view —
        // close(2) is all it needs. The callback form (not closeSync) so
        // this synchronous-looking `close()` never blocks the main thread
        // (.claude/rules/performance.md rule 1); the callback is a no-op
        // because there is nothing left to do once the fd is released
        // (best-effort pin teardown — errors here mean it was already gone).
        require('fs').close(fd, () => {});
      },
    };
  } catch {
    return null;
  }
}

const linuxReader: ProcReader = {
  exePath: linuxExePath,
  cmdline: linuxCmdline,
  environ: linuxEnviron,
  ppid: linuxPpid,
  startTime: linuxStartTime,
  tracerPid: linuxTracerPid,
  statPath: statPathImpl,
  pidfdOpen: linuxPidfdOpen,
};

// ---------------------------------------------------------------------------
// macOS — written per design §3 item 1's requirement, but UNVERIFIED on a
// real Mac (same posture as askpass.cjs's own ptrace(PT_DENY_ATTACH) call).
// `MAC_ENABLED` below is the off switch verify.ts checks before ever calling
// into any of this — flipping it on is a separate, deliberate change once
// KERN_PROCARGS2 / kinfo_proc reads are proven against SIP-enabled macOS.
// ---------------------------------------------------------------------------

/** Ships false. Do not flip without proving, on a real Mac with SIP on,
 *  that a non-ancestor same-uid process can read another process's argv
 *  and environ via `sysctl(KERN_PROCARGS2)` — review 2 E2/E3's whole point
 *  is that `ps` cannot (SIP-gated display path), and this has never been
 *  confirmed for the raw syscall used here instead. */
export const MAC_ENABLED = false;

const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_PID = 1;
const KERN_PROCARGS2 = 49;

interface SysctlFns {
  sysctl: (name: number[], namelen: number, oldp: Buffer | null, oldlenp: Buffer, newp: unknown, newlen: number) => number;
}

let sysctlFns: SysctlFns | null = null;
function loadSysctl(): SysctlFns {
  if (sysctlFns) return sysctlFns;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi');
  const lib = koffi.load('libSystem.B.dylib');
  const sysctl = lib.func(
    'int sysctl(_In_ int *name, unsigned int namelen, _Out_ void *oldp, _Inout_ unsigned long *oldlenp, void *newp, unsigned long newlen)',
  );
  sysctlFns = { sysctl };
  return sysctlFns;
}

/** Raw KERN_PROCARGS2 bytes for `pid`: `argc` (int32) then NUL-separated
 *  argv, then NUL-separated environ, then padding. Null on any failure — an
 *  unreadable result must fail closed (design §3 item 1), never be treated
 *  as "nothing to disagree with" (review 2 E2's exact failure mode). */
async function macProcArgs2(pid: number): Promise<Buffer | null> {
  try {
    const { sysctl } = loadSysctl();
    const name = [CTL_KERN, KERN_PROCARGS2, pid];
    // First call: discover the required buffer size (oldp = null idiom).
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeUInt32LE(0, 0);
    let rc = sysctl(name, name.length, null, lenBuf, null, 0);
    if (rc !== 0) return null;
    const size = lenBuf.readUInt32LE(0);
    if (size <= 0) return null;
    const outBuf = Buffer.alloc(size);
    const lenBuf2 = Buffer.alloc(8);
    lenBuf2.writeUInt32LE(size, 0);
    rc = sysctl(name, name.length, outBuf, lenBuf2, null, 0);
    if (rc !== 0) return null;
    return outBuf.subarray(0, lenBuf2.readUInt32LE(0));
  } catch {
    return null;
  }
}

/** Splits KERN_PROCARGS2's raw layout into argv and environ, both
 *  NUL-delimited — never text-parsed (review 2 E3: `ps -Eww`'s
 *  space-joined `KEY=VALUE KEY=VALUE …` dump is fundamentally ambiguous for
 *  a value containing a space or `=`; this reads the same bytes the kernel
 *  itself handed `ps`, before any of that formatting). */
function parseProcArgs2(buf: Buffer): { argv: string[]; environ: Map<string, string> } | null {
  if (buf.length < 4) return null;
  const argc = buf.readInt32LE(0);
  // Layout: argc(int32) | exec_path NUL | padding NULs | argv[0] NUL ... argv[argc-1] NUL | environ entries NUL ... | trailing NULs
  let offset = 4;
  // Skip the saved exec_path (a duplicate of argv[0], NUL-terminated).
  const execEnd = buf.indexOf(0, offset);
  if (execEnd === -1) return null;
  offset = execEnd + 1;
  // Skip NUL padding up to the next non-NUL byte (alignment filler).
  while (offset < buf.length && buf[offset] === 0) offset++;
  const records = splitNulRecords(buf.subarray(offset));
  const argv = records.slice(0, argc);
  const environMap = new Map<string, string>();
  for (const entry of records.slice(argc)) {
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    environMap.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return { argv, environ: environMap };
}

async function macCmdline(pid: number): Promise<string[] | null> {
  const buf = await macProcArgs2(pid);
  if (!buf) return null;
  const parsed = parseProcArgs2(buf);
  return parsed ? parsed.argv : null;
}

async function macEnviron(pid: number): Promise<Map<string, string> | null> {
  const buf = await macProcArgs2(pid);
  if (!buf) return null;
  const parsed = parseProcArgs2(buf);
  return parsed ? parsed.environ : null;
}

// kinfo_proc's fields this needs: p_ppid, p_starttime (a struct timeval),
// kp_proc/kp_eproc layout differs across Darwin versions — this reads only
// the byte offsets published in <sys/sysctl.h>/<sys/proc.h> for the extern
// kinfo_proc struct, unverified on a real machine (see MAC_ENABLED above).
const KINFO_PROC_SIZE_HINT = 648; // sizeof(struct kinfo_proc) on x86_64/arm64 Darwin
const KP_EPROC_PPID_OFFSET = 560; // kp_eproc.e_ppid
const KP_PROC_STARTTIME_OFFSET = 16; // kp_proc.p_starttime (struct timeval, first field tv_sec)

async function macKinfoProc(pid: number): Promise<Buffer | null> {
  try {
    const { sysctl } = loadSysctl();
    const name = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid];
    const outBuf = Buffer.alloc(KINFO_PROC_SIZE_HINT);
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeUInt32LE(KINFO_PROC_SIZE_HINT, 0);
    const rc = sysctl(name, name.length, outBuf, lenBuf, null, 0);
    if (rc !== 0) return null;
    const gotLen = lenBuf.readUInt32LE(0);
    if (gotLen <= 0) return null;
    return outBuf.subarray(0, gotLen);
  } catch {
    return null;
  }
}

async function macPpid(pid: number): Promise<number | null> {
  const buf = await macKinfoProc(pid);
  if (!buf || buf.length < KP_EPROC_PPID_OFFSET + 4) return null;
  return buf.readInt32LE(KP_EPROC_PPID_OFFSET);
}

async function macStartTime(pid: number): Promise<number | null> {
  const buf = await macKinfoProc(pid);
  if (!buf || buf.length < KP_PROC_STARTTIME_OFFSET + 8) return null;
  // tv_sec (a long) — treat as the identity value the same way Linux's
  // starttime (clock ticks) is used: an opaque, comparable-for-equality
  // number, never a wall-clock time to reason about otherwise.
  return Number(buf.readBigInt64LE(KP_PROC_STARTTIME_OFFSET));
}

async function macExePath(pid: number): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const lib = koffi.load('libSystem.B.dylib');
    const proc_pidpath = lib.func('int proc_pidpath(int pid, _Out_ char *buffer, uint32_t buffersize)');
    const buf = Buffer.alloc(4096);
    const n = proc_pidpath(pid, buf, buf.length);
    if (n <= 0) return null;
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  }
}

// macOS has no TracerPid concept exposed this way; P_TRACED lives in
// kinfo_proc.kp_proc.p_flag, unread here (unverified layout, and the whole
// macOS path is switched off — MAC_ENABLED). Reporting 0 unconditionally
// would be a silent pass on a real tracer; reporting "always traced" (-1)
// would break the platform outright once someone flips MAC_ENABLED. Neither
// is safe to guess, so this reader is honest about not implementing it yet.
async function macTracerPid(_pid: number): Promise<number> {
  return -1; // fail closed: "cannot confirm untraced" until this is implemented for real
}

const darwinReader: ProcReader = {
  exePath: macExePath,
  cmdline: macCmdline,
  environ: macEnviron,
  ppid: macPpid,
  startTime: macStartTime,
  tracerPid: macTracerPid,
  statPath: statPathImpl,
  // No pidfd_open equivalent is used on macOS — design §3 item 0 relies on
  // the startTime re-check there regardless.
  pidfdOpen: async () => null,
};

const unsupportedReader: ProcReader = {
  exePath: async () => null,
  cmdline: async () => null,
  environ: async () => null,
  ppid: async () => null,
  startTime: async () => null,
  tracerPid: async () => -1,
  statPath: statPathImpl,
  pidfdOpen: async () => null,
};

/** Real, platform-appropriate `ProcReader`. `askpass-verify.test.ts` never
 *  calls this — it drives verify.ts with hand-built fakes — this is what
 *  askpass-server.ts wires up for real use. */
export function createProcReader(platform: NodeJS.Platform = process.platform): ProcReader {
  if (platform === 'linux') return linuxReader;
  if (platform === 'darwin') return darwinReader;
  return unsupportedReader;
}
