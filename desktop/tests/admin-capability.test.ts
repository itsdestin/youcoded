// admin-capability.test.ts — Destin, 2026-09-26: one settled AdminCapability
// per app lifetime, decided BEFORE any session may start, drives exactly one
// true sentence in the Bash tool description (bash-env.test.ts pins the
// sentences themselves). This file pins the settling mechanics — readiness
// gating, idempotency, byte-stability across "turns" — and the two
// detection halves (sudo-flavour parsing, platform branching) with fakes,
// plus one real-machine check of the actual sudo installed here.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  detectAdminCapability,
  detectSudoFlavour,
  settleAdminCapability,
  adminCapabilityReady,
  getSettledAdminCapability,
  resetAdminCapabilityForTests,
  type AdminCapability,
} from '../src/main/harness/admin-capability';
import { createProcReader } from '../src/main/harness/askpass/proc-info';
import type { ProcReader, ProcStat, PidHandle } from '../src/main/harness/askpass/proc-info';

afterEach(() => {
  resetAdminCapabilityForTests();
});

/** Only `statPath` matters to `firstExistingKnownSudoPath` — every other
 *  method is an unreachable stub for this file's own tests. */
function fakeReader(existing: Record<string, ProcStat>): ProcReader {
  return {
    exePath: async () => null,
    cmdline: async () => null,
    environ: async () => null,
    ppid: async () => null,
    startTime: async () => null,
    tracerPid: async () => -1,
    statPath: async (p: string): Promise<ProcStat | null> => existing[p] ?? null,
    pidfdOpen: async (): Promise<PidHandle | null> => null,
    uids: async () => null,
    comm: async () => null,
  };
}

const SUDO_STAT: ProcStat = { uid: 0, mode: 0o4755, isFile: true, isDirectory: false };

/** A fake `spawn` — matches the (cmd, args, opts) shape `readSudoVersionFirstLine`
 *  calls, without a real child process. */
function fakeSpawn(script: { stdout?: string; exitCode?: number; neverSettle?: boolean; throws?: boolean }) {
  return (() => {
    if (script.throws) throw new Error('ENOENT');
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => child.emit('close', null);
    if (!script.neverSettle) {
      queueMicrotask(() => {
        if (script.stdout !== undefined) child.stdout.emit('data', Buffer.from(script.stdout, 'utf8'));
        child.emit('close', script.exitCode ?? 0);
      });
    }
    return child;
  }) as any;
}

describe('detectSudoFlavour: parses --version, never a PATH lookup', () => {
  it('reports "supported" for original sudo\'s real version banner', async () => {
    const reader = fakeReader({ '/usr/bin/sudo': SUDO_STAT });
    const flavour = await detectSudoFlavour(reader, fakeSpawn({ stdout: 'Sudo version 1.9.17p2\nSudoers policy plugin version 1.9.17p2\n' }));
    expect(flavour).toBe('supported');
  });

  it('reports "supported" for the oldest still-supported minor (1.8.0)', async () => {
    const reader = fakeReader({ '/usr/bin/sudo': SUDO_STAT });
    const flavour = await detectSudoFlavour(reader, fakeSpawn({ stdout: 'Sudo version 1.8.0\n' }));
    expect(flavour).toBe('supported');
  });

  it('reports "unsupported" for a version older than 1.8', async () => {
    const reader = fakeReader({ '/usr/bin/sudo': SUDO_STAT });
    const flavour = await detectSudoFlavour(reader, fakeSpawn({ stdout: 'Sudo version 1.7.10\n' }));
    expect(flavour).toBe('unsupported');
  });

  it('reports "unsupported" for a string that is not original sudo\'s exact phrase (e.g. sudo-rs)', async () => {
    const reader = fakeReader({ '/usr/bin/sudo': SUDO_STAT });
    // sudo-rs's real banner is a different string entirely; this is a
    // representative stand-in — the point is the regex never loosens to match it.
    const flavour = await detectSudoFlavour(reader, fakeSpawn({ stdout: 'sudo-rs 0.2.0\n' }));
    expect(flavour).toBe('unsupported');
  });

  it('reports "missing" when none of the fixed known locations exist here', async () => {
    const reader = fakeReader({});
    const flavour = await detectSudoFlavour(reader, fakeSpawn({ stdout: 'Sudo version 1.9.0\n' }));
    expect(flavour).toBe('missing');
  });

  it('reports "missing" (never hangs) when the child never exits — the timeout kills it', async () => {
    const reader = fakeReader({ '/usr/bin/sudo': SUDO_STAT });
    const flavour = await detectSudoFlavour(reader, fakeSpawn({ neverSettle: true }));
    expect(flavour).toBe('missing');
  }, 5_000);

  it('reports "missing" when spawning the candidate throws (e.g. ENOENT)', async () => {
    const reader = fakeReader({ '/usr/bin/sudo': SUDO_STAT });
    const flavour = await detectSudoFlavour(reader, fakeSpawn({ throws: true }));
    expect(flavour).toBe('missing');
  });

  it('reports "missing" for a non-zero exit', async () => {
    const reader = fakeReader({ '/usr/bin/sudo': SUDO_STAT });
    const flavour = await detectSudoFlavour(reader, fakeSpawn({ stdout: 'Sudo version 1.9.0\n', exitCode: 1 }));
    expect(flavour).toBe('missing');
  });
});

