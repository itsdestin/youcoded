import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initGitWatchers, watchGit, unwatchGit, dropGitSubscriber, closeAllGitWatchers,
} from '../../src/main/git/git-watcher';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Proving an event does NOT arrive needs a bounded wait; there is no signal for
// "nothing happened". 800ms is the 300ms debounce plus generous margin for a
// loaded CI box. Everything that waits for an event that SHOULD arrive uses
// vi.waitFor instead, so it finishes as soon as the event lands.
const SETTLE_MS = 800;

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t.t',
    },
  });
}

describe('git-watcher', () => {
  let root: string;
  let events: Array<{ repoRoot: string }>;
  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-git-watch-'));
    await fs.promises.mkdir(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    events = [];
    initGitWatchers((e) => events.push(e));
  });
  afterEach(async () => {
    // Guard: the error-handler teardown (root deleted while still watched)
    // may have already closed and removed this root's entry — tolerate that.
    try { closeAllGitWatchers(); } catch { /* already torn down */ }
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('refuses a root without .git', async () => {
    const bare = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-nogit-'));
    try { expect(watchGit(bare, 1).ok).toBe(false); }
    finally { await fs.promises.rm(bare, { recursive: true, force: true }); }
  });

  it('emits one debounced event for a burst of .git changes', async () => {
    expect(watchGit(root, 1).ok).toBe(true);
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'i1');
    await fs.promises.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'i2');
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toEqual({ repoRoot: root });
    // The point of the debounce: a burst is ONE event, so it has to still be
    // one after everything has had time to arrive.
    // settle (negative assertion): no second event may follow the burst.
    await wait(SETTLE_MS);
    expect(events.length).toBe(1);
  });

  // The test above can no longer distinguish a working watcher from a dead one:
  // watchGit emits once on subscribe by design (see git-watcher.ts), so it would
  // pass with fs.watch delivering nothing at all. This is the test that fails if
  // the watcher itself breaks — the change is made AFTER the subscribe emit has
  // been drained, so only a live watch can report it.
  it('reports a change made after the subscribe reconcile has landed', async () => {
    expect(watchGit(root, 1).ok).toBe(true);
    await vi.waitFor(() => expect(events.length).toBe(1));
    events.length = 0;
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'later');
    await vi.waitFor(() => expect(events).toEqual([{ repoRoot: root }]));
  });

  it('stops emitting after the last subscriber unwatches', async () => {
    watchGit(root, 1);
    watchGit(root, 2);
    unwatchGit(root, 1);
    unwatchGit(root, 2);
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'x');
    await wait(SETTLE_MS);
    expect(events).toEqual([]);
  });

  it('dropGitSubscriber releases every root a renderer held', async () => {
    watchGit(root, 7);
    dropGitSubscriber(7);
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'x');
    await wait(SETTLE_MS);
    expect(events).toEqual([]);
  });

  it('survives the watched root being deleted without unwatching first', async () => {
    // NOTE: on Linux, deleting a watched directory does not reliably make
    // fs.watch emit 'error' — inotify just stops delivering useful events
    // (verified empirically: rm -rf on a watched dir produced only 'rename'
    // change events, never 'error' or 'close'). The platforms/conditions the
    // review finding is guarding against (Windows, network filesystems,
    // inotify queue overflow) DO emit 'error' on the FSWatcher. To exercise
    // our handler deterministically regardless of platform, we spy on
    // fs.watch to capture the real FSWatcher instances it creates, then
    // manually fire 'error' on one of them after the real deletion — this
    // simulates exactly what those platforms do without depending on OS-
    // specific watch semantics.
    const watchSpy = vi.spyOn(fs, 'watch');
    expect(watchGit(root, 1).ok).toBe(true);
    const watchers = watchSpy.mock.results.map((r) => r.value as fs.FSWatcher);
    expect(watchers.length).toBeGreaterThan(0);

    // Simulate `git worktree remove` / external surgery: the root (and its
    // .git dir) disappears while we're still subscribed, with no unwatchGit
    // call first.
    await fs.promises.rm(root, { recursive: true, force: true });

    // This used to throw an uncaught exception (no 'error' listener on an
    // EventEmitter) and crash the Electron main process.
    expect(() => watchers[0].emit('error', new Error('simulated ENOENT'))).not.toThrow();
    // WHY no wait here (final review F55): the watcher's error handler tears the entry down
    // synchronously inside emit(), so the 200 ms sleep that stood here guarded nothing — and a
    // fixed sleep before a positive check is the shape that goes red under load.

    // Confirm the entry actually self-healed: a fresh subscribe on the now-
    // missing root goes back through the existsSync check and reports
    // {ok:false}, rather than reusing a stale map entry.
    expect(watchGit(root, 9).ok).toBe(false);
    watchSpy.mockRestore();
  });

  it('same subscriber watching the same root twice needs two unwatches before events stop', async () => {
    expect(watchGit(root, 1).ok).toBe(true);
    expect(watchGit(root, 1).ok).toBe(true); // refcount for subscriber 1 is now 2
    unwatchGit(root, 1); // refcount 2 -> 1, entry must still be alive
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'x1');
    await vi.waitFor(() => expect(events.length).toBe(1));

    unwatchGit(root, 1); // refcount 1 -> 0, last subscriber gone, entry closes
    events = [];
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'x2');
    await wait(SETTLE_MS);
    expect(events).toEqual([]);
  });

  it('dropGitSubscriber releases multiple roots held by one subscriber at once', async () => {
    const root2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-git-watch2-'));
    await fs.promises.mkdir(path.join(root2, '.git', 'refs', 'heads'), { recursive: true });
    await fs.promises.writeFile(path.join(root2, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    try {
      expect(watchGit(root, 5).ok).toBe(true);
      expect(watchGit(root2, 5).ok).toBe(true);
      dropGitSubscriber(5);
      await fs.promises.writeFile(path.join(root, '.git', 'index'), 'x');
      await fs.promises.writeFile(path.join(root2, '.git', 'index'), 'x');
      await wait(SETTLE_MS);
      expect(events).toEqual([]);
    } finally {
      await fs.promises.rm(root2, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasGit())('git-watcher (linked worktree, real git)', () => {
  let mainRoot: string;
  let linkedRoot: string;
  let events: Array<{ repoRoot: string }>;

  beforeEach(async () => {
    mainRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-git-watch-main-'));
    sh(mainRoot, ['init', '-b', 'main']);
    await fs.promises.writeFile(path.join(mainRoot, 'a.txt'), 'one\n');
    sh(mainRoot, ['add', '.']);
    sh(mainRoot, ['commit', '-m', 'initial']);
    linkedRoot = path.join(path.dirname(mainRoot), path.basename(mainRoot) + '-linked');
    sh(mainRoot, ['worktree', 'add', linkedRoot, '-b', 'feature']);
    events = [];
    initGitWatchers((e) => events.push(e));
  });

  afterEach(async () => {
    try { closeAllGitWatchers(); } catch { /* already torn down */ }
    try { sh(mainRoot, ['worktree', 'remove', '--force', linkedRoot]); } catch { /* best effort */ }
    await fs.promises.rm(mainRoot, { recursive: true, force: true });
    await fs.promises.rm(linkedRoot, { recursive: true, force: true });
  });

  it('watchGit on a linked worktree root resolves the real gitdir/commondir and reports ok:true', async () => {
    // <linkedRoot>/.git is a FILE (`gitdir: <main>/.git/worktrees/feature`),
    // not a directory — the pre-fix code only handled the directory case and
    // reported {ok:true} on a dead watcher (see resolveGitDirs in git-watcher.ts).
    expect(fs.statSync(path.join(linkedRoot, '.git')).isFile()).toBe(true);
    expect(watchGit(linkedRoot, 1).ok).toBe(true);
  });

  it('emits a debounced event when a commit is made in the linked worktree', async () => {
    expect(watchGit(linkedRoot, 1).ok).toBe(true);
    await fs.promises.writeFile(path.join(linkedRoot, 'a.txt'), 'one\ntwo\n');
    sh(linkedRoot, ['add', '.']);
    sh(linkedRoot, ['commit', '-m', 'change from linked worktree']);
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1));
    expect(events[0]).toEqual({ repoRoot: linkedRoot });
  });
});
