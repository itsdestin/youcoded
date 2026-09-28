// admin-capability.ts — Destin, 2026-09-26: "this must never feel broken, and
// the model's guidance must always be true on the machine in use." ONE value,
// settled ONCE at app start, decides which of the three Bash-description
// sentences (bash.ts) every session on this machine ever sees. Nothing here
// re-derives per session: the whole point is that a session started in the
// first moments of the app's life must get the SAME answer a session started
// an hour later gets — never a stale placeholder that outlives its own call.
'use strict';

import { spawn as spawnImpl } from 'child_process';
import { log } from '../logger';
import { createProcReader } from './askpass/proc-info';
import type { ProcReader } from './askpass/proc-info';
import { firstExistingKnownSudoPath } from './askpass/verify';

export type AdminCapability = 'card' | 'no-password-only' | 'windows';

// ---------------------------------------------------------------------------
// The settled singleton — one per app process, ever.
// ---------------------------------------------------------------------------

let resolveReady: ((capability: AdminCapability) => void) | null = null;
function freshReadyPromise(): Promise<AdminCapability> {
  return new Promise<AdminCapability>((resolve) => {
    resolveReady = resolve;
  });
}
let readyPromise: Promise<AdminCapability> = freshReadyPromise();
let settledCapability: AdminCapability | null = null;

/** Called exactly once, from ipc-handlers.ts's app-start wiring, once every
 *  check that decides the answer has finished (the askpass self-test, the
 *  sudo-flavour probe, or an immediate platform-only answer for macOS/
 *  Windows, which need neither). A second call is a no-op — this value
 *  never changes for the rest of the app's life, by design (design doc,
 *  "Per-machine guidance and refusals"). */
export function settleAdminCapability(capability: AdminCapability): void {
  if (settledCapability !== null) return;
  settledCapability = capability;
  resolveReady?.(capability);
  resolveReady = null;
}

/** Awaited before a session may be created (ipc-handlers.ts's session-start
 *  entry points) — resolves the instant `settleAdminCapability` runs, and
 *  never before. A session created while this is still pending would
 *  otherwise read `getSettledAdminCapability()`'s placeholder default and
 *  keep it, byte-identical, for its own whole life (prompt cache) — this is
 *  what stops that. */
export function adminCapabilityReady(): Promise<AdminCapability> {
  // WHY a deadline: session creation awaits this. If the startup check ever
  // stalls (a hung helper lookup, an unexpected throw upstream), conversations
  // must never hang with it — after READY_DEADLINE_MS the app settles on the
  // conservative answer, which only ever under-promises (sudo still runs
  // without a password; the card just never appears this run).
  if (settledCapability === null && !deadlineArmed) {
    deadlineArmed = true;
    const timer = setTimeout(() => {
      if (settledCapability !== null) return;
      log('WARN', 'AdminCapability', 'startup check did not finish in time — settling on no-password-only');
      settleAdminCapability('no-password-only');
    }, READY_DEADLINE_MS);
    timer.unref?.();
  }
  return readyPromise;
}
const READY_DEADLINE_MS = 10_000;
let deadlineArmed = false;

/** Synchronous read for bash.ts's description getter. Every call site that
 *  can reach it is gated behind `adminCapabilityReady()` having already
 *  resolved (session creation) — reading before settling should be
 *  unreachable in production; the fallback is the SAME conservative
 *  no-password answer a failed self-test already produces, never a throw. */
export function getSettledAdminCapability(): AdminCapability {
  return settledCapability ?? 'no-password-only';
}

/** Test-only: resets the module's singleton state between test files/cases —
 *  otherwise the first test to settle a value in a shared module instance
 *  would pin it for every test after it in the same run. */
export function resetAdminCapabilityForTests(): void {
  settledCapability = null;
  deadlineArmed = false;
  readyPromise = freshReadyPromise();
}

// ---------------------------------------------------------------------------
// Detection — the sudo-flavour half only. The askpass self-test half is
// whatever ipc-handlers.ts's own AskpassServer.start() already decided
// (constructing a SECOND server here just to re-run that self-test would be
// needless risk for zero benefit, the same reasoning design §11 task 5
// already applied to the platform gate itself) — this function is handed
// that outcome rather than recomputing it.
// ---------------------------------------------------------------------------

