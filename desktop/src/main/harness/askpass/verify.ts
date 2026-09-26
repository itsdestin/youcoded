// verify.ts — design §3's whole verification chain, items 0–5, as one
// function. Everything AskpassServer does with a newly-accepted connection
// funnels through here once it has the kernel-verified peer pid (peer-
// cred.ts); this file never talks to a socket and never sees the helper's
// own claims about itself.
//
// Threat model (design §3 preamble): the model runs arbitrary code as the
// user. It may plant a fake `sudo` earlier in PATH, run our helper itself,
// point SUDO_ASKPASS at its own script, race a second connection claiming to
// be a waiting helper, or supply its own prompt text. Every check below
// closes exactly one of those, and ALL must hold or the whole thing refuses.
//
// `reason` strings are a closed, fixed set (never interpolated with
// anything read from the peer — env values, argv text, paths) so a caller
// can log them freely without ever leaking what it refused (design §3:
// "reason never contains env values").
'use strict';

import * as path from 'path';
import type { ProcReader, PidHandle } from './proc-info';
import { MAC_ENABLED } from './proc-info';
import type { RunningCalls } from './running-calls';

// knip: not exported — nothing outside this file names VerifyReason/VerifyOk/
// VerifyFail directly; only the VerifyResult union (still exported below) and
// VerifyDeps cross the module boundary.
type VerifyReason =
  | 'peer-unresolvable'
  | 'macos-disabled'
  | 'proc-read-failed'
  | 'wrong-exe'
  | 'wrong-argv'
  | 'wrong-env-keys'
  | 'wrong-env-value'
  | 'traced'
  | 'no-parent'
  | 'parent-not-sudo-basename'
  | 'parent-not-regular-file'
  | 'parent-not-root-owned'
  | 'parent-not-setuid'
  | 'parent-writable-by-group-or-other'
  | 'ancestor-dir-not-root-owned'
  | 'ancestor-dir-writable-by-group-or-other'
  | 'ancestor-dir-not-a-directory'
  | 'no-registered-ancestor'
  | 'call-root-starttime-mismatch'
  | 'starttime-changed-mid-check'
  /** T3-3: at least one hop between sudo and the call root exists (the
   *  ancestor walk found a registered root, so the chain itself is real),
   *  but reading that hop's own argv (to name the outermost script for
   *  `via`) failed. Distinct from `undefined` `via` — that value means
   *  "no script was involved at all", which this is NOT: a script chain
   *  exists, we just couldn't read its name, so this refuses rather than
   *  silently showing "direct" for an indirect call. */
  | 'via-chain-unreadable'
  /** T3-4: `deps.signal` was aborted (the caller gave up waiting, e.g. a
   *  timed-out connection) before the chain finished. Never reached by a
   *  caller that doesn't pass a signal. */
  | 'aborted';

interface VerifyOk {
  ok: true;
  /** The genuine sudo process that is P's parent. */
  sudoPid: number;
  /** sudo's own argv, read fresh (design §3 item 5) — the caller strips
   *  `sudo` and its options (shell-words WRAPPERS rules) to build card text.
   *  Never anything the helper or `-p` supplied. */
  sudoArgv: string[];
  /** The RunningCalls root pid this chain resolved to. */
  callRoot: number;
  /** The EXACT path this chain validated as the genuine setuid sudo (item 2)
   *  — never a PATH lookup. Task 5's forget step (design §5) runs `-K`
   *  against this path, never anything re-derived from PATH. */
  sudoExePath: string;
  /** Basename of the script sudo's own parent is running, set only when
   *  sudo's parent is NOT itself the call root (design §2.2: an
   *  intermediate script/subshell sits between the approved call and this
   *  particular sudo). Undefined for a direct `sudo …` from the approved
   *  shell. */
  via?: string;
}

interface VerifyFail {
  ok: false;
  reason: VerifyReason;
}

export type VerifyResult = VerifyOk | VerifyFail;

