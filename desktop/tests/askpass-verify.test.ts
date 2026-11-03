// verifyAskpassPeer: every refusal reason, driven by a fake ProcReader (no real /proc, no real sudo), plus the accept path with and without `via`.
import { describe, it, expect } from 'vitest';
import { verifyAskpassPeer, type VerifyDeps } from '../src/main/harness/askpass/verify';
import { RunningCalls } from '../src/main/harness/askpass/running-calls';
import type { ProcReader, ProcStat, PidHandle } from '../src/main/harness/askpass/proc-info';

const EXEC_PATH = '/opt/YouCoded/youcoded';
const HELPER_SCRIPT = '/opt/YouCoded/resources/app.asar.unpacked/scripts/askpass/askpass.cjs';
// The invoking user's own uid in every fixture; matches makeDeps's `ourUid`.
const OUR_UID = 1000;

interface FakeProc {
  ppid: number | null;
  exePath: string | null;
  cmdline: string[] | null;
  environ: Map<string, string> | null;
  startTime: number | null;
  tracerPid: number;
  /** /proc/<pid>/status's `Uid:` line (real, effective) — unlike exe/
   *  environ, NOT gated by the kernel's dumpable flag on a real setuid
   *  process (verify.ts's redesigned item 2 relies on this instead). */
  uids: { real: number; effective: number } | null;
  /** /proc/<pid>/comm — set by the kernel from the EXECUTED FILE's own
   *  basename, never from argv[0]. */
  comm: string | null;
}

/** A tiny, fully in-memory stand-in for /proc, keyed by pid. `statByPath`
 *  models the filesystem checks (sudo's own exe + the directory chain up to
 *  `/`). `mutateStartTimeAfterFirstRead` lets a test simulate a pid being
 *  recycled BETWEEN verify.ts's first read of that pid and its final
 *  re-check (design §3 item 0, review 2 E7) — the standard TOCTOU race this
 *  check exists to catch. */
class FakeProcReader implements ProcReader {
  private readonly startTimeCalls = new Map<number, number>();
  constructor(
    private readonly procs: Map<number, FakeProc>,
    private readonly statByPath: Map<string, ProcStat>,
    private readonly mutateStartTimeAfterFirstRead = new Set<number>(),
  ) {}

  async exePath(pid: number): Promise<string | null> {
    return this.procs.get(pid)?.exePath ?? null;
  }
  async cmdline(pid: number): Promise<string[] | null> {
    return this.procs.get(pid)?.cmdline ?? null;
  }
  async environ(pid: number): Promise<Map<string, string> | null> {
    return this.procs.get(pid)?.environ ?? null;
  }
  async ppid(pid: number): Promise<number | null> {
    return this.procs.get(pid)?.ppid ?? null;
  }
  async startTime(pid: number): Promise<number | null> {
    const proc = this.procs.get(pid);
    if (!proc || proc.startTime === null) return proc?.startTime ?? null;
    const calls = (this.startTimeCalls.get(pid) ?? 0) + 1;
    this.startTimeCalls.set(pid, calls);
    if (calls > 1 && this.mutateStartTimeAfterFirstRead.has(pid)) {
      return proc.startTime + 999; // simulates a different incarnation on re-read
    }
    return proc.startTime;
  }
  async tracerPid(pid: number): Promise<number> {
    return this.procs.get(pid)?.tracerPid ?? -1;
  }
  async statPath(targetPath: string): Promise<ProcStat | null> {
    return this.statByPath.get(targetPath) ?? null;
  }
  async pidfdOpen(_pid: number): Promise<PidHandle | null> {
    // Never available in these tests — every case below exercises the
    // starttime-only fallback path (design §3 item 0's explicitly allowed
    // degradation when pidfd_open is unavailable).
    return null;
  }
  async uids(pid: number): Promise<{ real: number; effective: number } | null> {
    return this.procs.get(pid)?.uids ?? null;
  }
  async comm(pid: number): Promise<string | null> {
    return this.procs.get(pid)?.comm ?? null;
  }
}