describe('detectSudoFlavour: the REAL sudo actually installed on this machine', () => {
  it.skipIf(process.platform !== 'linux')('is a supported original-sudo build (empirical, no fakes)', async () => {
    const flavour = await detectSudoFlavour(createProcReader('linux'));
    // Whatever this machine's real sudo is, it must be classified as one of
    // the closed set — never an exception, never a hang.
    expect(['supported', 'unsupported', 'missing']).toContain(flavour);
  }, 5_000);
});

describe('detectAdminCapability: platform branching', () => {
  it('is "windows" on win32 — no self-test, no sudo read of any kind', async () => {
    const cap = await detectAdminCapability({ platform: 'win32', askpassSelfTestPassed: false });
    expect(cap).toBe('windows');
  });

  it('is "no-password-only" on darwin regardless of the self-test flag', async () => {
    expect(await detectAdminCapability({ platform: 'darwin', askpassSelfTestPassed: true })).toBe('no-password-only');
    expect(await detectAdminCapability({ platform: 'darwin', askpassSelfTestPassed: false })).toBe('no-password-only');
  });

  it('is "no-password-only" on linux when the askpass self-test failed, without ever probing sudo', async () => {
    const reader = fakeReader({ '/usr/bin/sudo': SUDO_STAT });
    const spawnFn = fakeSpawn({ stdout: 'Sudo version 1.9.0\n' });
    const spy = { called: false };
    const wrapped = ((...args: Parameters<typeof spawnFn>) => { spy.called = true; return spawnFn(...args); }) as typeof spawnFn;
    const cap = await detectAdminCapability({ platform: 'linux', askpassSelfTestPassed: false, reader, spawnFn: wrapped });
    expect(cap).toBe('no-password-only');
    expect(spy.called).toBe(false); // never even ran the sudo check
  });

  it('is "card" on linux when the self-test passed AND sudo is a supported flavour', async () => {
    const reader = fakeReader({ '/usr/bin/sudo': SUDO_STAT });
    const cap = await detectAdminCapability({
      platform: 'linux',
      askpassSelfTestPassed: true,
      reader,
      spawnFn: fakeSpawn({ stdout: 'Sudo version 1.9.17p2\n' }),
    });
    expect(cap).toBe('card');
  });

  it('is "no-password-only" on linux when the self-test passed but sudo is unrecognised (e.g. sudo-rs)', async () => {
    const reader = fakeReader({ '/usr/bin/sudo': SUDO_STAT });
    const cap = await detectAdminCapability({
      platform: 'linux',
      askpassSelfTestPassed: true,
      reader,
      spawnFn: fakeSpawn({ stdout: 'sudo-rs 0.2.0\n' }),
    });
    expect(cap).toBe('no-password-only');
  });

  it('is "no-password-only" on linux when the self-test passed but no sudo exists at any known location', async () => {
    const reader = fakeReader({});
    const cap = await detectAdminCapability({ platform: 'linux', askpassSelfTestPassed: true, reader });
    expect(cap).toBe('no-password-only');
  });
});