export interface VerifyDeps {
  reader: ProcReader;
  /** The running app's own real executable — `process.execPath`. P's real
   *  exe must equal this EXACTLY (design §3 item 1). */
  execPath: string;
  /** Real path of the shipped `askpass.cjs` — P's argv[1] must equal this
   *  EXACTLY. */
  helperScriptRealpath: string;
  runningCalls: RunningCalls;
  /** Defaults to `process.platform`; overridable for tests. */
  platform?: NodeJS.Platform;
  /** Longest ancestor walk (design §3 item 3). Defaults to 64. */
  maxAncestorSteps?: number;
  /** T3-4: checked between awaits so a caller that gave up (e.g. its own
   *  timeout elapsed) can make an in-flight chain stop promptly and release
   *  its pins, instead of running to completion unobserved. Optional —
   *  omitting it just means nothing can cancel this call early. */
  signal?: AbortSignal;
  /** Review fix T5-6: `registerPid` (bash.ts's foreground path) reads the
   *  new pid's start time ASYNCHRONOUSLY and is never awaited before the
   *  shell continues — a command whose very FIRST statement is `sudo -A …`
   *  can reach here before that read resolves, and the ancestor walk above
   *  would otherwise refuse a legitimate sudo outright (a false-negative
   *  ask failure, not a security gap either way). How long (ms) to keep
   *  re-checking the SAME already-walked pids for a registration that
   *  lands moments later, before finally refusing. Defaults to 1000ms;
   *  overridable for tests. 0 disables the retry (refuses immediately,
   *  the pre-fix behavior). */
  registrationRetryMs?: number;
  /** How often (ms) to re-check during `registrationRetryMs`. Defaults to
   *  50ms; overridable for tests. */
  registrationPollMs?: number;
}

/** T5-6: a plain timer wait — the retry window itself is the point, so
 *  unlike every OTHER wait in this file (which races a real read against
 *  `deps.signal`), this one has nothing to await except time passing. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The ONLY names design §3 item 1 allows in P's environment — anything
 *  else present, or either of these missing, is a refusal. Confirmed against
 *  the wrapper actually on this branch (`scripts/askpass/youcoded-askpass`):
 *  `exec /usr/bin/env -i ELECTRON_RUN_AS_NODE=1 YOUCODED_ASKPASS_SOCKET=… "$RUNTIME" "$SCRIPT"`
 *  — `env -i` sets exactly these two NAME=VALUE pairs and nothing else;
 *  `YOUCODED_ASKPASS_RUNTIME` is consumed positionally as the program to
 *  exec, so it is never itself an environment variable of the resulting
 *  process. The design's two-name allowlist was already exactly right —
 *  no third name to add. */
const ALLOWED_ENV_KEYS = new Set(['ELECTRON_RUN_AS_NODE', 'YOUCODED_ASKPASS_SOCKET']);

async function pin(reader: ProcReader, pid: number): Promise<PidHandle | null> {
  try {
    return await reader.pidfdOpen(pid);
  } catch {
    return null;
  }
}

function closeAll(handles: Array<PidHandle | null>): void {
  for (const h of handles) {
    try {
      h?.close();
    } catch {
      // best-effort pin release — never fails the caller
    }
  }
}

/** T3-4: true when `signal` says to stop. A plain function (not a thrown
 *  exception) so every call site stays a normal early `return` — which
 *  means it still runs every enclosing `finally` (pin release) exactly the
 *  way any other refusal does, with no separate cancellation-cleanup path
 *  to keep in sync. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Walk from `startExePath` up to `/`, requiring every directory component
 *  to be root-owned and not group/other-writable (design §3 item 2). The
 *  exe path itself was already checked by the caller. */
async function walkDirectoryChain(reader: ProcReader, startExePath: string): Promise<VerifyReason | null> {
  let dir = path.dirname(startExePath);
  // path.dirname('/') === '/', which is how this loop terminates.
  for (;;) {
    const st = await reader.statPath(dir);
    if (!st) return 'ancestor-dir-not-root-owned'; // unreadable directory in a root-owned chain is not the honest case — fail closed
    if (!st.isDirectory) return 'ancestor-dir-not-a-directory';
    if (st.uid !== 0) return 'ancestor-dir-not-root-owned';
    if (st.mode & 0o022) return 'ancestor-dir-writable-by-group-or-other';
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached '/'
    dir = parent;
  }
  return null;
}

/** basename of "the script that parent is running" (design §2.2's `via`
 *  example: `bash install.sh` → `install.sh`) — the last argument that
 *  doesn't look like a flag, falling back to argv[0] for a bare
 *  `sh`/`bash` with no script argument. This is a display label, not a
 *  security boundary — every check above it already decided whether to
 *  trust this pid; via just names what a human is looking at. */
function scriptBasenameFromArgv(argv: string[]): string | undefined {
  if (argv.length === 0) return undefined;
  for (let i = argv.length - 1; i >= 1; i--) {
    if (!argv[i].startsWith('-')) return path.basename(argv[i]);
  }
  return path.basename(argv[0]);
}

/**
 * The full chain, design §3 items 0–5, for a connection whose KERNEL peer
 * pid is `pid` (already resolved by peer-cred.ts — verify.ts trusts it as
 * given and never re-derives it).
 */