/** An intermediate wrapper-script process (bash running `script`). */
const scriptProc = (ppid: number, script: string | null, startTime: number): FakeProc => ({
  ppid, exePath: '/bin/bash', cmdline: script === null ? null : ['bash', script], environ: null, startTime, tracerPid: 0,
  uids: { real: OUR_UID, effective: OUR_UID }, comm: 'bash',
});

const ROOT_DIR_STAT: ProcStat = { uid: 0, mode: 0o755, isFile: false, isDirectory: true };
const SUDO_EXE_STAT_OK: ProcStat = { uid: 0, mode: 0o4755, isFile: true, isDirectory: false };

function baseFilesystem(): Map<string, ProcStat> {
  return new Map<string, ProcStat>([
    ['/', ROOT_DIR_STAT],
    ['/usr', ROOT_DIR_STAT],
    ['/usr/bin', ROOT_DIR_STAT],
    ['/usr/bin/sudo', SUDO_EXE_STAT_OK],
  ]);
}

const GOOD_ENVIRON = new Map([
  ['ELECTRON_RUN_AS_NODE', '1'],
  ['YOUCODED_ASKPASS_SOCKET', '/run/user/1000/youcoded/askpass-123.sock'],
]);

/** The standard, entirely-legitimate process tree: helper(500) → sudo(400)
 *  → shell/call-root(300). Individual tests mutate a clone of this to
 *  introduce exactly one problem. */
function goodProcs(): Map<number, FakeProc> {
  return new Map<number, FakeProc>([
    [
      500,
      {
        ppid: 400,
        exePath: EXEC_PATH,
        cmdline: [EXEC_PATH, HELPER_SCRIPT],
        environ: new Map(GOOD_ENVIRON),
        startTime: 500_00,
        tracerPid: 0,
        uids: { real: OUR_UID, effective: OUR_UID },
        comm: 'youcoded',
      },
    ],
    [
      400,
      {
        ppid: 300,
        // Deliberately null — a genuine setuid sudo's /proc/<pid>/exe and
        // /environ are EACCES to us in reality (that was the whole bug);
        // verify.ts's redesigned item 2 never reads either for sudoPid, so
        // these being unreadable here must NOT stop the accept-path tests
        // from passing.
        exePath: null,
        environ: null,
        cmdline: ['sudo', 'apt', 'update'],
        startTime: 400_00,
        tracerPid: 0,
        uids: { real: OUR_UID, effective: 0 },
        comm: 'sudo',
      },
    ],
    [
      300,
      {
        ppid: 2,
        exePath: '/bin/bash',
        cmdline: ['bash'],
        environ: null,
        startTime: 300_00,
        tracerPid: 0,
        uids: { real: OUR_UID, effective: OUR_UID },
        comm: 'bash',
      },
    ],
  ]);
}

function makeDeps(
  procs: Map<number, FakeProc>,
  statByPath: Map<string, ProcStat>,
  opts?: {
    registerRoot?: { pid: number; startTime: number };
    mutateAfterFirstRead?: Set<number>;
    /** T5-6: defaults to 0 (retry disabled) so every EXISTING negative test
     *  keeps refusing immediately rather than paying the real 1000ms
     *  default retry window — tests that specifically exercise the retry
     *  pass their own short values. */
    registrationRetryMs?: number;
    registrationPollMs?: number;
    /** Skips the default pre-registration entirely — for tests that
     *  register the root THEMSELVES, mid-test, to exercise the T5-6 race. */
    skipRegister?: boolean;
  },
): VerifyDeps {
  const runningCalls = new RunningCalls();
  if (!opts?.skipRegister) {
    const registerRoot = opts?.registerRoot ?? { pid: 300, startTime: 300_00 };
    runningCalls.register(registerRoot.pid, registerRoot.startTime, { sessionId: 's1', toolCallId: 't1' });
  }
  return {
    reader: new FakeProcReader(procs, statByPath, opts?.mutateAfterFirstRead),
    execPath: EXEC_PATH,
    helperScriptRealpath: HELPER_SCRIPT,
    runningCalls,
    platform: 'linux',
    registrationRetryMs: opts?.registrationRetryMs ?? 0,
    registrationPollMs: opts?.registrationPollMs,
    ourUid: OUR_UID,
  };
}