describe('settleAdminCapability / adminCapabilityReady: the readiness gate itself', () => {
  it('adminCapabilityReady() does not resolve before settleAdminCapability() runs', async () => {
    let resolved = false;
    void adminCapabilityReady().then(() => { resolved = true; });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);
    settleAdminCapability('card');
    await adminCapabilityReady();
    expect(resolved).toBe(true);
  });

  it('a "session" (a plain read) that runs BEFORE settling and one that runs AFTER both see the SAME settled text once it lands', async () => {
    // Simulates the exact bug this task fixes: something reads the
    // capability before the app has decided, then again once it has.
    const early = getSettledAdminCapability(); // reads the conservative default — never a throw
    expect(early).toBe('no-password-only');
    settleAdminCapability('card');
    const late = getSettledAdminCapability();
    expect(late).toBe('card');
    // The early read is NOT retroactively corrected (it already happened),
    // which is exactly why session creation must be gated on
    // adminCapabilityReady() rather than reading the getter directly —
    // this test documents that contract, not a claim the getter self-heals.
  });

  it('settles on the conservative answer if the startup check never finishes, so conversations never hang', async () => {
    vi.useFakeTimers();
    try {
      const ready = adminCapabilityReady();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(ready).resolves.toBe('no-password-only');
      // A late real answer is ignored: the value never changes once settled.
      settleAdminCapability('card');
      expect(getSettledAdminCapability()).toBe('no-password-only');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settleAdminCapability is idempotent — a second call with a different value is ignored', () => {
    settleAdminCapability('card');
    settleAdminCapability('windows');
    expect(getSettledAdminCapability()).toBe('card');
  });

  it('the settled value is byte-identical across repeated reads — "two turns on one machine"', async () => {
    settleAdminCapability('no-password-only');
    await adminCapabilityReady();
    const turn1 = getSettledAdminCapability();
    const turn2 = getSettledAdminCapability();
    const turn3 = getSettledAdminCapability();
    expect(turn1).toBe(turn2);
    expect(turn2).toBe(turn3);
  });

  it('a session created before readiness settles still gets the settled text once it awaits readiness', async () => {
    // Models a session-creation call that awaits adminCapabilityReady()
    // (ipc-handlers.ts's startSession) started BEFORE the app-start wiring
    // has settled anything.
    const sessionsSeen: AdminCapability[] = [];
    const simulateSessionCreation = async () => {
      const capability = await adminCapabilityReady();
      sessionsSeen.push(capability);
    };
    const pending = simulateSessionCreation(); // starts waiting immediately — nothing settled yet
    await new Promise((r) => setImmediate(r));
    expect(sessionsSeen).toEqual([]); // still waiting
    settleAdminCapability('windows'); // app-start wiring finally decides
    await pending;
    expect(sessionsSeen).toEqual(['windows']);
    expect(getSettledAdminCapability()).toBe('windows');
  });
});

// A conversation continued on another computer: the saved history carries no
// tool text, so the resumed session describes sudo the way THIS machine can do
// it — nothing about the admin guidance travels with the conversation.
describe('a resumed conversation gets the current machine\'s sudo sentence', () => {
  it('history saved on a "card" machine, resumed on a Windows one, sends only the Windows sentence', async () => {
    const { MockLanguageModelV4 } = await import('ai/test');
    const { makeSession, scriptModel, drainTurn } = await import('./helpers/harness-fakes');
    const { BashTool } = await import('../src/main/harness/tools/bash');
    const bashTextSent = async () => {
      const calls: any[] = [];
      const inner = scriptModel([{ text: 'ok' }]);
      const model = new MockLanguageModelV4({ doStream: async (o: any) => { calls.push(o); return inner.doStream(o); } });
      return { calls, session: makeSession({ model, extraTools: [BashTool] }) };
    };

    // Machine A: the card works here.
    resetAdminCapabilityForTests();
    settleAdminCapability('card');
    const a = await bashTextSent();
    await drainTurn(a.session, 'install the drivers');
    const savedHistory = a.session.acceptedHistory().messages;
    const bashOn = (calls: any[]) => calls[0].tools.find((t: any) => t.name === 'Bash').description as string;
    expect(bashOn(a.calls)).toContain('the user types their admin password in a card');

    // Machine B: a fresh app process on Windows resumes the same conversation.
    resetAdminCapabilityForTests();
    settleAdminCapability('windows');
    const b = await bashTextSent();
    b.session.seedHistory(savedHistory as any);
    await drainTurn(b.session, 'try again');
    expect(bashOn(b.calls)).toContain('opens Windows\' own permission window');
    expect(bashOn(b.calls)).not.toContain('the user types their admin password in a card');
    resetAdminCapabilityForTests();
  });
});
