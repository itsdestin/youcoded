import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { gitDiscard, gitFileReview, gitFileStatus, gitCommitFileDiff } from '../../src/main/git/git-service';
import { execGit, invalidateRepoRootCache } from '../../src/main/git/git-exec';
import { parseNumstat, parsePorcelainV2 } from '../../src/main/git/porcelain';

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