describe('verifyAskpassPeer: accept path', () => {
  it('accepts the genuine chain with no via (direct sudo from the call root)', async () => {
    const deps = makeDeps(goodProcs(), baseFilesystem());
    const result = await verifyAskpassPeer(500, deps);
    expect(result).toEqual({
      ok: true,
      sudoPid: 400,
      sudoArgv: ['sudo', 'apt', 'update'],
      sudoExePath: '/usr/bin/sudo',
      callRoot: 300,
      via: undefined,
    });
  });

  it('accepts with via set when a script sits between sudo and the call root', async () => {
    const procs = goodProcs();
    // Insert a script process (350) between sudo(400) and the call root
    // (300): sudo's parent is now 350 ("bash install.sh"), not the root.
    procs.get(400)!.ppid = 350;
    procs.set(350, scriptProc(300, 'install.sh', 350_00));
    const deps = makeDeps(procs, baseFilesystem());
    const result = await verifyAskpassPeer(500, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.via).toBe('install.sh');
      expect(result.callRoot).toBe(300);
    }
  });

  it('reports the OUTERMOST script when two layers of wrapper scripts sit between sudo and the call root', async () => {
    const procs = goodProcs();
    // call root (300) -> install.sh (360) -> helper.sh (350) -> sudo (400).
    // sudo's own immediate parent is helper.sh, the INNERMOST wrapper — the
    // card should still name install.sh, the thing the user actually
    // approved, not the implementation detail install.sh happens to run.
    procs.get(400)!.ppid = 350;
    procs.set(350, scriptProc(360, 'helper.sh', 350_00));
    procs.set(360, scriptProc(300, 'install.sh', 360_00));
    const deps = makeDeps(procs, baseFilesystem());
    const result = await verifyAskpassPeer(500, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.via).toBe('install.sh');
    }
  });

  it('refuses rather than silently reporting "direct" when an intermediate script hop is unreadable', async () => {
    const procs = goodProcs();
    procs.get(400)!.ppid = 350;
    procs.set(350, scriptProc(300, null, 350_00)); // a transient /proc/<pid>/cmdline read failure
    const deps = makeDeps(procs, baseFilesystem());
    const result = await verifyAskpassPeer(500, deps);
    expect(result).toEqual({ ok: false, reason: 'via-chain-unreadable' });
  });
});

describe('verifyAskpassPeer: cancellation', () => {
  it('stops and refuses with "aborted" when the caller\'s signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps: VerifyDeps = { ...makeDeps(goodProcs(), baseFilesystem()), signal: controller.signal };
    const result = await verifyAskpassPeer(500, deps);
    expect(result).toEqual({ ok: false, reason: 'aborted' });
  });
});

