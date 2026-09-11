// desktop/tests/sync-spaces-git-transport.test.ts
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { GitTransport } from '../src/main/sync-spaces/git-transport';
import type { SyncSpace } from '../src/main/sync-spaces/types';
import { describeTransportContract, TransportHarness } from './sync-transport-contract';

// INTEGRATION test, not a unit test: every case spawns real `git` subprocesses,
// so its wall-clock scales with machine load — and vitest's parallel pool
// guarantees load. The 5s default (and even 30s) is a fixed-budget bet that
// loses on a busy machine, which made this file time out nondeterministically
// and block release builds (`npm test` gates the Build step). A generous ceiling
// only bounds the FAILURE case; passing tests return as soon as they finish.
// Applies to the describeTransportContract() cases below too — verified.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Real git, local bare repo as the "GitHub" remote. Needs git on PATH (CI has it).
async function makeHarness(): Promise<TransportHarness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-gt-'));
  const bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  let n = 0;
  const transport = new GitTransport({ deviceName: 'TestDevice' });
  return {
    transport,
    async makeDeviceSpace(): Promise<SyncSpace> {
      const root = path.join(tmp, `device-${n++}`);
      fs.mkdirSync(root, { recursive: true });
      const space: SyncSpace = { id: 'project:contract', kind: 'project', root };
      await transport.init(space);
      await transport.setRemote(space, bare);
      return space;
    },
    // Windows holds handles briefly after the git subprocesses exit, so a bare
    // rmSync here threw `EPERM: operation not permitted` under parallel load.
    // Node retries EPERM/EBUSY/ENOTEMPTY natively with linear backoff — same
    // pattern sync-spaces-project-discovery.test.ts already uses.
    async cleanup() { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); },
  };
}

describeTransportContract('GitTransport', makeHarness);

