// git-service — status, review, stage/commit/discard and history against real Git
// repositories, including file names Git has to quote.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shell } from 'electron'; // vitest alias -> tests/__mocks__/electron.ts
import {
  gitFileStatus, gitFileReview, gitCommitFileDiff,
  gitStage, gitUnstage, gitCommit, gitDiscard, LOG_PAGE,
} from '../../src/main/git/git-service';
import { execGit, invalidateRepoRootCache } from '../../src/main/git/git-exec';
import { parseNumstat, parsePorcelainV2 } from '../../src/main/git/porcelain';

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

describe.skipIf(!hasGit())('git-service (integration, real git)', () => {
  let root: string;
  beforeEach(async () => {
    // WHY realpath: on macOS os.tmpdir() is a /var -> /private/var symlink
    // alias; git's own toplevel answer is always canonical. Tests below
    // compare absolute paths (e.g. shell.trashItem args) against `root` —
    // without this, those assertions would fail on macOS CI even with the
    // production fix applied, since `root` itself would be the alias form.
    root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-git-svc-')));
    invalidateRepoRootCache();
    sh(root, ['init', '-b', 'main']);
    // WHY: GitHub Windows runners default core.autocrlf=true globally, so
    // `git checkout HEAD` writes back CRLF and breaks byte-exact fixture
    // assertions (and can produce phantom eol-only diffs). Pin it off per-repo.
    sh(root, ['config', 'core.autocrlf', 'false']);
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
    sh(root, ['add', '.']);
    sh(root, ['commit', '-m', 'initial']);
  });
  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  it('fileStatus: clean tracked file -> no counts, hasHistory true', async () => {
    const r = await gitFileStatus(root, 'a.txt');
    expect(r).toMatchObject({ ok: true, isRepo: true, branch: 'main', counts: null, hasHistory: true, staged: false });
  });

  it('fileStatus: modified file -> counts vs HEAD', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'one\nTWO\nthree\n');
    const r = await gitFileStatus(root, 'a.txt');
    expect(r.counts).toEqual({ added: 2, removed: 1 });
  });

  it('fileStatus: non-repo dir -> isRepo false, ok true', async () => {
    const bare = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-norepo-')));
    try {
      const r = await gitFileStatus(bare, 'x.txt');
      expect(r).toMatchObject({ ok: true, isRepo: false, counts: null, hasHistory: false });
    } finally { await fs.promises.rm(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); }
  });

  it('fileStatus: escaping relPath is refused', async () => {
    const r = await gitFileStatus(root, '../outside.txt');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path-outside-project');
  });

  it('mutation op in a non-repo dir reports not-a-git-repository, not path-outside-project', async () => {
    const bare = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-norepo-')));
    try {
      const r = await gitStage(bare, 'x.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toBe('not-a-git-repository');
    } finally { await fs.promises.rm(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); }
  });

  it('mutation op with an escaping relPath still reports path-outside-project', async () => {
    const r = await gitStage(root, '../outside.txt');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path-outside-project');
  });

  it('fileReview: modified file -> uncommitted hunks + log + stagedCount', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'one\nTWO\n');
    const r = await gitFileReview(root, 'a.txt');
    expect(r.ok).toBe(true);
    expect(r.uncommitted?.untracked).toBe(false);
    expect(r.uncommitted?.inHead).toBe(true);
    expect(r.uncommitted?.counts).toEqual({ added: 1, removed: 1 });
    expect(r.uncommitted?.hunks[0].lines).toContain('-two');
    expect(r.log).toHaveLength(1);
    expect(r.log[0].subject).toBe('initial');
    expect(r.hasMore).toBe(false);
    expect(r.stagedCount).toBe(0);
  });

  it('fileReview: untracked file -> synthesized all-additions hunk', async () => {
    await fs.promises.writeFile(path.join(root, 'new.txt'), 'alpha\nbeta\n');
    const r = await gitFileReview(root, 'new.txt');
    expect(r.uncommitted?.untracked).toBe(true);
    expect(r.uncommitted?.inHead).toBe(false);
    expect(r.uncommitted?.hunks).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+alpha', '+beta'] },
    ]);
    expect(r.log).toEqual([]);
  });

  it('fileReview: untracked symlink outside the repo renders as binary stub, never follows the link', async () => {
    // A malicious/careless untracked symlink pointing outside the repo root
    // (e.g. at /etc/passwd) must never have its TARGET content read into
    // hunks — that would leak arbitrary filesystem content through the git
    // review surface. lstat (not stat) is what prevents the follow.
    const outside = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-symlink-target-')));
    try {
      const secretPath = path.join(outside, 'secret.txt');
      await fs.promises.writeFile(secretPath, 'TOP SECRET CONTENT\n');
      const linkPath = path.join(root, 'link.txt');
      await fs.promises.symlink(secretPath, linkPath);

      const r = await gitFileReview(root, 'link.txt');
      expect(r.ok).toBe(true);
      expect(r.uncommitted).toMatchObject({ untracked: true, binary: true, hunks: [] });
      expect(JSON.stringify(r)).not.toContain('TOP SECRET');
    } finally { await fs.promises.rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); }
  });

  it('fileStatus: untracked symlink outside the repo counts as 0/0, never follows the link', async () => {
    const outside = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-symlink-target-')));
    try {
      const secretPath = path.join(outside, 'secret.txt');
      await fs.promises.writeFile(secretPath, 'TOP SECRET CONTENT\n');
      const linkPath = path.join(root, 'link2.txt');
      await fs.promises.symlink(secretPath, linkPath);

      const r = await gitFileStatus(root, 'link2.txt');
      expect(r.ok).toBe(true);
      expect(r.counts).toEqual({ added: 0, removed: 0 });
    } finally { await fs.promises.rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); }
  });

  it('fileReview: oversize untracked file renders as a binary stub, not synthesized hunks', async () => {
    await fs.promises.writeFile(path.join(root, 'huge.txt'), 'x'.repeat(1024 * 1024 + 1));
    const r = await gitFileReview(root, 'huge.txt');
    expect(r.uncommitted).toMatchObject({ untracked: true, binary: true, hunks: [] });
  });

  it('stage/unstage flip index state and stagedCount', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'changed\n');
    expect((await gitStage(root, 'a.txt')).ok).toBe(true);
    expect((await gitFileStatus(root, 'a.txt')).staged).toBe(true);
    expect((await gitFileReview(root, 'a.txt')).stagedCount).toBe(1);
    expect((await gitUnstage(root, 'a.txt')).ok).toBe(true);
    expect((await gitFileStatus(root, 'a.txt')).staged).toBe(false);
  });

  it('commit commits the index and clears the uncommitted card', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'committed\n');
    await gitStage(root, 'a.txt');
    const c = await gitCommit(root, 'test: from the drawer');
    expect(c.ok).toBe(true);
    const r = await gitFileReview(root, 'a.txt');
    expect(r.uncommitted).toBeNull();
    expect(r.log[0].subject).toBe('test: from the drawer');
  });

  it('commit with empty index fails with real git stderr', async () => {
    const c = await gitCommit(root, 'nothing to commit');
    expect(c.ok).toBe(false);
    expect(c.error!.length).toBeGreaterThan(0); // git's own message, passed through
  });

  it('commitFileDiff returns the hunks of a past commit for the file', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
    sh(root, ['add', '.']); sh(root, ['commit', '-m', 'add three']);
    const sha = sh(root, ['rev-parse', 'HEAD']).trim();
    const d = await gitCommitFileDiff(root, sha, 'a.txt');
    expect(d.ok).toBe(true);
    expect(d.hunks[0].lines).toContain('+three');
  });

  it('commitFileDiff rejects a malformed sha before touching git', async () => {
    const d = await gitCommitFileDiff(root, 'not-a-sha!', 'a.txt');
    expect(d).toMatchObject({ ok: false, error: 'invalid-sha' });
  });

  it('discard tracked restores HEAD content', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'garbage\n');
    expect((await gitDiscard(root, 'a.txt')).ok).toBe(true);
    expect(await fs.promises.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('discard untracked goes through shell.trashItem, never git clean', async () => {
    const p = path.join(root, 'junk.txt');
    await fs.promises.writeFile(p, 'x\n');
    expect((await gitDiscard(root, 'junk.txt')).ok).toBe(true);
    expect(shell.trashItem).toHaveBeenCalledWith(p);
  });

  it('discard of a staged-but-never-committed file unstages then trashes', async () => {
    const p = path.join(root, 'staged-new.txt');
    await fs.promises.writeFile(p, 'x\n');
    sh(root, ['add', 'staged-new.txt']);
    expect((await gitDiscard(root, 'staged-new.txt')).ok).toBe(true);
    expect(shell.trashItem).toHaveBeenCalledWith(p);
    // Index no longer holds it (the mocked trash leaves the file on disk, so
    // git now sees it as plain untracked — proving rm --cached ran).
    expect(sh(root, ['status', '--porcelain']).trim()).toBe('?? staged-new.txt');
  });

  it('fileStatus sees an untracked file inside an untracked directory', async () => {
    await fs.promises.mkdir(path.join(root, 'newdir'));
    await fs.promises.writeFile(path.join(root, 'newdir', 'inner.txt'), 'a\nb\n');
    const r = await gitFileStatus(root, 'newdir/inner.txt');
    expect(r.counts).toEqual({ added: 2, removed: 0 });
  });

  it('fileReview works in a repo with no commits yet (unborn HEAD)', async () => {
    const fresh = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-unborn-')));
    try {
      sh(fresh, ['init']);
      sh(fresh, ['config', 'core.autocrlf', 'false']);
      await fs.promises.writeFile(path.join(fresh, 'f.txt'), 'hello\n');
      sh(fresh, ['add', 'f.txt']);
      const r = await gitFileReview(fresh, 'f.txt');
      expect(r.ok).toBe(true);
      expect(r.uncommitted?.inHead).toBe(false);
      expect(r.uncommitted?.hunks[0].lines).toEqual(['+hello']);
      expect(r.log).toEqual([]);
    } finally { await fs.promises.rm(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); }
  });

  it('discard on unborn HEAD unstages (rm --cached) then trashes, leaving the file untracked', async () => {
    const fresh = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-unborn-')));
    try {
      sh(fresh, ['init']);
      sh(fresh, ['config', 'core.autocrlf', 'false']);
      await fs.promises.writeFile(path.join(fresh, 'f.txt'), 'hello\n');
      sh(fresh, ['add', 'f.txt']);
      const r = await gitDiscard(fresh, 'f.txt');
      expect(r.ok).toBe(true);
      expect(shell.trashItem).toHaveBeenCalledWith(path.join(fresh, 'f.txt'));
      // The mocked trash leaves the file on disk, so git now sees it as plain
      // untracked — proving rm --cached ran against the unresolvable HEAD.
      expect(sh(fresh, ['status', '--porcelain']).trim()).toBe('?? f.txt');
    } finally { await fs.promises.rm(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); }
  });

  it('unstage on unborn HEAD falls back to rm --cached, leaving the file untracked', async () => {
    const fresh = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-unborn-')));
    try {
      sh(fresh, ['init']);
      sh(fresh, ['config', 'core.autocrlf', 'false']);
      await fs.promises.writeFile(path.join(fresh, 'f.txt'), 'hello\n');
      sh(fresh, ['add', 'f.txt']);
      const r = await gitUnstage(fresh, 'f.txt');
      expect(r.ok).toBe(true);
      expect(sh(fresh, ['status', '--porcelain']).trim()).toBe('?? f.txt');
    } finally { await fs.promises.rm(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); }
  });

  it('handles non-ASCII filenames despite core.quotepath default (fix: -c core.quotepath=false)', async () => {
    // With the default core.quotepath=true, git C-quotes "café.md" as
    // "caf\303\251.md" in porcelain/numstat output, which never matches the
    // plain `rel` string this service compares against — undercounting
    // stagedCount and dropping the file's review card entirely.
    const name = 'café.md';
    await fs.promises.writeFile(path.join(root, name), 'one\n');
    sh(root, ['add', '.']);
    sh(root, ['commit', '-m', 'add café.md']);
    await fs.promises.writeFile(path.join(root, name), 'one\ntwo\n');

    const status = await gitFileStatus(root, name);
    expect(status.ok).toBe(true);
    expect(status.counts).toEqual({ added: 1, removed: 0 });
    expect(status.hasHistory).toBe(true);

    const review = await gitFileReview(root, name);
    expect(review.ok).toBe(true);
    expect(review.uncommitted?.hunks[0].lines).toContain('+two');
    expect(review.stagedCount).toBe(0);

    sh(root, ['add', name]);
    const staged = await gitFileReview(root, name);
    expect(staged.stagedCount).toBe(1);
  });

  it('LOG_PAGE caps the log and reports hasMore', async () => {
    for (let i = 0; i < LOG_PAGE + 2; i++) {
      await fs.promises.writeFile(path.join(root, 'a.txt'), `rev ${i}\n`);
      sh(root, ['add', '.']); sh(root, ['commit', '-m', `rev ${i}`]);
    }
    const r = await gitFileReview(root, 'a.txt');
    expect(r.log).toHaveLength(LOG_PAGE);
    expect(r.hasMore).toBe(true);
    const page2 = await gitFileReview(root, 'a.txt', { logSkip: LOG_PAGE });
    expect(page2.log.length).toBeGreaterThan(0);
    // WHY 60000: this fixture spawns 2 git processes per commit (LOG_PAGE + 2
    // commits) — Windows process-spawn latency blows past vitest's 5000ms default.
  }, 60000);

  // Rename-tracking regression: `git log --follow` lists a file's commits
  // across a rename, but per-commit diffs must ask `git show` with the
  // HISTORICAL path (the name the file had AT that commit), not its current
  // path — otherwise every pre-rename commit's diff comes back empty even
  // though the timeline lists it as touching the file.
  it('gitFileReview + gitCommitFileDiff follow a rename: historical paths, empty rename-only diff', async () => {
    // WHY this exact content: --follow's rename detection is CONTENT-based
    // (-M), not name-based — if old.md's content ever became byte-identical
    // to a.txt's ('one\ntwo\n', committed in beforeEach), git would spuriously
    // attach a.txt's unrelated "initial" commit to this file's history too.
    // Keep old.md's content disjoint from a.txt's at every step.
    await fs.promises.writeFile(path.join(root, 'old.md'), 'alpha\n');
    sh(root, ['add', '.']); sh(root, ['commit', '-m', 'add old.md']);
    await fs.promises.writeFile(path.join(root, 'old.md'), 'alpha\nbeta\n');
    sh(root, ['add', '.']); sh(root, ['commit', '-m', 'edit old.md']);
    await fs.promises.mkdir(path.join(root, 'docs'));
    sh(root, ['mv', 'old.md', 'docs/new.md']);
    sh(root, ['commit', '-m', 'move to docs/new.md']);
    await fs.promises.writeFile(path.join(root, 'docs', 'new.md'), 'alpha\nbeta\ngamma\n');
    sh(root, ['add', '.']); sh(root, ['commit', '-m', 'edit docs/new.md']);

    const r = await gitFileReview(root, 'docs/new.md');
    expect(r.ok).toBe(true);
    // 4 of ours + the fixture's own "initial" commit for a.txt is NOT in this
    // file's history (--follow is pathspec-scoped) — exactly our 4 commits.
    expect(r.log).toHaveLength(4);
    const [editNew, moveCommit, editOld, addOld] = r.log;
    expect(editNew).toMatchObject({ subject: 'edit docs/new.md', pathAtCommit: 'docs/new.md', renamedFrom: undefined });
    expect(moveCommit).toMatchObject({ subject: 'move to docs/new.md', pathAtCommit: 'docs/new.md', renamedFrom: 'old.md' });
    expect(editOld).toMatchObject({ subject: 'edit old.md', pathAtCommit: 'old.md', renamedFrom: undefined });
    expect(addOld).toMatchObject({ subject: 'add old.md', pathAtCommit: 'old.md', renamedFrom: undefined });
    // Per-commit counts (--numstat, replacing --name-status): the pre-move
    // edit added one real line ('beta'); the pure-move commit changed no
    // content, so numstat reports 0/0 for it despite the rename.
    expect(editOld.counts).toEqual({ added: 1, removed: 0 });
    expect(moveCommit.counts).toEqual({ added: 0, removed: 0 });

    // THE BUG, pinned: asking for the pre-move edit commit's diff with the
    // CURRENT path returns nothing — this is what shipped and read as "No
    // direct changes to this file in this commit." despite the timeline
    // listing the commit.
    const buggy = await gitCommitFileDiff(root, editOld.sha, 'docs/new.md');
    expect(buggy.ok).toBe(true);
    expect(buggy.hunks).toEqual([]);

    // THE FIX: asking with the HISTORICAL path (what the timeline now hands
    // back as pathAtCommit) returns the real content diff.
    const fixed = await gitCommitFileDiff(root, editOld.sha, editOld.pathAtCommit!);
    expect(fixed.ok).toBe(true);
    expect(fixed.hunks[0].lines).toContain('+beta');

    // The move commit itself, paired with prevPath (-M), is rename-only —
    // empty hunks, not a full-file `+` wall.
    const moveDiff = await gitCommitFileDiff(root, moveCommit.sha, moveCommit.pathAtCommit!, moveCommit.renamedFrom);
    expect(moveDiff.ok).toBe(true);
    expect(moveDiff.hunks).toEqual([]);
  });

  // Regression for the macOS/Windows CI failure: locate() computed
  // `path.relative(repoRoot, abs)` from the CALLER's projectRoot while
  // repoRoot came from `git rev-parse --show-toplevel`, which git resolves to
  // the CANONICAL physical path. Any non-canonical alias for the same
  // directory (macOS `/var` -> `/private/var` symlink, Windows short 8.3
  // names, or — as reproduced here — a plain symlink into the repo) makes
  // `rel` a garbage `../../...` string and every git call fails as
  // "outside repository". This test builds that exact symlink-alias
  // situation on Linux (where it wouldn't otherwise occur, since /tmp isn't
  // a symlink) so the bug is caught here without needing macOS/Windows CI.
  it('resolves paths through a symlinked projectRoot alias (macOS /var + Windows short-path regression)', async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-symlink-alias-'));
    try {
      const real = path.join(parent, 'real-repo');
      const alias = path.join(parent, 'alias-repo');
      await fs.promises.mkdir(real);
      await fs.promises.symlink(real, alias);

      sh(real, ['init', '-b', 'main']);
      sh(real, ['config', 'core.autocrlf', 'false']);
      await fs.promises.writeFile(path.join(real, 'a.txt'), 'one\ntwo\n');
      sh(real, ['add', '.']);
      sh(real, ['commit', '-m', 'initial']);
      await fs.promises.writeFile(path.join(real, 'a.txt'), 'one\nTWO\nthree\n');

      const status = await gitFileStatus(alias, 'a.txt');
      expect(status.ok).toBe(true);
      expect(status.isRepo).toBe(true);
      expect(status.counts).toEqual({ added: 2, removed: 1 });

      const review = await gitFileReview(alias, 'a.txt');
      expect(review.ok).toBe(true);
      expect(review.uncommitted?.inHead).toBe(true);
      expect(review.uncommitted?.hunks.length).toBeGreaterThan(0);
    } finally { await fs.promises.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); }
  });

  // Reproduces the youcoded-dev workspace shape: `worktrees/<name>` is
  // gitignored by the outer project repo and holds a LINKED WORKTREE of a
  // completely different repo (per CLAUDE.md's "use worktrees for non-trivial
  // work" convention). locate() used to resolve the repo root from the fixed
  // projectRoot, so `git status`/`git rev-list` always ran against the OUTER
  // repo — which can never see a path it gitignores — silently hiding real
  // changes (and the Review Changes button) for every file under a worktree.
  it('fileStatus: a file inside a gitignored linked worktree resolves against the WORKTREE\'s own repo, not the outer project repo', async () => {
    await fs.promises.writeFile(path.join(root, '.gitignore'), 'worktrees/\n');
    sh(root, ['add', '.gitignore']);
    sh(root, ['commit', '-m', 'ignore worktrees']);

    const otherRepo = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-other-repo-')));
    try {
      sh(otherRepo, ['init', '-b', 'main']);
      sh(otherRepo, ['config', 'core.autocrlf', 'false']);
      await fs.promises.writeFile(path.join(otherRepo, 'c.txt'), 'one\ntwo\n');
      sh(otherRepo, ['add', '.']);
      sh(otherRepo, ['commit', '-m', 'other repo initial']);
      sh(otherRepo, ['branch', 'feature']);

      const worktreesDir = path.join(root, 'worktrees');
      await fs.promises.mkdir(worktreesDir, { recursive: true });
      const worktreeDir = path.join(worktreesDir, 'feature');
      sh(otherRepo, ['worktree', 'add', worktreeDir, 'feature']);

      await fs.promises.writeFile(path.join(worktreeDir, 'c.txt'), 'one\nTWO\nthree\n');

      const r = await gitFileStatus(root, 'worktrees/feature/c.txt');
      expect(r.ok).toBe(true);
      expect(r.isRepo).toBe(true);
      expect(r.counts).toEqual({ added: 2, removed: 1 });
      expect(r.hasHistory).toBe(true);
    } finally {
      try { sh(otherRepo, ['worktree', 'remove', '--force', path.join(root, 'worktrees', 'feature')]); } catch { /* best effort */ }
      await fs.promises.rm(otherRepo, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  });

  // Fix (2026-07-22 bug): the porcelain parser skipped `u` (unmerged) lines,
  // so a repo mid-merge reported its conflicted files as CLEAN — no counts,
  // no review card. The mirror must never lie about a conflict.
  it('fileStatus + fileReview: a mid-merge conflicted file reports conflicted, never clean', async () => {
    sh(root, ['checkout', '-b', 'side']);
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'side\ntwo\n');
    sh(root, ['add', '.']);
    sh(root, ['commit', '-m', 'side change']);
    sh(root, ['checkout', 'main']);
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'main\ntwo\n');
    sh(root, ['add', '.']);
    sh(root, ['commit', '-m', 'main change']);
    // The merge conflicts and exits 1 — that mid-merge state is the fixture.
    try { sh(root, ['merge', 'side']); } catch { /* expected: conflict */ }

    const s = await gitFileStatus(root, 'a.txt');
    expect(s.ok).toBe(true);
    expect(s.conflicted).toBe(true);
    // Not "clean": the worktree (conflict markers included) differs from HEAD.
    expect(s.counts).not.toBeNull();
    // An unmerged entry cannot be committed — it must not read as staged.
    expect(s.staged).toBe(false);

    const r = await gitFileReview(root, 'a.txt');
    expect(r.ok).toBe(true);
    expect(r.uncommitted?.conflicted).toBe(true);
    // The review card shows the real conflict-marked diff, like any modified file.
    expect(r.uncommitted?.hunks.length).toBeGreaterThan(0);
    expect(r.uncommitted?.hunks.flatMap((h) => h.lines).some((l) => l.includes('<<<<<<<'))).toBe(true);
    expect(r.stagedCount).toBe(0);
  });
});

