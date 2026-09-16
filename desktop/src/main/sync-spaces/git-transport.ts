// desktop/src/main/sync-spaces/git-transport.ts
// SyncTransport implementation over a HIDDEN git repo (spec §7).
//
// CRITICAL MECHANISM: we do NOT use `git init --separate-git-dir` — that writes
// a `.git` FILE into the worktree, which would collide with a developer's own
// .git in the same project. Instead every git call runs with GIT_DIR pointing
// at <root>/.youcoded/sync.git and GIT_WORK_TREE at <root>. The user's tree
// never contains any git artifact of ours; their own repo is untouched.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DEFAULT_IGNORES, MAX_SYNC_FILE_BYTES, conflictCopyName } from './guards';
import { nextGcCounter } from './gc-policy';
import { GITHUB_AUTH_ERROR_CODE } from '../github-client';
import { matchGitCorruption, isNetworkFailureStderr, stderrTail, REPO_CORRUPT_ERROR_CODE } from '../sync-error-classifier';
import { deleteZeroByteObjects, brokenBackupName, pruneBrokenBackups } from './repair';
import type { PullResult, PushResult, RepairOutcome, SpaceVersion, SyncSpace, SyncTransport } from './types';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Credential injection (Phase 2, 2026-07-22 sync-setup overhaul)
// ---------------------------------------------------------------------------

/**
 * Inline git credential helper (the `!`-prefixed form runs under git's own sh —
 * bundled with Git for Windows too, so this is cross-platform). It answers
 * `get` with the app token read FROM THE CHILD ENV; store/erase are no-ops.
 *
 * WHY a credential.helper and not GIT_ASKPASS: git consults credential HELPERS
 * before askpass, so askpass could never take precedence over a stale system
 * helper (e.g. an expired gh login). Prepending `credential.helper=` (empty)
 * resets git's helper list, so when the app HAS a token it wins outright; when
 * it has none we pass nothing and the system's configured helper keeps working
 * exactly as today (the "no forced migration" guarantee).
 *
 * TOKEN HYGIENE: the token rides ONLY in the env var — this helper string (and
 * therefore argv) never contains it, and nothing is written to any git config.
 */
export const GIT_CREDENTIAL_HELPER =
  '!f() { if [ "$1" = "get" ]; then printf "username=x-access-token\\npassword=%s\\n" "$YOUCODED_GIT_TOKEN"; fi; }; f';

/** Pure: build the argv+env for one git call. No token → untouched passthrough
 *  (system credential helpers keep working). With a token → our helper wins,
 *  the token rides env-only, and GIT_TERMINAL_PROMPT=0 stops git from ever
 *  hanging on a TTY prompt we can't answer. */
export function credentialedGitInvocation(
  args: string[],
  env: NodeJS.ProcessEnv,
  token: string | null,
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!token) return { args, env };
  return {
    args: ['-c', 'credential.helper=', '-c', `credential.helper=${GIT_CREDENTIAL_HELPER}`, ...args],
    env: { ...env, YOUCODED_GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' },
  };
}

/**
 * Pure: recognize a git auth failure in stderr and translate it to the
 * plain-language error the panel shows verbatim (never raw git jargon — see
 * docs/error-message-standards.md). `tokenUsed` picks the accurate message:
 * a failure WITH our token means the sign-in expired/was revoked; a failure
 * with NO credentials at all means the device was never connected. Returns
 * null for every non-auth failure so offline handling stays untouched.
 */
export function classifyGitAuthFailure(
  stderr: string,
  tokenUsed: boolean,
): { message: string; code: string } | null {
  const s = (stderr || '').toLowerCase();
  const authy =
    s.includes('authentication failed') ||
    s.includes('invalid credentials') ||
    s.includes('could not read username') ||
    s.includes('could not read password') ||
    /returned error: 40[13]/.test(s);
  if (!authy) return null;
  return {
    code: GITHUB_AUTH_ERROR_CODE,
    message: tokenUsed
      ? 'GitHub sign-in expired — reconnect your GitHub account in the Sync settings'
      : 'Not connected to GitHub — connect your GitHub account in the Sync settings',
  };
}

/** Throw the classified auth failure as a coded error (engine copies
 *  syncErrorCode onto the 'error' event so the UI can offer Reconnect). */
function throwAuthFailure(auth: { message: string; code: string }): never {
  const e: any = new Error(auth.message);
  e.syncErrorCode = auth.code;
  throw e;
}

/** Throw the corruption as a coded error. The engine matches the CODE (never
 *  prose) to trigger repair(); the message still carries the real git line per
 *  docs/error-message-standards.md. */
function throwRepoCorrupt(spaceId: string, op: string, detail: string): never {
  const e: any = new Error(`Sync data for ${spaceId} needs repair (git ${op}: ${detail})`);
  e.syncErrorCode = REPO_CORRUPT_ERROR_CODE;
  throw e;
}

const GIT_TIMEOUT = 5 * 60 * 1000; // mirrors sync-service.ts GIT_TIMEOUT
const DEFAULT_GC_INTERVAL = 50;    // run a local git gc every 50th successful sync (spec §7)
// Bound the recursive size walk so a pathological repo can never hang the probe.
// Both a total-entry cap AND a depth cap (belt-and-suspenders, matching
// countFilesBounded): fs.Dirent.isSymbolicLink does NOT detect NTFS junctions,
// so a junction cycle wouldn't trip the entry cap on its own (PITFALLS).
const SIZE_WALK_MAX_ENTRIES = 200_000;
const SIZE_WALK_MAX_DEPTH = 100;

