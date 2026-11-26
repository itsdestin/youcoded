// The stand-in for the git program on an iPhone (src/main/git-snapshot.ts): the plugin installer's exact command
// lines, answered from GitHub commit archives. The archives here are made by the real `git archive` from a real
// repository, which is the same format GitHub serves.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitFromSnapshots, archiveUrl, readTarGz, type ArchiveFetcher } from '../src/main/git-snapshot';

let work = '';
let repo = '';
let first = '';
let second = '';
const asked: string[] = [];
const REPO_URL = 'https://github.com/itsdestin/wecoded-marketplace.git';

const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
/** What codeload.github.com would answer: `git archive` of that ref, wrapped in "<repo>-<commit>/". */
const fetcher: ArchiveFetcher = async (url) => {
  asked.push(url);
  const ref = url.split('/tar.gz/')[1];
  const commit = git('rev-parse', ref === 'HEAD' ? 'HEAD' : ref);
  return execFileSync('git', ['-C', repo, 'archive', '--format=tar.gz', `--prefix=wecoded-marketplace-${commit}/`, commit], { maxBuffer: 64 * 1024 * 1024 });
};

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-snap-'));
  repo = path.join(work, 'origin');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  const write = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body); };
  write('plugins/pages/plugin.json', '{"version":"1.0.0"}');
  write('plugins/pages/skills/build/SKILL.md', 'first');
  write('plugins/themes/plugin.json', '{"version":"1.0.0"}');
  write(`plugins/pages/${'deep/'.repeat(30)}long-name-file.txt`, 'a path longer than a tar header holds');
  fs.symlinkSync('/etc/passwd', path.join(repo, 'plugins/pages/link-out'));
  git('add', '-A'); git('commit', '-q', '-m', 'one');
  first = git('rev-parse', 'HEAD');
  write('plugins/pages/skills/build/SKILL.md', 'second');
  write('plugins/pages/new-file.txt', 'added later');
  fs.rmSync(path.join(repo, 'plugins/themes'), { recursive: true });
  git('add', '-A'); git('commit', '-q', '-m', 'two');
  second = git('rev-parse', 'HEAD');
});
afterAll(() => { fs.rmSync(work, { recursive: true, force: true }); });

const run = (...args: string[]) => gitFromSnapshots(args, fetcher);
const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

describe('the archive address', () => {
  it('is built only for a public GitHub repository over https, and only for a plain ref', () => {
    expect(archiveUrl(REPO_URL, 'master')).toBe('https://codeload.github.com/itsdestin/wecoded-marketplace/tar.gz/master');
    expect(archiveUrl('https://github.com/anthropics/claude-plugins-official', first)).toBe(`https://codeload.github.com/anthropics/claude-plugins-official/tar.gz/${first}`);
    for (const bad of ['http://github.com/a/b', 'https://gitlab.com/a/b', 'https://evil.example/github.com/a/b', 'https://github.com/a', 'https://github.com/a/b/c', 'not a url']) {
      expect(archiveUrl(bad, 'master')).toBeNull();
    }
    expect(archiveUrl(REPO_URL, '../../x')).toBeNull();
    expect(archiveUrl(REPO_URL, 'a b')).toBeNull();
  });
});