describe('GitTransport specifics', () => {
  it('oversize files are excluded from sync and reported', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    // 50MB cap — write cap+1 bytes sparsely is slow; instead the transport takes
    // an injectable cap for tests:
    const small = new GitTransport({ deviceName: 'T', maxFileBytes: 10 });
    fs.writeFileSync(path.join(a.root, 'big.bin'), 'x'.repeat(11));
    fs.writeFileSync(path.join(a.root, 'ok.md'), 'fine');
    const r = await small.push(a, 'mixed');
    expect(r.pushed).toBe(true);
    expect(r.oversize).toEqual(['big.bin']);
    await h.cleanup();
  });

  it('a tracked file that grows past the cap is excluded ONCE, not re-appended every sync', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const small = new GitTransport({ deviceName: 'T', maxFileBytes: 10 });
    fs.writeFileSync(path.join(a.root, 'log.txt'), 'tiny'); // under cap → gets tracked
    await small.push(a, 'small');
    fs.writeFileSync(path.join(a.root, 'log.txt'), 'x'.repeat(11)); // grows past cap
    const r1 = await small.push(a, 'grew');
    expect(r1.oversize).toEqual(['log.txt']);
    // info/exclude only silences UNTRACKED files, so `git add -A` re-stages the
    // tracked file's growth on EVERY sync — each cycle must not re-append its
    // exclude line (unbounded info/exclude growth at poll cadence).
    const r2 = await small.push(a, 'again');
    expect(r2.oversize).toEqual(['log.txt']);
    const exclude = fs.readFileSync(path.join(a.root, '.youcoded', 'sync.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter(l => l === '/log.txt').length).toBe(1);
    await h.cleanup();
  });

  it('a merge that cannot complete surfaces an error instead of silently reporting no update', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const b = await h.makeDeviceSpace();
    const t = h.transport;
    // Divergent same-file edits → the conflict-resolution path runs on pull.
    fs.writeFileSync(path.join(a.root, 'plan.md'), 'base\n');
    await t.push(a, 'base');
    await t.pull(b);
    fs.writeFileSync(path.join(a.root, 'plan.md'), 'A version\n');
    await t.push(a, 'A edit');
    fs.writeFileSync(path.join(b.root, 'plan.md'), 'B version\n');
    // Force the merge-conclusion commit to fail (stands in for lock contention /
    // disk hiccups). Silent {updated:false} here left a non-converging space
    // LOOKING healthy — it must throw so the engine emits an error event.
    const origGit = (t as any).git.bind(t);
    (t as any).git = async (space: SyncSpace, args: string[]) => {
      if (args[0] === 'commit' && args.includes('--no-edit')) return { code: 1, stdout: '', stderr: 'simulated: cannot commit' };
      return origGit(space, args);
    };
    await expect(t.pull(b)).rejects.toThrow(/could not complete/i);
    // The abort left the repo un-wedged: with git healthy again, the next pull
    // converges normally (remote wins canonical + local kept as conflict copy).
    (t as any).git = origGit;
    const retry = await t.pull(b);
    expect(retry.updated).toBe(true);
    expect(retry.conflictCopies.length).toBe(1);
    expect(fs.readFileSync(path.join(b.root, 'plan.md'), 'utf8')).toBe('A version\n');
    await h.cleanup();
  });

  it('maybeGc advances the persisted counter and gc actually repacks on the Nth sync', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    // Force a gc every 2nd call so we don't need 50 iterations.
    const t = new GitTransport({ deviceName: 'T', gcInterval: 2 });
    const gitDir = path.join(a.root, '.youcoded', 'sync.git');
    const counterFile = path.join(a.root, '.youcoded', 'gc-counter');
    const packDir = path.join(gitDir, 'objects', 'pack');
    const gitEnv = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: a.root };
    const git = (...args: string[]) => execFileSync('git', args, { env: gitEnv });
    const packCount = () => { try { return fs.readdirSync(packDir).filter(f => f.endsWith('.pack')).length; } catch { return 0; } };

    // The production command is `git gc --auto`, which decides to run via a
    // heuristic. `--auto`'s LOOSE-object sampler is unreliable on a tiny repo
    // (it samples a single fanout bucket), so instead drive the deterministic
    // TOO-MANY-PACKS trigger: set gc.autoPackLimit=1 and manufacture 2 packs,
    // so `git gc --auto` MUST run and consolidate them back to 1. That proves
    // the gc had a real EFFECT rather than the command silently no-op'ing/failing
    // (both git() and maybeGc swallow failures, so counter-advance alone wouldn't).
    git('config', 'gc.autoPackLimit', '1');
    // gc.autoDetach defaults to TRUE, so `git gc --auto` forks and returns
    // immediately wherever git can daemonize() — i.e. Linux/macOS but NOT
    // Windows. The packCount() assertion below then races the background gc and
    // reads the pre-gc value, which is why this test passed locally on Windows
    // and failed on every ubuntu/macos CI run from 2026-07-14 (ffd17fe5) on.
    // Verified on Linux: with autoDetach default the count is still 2 right
    // after gc and only drops to 1 ~2s later; with it false it's 1 immediately.
    // Pinned here rather than in maybeGc because BACKGROUND gc is the behavior
    // we want in production — a sync must never block on repacking.
    git('config', 'gc.autoDetach', 'false');
    fs.writeFileSync(path.join(a.root, 'f.md'), 'v1');
    await t.push(a, 'c1');
    git('repack', '-d');                       // pack #1 (packs c1's loose objects)
    fs.writeFileSync(path.join(a.root, 'g.md'), 'v2');
    await t.push(a, 'c2');
    git('repack', '-d');                       // pack #2 (packs c2's loose objects)
    expect(packCount()).toBe(2);               // two packs now → over autoPackLimit

    await t.maybeGc(a);
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('1'); // 1 % 2 !== 0, no gc yet
    expect(packCount()).toBe(2);               // untouched — gc did NOT run
    await t.maybeGc(a);
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('2'); // 2 % 2 === 0, gc ran
    expect(packCount()).toBe(1);               // gc consolidated 2 packs → 1: real effect
    await t.maybeGc(a);
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('3');

    // Corrupt counter file → treated as 0, so next write is 1 (never throws).
    fs.writeFileSync(counterFile, 'not-a-number');
    await expect(t.maybeGc(a)).resolves.toBeUndefined();
    expect(fs.readFileSync(counterFile, 'utf8').trim()).toBe('1');
    await h.cleanup();
  });

  it('gitDirSizeBytes returns >0 for a real repo and 0 for a missing dir', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const t = new GitTransport({ deviceName: 'T' });
    fs.writeFileSync(path.join(a.root, 'f.md'), 'content');
    await t.push(a, 'commit');
    const size = await t.gitDirSizeBytes(a);
    expect(size).toBeGreaterThan(0);

    // A space whose .youcoded/sync.git doesn't exist reports 0.
    const empty: SyncSpace = { id: 'project:none', kind: 'project', root: path.join(a.root, 'nope') };
    fs.mkdirSync(empty.root, { recursive: true });
    expect(await t.gitDirSizeBytes(empty)).toBe(0);
    await h.cleanup();
  });

  // New (Task 1C): the async walk must keep the SAME behavior as the sync one
  // it replaces — sums real files and skips symlinks outright (never
  // follows). Built directly under a fake .youcoded/sync.git (no real git
  // needed) so the byte counts are exact and controllable.
  // Renamed (review round 1): this case never writes anywhere near
  // SIZE_WALK_MAX_ENTRIES (200_000), so it does not exercise the entry cap —
  // the old name overclaimed. No test in this file currently reaches the cap.
  it('gitDirSizeBytes sums files and skips symlinks', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-gt-walk-'));
    try {
      const root = path.join(tmp, 'space');
      const gitDir = path.join(root, '.youcoded', 'sync.git');
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'a.bin'), 'x'.repeat(100));
      fs.writeFileSync(path.join(gitDir, 'b.bin'), 'x'.repeat(200));
      // A symlink to a real file must NOT be counted — skipped outright, never
      // followed (also the Windows-junction backstop's first line of defense).
      fs.symlinkSync(path.join(gitDir, 'a.bin'), path.join(gitDir, 'link-to-a.bin'));

      const t = new GitTransport({ deviceName: 'T' });
      const space: SyncSpace = { id: 'project:walk', kind: 'project', root };
      expect(await t.gitDirSizeBytes(space)).toBe(300); // 100 + 200, symlink excluded
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---- Honest failures (2026-07-30 spec §1). Pins the 2026-07-27 bug: a
  // crash-truncated loose object made every git op fail while push() returned
  // {pushed:false} ("nothing to push") — sync dead 3 days, panel green. ----

  /** Zero-byte-truncate the loose object HEAD points at — the exact artifact a
   *  power loss leaves (rename landed, content never flushed). */
  function corruptHeadObject(root: string): void {
    const gd = path.join(root, '.youcoded', 'sync.git');
    const env = { ...process.env, GIT_DIR: gd };
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { env }).toString().trim();
    const objectPath = path.join(gd, 'objects', head.slice(0, 2), head.slice(2));
    // Git writes loose objects read-only (mode 0444) — truncateSync needs
    // write permission first, or it fails EACCES before it can corrupt anything.
    fs.chmodSync(objectPath, 0o644);
    fs.truncateSync(objectPath, 0);
  }

  it('push() on a crash-corrupted repo throws coded repo-corrupt — never a silent {pushed:false}', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    fs.writeFileSync(path.join(a.root, 'one.md'), 'first');
    await h.transport.push(a, 'seed');           // HEAD + origin/main now exist
    corruptHeadObject(a.root);
    fs.writeFileSync(path.join(a.root, 'two.md'), 'second');
    await expect(h.transport.push(a, 'after crash')).rejects.toMatchObject({ syncErrorCode: 'repo-corrupt' });
    await h.cleanup();
  });

  it('pull() on a crash-corrupted repo throws coded repo-corrupt — never a silent {updated:false}', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    fs.writeFileSync(path.join(a.root, 'one.md'), 'first');
    await h.transport.push(a, 'seed');
    corruptHeadObject(a.root);
    fs.writeFileSync(path.join(a.root, 'two.md'), 'second'); // dirty → pull's snapshot commit must run
    await expect(h.transport.pull(a)).rejects.toMatchObject({ syncErrorCode: 'repo-corrupt' });
    await h.cleanup();
  });

  it('benign paths stay silent: first push against an empty remote still works end-to-end', async () => {
    // Guards the allowlist: unborn origin/main ("Invalid revision range"),
    // empty-remote fetch ("couldn't find remote ref") must NOT throw.
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    fs.writeFileSync(path.join(a.root, 'one.md'), 'first');
    const pulled = await h.transport.pull(a);          // empty remote — benign
    expect(pulled.updated).toBe(false);
    const r = await h.transport.push(a, 'first push'); // no origin/main yet — benign probe failure
    expect(r.pushed).toBe(true);
    await h.cleanup();
  });

  it('an unexplained local git failure surfaces the real stderr, not a guess', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    fs.writeFileSync(path.join(a.root, 'one.md'), 'first');
    await h.transport.push(a, 'seed');
    // Corruption vs. unexplained-failure discrimination: the PRIOR technique
    // here — replacing objects/ with a plain file — was verified empirically
    // to make git print
    // `fatal: not a git repository: '<path>'`, which IS one of
    // CORRUPTION_PATTERNS in sync-error-classifier.ts. So this test was
    // silently exercising throwRepoCorrupt() while its assertion
    // (`/Sync failed for|needs repair/`) passed for EITHER branch — the "real
    // stderr, not a guess" half of the contract (the generic, non-coded throw)
    // was never actually pinned.
    //
    // A git pre-commit hook gives us a LOCAL git failure we fully author:
    // deterministic stderr, guaranteed not to match any CORRUPTION_PATTERNS or
    // benign predicate (LOCK_CONTENDED / "nothing to commit" / NOTHING_TO_PUSH_YET),
    // and portable — git invokes a hook with a `#!/bin/sh` shebang via its own
    // bundled shell on every CI OS this suite runs on (Git for Windows ships
    // one for exactly this reason).
    const hooksDir = path.join(a.root, '.youcoded', 'sync.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "simulated-disk-hiccup: pre-commit refused" >&2\nexit 1\n');
    fs.chmodSync(hookPath, 0o755);
    fs.writeFileSync(path.join(a.root, 'two.md'), 'second');
    const err = await h.transport.push(a, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // NOT the coded corruption path — proves this is the generic branch.
    expect(err.syncErrorCode).toBeUndefined();
    // AND the real git/hook-emitted text reached the message, not a guess.
    expect(String(err.message)).toContain('simulated-disk-hiccup: pre-commit refused');
    await h.cleanup();
  });
});