/** Todd Miller's sudo prints exactly this on the FIRST line of `--version`
 *  (empirically confirmed on this session's own dev machine, 2026-09-26:
 *  "Sudo version 1.9.17p2"). sudo-rs (memorysafety/sudo-rs) prints a
 *  DIFFERENT string entirely (its own crate/version banner, not "Sudo
 *  version …") — this regex simply never matches it, which is exactly the
 *  point: "treat sudo-rs or anything unrecognised as unsupported until
 *  proven" (coordinator, 2026-09-26). Never widen this to match on
 *  anything looser than the exact phrase original sudo uses. */
const ORIGINAL_SUDO_VERSION_LINE = /^Sudo version (\d+)\.(\d+)/;

export type SudoFlavour = 'supported' | 'unsupported' | 'missing';

/** Runs ONLY `sudo --version` — never authenticates, never reads a password.
 *  `-V`/`--version` never invokes sudo's authentication path at all (confirmed
 *  empirically: `env -i /usr/bin/sudo --version < /dev/null` exits 0
 *  immediately with the version banner — no hang, no prompt). Belt-and-
 *  suspenders anyway, never relied on alone: stdin is explicitly `'ignore'`
 *  (there is nothing to read even if some future build ever tried) and a
 *  timeout kills a child that somehow still doesn't exit. Never throws;
 *  resolves null on any failure (missing binary, non-zero exit, timeout). */
function readSudoVersionFirstLine(sudoPath: string, spawnFn: typeof spawnImpl = spawnImpl): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawnImpl>;
    try {
      // `env: {}` — never hands the child anything of ours (matches the
      // clean-env posture `env -i` gave the manual verification run);
      // `stdio: ['ignore', 'pipe', 'ignore']` closes stdin outright.
      child = spawnFn(sudoPath, ['--version'], { env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish(null);
    }, 3_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? (stdout.split('\n')[0] ?? '') : null);
    });
  });
}

/** Finds sudo at one of the fixed, never-$PATH-derived locations
 *  `verify.ts` also uses (never re-derived independently — one list), and
 *  classifies what it prints for `--version`. `'missing'` covers both "no
 *  candidate exists here" and every candidate failing to even run. */
export async function detectSudoFlavour(reader: ProcReader, spawnFn: typeof spawnImpl = spawnImpl): Promise<SudoFlavour> {
  const sudoPath = await firstExistingKnownSudoPath(reader);
  if (!sudoPath) return 'missing';
  const firstLine = await readSudoVersionFirstLine(sudoPath, spawnFn);
  if (firstLine === null) return 'missing';
  const match = ORIGINAL_SUDO_VERSION_LINE.exec(firstLine);
  if (!match) return 'unsupported'; // sudo-rs, or anything else unrecognised
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const supported = major > 1 || (major === 1 && minor >= 8);
  return supported ? 'supported' : 'unsupported';
}

export interface DetectAdminCapabilityDeps {
  platform?: NodeJS.Platform;
  reader?: ProcReader;
  spawnFn?: typeof spawnImpl;
  /** Whether AskpassServer's OWN startup self-test (peer-cred resolution)
   *  already passed — Linux only; ignored on every other platform. Required
   *  (no default) so a caller can never forget to pass the real outcome. */
  askpassSelfTestPassed: boolean;
}

/** The one computation `settleAdminCapability` is fed from. Windows needs
 *  neither read (sudo there, when the user enables it, is Windows' own
 *  permission window — nothing this app can verify or intercept); macOS
 *  stays `'no-password-only'` while `MAC_ENABLED` (verify.ts) is off, same
 *  as it always has. */
export async function detectAdminCapability(deps: DetectAdminCapabilityDeps): Promise<AdminCapability> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return 'windows';
  if (platform !== 'linux') return 'no-password-only';
  if (!deps.askpassSelfTestPassed) return 'no-password-only';
  const reader = deps.reader ?? createProcReader('linux');
  const flavour = await detectSudoFlavour(reader, deps.spawnFn ?? spawnImpl);
  if (flavour !== 'supported') {
    log('WARN', 'AdminCapability', 'sudo present but not a supported flavour — password card stays off', { flavour });
    return 'no-password-only';
  }
  return 'card';
}