type Setup = (procs: Map<number, FakeProc>, fsMap: Map<string, ProcStat>, opts: NonNullable<Parameters<typeof makeDeps>[2]>) => void;
const SUDO = '/usr/bin/sudo';
describe('verifyAskpassPeer: refusals', () => {
  it.each<[string, Setup, string]>([
    ['a helper whose real exe is not process.execPath', (p) => { p.get(500)!.exePath = '/tmp/evil-node'; }, 'wrong-exe'],
    ['extra argv (e.g. --require)', (p) => { p.get(500)!.cmdline = [EXEC_PATH, '--require=/tmp/evil.js', HELPER_SCRIPT]; }, 'wrong-argv'],
    ['a helper argv pointing at the wrong script', (p) => { p.get(500)!.cmdline = [EXEC_PATH, '/tmp/not-the-real-askpass.cjs']; }, 'wrong-argv'],
    ['an extra environment variable (NODE_OPTIONS hijack)', (p) => { p.get(500)!.environ = new Map([...GOOD_ENVIRON, ['NODE_OPTIONS', '--require=/tmp/evil.js']]); }, 'wrong-env-keys'],
    ['a missing environment variable', (p) => { const e = new Map(GOOD_ENVIRON); e.delete('YOUCODED_ASKPASS_SOCKET'); p.get(500)!.environ = e; }, 'wrong-env-keys'],
    ['a traced helper (TracerPid != 0)', (p) => { p.get(500)!.tracerPid = 12345; }, 'traced'],
    // comm is set by the KERNEL from the executed file's basename; argv[0] could say anything.
    ['a fake sudo with the wrong basename', (p) => { p.get(400)!.comm = 'notsudo'; }, 'parent-not-sudo-basename'],
    // WHY: a real setuid sudo's /proc exe and environ are EACCES to us, so goodProcs() fakes both null; uids are what item 2 reads.
    ['a parent that never reached effective uid 0', (p) => { p.get(400)!.uids = { real: OUR_UID, effective: OUR_UID }; }, 'parent-euid-not-root'],
    ['a euid-0 parent that belongs to a different user', (p) => { p.get(400)!.uids = { real: OUR_UID + 1, effective: 0 }; }, 'parent-real-uid-mismatch'],
    ['a bare "sudo" argv[0] when no fixed install location exists here', (_p, f) => f.clear(), 'no-verified-sudo-candidate'],
    ['an absolute argv[0] failing the ownership chain, without falling back to a fixed location', (p, f) => {
      p.get(400)!.cmdline = ['/opt/vendor/sudo', 'apt', 'update'];
      f.set('/opt/vendor', ROOT_DIR_STAT); f.set('/opt', ROOT_DIR_STAT);
      f.set('/opt/vendor/sudo', { uid: 1000, mode: 0o4755, isFile: true, isDirectory: false }); // /usr/bin/sudo stays valid but is never consulted
    }, 'parent-not-root-owned'],
    ['a fake sudo that is not setuid', (_p, f) => { f.set(SUDO, { uid: 0, mode: 0o755, isFile: true, isDirectory: false }); }, 'parent-not-setuid'],
    ['a fake sudo not owned by root', (_p, f) => { f.set(SUDO, { uid: 1000, mode: 0o4755, isFile: true, isDirectory: false }); }, 'parent-not-root-owned'],
    ['a sudo that is group/other-writable', (_p, f) => { f.set(SUDO, { uid: 0, mode: 0o4757, isFile: true, isDirectory: false }); }, 'parent-writable-by-group-or-other'],
    ['a directory up the chain to / that is user-writable', (_p, f) => { f.set('/usr/bin', { uid: 0, mode: 0o777, isFile: false, isDirectory: true }); }, 'ancestor-dir-writable-by-group-or-other'],
    ['a directory up the chain that is not root-owned', (_p, f) => { f.set('/usr', { uid: 1000, mode: 0o755, isFile: false, isDirectory: true }); }, 'ancestor-dir-not-root-owned'],
    ['no ancestor being a registered call root', (_p, _f, o) => { o.registerRoot = { pid: 999, startTime: 1 }; }, 'no-registered-ancestor'],
    // 300 was reused for a new, unrelated process since the registering call exited.
    ['a recycled call-root pid (starttime disagrees with the registry)', (_p, _f, o) => { o.registerRoot = { pid: 300, startTime: 999999 }; }, 'call-root-starttime-mismatch'],
    ['the helper pid recycled mid-check', (_p, _f, o) => { o.mutateAfterFirstRead = new Set([500]); }, 'starttime-changed-mid-check'],
    ['the sudo pid recycled mid-check', (_p, _f, o) => { o.mutateAfterFirstRead = new Set([400]); }, 'starttime-changed-mid-check'],
    ['the call-root pid recycled mid-check', (_p, _f, o) => { o.mutateAfterFirstRead = new Set([300]); }, 'starttime-changed-mid-check'],
  ])('refuses %s', async (_n, setup, reason) => {
    const procs = goodProcs(); const fsMap = baseFilesystem(); const opts: Parameters<typeof makeDeps>[2] = {};
    setup(procs, fsMap, opts);
    expect(await verifyAskpassPeer(500, makeDeps(procs, fsMap, opts))).toEqual({ ok: false, reason });
  });

  it('accepts an ABSOLUTE argv[0] and validates that exact path (never a fixed-location fallback)', async () => {
    const procs = goodProcs();
    procs.get(400)!.cmdline = ['/opt/vendor/sudo', 'apt', 'update'];
    const statByPath = baseFilesystem();
    statByPath.delete('/usr/bin/sudo'); // proves the fixed-location list is never consulted when argv[0] is absolute
    statByPath.set('/opt/vendor', ROOT_DIR_STAT);
    statByPath.set('/opt', ROOT_DIR_STAT);
    statByPath.set('/opt/vendor/sudo', SUDO_EXE_STAT_OK);
    const result = await verifyAskpassPeer(500, makeDeps(procs, statByPath));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sudoExePath).toBe('/opt/vendor/sudo');
  });

  // WHY: bash.ts's foreground registerPid() is fire-and-forget async, so a command whose first statement is `sudo -A` can reach verification before it resolves; the chain must retry.
  it('accepts when the call root registers a little AFTER the ancestor walk starts, within the retry window', async () => {
    const procs = goodProcs();
    const deps = makeDeps(procs, baseFilesystem(), {
      skipRegister: true,
      registrationRetryMs: 500,
      registrationPollMs: 15,
    });
    setTimeout(() => {
      deps.runningCalls.register(300, 300_00, { sessionId: 's1', toolCallId: 't1' });
    }, 60);
    const result = await verifyAskpassPeer(500, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.callRoot).toBe(300);
  });

  it('still refuses with no-registered-ancestor once the retry window elapses and nothing ever registered', async () => {
    const procs = goodProcs();
    const deps = makeDeps(procs, baseFilesystem(), {
      skipRegister: true,
      registrationRetryMs: 80,
      registrationPollMs: 15,
    });
    const result = await verifyAskpassPeer(500, deps);
    expect(result).toEqual({ ok: false, reason: 'no-registered-ancestor' });
  });

  it('a recycled root pid registering during the retry window (wrong start time) is rejected, not accepted', async () => {
    const procs = goodProcs();
    const deps = makeDeps(procs, baseFilesystem(), {
      skipRegister: true,
      registrationRetryMs: 200,
      registrationPollMs: 15,
    });
    setTimeout(() => {
      // A DIFFERENT incarnation of pid 300 — its own real start time (per
      // FakeProcReader/goodProcs) is 300_00, not this stale value.
      deps.runningCalls.register(300, 999_99, { sessionId: 's1', toolCallId: 't1' });
    }, 40);
    const result = await verifyAskpassPeer(500, deps);
    expect(result).toEqual({ ok: false, reason: 'no-registered-ancestor' });
  });

  it('refuses a recycled call-root pid (starttime disagrees with the registry)', async () => {
    const procs = goodProcs();
    // RunningCalls remembers 300 starting at a DIFFERENT time than what's
    // live now — i.e. 300 was reused for a new, unrelated process since the
    // call that registered it exited.
    const deps = makeDeps(procs, baseFilesystem(), { registerRoot: { pid: 300, startTime: 999999 } });
    const result = await verifyAskpassPeer(500, deps);
    expect(result).toEqual({ ok: false, reason: 'call-root-starttime-mismatch' });
  });

  it('refuses when the helper pid is recycled mid-check (starttime changes)', async () => {
    const procs = goodProcs();
    const deps = makeDeps(procs, baseFilesystem(), { mutateAfterFirstRead: new Set([500]) });
    const result = await verifyAskpassPeer(500, deps);
    expect(result).toEqual({ ok: false, reason: 'starttime-changed-mid-check' });
  });

  it('refuses when the sudo pid is recycled mid-check (starttime changes)', async () => {
    const procs = goodProcs();
    const deps = makeDeps(procs, baseFilesystem(), { mutateAfterFirstRead: new Set([400]) });
    const result = await verifyAskpassPeer(500, deps);
    expect(result).toEqual({ ok: false, reason: 'starttime-changed-mid-check' });
  });

  it('refuses when the call-root pid is recycled mid-check (starttime changes)', async () => {
    const procs = goodProcs();
    const deps = makeDeps(procs, baseFilesystem(), { mutateAfterFirstRead: new Set([300]) });
    const result = await verifyAskpassPeer(500, deps);
    expect(result).toEqual({ ok: false, reason: 'starttime-changed-mid-check' });
  });

  it('refuses outright on macOS while MAC_ENABLED is false', async () => {
    const deps: VerifyDeps = { ...makeDeps(goodProcs(), baseFilesystem()), platform: 'darwin' };
    const result = await verifyAskpassPeer(500, deps);
    expect(result).toEqual({ ok: false, reason: 'macos-disabled' });
  });
});
