// desktop/tests/sync-spaces-repair.test.ts
// Real-git INTEGRATION tests for the two-tier corruption repair (2026-07-30
// spec §2), plus unit tests for the pure fs helpers. Same conventions as
// sync-spaces-git-transport.test.ts (real subprocesses → generous ceiling).
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { GitTransport } from '../src/main/sync-spaces/git-transport';
import { deleteZeroByteObjects, brokenBackupName, pruneBrokenBackups } from '../src/main/sync-spaces/repair';
import { SpaceSyncEngine } from '../src/main/sync-spaces/engine';
import type { SyncSpace, SpaceSyncEvent } from '../src/main/sync-spaces/types';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// vi.waitFor carries its OWN default ceiling (1000ms) independent of the
// vi.setConfig above — omitting an explicit timeout would silently cap the
// wait at 1s while this file's real-git ops (and the healed rerun below) can
// legitimately take longer. One named knob, not an inline literal (see
// sync-spaces-engine.test.ts's WAIT_MS for the same convention): reuse the
// file's own testTimeout ceiling rather than inventing a second, tighter
// budget that could starve the end-to-end case before the config ceiling would.
const E2E_WAIT_MS = 120_000;

// Fix (test fidelity): git writes loose objects READ-ONLY (mode 0444), so a
// bare fs.truncateSync on one fails EACCES before it can corrupt anything —
// the test would then be silently testing nothing. chmod to writable first,
// exactly like Task 3's helper had to.
function truncateObject(p: string): void {
  fs.chmodSync(p, 0o644);
  fs.truncateSync(p, 0);
}

function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-repair-'));
  const bare = path.join(tmp, 'remote.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  const root = path.join(tmp, 'device');
  fs.mkdirSync(root);
  const space: SyncSpace = { id: 'project:repair', kind: 'project', root };
  // Capture the injected log (the service threads its logFn the same way) so
  // tests can assert repair() leaves a readable trace, not just a return value.
  const logs: string[] = [];
  const transport = new GitTransport({ deviceName: 'RepairTest', log: (m) => logs.push(m) });
  const gitDir = path.join(root, '.youcoded', 'sync.git');
  const gitEnv = { ...process.env, GIT_DIR: gitDir };
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return { tmp, bare, root, space, transport, gitDir, gitEnv, logs, cleanup };
}

/** Clone the bare remote and return the file list + a file's content. */
function remoteState(bare: string, tmp: string): { files: string[]; read: (f: string) => string } {
  const co = fs.mkdtempSync(path.join(tmp, 'verify-'));
  execFileSync('git', ['clone', '--quiet', bare, co]);
  const files = fs.readdirSync(co).filter(f => f !== '.git').sort();
  return { files, read: (f) => fs.readFileSync(path.join(co, f), 'utf8') };
}