describe('file names Git has to quote', () => {
  let root: string;
  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t.t',
    } });
  }
  function write(name: string, content = 'one\ntwo\n'): void {
    fs.writeFileSync(path.join(root, name), content);
  }
  function commit(message: string): void { git('add', '.'); git('commit', '-m', message); }

  // WHY real repos: hand-written line fixtures hid Git's quoting and rename framing.
  // Windows cannot create quotes, backslashes, control characters or '>' in names.
  const names = ['café.txt', ...(process.platform === 'win32' ? [] : [
    'quo"te.txt', 'back\\slash.txt', 'tab\tname.txt', 'line\nname.txt',
    'literal => name.txt', 'literal {old => new}.txt', ' space.txt ', 'record\x1eseparator.txt',
  ])];
  beforeEach(async () => {
    root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-git-paths-')));
    invalidateRepoRootCache();
    git('init', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    git('config', 'core.quotePath', 'true');
    write('seed.txt', 'seed\n'); commit('seed');
  });
  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });

  describe.each(names)('literal Git path %j', (name) => {
    it('round trips untracked, added, modified, staged and deleted status plus discard', async () => {
      write(name);
      expect((await gitFileStatus(root, name)).counts).toEqual({ added: 2, removed: 0 });
      expect((await gitFileReview(root, name)).uncommitted?.untracked).toBe(true);
      git('add', '--', name);
      expect(await gitFileStatus(root, name)).toMatchObject({ staged: true, counts: { added: 2, removed: 0 } });
      commit('add');
      write(name, 'one\nTHREE\nfour\n');
      expect((await gitFileStatus(root, name)).counts).toEqual({ added: 2, removed: 1 });
      git('add', '--', name);
      expect((await gitFileReview(root, name)).stagedCount).toBe(1);
      expect(await gitDiscard(root, name)).toEqual({ ok: true });
      expect(fs.readFileSync(path.join(root, name), 'utf8')).toBe('one\ntwo\n');
      fs.unlinkSync(path.join(root, name));
      expect((await gitFileStatus(root, name)).counts).toEqual({ added: 0, removed: 2 });
    });

    it('keeps log historical names/counts and distinguishes a true rename from literal arrows', async () => {
      write(name); commit('add\x1fsubject');
      write(name, 'one\nTHREE\nfour\n'); commit('edit');
      const dest = `renamed-${name}`;
      git('mv', '--', name, dest);
      const raw = await execGit(root, ['status', '--porcelain=v2', '-z', '--branch']);
      expect(raw.stdout.endsWith('\0')).toBe(true);
      expect(parsePorcelainV2(raw.stdout).files).toEqual([
        { path: dest, kind: 'renamed', staged: true, unstaged: false, untracked: false },
      ]);
      const num = await execGit(root, ['diff', '--cached', '--numstat', '-z']);
      expect([...parseNumstat(num.stdout)]).toEqual([[dest, { added: 0, removed: 0, binary: false }]]);
      commit('rename');
      const review = await gitFileReview(root, dest);
      expect(review.log.map(e => ({ subject: e.subject, path: e.pathAtCommit, from: e.renamedFrom, counts: e.counts }))).toEqual([
        { subject: 'rename', path: dest, from: name, counts: { added: 0, removed: 0 } },
        { subject: 'edit', path: name, from: undefined, counts: { added: 2, removed: 1 } },
        { subject: 'add\x1fsubject', path: name, from: undefined, counts: { added: 2, removed: 0 } },
      ]);
      const diff = await gitCommitFileDiff(root, review.log[1].sha, review.log[1].pathAtCommit!);
      expect(diff.hunks[0].lines).toContain('+THREE');
    });
  });
});
