// askpass-verify.test.ts — design §3, §9: every refusal reason
// verifyAskpassPeer can return, driven by a fake ProcReader (no real /proc,
// no real sudo), plus the accept path with and without `via`.
import { describe, it, expect } from 'vitest';
import { verifyAskpassPeer, type VerifyDeps } from '../src/main/harness/askpass/verify';
import { RunningCalls } from '../src/main/harness/askpass/running-calls';
import type { ProcReader, ProcStat, PidHandle } from '../src/main/harness/askpass/proc-info';

const EXEC_PATH = '/opt/YouCoded/youcoded';
const HELPER_SCRIPT = '/opt/YouCoded/resources/app.asar.unpacked/scripts/askpass/askpass.cjs';

interface FakeProc {
  ppid: number | null;
  exePath: string | null;
  cmdline: string[] | null;
  environ: Map<string, string> | null;
  startTime: number | null;
  tracerPid: number;
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
}

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
      },
    ],
    [
      400,
      {
        ppid: 300,
        exePath: '/usr/bin/sudo',
        cmdline: ['sudo', 'apt', 'update'],
        environ: null,
        startTime: 400_00,
        tracerPid: 0,
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
      },
    ],
  ]);
}

function makeDeps(
  procs: Map<number, FakeProc>,
  statByPath: Map<string, ProcStat>,
  opts?: { registerRoot?: { pid: number; startTime: number }; mutateAfterFirstRead?: Set<number> },
): VerifyDeps {
  const runningCalls = new RunningCalls();
  const registerRoot = opts?.registerRoot ?? { pid: 300, startTime: 300_00 };
  runningCalls.register(registerRoot.pid, registerRoot.startTime, { sessionId: 's1', toolCallId: 't1' });
  return {
    reader: new FakeProcReader(procs, statByPath, opts?.mutateAfterFirstRead),
    execPath: EXEC_PATH,
    helperScriptRealpath: HELPER_SCRIPT,
    runningCalls,
    platform: 'linux',
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
    procs.set(350, {
      ppid: 300,
      exePath: '/bin/bash',
      cmdline: ['bash', 'install.sh'],
      environ: null,
      startTime: 350_00,
      tracerPid: 0,
    });
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
    procs.set(350, {
      ppid: 360,
      exePath: '/bin/bash',
      cmdline: ['bash', 'helper.sh'],
      environ: null,
      startTime: 350_00,
      tracerPid: 0,
    });
    procs.set(360, {
      ppid: 300,
      exePath: '/bin/bash',
      cmdline: ['bash', 'install.sh'],
      environ: null,
      startTime: 360_00,
      tracerPid: 0,
    });
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
    procs.set(350, {
      ppid: 300,
      exePath: '/bin/bash',
      cmdline: null, // simulates a transient /proc/<pid>/cmdline read failure
      environ: null,
      startTime: 350_00,
      tracerPid: 0,
    });
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

describe('verifyAskpassPeer: refusals', () => {
  it('refuses a helper whose real exe is not process.execPath', async () => {
    const procs = goodProcs();
    procs.get(500)!.exePath = '/tmp/evil-node';
    const result = await verifyAskpassPeer(500, makeDeps(procs, baseFilesystem()));
    expect(result).toEqual({ ok: false, reason: 'wrong-exe' });
  });

  it('refuses extra argv (e.g. --require)', async () => {
    const procs = goodProcs();
    procs.get(500)!.cmdline = [EXEC_PATH, '--require=/tmp/evil.js', HELPER_SCRIPT];
    const result = await verifyAskpassPeer(500, makeDeps(procs, baseFilesystem()));
    expect(result).toEqual({ ok: false, reason: 'wrong-argv' });
  });

  it('refuses a helper argv pointing at the wrong script', async () => {
    const procs = goodProcs();
    procs.get(500)!.cmdline = [EXEC_PATH, '/tmp/not-the-real-askpass.cjs'];
    const result = await verifyAskpassPeer(500, makeDeps(procs, baseFilesystem()));
    expect(result).toEqual({ ok: false, reason: 'wrong-argv' });
  });

  it('refuses an extra environment variable (NODE_OPTIONS hijack)', async () => {
    const procs = goodProcs();
    const environ = new Map(GOOD_ENVIRON);
    environ.set('NODE_OPTIONS', '--require=/tmp/evil.js');
    procs.get(500)!.environ = environ;
    const result = await verifyAskpassPeer(500, makeDeps(procs, baseFilesystem()));
    expect(result).toEqual({ ok: false, reason: 'wrong-env-keys' });
  });

  it('refuses a missing environment variable', async () => {
    const procs = goodProcs();
    const environ = new Map(GOOD_ENVIRON);
    environ.delete('YOUCODED_ASKPASS_SOCKET');
    procs.get(500)!.environ = environ;
    const result = await verifyAskpassPeer(500, makeDeps(procs, baseFilesystem()));
    expect(result).toEqual({ ok: false, reason: 'wrong-env-keys' });
  });

  it('refuses a traced helper (TracerPid != 0)', async () => {
    const procs = goodProcs();
    procs.get(500)!.tracerPid = 12345;
    const result = await verifyAskpassPeer(500, makeDeps(procs, baseFilesystem()));
    expect(result).toEqual({ ok: false, reason: 'traced' });
  });

  it('refuses a fake sudo with the wrong basename', async () => {
    const procs = goodProcs();
    procs.get(400)!.exePath = '/usr/bin/notsudo';
    const statByPath = baseFilesystem();
    statByPath.set('/usr/bin/notsudo', SUDO_EXE_STAT_OK);
    const result = await verifyAskpassPeer(500, makeDeps(procs, statByPath));
    expect(result).toEqual({ ok: false, reason: 'parent-not-sudo-basename' });
  });

  it('refuses a fake sudo that is not setuid', async () => {
    const statByPath = baseFilesystem();
    statByPath.set('/usr/bin/sudo', { uid: 0, mode: 0o755, isFile: true, isDirectory: false });
    const result = await verifyAskpassPeer(500, makeDeps(goodProcs(), statByPath));
    expect(result).toEqual({ ok: false, reason: 'parent-not-setuid' });
  });

  it('refuses a fake sudo not owned by root', async () => {
    const statByPath = baseFilesystem();
    statByPath.set('/usr/bin/sudo', { uid: 1000, mode: 0o4755, isFile: true, isDirectory: false });
    const result = await verifyAskpassPeer(500, makeDeps(goodProcs(), statByPath));
    expect(result).toEqual({ ok: false, reason: 'parent-not-root-owned' });
  });

  it('refuses when sudo itself is group/other-writable', async () => {
    const statByPath = baseFilesystem();
    statByPath.set('/usr/bin/sudo', { uid: 0, mode: 0o4757, isFile: true, isDirectory: false });
    const result = await verifyAskpassPeer(500, makeDeps(goodProcs(), statByPath));
    expect(result).toEqual({ ok: false, reason: 'parent-writable-by-group-or-other' });
  });

  it('refuses when a directory anywhere up the chain to / is user-writable', async () => {
    const statByPath = baseFilesystem();
    statByPath.set('/usr/bin', { uid: 0, mode: 0o777, isFile: false, isDirectory: true });
    const result = await verifyAskpassPeer(500, makeDeps(goodProcs(), statByPath));
    expect(result).toEqual({ ok: false, reason: 'ancestor-dir-writable-by-group-or-other' });
  });

  it('refuses when a directory anywhere up the chain is not root-owned', async () => {
    const statByPath = baseFilesystem();
    statByPath.set('/usr', { uid: 1000, mode: 0o755, isFile: false, isDirectory: true });
    const result = await verifyAskpassPeer(500, makeDeps(goodProcs(), statByPath));
    expect(result).toEqual({ ok: false, reason: 'ancestor-dir-not-root-owned' });
  });

  it('refuses when no ancestor is a registered call root', async () => {
    const procs = goodProcs();
    // Registered root (300) is never reached because the call root the test
    // registers below doesn't match anything in this process tree.
    const deps = makeDeps(procs, baseFilesystem(), { registerRoot: { pid: 999, startTime: 1 } });
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