describe('repair helpers (pure)', () => {
  it('deleteZeroByteObjects removes exactly the empty poison files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-zb-'));
    const objects = path.join(tmp, 'objects');
    fs.mkdirSync(path.join(objects, 'ab'), { recursive: true });
    fs.mkdirSync(path.join(objects, 'cd'), { recursive: true });
    fs.writeFileSync(path.join(objects, 'ab', 'empty1'), '');
    fs.writeFileSync(path.join(objects, 'cd', 'empty2'), '');
    fs.writeFileSync(path.join(objects, 'cd', 'real'), 'content');
    expect(deleteZeroByteObjects(tmp)).toBe(2);
    expect(fs.existsSync(path.join(objects, 'cd', 'real'))).toBe(true);
    expect(fs.existsSync(path.join(objects, 'ab', 'empty1'))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('pruneBrokenBackups keeps only the newest backup', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-pb-'));
    const gd = path.join(tmp, 'sync.git');
    fs.mkdirSync(`${gd}.broken-2026-07-27T19-21-00`);
    fs.mkdirSync(`${gd}.broken-2026-07-28T20-16-00`);
    fs.mkdirSync(`${gd}.broken-2026-07-30T14-00-00`);
    pruneBrokenBackups(gd);
    expect(fs.readdirSync(tmp).sort()).toEqual(['sync.git.broken-2026-07-30T14-00-00']);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('brokenBackupName is filesystem-safe (no colons — Windows)', () => {
    const name = brokenBackupName('/x/sync.git', new Date('2026-07-30T14:05:06Z'));
    expect(name).toBe('/x/sync.git.broken-2026-07-30T14-05-06');
  });
});

describe('GitTransport.repair (real git)', () => {
  it('Tier 1: zero-byte HEAD object → reset to origin/main → next push recovers ALL local content', async () => {
    const w = makeWorld();
    await w.transport.init(w.space);
    await w.transport.setRemote(w.space, w.bare);
    fs.writeFileSync(path.join(w.root, 'pushed.md'), 'made it out');
    await w.transport.push(w.space, 'seed');                       // origin/main exists
    // Local-only commit after the push, then the crash zeroes its object —
    // mirrors the Z13: local tip unreadable, older origin/main intact, and the
    // stranded commit NEVER reached the remote (rewind the bare too).
    fs.writeFileSync(path.join(w.root, 'stranded.md'), 'local only');
    await w.transport.push(w.space, 'will be stranded');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { env: w.gitEnv }).toString().trim();
    const prev = execFileSync('git', ['rev-parse', 'HEAD~1'], { env: w.gitEnv }).toString().trim(); // resolve BEFORE truncating
    truncateObject(path.join(w.gitDir, 'objects', head.slice(0, 2), head.slice(2)));
    execFileSync('git', ['--git-dir', w.bare, 'update-ref', 'refs/heads/main', prev]);       // remote never saw the crash commit
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', prev], { env: w.gitEnv }); // local mirror agrees

    // Pin BOTH the tier and the worktree-untouched property before repairing:
    // Tier 1 must not create a `.broken-*` backup sibling (that's Tier 2's
    // signature — it renames gitDir aside then re-inits, which recreates
    // gitDir and would make a bare fs.existsSync(gitDir) check pass under
    // EITHER tier), and Tier 1 must not write to worktree files at all.
    const strandedBefore = fs.statSync(path.join(w.root, 'stranded.md'));

    await expect(w.transport.push(w.space, 'x')).rejects.toMatchObject({ syncErrorCode: 'repo-corrupt' });
    const outcome = await w.transport.repair!(w.space);
    // PR #276 review: repair() must leave a trace of what it did — tier + the
    // previously-discarded zero-byte sweep count (exactly 1 here: the object
    // the "crash" truncated), both returned AND logged.
    expect(outcome).toMatchObject({ tier: 1, zeroByteObjectsDeleted: 1 });
    expect(outcome.backupPath).toBeUndefined();
    expect(w.logs.some(l => /repair\(project:repair\) tier=1/.test(l) && /1 zero-byte object/.test(l))).toBe(true);
    expect(fs.existsSync(w.gitDir)).toBe(true);
    // Tier 1 discriminator: no `sync.git.broken-*` sibling in .youcoded. Only
    // Tier 2 creates one (brokenBackupName + rename), so this fails if repair
    // silently took the Tier 2 path instead.
    const siblings = fs.readdirSync(path.join(w.root, '.youcoded'));
    expect(siblings.some(e => e.startsWith('sync.git.broken-'))).toBe(false);
    // Worktree-untouched discriminator, pinned specifically to Tier 1 (the
    // riskier tier — it manipulates refs and deletes the index in place;
    // Tier 2's rename+init never goes near the worktree by construction, so
    // this file's mtime would survive Tier 2 regardless of a worktree-write
    // bug). If Tier 1 ever grew a checkout/reset --hard, this fails.
    expect(fs.readFileSync(path.join(w.root, 'stranded.md'), 'utf8')).toBe('local only');
    expect(fs.statSync(path.join(w.root, 'stranded.md')).mtimeMs).toBe(strandedBefore.mtimeMs);
    fs.writeFileSync(path.join(w.root, 'after-heal.md'), 'post');
    const r = await w.transport.push(w.space, 'healed snapshot');
    expect(r.pushed).toBe(true);
    const remote = remoteState(w.bare, w.tmp);
    // Every worktree file made it out — including the one stranded by the crash.
    expect(remote.files).toEqual(['after-heal.md', 'pushed.md', 'stranded.md']);
    expect(remote.read('stranded.md')).toBe('local only');
    w.cleanup();
  });

  it('Tier 2: origin/main unreadable too → repo moved aside as .broken-*, fresh init', async () => {
    const w = makeWorld();
    await w.transport.init(w.space);
    await w.transport.setRemote(w.space, w.bare);
    fs.writeFileSync(path.join(w.root, 'a.md'), 'content-a');
    await w.transport.push(w.space, 'seed');
    // Zero EVERY loose object: local origin/main's closure is gone → Tier 1
    // verification fails → Tier 2.
    const objects = path.join(w.gitDir, 'objects');
    for (const d of fs.readdirSync(objects)) {
      const dir = path.join(objects, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) truncateObject(path.join(dir, f));
    }
    const outcome = await w.transport.repair!(w.space);
    const parent = path.join(w.root, '.youcoded');
    const entries = fs.readdirSync(parent);
    expect(entries.some(e => e.startsWith('sync.git.broken-'))).toBe(true);  // backup kept
    expect(fs.existsSync(path.join(w.gitDir, 'HEAD'))).toBe(true);           // fresh repo
    // Trace (PR #276 review): tier 2 records WHY tier 1 fell through, how many
    // poison objects the sweep removed (every loose object was zeroed above),
    // and where the broken repo went — and the same facts hit the log.
    expect(outcome.tier).toBe(2);
    expect(outcome.zeroByteObjectsDeleted).toBeGreaterThan(0);
    expect(outcome.tier1Failure).toBeTruthy();
    expect(path.basename(outcome.backupPath ?? '')).toMatch(/^sync\.git\.broken-/);
    expect(entries).toContain(path.basename(outcome.backupPath ?? ''));
    expect(w.logs.some(l => /repair\(project:repair\) tier=2/.test(l) && /broken repo kept at sync\.git\.broken-/.test(l))).toBe(true);
    // Re-provision (the engine's ensureProvisioned does this in prod), then a
    // normal pull+push cycle converges: remote history re-adopted, worktree pushed.
    await w.transport.setRemote(w.space, w.bare);
    await w.transport.pull(w.space);
    fs.writeFileSync(path.join(w.root, 'b.md'), 'content-b');
    const r = await w.transport.push(w.space, 'post tier2');
    expect(r.pushed).toBe(true);
    const remote = remoteState(w.bare, w.tmp);
    expect(remote.files).toEqual(['a.md', 'b.md']);
    w.cleanup();
  });

  // NOTE: this exercises Tier 2 only. The seed push makes HEAD == origin/main,
  // so truncating HEAD's object also destroys origin/main's closure, which
  // fails Tier 1's cat-file verification and falls through to Tier 2 every
  // time. The Tier-1-specific worktree-untouched pin lives in the Tier 1 test
  // above — Tier 1 is the riskier path (it manipulates refs and deletes the
  // index in place) and needs its own coverage rather than inheriting this
  // one by coincidence.
  it('worktree files are NEVER touched by repair (Tier 2 path)', async () => {
    const w = makeWorld();
    await w.transport.init(w.space);
    await w.transport.setRemote(w.space, w.bare);
    fs.writeFileSync(path.join(w.root, 'precious.md'), 'do not touch');
    await w.transport.push(w.space, 'seed');
    const before = fs.statSync(path.join(w.root, 'precious.md')).mtimeMs;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { env: w.gitEnv }).toString().trim();
    truncateObject(path.join(w.gitDir, 'objects', head.slice(0, 2), head.slice(2)));
    await w.transport.repair!(w.space);
    expect(fs.readFileSync(path.join(w.root, 'precious.md'), 'utf8')).toBe('do not touch');
    expect(fs.statSync(path.join(w.root, 'precious.md')).mtimeMs).toBe(before);
    w.cleanup();
  });
});