describe('the installer\'s git commands, from archives', () => {
  it('clone puts the branch\'s files in place and knows which commit they are', async () => {
    const dir = path.join(work, 'clone-1');
    expect(await run('clone', '--depth', '1', '--branch', 'master', REPO_URL, dir)).toEqual({ ok: true, output: '' });
    expect(read(dir, 'plugins/pages/skills/build/SKILL.md')).toBe('second');
    expect(read(dir, `plugins/pages/${'deep/'.repeat(30)}long-name-file.txt`)).toContain('longer than a tar header');
    expect((await run('-C', dir, 'rev-parse', 'HEAD')).output.trim()).toBe(second);
    expect(asked.at(-1)).toBe('https://codeload.github.com/itsdestin/wecoded-marketplace/tar.gz/master');
  });

  it('never creates a link from an archive', async () => {
    const dir = path.join(work, 'clone-links');
    await run('clone', '--depth', '1', REPO_URL, dir);
    expect(fs.existsSync(path.join(dir, 'plugins/pages/link-out'))).toBe(false);
    expect(fs.lstatSync(path.join(dir, 'plugins/pages/plugin.json')).isFile()).toBe(true);
  });

  it('the pinned-plugin sequence: is it that commit? → fetch it → is it now? → check one folder out of it', async () => {
    const dir = path.join(work, 'pinned');
    await run('clone', '--depth', '1', '--branch', 'master', REPO_URL, dir);
    const isIt = () => run('-C', dir, 'rev-parse', '--verify', '--quiet', `${first}^{commit}`);
    expect((await isIt()).ok).toBe(false);
    expect((await run('-C', dir, 'fetch', '--depth', '1', 'origin', first)).ok).toBe(true);
    const now = await isIt();
    expect([now.ok, now.output.trim()]).toEqual([true, first]);
    // The folder is cleared first by the installer, then restored from the pinned commit.
    fs.rmSync(path.join(dir, 'plugins/pages'), { recursive: true, force: true });
    expect((await run('-C', dir, 'checkout', '--force', first, '--', 'plugins/pages')).ok).toBe(true);
    expect(read(dir, 'plugins/pages/skills/build/SKILL.md')).toBe('first');
    expect(fs.existsSync(path.join(dir, 'plugins/pages/new-file.txt'))).toBe(false);
    // A second launch downloads nothing: the commit is already here.
    const before = asked.length;
    expect((await run('-C', dir, 'fetch', '--depth', '1', 'origin', first)).ok).toBe(true);
    expect(asked.length).toBe(before);
  });

  it('checking out a folder the commit does not have fails, as git does', async () => {
    const dir = path.join(work, 'missing-path');
    await run('clone', '--depth', '1', REPO_URL, dir);
    const r = await run('-C', dir, 'checkout', '--force', second, '--', 'plugins/themes');
    expect(r.ok).toBe(false);
    expect((await run('-C', dir, 'checkout', '--force', second, '--', '../outside')).ok).toBe(false);
  });

  it('a third-party plugin: clone, fetch the scanned commit, detach to it, confirm HEAD', async () => {
    const dir = path.join(work, 'detached');
    await run('clone', '--depth', '1', REPO_URL, dir);
    await run('-C', dir, 'fetch', '--depth', '1', 'origin', first);
    expect((await run('-C', dir, 'checkout', '--detach', first)).ok).toBe(true);
    expect((await run('-C', dir, 'rev-parse', 'HEAD')).output.trim()).toBe(first);
    expect(read(dir, 'plugins/pages/skills/build/SKILL.md')).toBe('first');
    expect(fs.existsSync(path.join(dir, 'plugins/themes/plugin.json'))).toBe(true); // was deleted in the later commit
    expect(fs.existsSync(path.join(dir, 'plugins/pages/new-file.txt'))).toBe(false);
  });

  it('refreshing a cached copy: fetch origin, then reset --hard takes the newest files', async () => {
    const dir = path.join(work, 'refresh');
    await run('clone', '--depth', '1', '--branch', 'master', REPO_URL, dir);
    fs.writeFileSync(path.join(repo, 'plugins/pages/third.txt'), 'three');
    git('add', '-A'); git('commit', '-q', '-m', 'three');
    const third = git('rev-parse', 'HEAD');
    try {
      expect((await run('-C', dir, 'fetch', 'origin')).ok).toBe(true);
      expect(fs.existsSync(path.join(dir, 'plugins/pages/third.txt'))).toBe(false); // not until the reset
      expect((await run('-C', dir, 'reset', '--hard', 'origin/master')).ok).toBe(true);
      expect(read(dir, 'plugins/pages/third.txt')).toBe('three');
      expect((await run('-C', dir, 'rev-parse', 'HEAD')).output.trim()).toBe(third);
    } finally {
      git('reset', '-q', '--hard', second);
    }
  });

  it('an archive that is not the commit asked for is refused and leaves nothing behind', async () => {
    const dir = path.join(work, 'wrong');
    await run('clone', '--depth', '1', REPO_URL, dir);
    const lying: ArchiveFetcher = async () => execFileSync('git', ['-C', repo, 'archive', '--format=tar.gz', `--prefix=x-${second}/`, second], { maxBuffer: 64 * 1024 * 1024 });
    const r = await gitFromSnapshots(['-C', dir, 'fetch', '--depth', '1', 'origin', first], lying);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/not the one that was asked for/);
    expect((await run('-C', dir, 'rev-parse', '--verify', '--quiet', `${first}^{commit}`)).ok).toBe(false);
  });

  it('a failed download and an unknown command are refusals with words, never a throw', async () => {
    const offline: ArchiveFetcher = async () => { throw new Error('GitHub answered 404 for x'); };
    expect(await gitFromSnapshots(['clone', '--depth', '1', REPO_URL, path.join(work, 'nope')], offline)).toEqual({ ok: false, output: 'GitHub answered 404 for x' });
    const dir = path.join(work, 'unknown');
    await run('clone', '--depth', '1', REPO_URL, dir);
    expect((await run('-C', dir, 'push', 'origin')).ok).toBe(false);
    expect((await run('-C', path.join(work, 'never-cloned'), 'rev-parse', 'HEAD')).ok).toBe(false);
    expect((await run('-C', dir, 'sparse-checkout', 'set', 'plugins/pages')).ok).toBe(true);
  });

  it('reads the commit id GitHub writes into an archive', async () => {
    expect(readTarGz(await fetcher(`x/tar.gz/${first}`)).commit).toBe(first);
  });
});