interface ExecResult { code: number; stdout: string; stderr: string; tokenUsed: boolean; }

// Benign for local WRITE ops (add/commit/checkout — anything that takes a git
// lock): a *.lock already held by a genuinely-live writer (a second app
// instance, or this same process's prior sync cycle still finishing under
// contention). This is transient and self-resolving — reapStaleLocks heals it
// once it goes stale, or the other writer simply finishes — so throwing here
// would alarm the user over a condition the very next poll cycle clears on its
// own. Distinct from corruption: git created the lock file itself; nothing is
// damaged.
const LOCK_CONTENDED = /Unable to create .*\.lock['"]?: File exists/i;

// A single canonical predicate, applied identically at EVERY lock-taking op
// (add/commit/checkout, in both push() and pull()). The same transient lock
// must produce the same user-visible outcome no matter which op happens to
// hit it — a concurrent writer holding index.lock is exactly as benign at
// `commit` as it is at `add`, since both mean "nothing damaged, try again
// next cycle," never "whichever op lost the race decides silent-vs-throw."
// Named once here (rather than inlined per call site) so a future narrowing
// of the lock rule is a single edit, not a hunt across every call site for
// ones that got missed.
const isLockContended = (r: ExecResult) => LOCK_CONTENDED.test(r.stderr);

const isNothingToCommit = (r: ExecResult) => /nothing to commit/i.test(r.stdout + r.stderr);

// Shared here so push()'s commit and pull()'s snapshot commit apply the
// identical benign rule. IMPORTANT: this collapses two DIFFERENT benign
// reasons into one boolean, which is fine for
// assertLocalOk's purposes (either one means "don't throw") but NOT fine for
// deciding what to do next. "Nothing to commit" means a commit genuinely
// happened on a prior cycle and HEAD already reflects it — safe to read HEAD
// and continue. Lock contention means NO commit happened at all — reading
// HEAD would return the PRIOR sha and let a caller mistake "commit didn't run"
// for "commit ran". Callers that need to tell these apart call
// isLockContended(r) directly alongside this predicate; see push()/pull()'s
// commit sites below.
const isCommitBenign = (r: ExecResult) => isLockContended(r) || isNothingToCommit(r);

// Benign for a push: the local branch has NEVER had a commit (a fresh space
// with zero history) — git refuses "push -u origin main" with this exact
// message since there is no local `main` ref to push at all. Equivalent to
// "nothing to push", just via a different git code path than the
// already-handled ahead-count===0 case (which requires origin/main to exist).
const NOTHING_TO_PUSH_YET = /src refspec .* does not match any/i;

export class GitTransport implements SyncTransport {
  private deviceName: string;
  private maxFileBytes: number;
  private gcInterval: number;
  private lockStaleMs: number;
  private getAuthToken?: () => Promise<string | null>;
  private log: (m: string) => void;

  constructor(opts: { deviceName: string; maxFileBytes?: number; gcInterval?: number; lockStaleMs?: number; getAuthToken?: () => Promise<string | null>; log?: (m: string) => void }) {
    this.deviceName = opts.deviceName;
    // Injected logger (service.ts threads its logFn through makeTransport), the
    // subsystem's existing pattern — default console.log mirrors service.ts's
    // own logFn default so an unwired construction still leaves a trace.
    this.log = opts.log ?? console.log;
    // App-token provider (github-client via service.ts). Optional + failure-
    // tolerant: null/throw simply means "no app token", and the invocation
    // falls back to the system credential helper unchanged.
    this.getAuthToken = opts.getAuthToken;
    this.maxFileBytes = opts.maxFileBytes ?? MAX_SYNC_FILE_BYTES;
    // Injectable so tests can force a gc after a couple of syncs instead of 50.
    this.gcInterval = opts.gcInterval ?? DEFAULT_GC_INTERVAL;
    // A git *.lock older than this is treated as orphaned and reaped before a
    // sync (see reapStaleLocks). Default = GIT_TIMEOUT: any legitimate holder
    // would already have been SIGTERM-killed by the exec timeout, so a lock that
    // has survived longer than that is provably dead. Injectable so tests don't
    // have to wait 5 real minutes.
    this.lockStaleMs = opts.lockStaleMs ?? GIT_TIMEOUT;
  }

  private gitDir(space: SyncSpace): string {
    return path.join(space.root, '.youcoded', 'sync.git');
  }

  /** Remove orphaned git `*.lock` files before a sync so a space that was wedged
   *  by an interrupted write self-heals instead of failing forever.
   *
   *  WHY this is needed: git creates `index.lock` (and, during a ref update,
   *  `<ref>.lock`) at the start of every write and deletes it when done. If the
   *  git process dies in between — the 5-min exec timeout SIGTERM-killing a slow
   *  op, the app quitting, the machine sleeping, or a SECOND app instance racing
   *  the same sync.git (dev + built app both syncing ~/YouCoded/Personal, since
   *  the engine's single-flight is per-instance, not cross-process) — the lock is
   *  left behind. Git then refuses EVERY subsequent write ("Unable to create
   *  index.lock: File exists"), so the space stays broken until the file is
   *  deleted by hand. This is the same self-heal the two OTHER lock systems in
   *  this app already have (cas-write.ts's 30s age-break, sync-service.ts's
   *  pid-liveness check); the git transport was the only one missing it.
   *
   *  WHY age-gated (never remove a fresh lock): a lock younger than lockStaleMs
   *  might be held by a genuinely-live git — most plausibly a second instance
   *  mid-write. Deleting it would corrupt that write. The default threshold is
   *  GIT_TIMEOUT, so any lock we reap is older than the longest a live op could
   *  possibly run before the exec timeout kills it — i.e. provably orphaned.
   *  Synchronous + best-effort: a reap failure must never itself break a sync. */
  private reapStaleLocks(space: SyncSpace): void {
    const gd = this.gitDir(space);
    const now = Date.now();
    const reapIfStale = (p: string): void => {
      try {
        if (now - fs.statSync(p).mtimeMs > this.lockStaleMs) fs.rmSync(p, { force: true });
      } catch { /* vanished or unreadable between listing and here — nothing to do */ }
    };
    // Top-level lock files: index.lock, HEAD.lock, config.lock, packed-refs.lock,
    // ORIG_HEAD.lock, shallow.lock, gc.log.lock, … Match any *.lock. (gc.pid is
    // deliberately NOT touched — it isn't a *.lock and git manages its own
    // staleness for it.)
    let top: string[];
    try { top = fs.readdirSync(gd); } catch { return; } // no repo dir yet → nothing to reap
    for (const name of top) if (name.endsWith('.lock')) reapIfStale(path.join(gd, name));
    // Ref-update locks live under refs/ (refs/heads/<b>.lock, refs/remotes/**,
    // refs/tags/…). A stale one wedges commits/pushes exactly like index.lock.
    const walkRefs = (dir: string, depth: number): void => {
      if (depth > 20) return; // refs nest shallowly; bound the walk defensively
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkRefs(full, depth + 1);
        else if (e.name.endsWith('.lock')) reapIfStale(full);
      }
    };
    walkRefs(path.join(gd, 'refs'), 0);
  }

  private async git(space: SyncSpace, args: string[]): Promise<ExecResult> {
    const baseEnv = { ...process.env, GIT_DIR: this.gitDir(space), GIT_WORK_TREE: space.root };
    // App token first, system helper otherwise (credentialedGitInvocation is a
    // no-op passthrough on null). getToken is cached upstream, so this does
    // not re-read disk / re-exec gh per git call.
    const token = this.getAuthToken ? await this.getAuthToken().catch(() => null) : null;
    const inv = credentialedGitInvocation(args, baseEnv, token);
    try {
      // Why maxBuffer 64MB: Node's default is only 1MB and it KILLS the child
      // when output exceeds it — on a big space that silently breaks history()
      // and the name-only file listings this class depends on.
      const { stdout, stderr } = await execFileAsync('git', inv.args,
        { cwd: space.root, env: inv.env, timeout: GIT_TIMEOUT, maxBuffer: 64 * 1024 * 1024 });
      return { code: 0, stdout, stderr, tokenUsed: token != null };
    } catch (e: any) {
      return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '', stderr: e.stderr || String(e), tokenUsed: token != null };
    }
  }

  /** Guard for LOCAL git ops (add/diff/commit/checkout/rev-parse…): exit 0
   *  passes; corruption throws coded repo-corrupt; anything else throws with
   *  the REAL stderr. WHY (2026-07-27 incident): the old shape returned benign
   *  results on failure — a corrupt repo reported "nothing to push" for three
   *  days while the panel showed green. Benign is now an explicit allowlist
   *  via the `benign` predicate, never the fallthrough.
   *
   *  Corruption is checked BEFORE the benign allowlist, not after: `benign`
   *  predicates test the WHOLE stderr while matchGitCorruption is LINE-based,
   *  so a multi-line stderr carrying both a benign line (e.g. an orphaned
   *  index.lock) AND a corruption line would otherwise be swallowed as benign
   *  and never reach the corruption check. That co-occurrence is exactly what
   *  a power-loss crash produces: an orphaned lock (not yet aged past
   *  lockStaleMs, so reapStaleLocks hasn't cleared it) sitting alongside a
   *  truncated loose object. Corruption must win that race every time. */
  private assertLocalOk(space: SyncSpace, op: string, r: ExecResult, benign?: (r: ExecResult) => boolean): void {
    if (r.code === 0) return;
    const corrupt = matchGitCorruption(r.stderr);
    if (corrupt) throwRepoCorrupt(space.id, op, corrupt);
    if (benign?.(r)) return;
    throw new Error(`Sync failed for ${space.id} (git ${op}): ${stderrTail(r.stderr)}`);
  }

  /** Corruption-only guard for PROBE ops whose non-zero exit is often expected
   *  (ahead/behind rev-list before origin/main exists). Keeps the probe's
   *  benign fallthrough but refuses to let corruption ride it. */
  private throwIfCorrupt(space: SyncSpace, op: string, r: ExecResult): void {
    if (r.code === 0) return;
    const corrupt = matchGitCorruption(r.stderr);
    if (corrupt) throwRepoCorrupt(space.id, op, corrupt);
  }

  /** Read one side of a conflicted file (stage 2 = ours, 3 = theirs) as raw
   *  BYTES. The string-returning git() helper must never be used for file
   *  CONTENT: utf8 decoding mangles binary files, and a too-small buffer cap
   *  rejects large ones. Returns null when the stage doesn't exist (e.g. the
   *  file is a remote-only add). WHY the maxBuffer must stay ≥ maxFileBytes:
   *  the conflict loop treats null as "no local version to preserve" and lets
   *  checkout --theirs overwrite the file — if this buffer were smaller than
   *  the sync size cap, a big-but-legal local edit would come back null and be
   *  silently DROPPED with no conflict copy. */
  private async showStage(space: SyncSpace, stage: 2 | 3, rel: string): Promise<Buffer | null> {
    const env = { ...process.env, GIT_DIR: this.gitDir(space), GIT_WORK_TREE: space.root };
    try {
      const { stdout } = await execFileAsync('git', ['show', `:${stage}:${rel}`], {
        cwd: space.root, env, timeout: GIT_TIMEOUT,
        encoding: 'buffer', maxBuffer: this.maxFileBytes + 1024 * 1024,
      });
      return stdout as unknown as Buffer;
    } catch {
      return null;
    }
  }

  async init(space: SyncSpace): Promise<void> {
    const gd = this.gitDir(space);
    if (!fs.existsSync(path.join(gd, 'HEAD'))) {
      fs.mkdirSync(gd, { recursive: true });
      await this.git(space, ['init', '--initial-branch=main']);
      await this.git(space, ['config', 'user.name', `YouCoded Sync (${this.deviceName})`]);
      await this.git(space, ['config', 'user.email', 'sync@youcoded.local']);
      // Byte-faithful storage: `* -text` disables ALL end-of-line conversion so
      // bytes round-trip identically on every platform. Fix: the earlier
      // `* text=auto` OVERRODE core.autocrlf=false and re-introduced LF→CRLF on
      // Windows checkout — a sync tool must never rewrite the user's line endings.
      // Set via repo-local info/attributes (never a .gitattributes in the user's tree).
      await this.git(space, ['config', 'core.autocrlf', 'false']);
      fs.writeFileSync(path.join(gd, 'info', 'attributes'), '* -text\n');
    }
    // info/exclude is OURS (rewritten on every init so ignore updates roll out).
    // The user's own .gitignore still applies on top for their repo, not ours.
    fs.writeFileSync(path.join(gd, 'info', 'exclude'), DEFAULT_IGNORES.join('\n') + '\n');
  }

  async hasRemote(space: SyncSpace): Promise<boolean> {
    const r = await this.git(space, ['remote', 'get-url', 'origin']);
    return r.code === 0;
  }

  async setRemote(space: SyncSpace, url: string): Promise<void> {
    const existing = await this.git(space, ['remote', 'get-url', 'origin']);
    if (existing.code === 0) await this.git(space, ['remote', 'set-url', 'origin', url]);
    else await this.git(space, ['remote', 'add', 'origin', url]);
  }

  /** Stage everything, unstage+exclude oversize files, commit, push. */
  async push(space: SyncSpace, message: string): Promise<PushResult> {
    this.reapStaleLocks(space); // heal an orphaned lock from a crashed prior write
    const add = await this.git(space, ['add', '-A']);
    this.assertLocalOk(space, 'add', add, isLockContended);
    // Deliberately NO early return here on a lock-contended `add` (contrast
    // pull()'s add guard below, which DOES early-return): if
    // `add` loses the lock race, nothing NEW gets staged this cycle, but a
    // PRIOR cycle's commit(s) may still be sitting locally unpushed. Falling
    // through lets that backlog reach `git push` below and go out — the
    // honest result is {pushed:true, commit:undefined}, since nothing
    // committed THIS cycle but something real still shipped. `commit` being
    // undefined self-clears next cycle once the lock is gone. Do not "fix"
    // this into an early return — that would strand already-committed work
    // behind a transient lock that has nothing to do with it.
    const oversize = await this.unstageOversize(space);
    const staged = await this.git(space, ['diff', '--cached', '--name-only']);
    this.assertLocalOk(space, 'diff', staged);
    let commit: string | undefined;
    if (staged.stdout.trim().length > 0) {
      const c = await this.git(space, ['commit', '-m', message]);
      // THE 2026-07-27 bug site: this used to `return {pushed:false}` on ANY
      // failure — indistinguishable from "nothing to push", so a corrupt repo
      // synced "green" forever. Benign allowlist (isCommitBenign): a commit
      // race where another cycle already committed the staged set ("nothing
      // to commit"), OR a live writer still holding index.lock — same rule as
      // the `add` guard above, so losing the lock race here vs. there no
      // longer decides silent-vs-throw.
      this.assertLocalOk(space, 'commit', c, isCommitBenign);
      // assertLocalOk passing only proves the failure was BENIGN, not that a
      // commit happened. If it was benign because HEAD is stale-locked
      // (isLockContended), the staged edits are STILL uncommitted — reading
      // `rev-parse HEAD` below would return the PRIOR sha, and that truthy
      // value would bypass the `!commit` nothing-to-push shortcut further
      // down, returning {pushed:true} while none of the user's changes
      // actually pushed. Only the "nothing to commit" half of isCommitBenign
      // is safe to fall through on — there, HEAD already IS the right commit.
      if (c.code !== 0 && isLockContended(c)) return { pushed: false, oversize };
      const head = await this.git(space, ['rev-parse', 'HEAD']);
      this.assertLocalOk(space, 'rev-parse', head);
      commit = head.stdout.trim();
    }
    if (!(await this.hasRemote(space))) return { pushed: false, commit, oversize };
    const ahead = await this.git(space, ['rev-list', '--count', 'origin/main..main']);
    // origin/main may not exist yet (first push) — rev-list fails benignly;
    // push anyway. Corruption must not ride that fallthrough.
    this.throwIfCorrupt(space, 'rev-list', ahead);
    if (ahead.code === 0 && ahead.stdout.trim() === '0' && !commit) return { pushed: false, oversize };
    const p = await this.git(space, ['push', '-u', 'origin', 'main']);
    if (p.code !== 0) {
      // Non-fast-forward: another device pushed first. Merge, then push again.
      // The recovery pull's outcome MUST be surfaced on the result: it applies
      // the peer's changes, and discarding it made those changes invisible to
      // the engine's event (updated:false → no materialize sweep, no discovery,
      // no conflict notice) until some unrelated later pull — a stale-resume /
      // forked-transcript hazard on conversations (2026-07-15 review finding).
      const recovery = await this.pull(space);
      const retry = await this.git(space, ['push', '-u', 'origin', 'main']);
      if (retry.code !== 0) {
        // An auth-refused push must SURFACE (engine error event → red dot +
        // Reconnect CTA), never return a silent pushed:false — an expired
        // token would otherwise look like "nothing to push" forever.
        const auth = classifyGitAuthFailure(retry.stderr, retry.tokenUsed);
        if (auth) throwAuthFailure(auth);
        this.throwIfCorrupt(space, 'push', retry);
        // Offline stays silent by design (spec §13), and so does "nothing to
        // push yet" (a fresh space with zero commits ever — git refuses the
        // push because local `main` doesn't exist as a ref at all). Every
        // OTHER push refusal (deleted repo, server-side hook, …) surfaces with
        // the real stderr.
        if (!isNetworkFailureStderr(retry.stderr) && !NOTHING_TO_PUSH_YET.test(retry.stderr)) {
          throw new Error(`Sync push failed for ${space.id}: ${stderrTail(retry.stderr)}`);
        }
      }
      return { pushed: retry.code === 0, commit, oversize, updated: recovery.updated, conflictCopies: recovery.conflictCopies };
    }
    return { pushed: true, commit, oversize };
  }

  private async unstageOversize(space: SyncSpace): Promise<string[]> {
    const staged = (await this.git(space, ['diff', '--cached', '--name-only', '-z'])).stdout
      .split('\0').filter(Boolean);
    const oversize: string[] = [];
    for (const rel of staged) {
      try {
        if (fs.statSync(path.join(space.root, rel)).size > this.maxFileBytes) oversize.push(rel);
      } catch { /* deleted while staging — fine */ }
    }
    if (oversize.length) {
      await this.git(space, ['reset', '--', ...oversize]);
      // Persist the exclusion so the watcher doesn't re-stage it every cycle —
      // DEDUPED, because exclude only silences UNTRACKED files: a TRACKED file
      // that grew past the cap is re-staged by `git add -A` on every sync, and
      // an unconditional append grew info/exclude without bound at poll cadence.
      const excludePath = path.join(this.gitDir(space), 'info', 'exclude');
      let have = new Set<string>();
      try { have = new Set(fs.readFileSync(excludePath, 'utf8').split('\n')); } catch { /* fresh file */ }
      const fresh = oversize.map(o => `/${o}`).filter(line => !have.has(line));
      if (fresh.length) fs.appendFileSync(excludePath, fresh.join('\n') + '\n');
    }
    return oversize;
  }

  /** Commit local pending, fetch, merge. Convergent conflict rule (spec §8):
   *  REMOTE wins the canonical filename; LOCAL content is preserved as a
   *  visible conflict copy. Both devices converge to identical trees. */
  async pull(space: SyncSpace): Promise<PullResult> {
    this.reapStaleLocks(space); // heal an orphaned lock from a crashed prior write
    // Snapshot local changes first so merge never runs on a dirty tree.
    const add = await this.git(space, ['add', '-A']);
    this.assertLocalOk(space, 'add', add, isLockContended);
    // `add` is the FIRST lock-taking op in pull(), so it is the one that loses
    // a live-writer race first. If it fails, there is no staged snapshot of
    // the working tree and no way to know whether it's dirty — falling
    // through would let `merge` below run against a tree that may hold
    // uncommitted edits, exactly what this function's header comment ("...so
    // merge never runs on a dirty tree") promises never happens. Report the
    // honest benign result immediately and let the next poll cycle retry once
    // the lock clears — mirrors the same transient-lock-is-silent behavior at
    // every other lock-taking op in this file.
    if (add.code !== 0 && isLockContended(add)) return { updated: false, conflictCopies: [] };
    await this.unstageOversize(space);
    const dirtyR = await this.git(space, ['diff', '--cached', '--name-only']);
    this.assertLocalOk(space, 'diff', dirtyR);
    const dirty = dirtyR.stdout.trim();
    if (dirty) {
      const snap = await this.git(space, ['commit', '-m', `local snapshot before merge (${this.deviceName})`]);
      // Same benign rule as push()'s commit — see isCommitBenign.
      this.assertLocalOk(space, 'commit', snap, isCommitBenign);
      // A lock-contended snapshot commit HERE is a genuinely different race
      // window than the `add` guard above — a writer can grab the lock in the
      // gap between `add` succeeding and this `commit` running — so this
      // guard stays reachable and still needed even with the early return
      // above. Falling through would violate the same "merge never runs on a
      // dirty tree" invariant: running merge dirty either corrupts the merge
      // result or (if git refuses) reaches the conflict block with zero
      // --diff-filter=U entries and throws "Sync merge could not complete",
      // misattributing a transient lock to a genuinely unmergeable space.
      // Report the honest benign result instead and let the next poll cycle
      // retry once the lock clears. "Nothing to commit" doesn't need this —
      // there the tree genuinely was clean already.
      if (snap.code !== 0 && isLockContended(snap)) return { updated: false, conflictCopies: [] };
    }

    if (!(await this.hasRemote(space))) return { updated: false, conflictCopies: [] };
    const fetch = await this.git(space, ['fetch', 'origin', 'main']);
    if (fetch.code !== 0) {
      // Auth refusals must NOT masquerade as offline: "offline" is silent by
      // design (spec §13), so an expired/revoked credential would read as a
      // healthy-but-idle device forever. Same for corruption (2026-07-30 spec).
      // Every remaining fetch failure keeps the never-block offline contract.
      const auth = classifyGitAuthFailure(fetch.stderr, fetch.tokenUsed);
      if (auth) throwAuthFailure(auth);
      this.throwIfCorrupt(space, 'fetch', fetch);
      return { updated: false, conflictCopies: [] }; // offline — never block (spec §13)
    }
    // Fix: a fresh device has no local `main` yet (nothing committed). `main..origin/main`
    // errors on an unborn branch, so adopt the remote wholesale on first sync — this is
    // what lets a second device actually receive the first device's push.
    const localMain = await this.git(space, ['rev-parse', '--verify', '--quiet', 'main']);
    this.throwIfCorrupt(space, 'rev-parse', localMain);
    if (localMain.code !== 0) {
      const co = await this.git(space, ['checkout', '-B', 'main', 'origin/main']);
      // Used to return {updated:false} on failure — silent. A failed remote
      // adoption is a real error (corrupt local objects, unreadable remote tip).
      // checkout takes a lock too (it moves HEAD/refs), so the same transient
      // live-writer contention that's benign at `add`/`commit` must be benign
      // here as well — otherwise this would be the ONE lock-taking op still
      // hard-throwing on the exact condition the other two swallow.
      this.assertLocalOk(space, 'checkout', co, isLockContended);
      // assertLocalOk passing only proves the failure was benign, not that the
      // checkout ran — an unconditional {updated:true} would report success
      // for a checkout that never happened: the working tree still has none
      // of the remote's content and local `main` still doesn't exist. Report
      // the real outcome; the throw above still fires for anything that isn't
      // the benign lock case, so this stays honest without widening the
      // allowlist.
      return { updated: co.code === 0, conflictCopies: [] };
    }
    const behind = await this.git(space, ['rev-list', '--count', 'main..origin/main']);
    this.throwIfCorrupt(space, 'rev-list', behind);
    if (behind.code !== 0 || behind.stdout.trim() === '0') return { updated: false, conflictCopies: [] };

    // Fix: --allow-unrelated-histories covers the mainline "second device" case —
    // a device that enables sync on a space that ALREADY has content (e.g. the
    // Personal space in use on two machines) commits its own unrelated root, and
    // without this flag git refuses the merge ("refusing to merge unrelated
    // histories"), leaving both devices silently stuck forever. Conflicting files
    // still route through the convergent conflict-copy resolution below;
    // non-overlapping files simply union.
    const merge = await this.git(space, ['merge', '--no-edit', '--allow-unrelated-histories', 'origin/main']);
    if (merge.code === 0) return { updated: true, conflictCopies: [] };

    // Conflicts: resolve each convergently.
    const conflicted = (await this.git(space, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout
      .split('\0').filter(Boolean);
    const copies: string[] = [];
    for (const rel of conflicted) {
      // Stage 2 = ours (this device), stage 3 = theirs (remote). Content is
      // read as raw bytes via showStage so binary and >1MB files survive the
      // copy intact (utf8 strings would corrupt bytes; Node's 1MB default
      // buffer would reject big files and silently skip the copy).
      const ours = await this.showStage(space, 2, rel);
      if (ours !== null) {
        const copyRel = this.freeCopyName(space, rel);
        fs.mkdirSync(path.dirname(path.join(space.root, copyRel)), { recursive: true });
        fs.writeFileSync(path.join(space.root, copyRel), ours);
        await this.git(space, ['add', copyRel]);
        copies.push(copyRel);
      }
      // Cheap existence probe — the canonical restore stays checkout --theirs
      // (git writes the content itself, so it's already byte-faithful).
      const theirs = await this.git(space, ['cat-file', '-e', `:3:${rel}`]);
      if (theirs.code === 0) {
        await this.git(space, ['checkout', '--theirs', '--', rel]);
        await this.git(space, ['add', rel]);
      } else {
        await this.git(space, ['rm', '--force', '--', rel]); // deleted remotely → deletion wins canonical
      }
    }
    const commit = await this.git(space, ['commit', '--no-edit']);
    if (commit.code !== 0) {
      // Merge could not complete — abort rather than leave a wedged repo, then
      // THROW so the engine emits an error event (red dot + message). The old
      // silent {updated:false} made a persistently unmergeable space look
      // healthy while it quietly stopped converging (2026-07-15 review finding).
      // The abort restores the pre-merge state, so the next sync retries clean.
      // NOTE: a *stale* index.lock can no longer be the cause of this failure —
      // pull() reaps orphaned locks before the merge runs (reapStaleLocks), so
      // the abort itself is never blocked by one. (Historically a lock-caused
      // commit failure made this abort a silent no-op — it needs index.lock too —
      // leaving the repo mid-merge; the pre-merge reap removes that hazard.)
      await this.git(space, ['merge', '--abort']);
      throw new Error(`Sync merge could not complete for ${space.id}: ${commit.stderr.trim() || 'git commit failed'}`);
    }
    return { updated: true, conflictCopies: copies };
  }

  private freeCopyName(space: SyncSpace, rel: string): string {
    let candidate = conflictCopyName(rel, this.deviceName, new Date());
    let i = 2;
    while (fs.existsSync(path.join(space.root, candidate))) {
      candidate = conflictCopyName(rel, `${this.deviceName} ${i++}`, new Date());
    }
    return candidate;
  }

  async history(space: SyncSpace, limit = 50): Promise<SpaceVersion[]> {
    const r = await this.git(space, ['log', `--max-count=${limit}`, '--format=%H%x1f%cI%x1f%s']);
    if (r.code !== 0) return [];
    return r.stdout.split('\n').filter(Boolean).map(line => {
      const [commit, date, message] = line.split('\x1f');
      return { commit, date, message };
    });
  }

  private gcCounterFile(space: SyncSpace): string {
    // Lives NEXT TO sync.git in the hidden dir — NOT in config.json, which is
    // per-user/syncable; a maintenance counter is strictly per-device state.
    return path.join(space.root, '.youcoded', 'gc-counter');
  }

  /** Increment the persisted per-space sync counter and, every Nth sync, run a
   *  LOCAL `git gc --auto --quiet`. The hidden repos grow unbounded from
   *  append-only transcript re-commits with no repack; this reclaims local disk
   *  and keeps push sizes sane. WHY this is safe: `git gc` only repacks THIS
   *  device's objects — it NEVER rewrites history (no force-push, no
   *  filter-branch), so it can never desync a peer. Best-effort throughout: a
   *  gc failure is swallowed (it just retries in another N syncs) and this
   *  method never throws, so maintenance can't break a sync. */
  async maybeGc(space: SyncSpace): Promise<void> {
    const file = this.gcCounterFile(space);
    let prev = 0;
    try { prev = parseInt(fs.readFileSync(file, 'utf8').trim(), 10); } catch { /* missing/corrupt → 0 */ }
    const { counter, shouldGc } = nextGcCounter(prev, this.gcInterval);
    // Persist the incremented counter FIRST, even if gc then fails, so we don't
    // retry gc every single sync after one failure.
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(counter));
    } catch { /* can't persist → next sync recomputes from stale/absent file, harmless */ }
    if (!shouldGc) return;
    try {
      // Inherits GIT_DIR/GIT_WORK_TREE via git(); --auto lets git skip if the
      // repo doesn't actually need repacking, --quiet suppresses progress noise.
      await this.git(space, ['gc', '--auto', '--quiet']);
    } catch { /* best-effort; retries in another N syncs */ }
  }

  /** Two-tier corruption repair (2026-07-30 spec §2). Resolves when healed;
   *  throws when even Tier 2 failed. NEVER touches the user's files — every
   *  write is under <root>/.youcoded/. The engine gates calls to once per
   *  space per launch.
   *
   *  Returns + logs a RepairOutcome trace (PR #276 review: this method used to
   *  discard the deleteZeroByteObjects count and log nothing, so post-hoc
   *  debugging couldn't tell whether a space healed surgically or was re-inited
   *  — and a .broken-* backup's origin was unexplainable). Logging only, no
   *  behavior change: the git/fs sequence below is byte-identical to before. */
  async repair(space: SyncSpace): Promise<RepairOutcome> {
    const gd = this.gitDir(space);
    // Trace fields, filled in as the tiers run. tier1Failure records WHY the
    // repair fell through to Tier 2 — the one fact the .broken-* backup alone
    // can never tell you.
    let zeroByteObjectsDeleted = 0;
    let tier1Failure: string | undefined;
    // ---- Tier 1: surgical, offline-capable ----
    if (fs.existsSync(path.join(gd, 'HEAD'))) {
      // Reap first: assertLocalOk's own comment above notes that a power-loss
      // crash's classic signature is an orphaned *.lock (not yet past
      // lockStaleMs) sitting alongside a truncated object — exactly the state
      // repair() is called to fix. Without this, the update-ref below hits
      // "Unable to create '...refs/heads/main.lock': File exists" against a
      // repo that's otherwise perfectly repairable, and a stale-but-provably-
      // dead lock (reapStaleLocks only removes locks older than lockStaleMs)
      // sends a Tier-1-fixable repo down the more destructive Tier 2 path.
      this.reapStaleLocks(space);
      zeroByteObjectsDeleted = deleteZeroByteObjects(gd);
      const tip = await this.git(space, ['rev-parse', '--verify', '--quiet', 'origin/main']);
      if (tip.code === 0) {
        const sha = tip.stdout.trim();
        // Light closure check: commit + root tree readable. NOT a full fsck —
        // that times out on real repos (>2 min on the Z13's Personal space).
        // Residual damage this misses fails the next push, but the engine's
        // launch-scoped healedSpaces guard means that failure does NOT re-enter
        // repair() this run — it forwards a plain repo-corrupt error instead.
        // Escalation to Tier 2 happens on the NEXT app launch, when the guard
        // resets and a fresh corruption is seen for the first time.
        const commitOk = (await this.git(space, ['cat-file', 'commit', sha])).code === 0;
        const treeOk = (await this.git(space, ['cat-file', '-p', `${sha}^{tree}`])).code === 0;
        if (commitOk && treeOk) {
          const upd = await this.git(space, ['update-ref', 'refs/heads/main', sha]);
          // Delete the index: it may reference the just-deleted poison hashes.
          // add -A rebuilds it from the worktree — files are the source of truth.
          try { fs.rmSync(path.join(gd, 'index'), { force: true }); } catch { /* rebuilt anyway */ }
          const probe = await this.git(space, ['rev-parse', '--verify', 'HEAD']);
          if (upd.code === 0 && probe.code === 0) {
            // Healed — local changes re-commit on the next cycle.
            this.log(`sync-spaces: repair(${space.id}) tier=1 healed — main reset to origin/main ${sha.slice(0, 8)}, ${zeroByteObjectsDeleted} zero-byte object(s) deleted`);
            return { tier: 1, zeroByteObjectsDeleted };
          }
          tier1Failure = `update-ref/HEAD probe failed (update-ref exit ${upd.code}, probe exit ${probe.code})`;
        } else {
          tier1Failure = commitOk ? 'origin/main root tree unreadable' : 'origin/main commit unreadable';
        }
      } else {
        tier1Failure = 'origin/main unresolvable';
      }
    } else {
      tier1Failure = 'no HEAD — repo missing or hollow';
    }
    // ---- Tier 2: move the repo aside, start fresh ----
    // The worktree files and the GitHub remote are the two real sources of
    // truth; the hidden repo is just transport machinery. After the re-init,
    // the engine's normal cycle re-provisions the remote (ensureProvisioned →
    // setRemote: provisionGithubRemote treats an existing repo as SUCCESS) and
    // pull() adopts origin/main via its unborn-branch checkout — real ancestry,
    // so NO conflict-copy explosion (spec §2).
    let backupPath: string | undefined;
    if (fs.existsSync(gd)) {
      backupPath = brokenBackupName(gd, new Date());
      fs.renameSync(gd, backupPath);
      pruneBrokenBackups(gd);
    }
    await this.init(space);
    this.log(
      `sync-spaces: repair(${space.id}) tier=2 re-init — Tier 1 fell through (${tier1Failure}), ` +
      `${zeroByteObjectsDeleted} zero-byte object(s) deleted, ` +
      `${backupPath ? `broken repo kept at ${path.basename(backupPath)}` : 'no repo dir to back up'}`,
    );
    return { tier: 2, zeroByteObjectsDeleted, tier1Failure, backupPath };
  }

  /** Recursive byte size of <root>/.youcoded/sync.git — feeds the engine's
   *  large-history warning. Bounded (entry cap) and best-effort: returns 0 on
   *  any error or a missing repo, and returns whatever was summed so far if the
   *  walk trips its bound (a partial-but-nonzero size still trips the warning). */
  async gitDirSizeBytes(space: SyncSpace): Promise<number> {
    // WHY async walk (2026-09-10): this runs from the engine's 120 s poll for
    // every space; readdirSync/statSync over a large .git held the main thread
    // for the whole walk. Same caps, same symlink rule, off the event loop.
    const root = this.gitDir(space);
    let total = 0;
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (visited >= SIZE_WALK_MAX_ENTRIES || depth > SIZE_WALK_MAX_DEPTH) return;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (visited >= SIZE_WALK_MAX_ENTRIES) return;
        visited++;
        const full = path.join(dir, e.name);
        // Skip symlinks outright (never follow) — a defense the junction-cycle
        // depth cap backstops on Windows where isSymbolicLink misses junctions.
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (e.isFile()) { try { total += (await fs.promises.stat(full)).size; } catch { /* raced away */ } }
      }
    };
    try {
      try { await fs.promises.access(root); } catch { return 0; }
      await walk(root, 0);
    } catch { return 0; }
    return total;
  }
}