describe('engine + real transport end-to-end', () => {
  it('crash-corrupted repo: engine heals, reruns, and the remote ends byte-identical to the worktree', async () => {
    const w = makeWorld();
    await w.transport.init(w.space);
    await w.transport.setRemote(w.space, w.bare);
    fs.writeFileSync(path.join(w.root, 'day1.md'), 'pushed before the crash');
    await w.transport.push(w.space, 'seed');
    // The crash (2026-07-27 Z13 incident, reproduced in miniature): a power
    // loss zeroes the loose object the local tip points at. Git checks object
    // existence by FILENAME, so a plain `add -A` sees the empty file "exists"
    // and never rewrites it from the intact worktree file — the repo cannot
    // self-heal on its own. Critically, the crash commit had NEVER reached the
    // remote, so BOTH the bare repo's main AND the local origin/main mirror
    // must be rewound to the prior commit — rewinding only one would make this
    // solvable by a plain fetch/reset, not a real repair.
    fs.writeFileSync(path.join(w.root, 'day2.md'), 'stranded by the crash');
    await w.transport.push(w.space, 'stranded');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { env: w.gitEnv }).toString().trim();
    const prev = execFileSync('git', ['rev-parse', 'HEAD~1'], { env: w.gitEnv }).toString().trim(); // resolve BEFORE truncating
    truncateObject(path.join(w.gitDir, 'objects', head.slice(0, 2), head.slice(2)));
    execFileSync('git', ['--git-dir', w.bare, 'update-ref', 'refs/heads/main', prev]);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', prev], { env: w.gitEnv });

    // Real engine + real transport, no mocks anywhere in this test — this is
    // what proves the SYSTEM converges, not just the parts in isolation.
    // engine.syncSpace's pull-then-push hits the corrupted object, the
    // transport throws with syncErrorCode 'repo-corrupt', the engine's catch
    // calls the real GitTransport.repair (Tier 1: purge the zero-byte object,
    // reset main to origin/main), emits the notice, and reruns itself.
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(w.transport, { onEvent: (e) => events.push(e), pollMs: 0, debounceMs: 50 });
    await engine.addSpace(w.space);
    await engine.syncSpace(w.space);
    // engine.syncSpace's own promise resolves as soon as the FIRST (corrupt)
    // attempt's `finally` fires the rerun — it does NOT await the rerun itself
    // (engine.ts kicks it off as a fire-and-forget `void this.syncSpace(...)`
    // inside that finally). So this vi.waitFor is load-bearing, not decorative:
    // without it, the assertions below could run before the healed retry —
    // the one that actually reaches a real push — has finished.
    await vi.waitFor(() => expect(events.some(e => e.type === 'synced' && e.pushed)).toBe(true), { timeout: E2E_WAIT_MS });
    await engine.stop();

    expect(events.some(e => e.type === 'notice' && /repaired itself/.test(e.message))).toBe(true);
    // Discriminates the heal actually happening: if repair() were never called
    // (or the healed rerun's push failed for any reason), the corrupted
    // pull/push keeps throwing 'repo-corrupt' — the engine heals at most ONCE
    // per space per launch (engine.ts's healedSpaces guard), so a second
    // failure forwards as a plain error event and this array is non-empty.
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    const remote = remoteState(w.bare, w.tmp);
    // Discriminates the actual incident class this test reproduces: Tier 1
    // resets local `main` to origin/main (day1.md only) and deletes the index,
    // but leaves day2.md sitting untouched on disk — the healed rerun's
    // `add -A` re-discovers it as new content and pushes it out. If the heal
    // or the rerun push were broken, the remote would end with only day1.md.
    expect(remote.files).toEqual(['day1.md', 'day2.md']);
    // Byte-check BOTH files, not just the stranded one — the title claims the
    // remote ends byte-identical to the worktree, which day1.md (pushed before
    // the crash, untouched by the repair) must also prove.
    expect(remote.read('day1.md')).toBe('pushed before the crash');
    expect(remote.read('day2.md')).toBe('stranded by the crash');  // the 3,381-file class, in miniature
    w.cleanup();
  });
});

