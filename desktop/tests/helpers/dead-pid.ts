// A process id nothing is running as, found by asking the operating system.
// WHY: tests used the literal 999999 as "a process that is long gone". Linux here allows pids up to 4,194,304 and hands them out round robin, so
// 999999 is a REAL process some of the time (it was, in a full run on 2026-10-01) and "dead owner" tests failed at random.
export function deadPid(): number {
  for (let pid = 4_194_000; pid > 3_000_000; pid -= 7) {
    try { process.kill(pid, 0); } catch (e: any) { if (e?.code === 'ESRCH') return pid; }
  }
  return 2_999_999;
}