export async function verifyAskpassPeer(pid: number, deps: VerifyDeps): Promise<VerifyResult> {
  const platform = deps.platform ?? process.platform;
  const maxSteps = deps.maxAncestorSteps ?? 64;
  const { reader } = deps;

  // Design §3 item 1's macOS half ships switched off until KERN_PROCARGS2 is
  // proven on a real Mac with SIP on (design §3, review 2 E2). Refuse
  // outright rather than run a chain whose environment/argv reads cannot yet
  // be trusted on this platform.
  if (platform === 'darwin' && !MAC_ENABLED) {
    return { ok: false, reason: 'macos-disabled' };
  }
  if (aborted(deps.signal)) return { ok: false, reason: 'aborted' };

  // --- item 0 (part 1): pin + record P's own start time before reading
  // anything else about it. ---
  const helperPin = await pin(reader, pid);
  const helperStartTime0 = await reader.startTime(pid);
  if (helperStartTime0 === null) {
    closeAll([helperPin]);
    return { ok: false, reason: 'proc-read-failed' };
  }

  try {
    // --- item 1: P is our helper, unmodified. ---
    const exePath = await reader.exePath(pid);
    if (exePath === null) return { ok: false, reason: 'proc-read-failed' };
    if (exePath !== deps.execPath) return { ok: false, reason: 'wrong-exe' };

    const argv = await reader.cmdline(pid);
    if (argv === null) return { ok: false, reason: 'proc-read-failed' };
    if (argv.length !== 2 || argv[0] !== deps.execPath || argv[1] !== deps.helperScriptRealpath) {
      return { ok: false, reason: 'wrong-argv' };
    }

    const environ = await reader.environ(pid);
    if (environ === null) return { ok: false, reason: 'proc-read-failed' };
    if (environ.size !== ALLOWED_ENV_KEYS.size) return { ok: false, reason: 'wrong-env-keys' };
    for (const key of environ.keys()) {
      if (!ALLOWED_ENV_KEYS.has(key)) return { ok: false, reason: 'wrong-env-keys' };
    }
    if (environ.get('ELECTRON_RUN_AS_NODE') !== '1') return { ok: false, reason: 'wrong-env-value' };
    if (!environ.get('YOUCODED_ASKPASS_SOCKET')) return { ok: false, reason: 'wrong-env-value' };

    const tracerPid = await reader.tracerPid(pid);
    if (tracerPid !== 0) return { ok: false, reason: 'traced' };
    if (aborted(deps.signal)) return { ok: false, reason: 'aborted' };

    // --- item 2: P's parent is a genuine setuid sudo. ---
    const sudoPid = await reader.ppid(pid);
    if (sudoPid === null || sudoPid <= 1) return { ok: false, reason: 'no-parent' };

    const sudoPin = await pin(reader, sudoPid);
    const sudoStartTime0 = await reader.startTime(sudoPid);
    if (sudoStartTime0 === null) {
      closeAll([sudoPin]);
      return { ok: false, reason: 'proc-read-failed' };
    }

    try {
      const sudoExePath = await reader.exePath(sudoPid);
      if (sudoExePath === null) return { ok: false, reason: 'proc-read-failed' };
      if (path.basename(sudoExePath) !== 'sudo') return { ok: false, reason: 'parent-not-sudo-basename' };

      const sudoStat = await reader.statPath(sudoExePath);
      if (!sudoStat) return { ok: false, reason: 'proc-read-failed' };
      if (!sudoStat.isFile) return { ok: false, reason: 'parent-not-regular-file' };
      if (sudoStat.uid !== 0) return { ok: false, reason: 'parent-not-root-owned' };
      if (!(sudoStat.mode & 0o4000)) return { ok: false, reason: 'parent-not-setuid' };
      if (sudoStat.mode & 0o022) return { ok: false, reason: 'parent-writable-by-group-or-other' };

      const dirReason = await walkDirectoryChain(reader, sudoExePath);
      if (dirReason) return { ok: false, reason: dirReason };
      if (aborted(deps.signal)) return { ok: false, reason: 'aborted' };

      // --- item 3: P is inside a registered Bash call. `walked` records
      // EVERY pid checked, in order, ending with callRoot — T3-3 uses this
      // full chain to name the OUTERMOST script (the one the call root
      // itself directly ran), not just the one hop nearest sudo. ---
      let node = sudoPid;
      let callRoot: number | null = null;
      let callRootPin: PidHandle | null = null;
      let callRootStartTime0: number | null = null;
      const walked: number[] = [];
      try {
        for (let step = 0; step < maxSteps; step++) {
          if (aborted(deps.signal)) return { ok: false, reason: 'aborted' };
          walked.push(node);
          const entry = deps.runningCalls.lookup(node);
          if (entry) {
            // "RunningCalls stores the root's start time, so a recycled root
            // pid never matches" (review 2 E7) — compare the FRESH read
            // against what was recorded at registration time, not just
            // self-consistency across this one check.
            callRootPin = await pin(reader, node);
            callRootStartTime0 = await reader.startTime(node);
            if (callRootStartTime0 === null || callRootStartTime0 !== entry.startTime) {
              return { ok: false, reason: 'call-root-starttime-mismatch' };
            }
            callRoot = node;
            break;
          }
          const next = await reader.ppid(node);
          if (next === null || next <= 1) break;
          node = next;
        }
        // T5-6: no registered root on the first pass — before refusing,
        // retry the SAME already-walked pids (their own ppid chain cannot
        // change during this short window; only WHETHER one of them is
        // registered can) for up to `registrationRetryMs`, covering the
        // registerPid() race described on VerifyDeps.registrationRetryMs.
        if (callRoot === null) {
          const retryMs = deps.registrationRetryMs ?? 1_000;
          const pollMs = deps.registrationPollMs ?? 50;
          const deadline = Date.now() + retryMs;
          while (callRoot === null && Date.now() < deadline) {
            if (aborted(deps.signal)) return { ok: false, reason: 'aborted' };
            await sleep(pollMs);
            for (const p of walked) {
              const entry = deps.runningCalls.lookup(p);
              if (!entry) continue;
              const pin2 = await pin(reader, p);
              const startTime2 = await reader.startTime(p);
              if (startTime2 === null || startTime2 !== entry.startTime) {
                closeAll([pin2]);
                continue; // not a match after all — keep retrying/looking
              }
              callRootPin = pin2;
              callRootStartTime0 = startTime2;
              callRoot = p;
              break;
            }
          }
        }
        if (callRoot === null) return { ok: false, reason: 'no-registered-ancestor' };
        // Narrows callRootStartTime0 for TS below — logically implied by
        // callRoot being set (they're assigned together above), but the
        // compiler tracks the two variables independently.
        if (callRootStartTime0 === null) return { ok: false, reason: 'proc-read-failed' };

        // --- item 5: card text comes only from sudo's own argv. ---
        const sudoArgv = await reader.cmdline(sudoPid);
        if (sudoArgv === null) return { ok: false, reason: 'proc-read-failed' };

        // via names the OUTERMOST script under the call root (T3-3) — e.g.
        // call root → install.sh → helper.sh → sudo reports 'install.sh',
        // the thing the user actually approved running, even though sudo's
        // OWN immediate parent is helper.sh. `walked` is
        // [sudoPid, hop1, hop2, ..., callRoot]; length 1 means sudoPid
        // itself was the registered root (no parent chain to speak of);
        // length 2 means sudoPid's own parent IS callRoot (the simple,
        // direct case R20 exists for — no script in between); length >= 3
        // means at least one script sits between them, and
        // walked[walked.length - 2] is the outermost one (its OWN parent is
        // callRoot). A read failure at that pid is NOT the same as "no
        // script involved" — silently returning `via: undefined` there
        // would show "direct" for a call that visibly is not, so this
        // refuses instead (T3-3's second half).
        let via: string | undefined;
        if (walked.length >= 3) {
          const outermostPid = walked[walked.length - 2];
          const outermostArgv = await reader.cmdline(outermostPid);
          if (outermostArgv === null) return { ok: false, reason: 'via-chain-unreadable' };
          via = scriptBasenameFromArgv(outermostArgv);
        } else {
          via = undefined;
        }

        // --- item 0 (part 2): re-read every pinned start time; ANY change
        // discards the whole verification, however unlikely the race. ---
        const [helperStartTime1, sudoStartTime1, callRootStartTime1] = await Promise.all([
          reader.startTime(pid),
          reader.startTime(sudoPid),
          reader.startTime(callRoot),
        ]);
        if (
          helperStartTime1 !== helperStartTime0 ||
          sudoStartTime1 !== sudoStartTime0 ||
          callRootStartTime1 !== callRootStartTime0
        ) {
          return { ok: false, reason: 'starttime-changed-mid-check' };
        }

        return { ok: true, sudoPid, sudoArgv, callRoot, via, sudoExePath };
      } finally {
        closeAll([callRootPin]);
      }
    } finally {
      closeAll([sudoPin]);
    }
  } finally {
    closeAll([helperPin]);
  }
}