// Tier 1 used to point main at origin/main without touching the worktree. When
// the crash landed after a fetch but before the merge, the disk lagged the new
// main, and the next add -A pushed that lag as edits: a peer's new file DELETED
// for every device, a peer's deletion undone. Real git, two devices, one remote.
describe('repair Tier 1 never turns an unapplied fetch into pushed edits', () => {
  function twoDevices() {
    const w = makeWorld();
    const mk = async (name: string) => {
      const root = path.join(w.tmp, name);
      fs.mkdirSync(root);
      const space: SyncSpace = { id: 'project:repair', kind: 'project', root };
      const transport = new GitTransport({ deviceName: name, log: () => {} });
      await transport.init(space);
      await transport.setRemote(space, w.bare);
      const env = { ...process.env, GIT_DIR: path.join(root, '.youcoded', 'sync.git'), GIT_WORK_TREE: root };
      return { root, space, transport, env };
    };
    return { w, mk };
  }
  const has = (root: string, f: string) => fs.existsSync(path.join(root, f));

  it("keeps a peer's new file and applies a peer's deletion when this device's tip is readable", async () => {
    const { w, mk } = twoDevices();
    try {
      const a = await mk('A');
      fs.writeFileSync(path.join(a.root, 'shared.txt'), 'v1');
      fs.writeFileSync(path.join(a.root, 'stale.txt'), 'old');
      await a.transport.push(a.space, 'seed');
      const b = await mk('B');
      await b.transport.pull(b.space);
      fs.writeFileSync(path.join(a.root, 'new.txt'), 'from A');
      fs.rmSync(path.join(a.root, 'stale.txt'));
      await a.transport.push(a.space, 'a edits');
      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { env: b.env }); // fetched, never applied
      expect((await b.transport.repair!(b.space))!.tier).toBe(1);
      await b.transport.pull(b.space);
      await b.transport.push(b.space, 'after repair');
      expect(remoteState(w.bare, w.tmp).files).toEqual(['new.txt', 'shared.txt']);
      expect(has(b.root, 'new.txt')).toBe(true);
      expect(has(b.root, 'stale.txt')).toBe(false);
    } finally { w.cleanup(); }
  });

  it("with this device's tip unreadable: a peer's file survives and a differing local file becomes a copy", async () => {
    const { w, mk } = twoDevices();
    try {
      const a = await mk('A');
      fs.writeFileSync(path.join(a.root, 'shared.txt'), 'v1');
      await a.transport.push(a.space, 'seed');
      const b = await mk('B');
      await b.transport.pull(b.space);
      fs.writeFileSync(path.join(a.root, 'new.txt'), 'from A');
      fs.writeFileSync(path.join(a.root, 'shared.txt'), 'v2 from A');
      await a.transport.push(a.space, 'a edits');
      // B edits shared.txt and commits locally; the crash zeroes that commit.
      fs.writeFileSync(path.join(b.root, 'shared.txt'), 'B local edit');
      execFileSync('git', ['add', '-A'], { env: b.env });
      execFileSync('git', ['commit', '-q', '-m', 'stranded'], { env: b.env });
      const tip = execFileSync('git', ['rev-parse', 'HEAD'], { env: b.env }).toString().trim();
      execFileSync('git', ['fetch', '-q', 'origin', 'main'], { env: b.env });
      truncateObject(path.join(b.root, '.youcoded', 'sync.git', 'objects', tip.slice(0, 2), tip.slice(2)));
      expect((await b.transport.repair!(b.space))!.tier).toBe(1);
      await b.transport.pull(b.space);
      await b.transport.push(b.space, 'after repair');
      const remote = remoteState(w.bare, w.tmp);
      expect(remote.files).toContain('new.txt');
      expect(remote.read('shared.txt')).toBe('v2 from A');
      const copy = remote.files.find((f) => f.startsWith('shared (from B, '));
      expect(copy && remote.read(copy)).toBe('B local edit');
    } finally { w.cleanup(); }
  });
});