// Stale git-lock recovery: a git write killed mid-operation (5-min timeout
// SIGTERM, app quit, machine sleep, or a second instance racing the same
// sync.git) leaves an orphaned `*.lock` behind. Git then refuses EVERY
// subsequent write ("Unable to create index.lock: File exists"), wedging the
// space forever until the file is deleted by hand. The transport reaps locks
// older than its stale threshold before each sync so the space self-heals —
// age-gated so we never yank a lock a genuinely-live writer still holds.
describe('GitTransport stale-lock recovery', () => {
  const gitDirOf = (space: SyncSpace) => path.join(space.root, '.youcoded', 'sync.git');
  // Backdate a file's mtime so the age gate treats it as stale. utimes takes seconds.
  const backdate = (file: string, ms: number) => {
    const t = (Date.now() - ms) / 1000;
    fs.utimesSync(file, t, t);
  };

  it('reaps a stale index.lock so a wedged push commits and pushes again', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    // Tiny stale threshold so the test never waits the real 5-minute default.
    const t = new GitTransport({ deviceName: 'T', lockStaleMs: 50 });
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v1');
    await t.push(a, 'v1');
    // Simulate the crash: an empty, orphaned index.lock aged past the threshold.
    const lock = path.join(gitDirOf(a), 'index.lock');
    fs.writeFileSync(lock, '');
    backdate(lock, 10_000);
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v2');
    const r = await t.push(a, 'v2');
    expect(r.pushed).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    await h.cleanup();
  });

  it('reaps a stale index.lock so a wedged pull merge no longer throws', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const t = new GitTransport({ deviceName: 'T', lockStaleMs: 50 });
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v1');
    await t.push(a, 'v1');
    const lock = path.join(gitDirOf(a), 'index.lock');
    fs.writeFileSync(lock, '');
    backdate(lock, 10_000);
    // pull() snapshots local changes with a commit — that commit throws the
    // "Sync merge could not complete" error when the lock is present.
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v2');
    await expect(t.pull(a)).resolves.toBeDefined();
    expect(fs.existsSync(lock)).toBe(false);
    await h.cleanup();
  });

  it('leaves a FRESH lock untouched (a live writer may still hold it)', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    // Real 5-minute threshold: a just-created lock is well under it.
    const t = new GitTransport({ deviceName: 'T', lockStaleMs: 5 * 60 * 1000 });
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v1');
    await t.push(a, 'v1');
    const lock = path.join(gitDirOf(a), 'index.lock');
    fs.writeFileSync(lock, ''); // fresh — mtime is now
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v2');
    const r = await t.push(a, 'v2');
    // The fresh lock must survive, and because it survived the push could not commit.
    expect(fs.existsSync(lock)).toBe(true);
    expect(r.pushed).toBe(false);
    await h.cleanup();
  });

  it('reaps a stale ref lock under refs/, not just index.lock', async () => {
    const h = await makeHarness();
    const a = await h.makeDeviceSpace();
    const t = new GitTransport({ deviceName: 'T', lockStaleMs: 50 });
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v1');
    await t.push(a, 'v1');
    // A commit updates refs/heads/main, which needs main.lock — a stale one
    // from a crashed ref update wedges the space just like index.lock.
    const refLock = path.join(gitDirOf(a), 'refs', 'heads', 'main.lock');
    fs.mkdirSync(path.dirname(refLock), { recursive: true });
    fs.writeFileSync(refLock, '');
    backdate(refLock, 10_000);
    fs.writeFileSync(path.join(a.root, 'note.md'), 'v2');
    const r = await t.push(a, 'v2');
    expect(r.pushed).toBe(true);
    expect(fs.existsSync(refLock)).toBe(false);
    await h.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Phase 2 (2026-07-22): app-token credentials + auth-failure surfacing.
// The invocation builder and the classifier are PURE — pinned directly. The
// throw-wiring in pull()/push() is pinned by overriding the private git()
// (cast) so no test ever needs a real network/auth failure.
// ---------------------------------------------------------------------------

import {
  credentialedGitInvocation,
  classifyGitAuthFailure,
  GIT_CREDENTIAL_HELPER,
} from '../src/main/sync-spaces/git-transport';

const TOKEN = 'gho_supersecrettoken_should_never_leak';

describe('credentialedGitInvocation', () => {
  it('no token → untouched passthrough (system credential helpers keep working)', () => {
    const args = ['push', '-u', 'origin', 'main'];
    const env = { GIT_DIR: '/x/.youcoded/sync.git' } as NodeJS.ProcessEnv;
    const inv = credentialedGitInvocation(args, env, null);
    expect(inv.args).toBe(args);
    expect(inv.env).toBe(env);
  });

  it('HYGIENE PIN: with a token, the token rides ENV ONLY — never argv', () => {
    const inv = credentialedGitInvocation(['fetch', 'origin', 'main'], {}, TOKEN);
    // Helper list is RESET then replaced, so our token takes precedence over
    // any stale system helper.
    expect(inv.args.slice(0, 4)).toEqual([
      '-c', 'credential.helper=',
      '-c', `credential.helper=${GIT_CREDENTIAL_HELPER}`,
    ]);
    expect(inv.args.join(' ')).not.toContain(TOKEN);
    expect(inv.env.YOUCODED_GIT_TOKEN).toBe(TOKEN);
    // Never hang on a TTY prompt we cannot answer.
    expect(inv.env.GIT_TERMINAL_PROMPT).toBe('0');
    // The helper reads the env var by NAME — it must appear in the helper
    // string or the credentials would silently be empty.
    expect(GIT_CREDENTIAL_HELPER).toContain('$YOUCODED_GIT_TOKEN');
  });
});

describe('classifyGitAuthFailure', () => {
  it('recognizes auth stderr shapes and picks the accurate message by token use', () => {
    for (const stderr of [
      "fatal: Authentication failed for 'https://github.com/u/r.git/'",
      'remote: Invalid credentials',
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      'fatal: unable to access …: The requested URL returned error: 403',
    ]) {
      expect(classifyGitAuthFailure(stderr, true)?.message).toContain('GitHub sign-in expired');
      expect(classifyGitAuthFailure(stderr, false)?.message).toContain('Not connected to GitHub');
      expect(classifyGitAuthFailure(stderr, true)?.code).toBe('github-auth');
    }
  });

  it('returns null for every non-auth failure (offline stays silent by contract)', () => {
    for (const stderr of [
      'fatal: unable to access …: Could not resolve host: github.com',
      'fatal: the remote end hung up unexpectedly',
      '',
    ]) {
      expect(classifyGitAuthFailure(stderr, true)).toBeNull();
    }
  });
});

describe('GitTransport auth-failure surfacing', () => {
  const space: SyncSpace = { id: 'personal', kind: 'personal', root: '/nowhere' };
  const AUTH_STDERR = "fatal: Authentication failed for 'https://github.com/u/r.git/'";

  /** Transport whose git() is scripted per leading arg — no real git runs. */
  function scripted(responses: Record<string, { code: number; stdout?: string; stderr?: string }>) {
    const t = new GitTransport({ deviceName: 'test', getAuthToken: async () => TOKEN });
    (t as any).git = vi.fn(async (_s: SyncSpace, args: string[]) => {
      const r = responses[args[0]] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', tokenUsed: true };
    });
    (t as any).reapStaleLocks = () => {};
    return t;
  }

  it('pull(): an auth-refused fetch THROWS the coded plain-language error (never mistaken for offline)', async () => {
    const t = scripted({
      remote: { code: 0, stdout: 'https://github.com/u/r.git' }, // hasRemote → true
      diff: { code: 0, stdout: '' },                             // nothing staged
      fetch: { code: 1, stderr: AUTH_STDERR },
    });
    const err = await t.pull(space).catch((e) => e);
    expect(String(err.message)).toContain('GitHub sign-in expired');
    expect(err.syncErrorCode).toBe('github-auth');
    expect(String(err.message)).not.toContain(TOKEN);
  });

  it('pull(): a NON-auth fetch failure keeps the silent offline contract (spec §13)', async () => {
    const t = scripted({
      remote: { code: 0, stdout: 'https://github.com/u/r.git' },
      diff: { code: 0, stdout: '' },
      fetch: { code: 1, stderr: 'fatal: Could not resolve host: github.com' },
    });
    await expect(t.pull(space)).resolves.toEqual({ updated: false, conflictCopies: [] });
  });

  it('push(): an auth-refused push (after the recovery retry) THROWS the coded error', async () => {
    const t = scripted({
      remote: { code: 0, stdout: 'https://github.com/u/r.git' },
      add: { code: 0 },
      diff: { code: 0, stdout: '' },
      'rev-list': { code: 0, stdout: '1' },
      // fetch succeeds (token can read but not write — e.g. lost repo access),
      // so pull() completes and only the push retry hits the refusal.
      fetch: { code: 1, stderr: 'fatal: Could not resolve host: github.com' },
      push: { code: 1, stderr: AUTH_STDERR },
    });
    const err = await t.push(space, 'msg').catch((e) => e);
    expect(String(err.message)).toContain('GitHub sign-in expired');
    expect(err.syncErrorCode).toBe('github-auth');
    expect(String(err.message)).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Benign-allowlist intent pins.
// LOCK_CONTENDED and NOTHING_TO_PUSH_YET were previously covered only
// INCIDENTALLY, by tests written before the constants existed (pinning the
// OLD "swallow every failure" behavior, not the deliberate allowlist). Without
// a test that names the intent, anyone narrowing these regexes later gets a
// failure that reads as "stale-lock reaping broke" or "first-push broke",
// never "you narrowed the benign allowlist". These state the intent directly,
// via the same scripted-git() technique as the auth-failure block above (no
// real git subprocess, no real race needed to prove a policy decision).
// ---------------------------------------------------------------------------
describe('GitTransport benign-allowlist intent', () => {
  const space: SyncSpace = { id: 'personal', kind: 'personal', root: '/nowhere' };
  const LOCK_STDERR = "Unable to create '/nowhere/.youcoded/sync.git/index.lock': File exists.";

  /** Transport whose git() is scripted per leading arg — no real git runs. */
  function scripted(responses: Record<string, { code: number; stdout?: string; stderr?: string }>) {
    const t = new GitTransport({ deviceName: 'test' });
    (t as any).git = vi.fn(async (_s: SyncSpace, args: string[]) => {
      const r = responses[args[0]] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '', tokenUsed: false };
    });
    (t as any).reapStaleLocks = () => {};
    return t;
  }

  it('LOCK_CONTENDED: a still-held lock on `add` during push stays silent (transient, self-resolving)', async () => {
    const t = scripted({
      add: { code: 128, stderr: LOCK_STDERR },
      remote: { code: 0, stdout: 'https://example.com/r.git' },
      diff: { code: 0, stdout: '' },
      'rev-list': { code: 0, stdout: '0' },
    });
    await expect(t.push(space, 'msg')).resolves.toMatchObject({ pushed: false });
  });

  it('LOCK_CONTENDED now also covers `commit` (the same transient lock must not decide silent-vs-throw by which op loses the race)', async () => {
    const t = scripted({
      add: { code: 0 },
      diff: { code: 0, stdout: 'file.md' }, // something staged, so push() attempts a commit
      commit: { code: 128, stderr: LOCK_STDERR },
    });
    // Must resolve, not throw — the lock at commit is exactly as benign as at
    // add. Pin the EXACT shape, not just "resolves": a bare `.toBeDefined()`
    // passes identically whether the fix's early return runs (real result
    // {pushed:false, oversize:[]}) or the fix is missing entirely and every
    // downstream unscripted call falls through to its `{code:0}` default,
    // producing {pushed:true, commit:'', oversize:[]} — a silently wrong
    // result that still satisfies `toBeDefined()`.
    await expect(t.push(space, 'msg')).resolves.toEqual({ pushed: false, oversize: [] });
  });

  it('LOCK_CONTENDED now also covers `checkout` (pull() adopting a fresh remote while a lock is still live) — but the checkout still did not happen, so it must not report updated:true', async () => {
    const t = scripted({
      add: { code: 0 },
      diff: { code: 0, stdout: '' },
      remote: { code: 0, stdout: 'https://example.com/r.git' },
      fetch: { code: 0 },
      'rev-parse': { code: 1 }, // no local `main` yet → pull() takes the adopt-remote/checkout branch
      checkout: { code: 128, stderr: LOCK_STDERR },
    });
    // Must resolve (not throw — the lock is transient), but the checkout never
    // ran, so `updated: true` here would be a success-shaped result for a
    // verifiably failed op.
    await expect(t.pull(space)).resolves.toMatchObject({ updated: false, conflictCopies: [] });
  });

  it('LOCK_CONTENDED on `add` in pull() resolves benignly and never falls through to merge (`add` is the FIRST lock-taking op, so losing the race there leaves the tree state unknown — proceeding to merge would risk running on a dirty tree)', async () => {
    const t = scripted({
      add: { code: 128, stderr: LOCK_STDERR },
      // Every other call is left unscripted, so it defaults to `{code:0}`.
      // If the early return after `add` were missing, execution would sail
      // straight through diff/hasRemote/fetch/rev-parse/rev-list all the way
      // to `merge`, which would ALSO default to success — silently reporting
      // `updated: true` for a pull that never actually ran a merge. The
      // exact-shape assertion below catches that value; the mock-calls check
      // proves `merge` specifically never ran.
    });
    await expect(t.pull(space)).resolves.toEqual({ updated: false, conflictCopies: [] });
    const calledMerge = (t as any).git.mock.calls.some((c: any[]) => c[1][0] === 'merge');
    expect(calledMerge).toBe(false);
  });

  it('NOTHING_TO_PUSH_YET: a fresh space with zero local commits ever stays silent, not a throw', async () => {
    const t = scripted({
      add: { code: 0 },
      diff: { code: 0, stdout: '' },
      remote: { code: 0, stdout: 'https://example.com/r.git' },
      fetch: { code: 0 },
      'rev-list': { code: 1, stderr: 'fatal: Invalid revision range' }, // origin/main doesn't exist yet
      push: { code: 1, stderr: 'error: src refspec main does not match any known revisions' },
    });
    // Exact-shape pin, not a partial match: a bare `pushed: false` partial
    // match passes for ANY resolution shape, including a false positive where
    // `commit` ends up truthy (e.g. from a lock-contended commit leaking the
    // prior HEAD sha) — the field that actually decides whether the "nothing
    // was pushed" story is honest never gets checked. Pin the full result so
    // a future regression at any field surfaces here.
    await expect(t.push(space, 'msg')).resolves.toEqual({
      pushed: false, commit: undefined, oversize: [], updated: false, conflictCopies: [],
    });
  });

  it('corruption evidence wins over a co-occurring lock line: a stderr carrying BOTH lock contention AND corruption evidence throws repo-corrupt, never gets swallowed as benign', async () => {
    // The 2026-07-27 incident shape: an orphaned index.lock not yet aged past
    // lockStaleMs, sitting alongside a truncated loose object in the same
    // stderr. Corruption must win — assertLocalOk checks corruption evidence
    // BEFORE the benign allowlist, so this case can't be misclassified as a
    // simple lock race.
    const t = scripted({
      add: {
        code: 128,
        stderr: `${LOCK_STDERR}\nerror: object file .youcoded/sync.git/objects/ab/cdef is empty`,
      },
    });
    const err = await t.push(space, 'msg').catch((e) => e);
    expect(err.syncErrorCode).toBe('repo-corrupt');
  });
});

// REAL-GIT PIN: the credentialed invocation must not disturb actual git ops.
// A file:// remote never consults credential helpers, so what this validates
// is that real git (all 3 CI OSes — incl. Git for Windows's sh, which executes
// the `!`-prefixed inline helper) ACCEPTS the prepended -c flags + env on the
// full init→push→pull cycle, and that no token ever lands in the repo config.
describe('GitTransport credentialed against real git', () => {
  it('full sync cycle succeeds with a token provider; token never reaches any git config', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-gtc-'));
    try {
      const bare = path.join(tmp, 'remote.git');
      fs.mkdirSync(bare);
      execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
      const t = new GitTransport({ deviceName: 'TestDevice', getAuthToken: async () => TOKEN });
      const root = path.join(tmp, 'device');
      fs.mkdirSync(root);
      const space: SyncSpace = { id: 'project:cred', kind: 'project', root };
      await t.init(space);
      await t.setRemote(space, bare);
      fs.writeFileSync(path.join(root, 'note.md'), 'hello');
      const push = await t.push(space, 'first');
      expect(push.pushed).toBe(true);
      await expect(t.pull(space)).resolves.toEqual({ updated: false, conflictCopies: [] });
      // HYGIENE: the token must not appear in the hidden repo's config (the
      // helper is per-invocation argv config, and even that carries only the
      // env var NAME).
      const config = fs.readFileSync(path.join(root, '.youcoded', 'sync.git', 'config'), 'utf8');
      expect(config).not.toContain(TOKEN);
      expect(config).not.toContain('credential');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
