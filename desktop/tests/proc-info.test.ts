// proc-info.test.ts — Destin's real-machine bug report (2026-09-26): every
// real sudo was refused with 'proc-read-failed' because verify.ts's old
// item 2 read /proc/<sudoPid>/exe — unreadable (EACCES) for a setuid-root
// process even when our own real uid matches its real uid, because the
// kernel clears "dumpable" on any privilege-elevating exec. This runs the
// REAL Linux ProcReader against pid 1 — always present, always root-owned,
// never requiring us to run sudo ourselves — to prove empirically which
// reads verify.ts's redesigned parent check can actually rely on.
import { describe, it, expect } from 'vitest';
import { createProcReader } from '../src/main/harness/askpass/proc-info';

describe('createProcReader (linux): what is actually readable for a root-owned process we did not create', () => {
  const reader = createProcReader('linux');

  it.skipIf(process.platform !== 'linux')('exe and environ of pid 1 are unreadable (null) — the read the old check depended on', async () => {
    // pid 1 is always root-owned and always present on a running Linux
    // system; a non-root reader hitting EACCES on both of these is exactly
    // the failure a real sudo call hit in production, just against a
    // process we don't need sudo to reach.
    expect(await reader.exePath(1)).toBeNull();
    expect(await reader.environ(1)).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')('status/comm/cmdline/stat of pid 1 stay readable — what the redesigned check uses instead', async () => {
    const uids = await reader.uids(1);
    expect(uids).not.toBeNull();
    // pid 1 runs fully as root; effective uid 0 is exactly the signal item
    // 2 now looks for (though real uid won't equal OUR uid here — pid 1
    // isn't ours, unlike a real sudo call, which is why item 2 ALSO checks
    // real uid match, not effective alone).
    expect(uids?.effective).toBe(0);

    const comm = await reader.comm(1);
    expect(comm).not.toBeNull();
    expect(typeof comm).toBe('string');
    expect(comm!.length).toBeGreaterThan(0);

    expect(await reader.cmdline(1)).not.toBeNull();
    expect(await reader.startTime(1)).not.toBeNull();
    expect(await reader.ppid(1)).not.toBeNull();
  });
});
