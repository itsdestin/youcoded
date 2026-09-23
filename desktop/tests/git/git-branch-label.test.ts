import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitBranchLabel } from '../../src/main/git/git-branch-label';

// The status bar's Git Branch chip in a native session. Claude Code's status
// line is the chip's only feed for Claude Code sessions; a native session has
// none, so main reads the branch itself — in the SAME "repo/branch" shape the
// status line writes (hook-scripts/statusline.sh), so the chip reads alike.
describe('gitBranchLabel', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'gbl-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  const repo = (name: string, head: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), head);
    return dir;
  };

  it('names the repo folder and the branch', async () => {
    const dir = repo('myapp', 'ref: refs/heads/feature/login\n');
    expect(await gitBranchLabel(dir)).toBe('myapp/feature/login');
  });

  it('finds the repo from a folder inside it', async () => {
    const dir = repo('myapp', 'ref: refs/heads/main\n');
    const sub = path.join(dir, 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });
    expect(await gitBranchLabel(sub)).toBe('myapp/main');
  });

  it('says HEAD for a detached checkout, as git does', async () => {
    const dir = repo('myapp', '0123456789abcdef0123456789abcdef01234567\n');
    expect(await gitBranchLabel(dir)).toBe('myapp/HEAD');
  });

  it('follows a worktree’s .git file to its own HEAD', async () => {
    const main = repo('main-checkout', 'ref: refs/heads/main\n');
    const gitdir = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, 'HEAD'), 'ref: refs/heads/session/x\n');
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitdir}\n`);
    expect(await gitBranchLabel(wt)).toBe('wt/session/x');
  });

  it('is null outside any repo, and for a folder that does not exist', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    // The temp root itself could sit inside a repo on some machine; only
    // assert when it does not.
    const outside = await gitBranchLabel(plain);
    if (outside !== null) expect(outside).not.toContain('plain');
    expect(await gitBranchLabel(path.join(root, 'missing'))).toBeNull();
  });
});
