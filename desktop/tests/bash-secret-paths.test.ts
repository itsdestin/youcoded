import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { secretPathIn } from '../src/main/harness/tools/bash-secret-paths';

// Destin, 2026-09-23 (option B): a Bash command that names a file the file
// tools refuse gets an approval card every time. The decision is the file
// tools' own list (guards.ts checkPathGuard) — these cases pin that it fires on
// real path references and NOT on commands that merely contain a similar word.
const project = path.join(os.tmpdir(), 'yc-secret-floor-project');
const ctx = { cwd: project };

describe('secret-path floor: commands that are always asked about', () => {
  it.each([
    ['ssh -i ~/.ssh/key host', '~/.ssh/key'],
    ['cat .env', '.env'],
    ['cat ~/.aws/credentials', '~/.aws/credentials'],
    ['ls ~/.ssh', '~/.ssh'],
    ['cat "my secrets/.env"', 'my secrets/.env'],
    ["cat '/home/someone/.ssh/id_rsa'", '/home/someone/.ssh/id_rsa'],
    ['cat .env.local', '.env.local'],
    ['source .envrc', '.envrc'],
    ['docker run --env-file=.env app', '.env'],
    ['cat $HOME/.netrc', '$HOME/.netrc'],
    ['cat ~/.config/gh/hosts.yml', '~/.config/gh/hosts.yml'],
    ['git add .env && git commit -m x', '.env'],
    ['cat ~/.git-credentials', '~/.git-credentials'],
  ])('%s', (cmd, hit) => {
    expect(secretPathIn(cmd, ctx)).toBe(hit);
  });

  it('resolves relative names from the shell folder, so a home-anchored credential file counts', () => {
    expect(secretPathIn('cat .git-credentials', { cwd: project, shellCwd: os.homedir() })).toBe('.git-credentials');
  });
});

describe('secret-path floor: commands that only look similar are left alone', () => {
  it.each([
    'printenv',
    'env',
    'npm run env:check',
    'echo .envrc-template',
    'cat .environment',
    'cat src/env.ts',
    'ls ~',
    'cat ~/.bashrc',
    'grep -r API_KEY src',
    'curl https://example.com/.env.example',
    'ssh-keygen --help',
    'cat .git-credentials',        // outside the home folder it is an ordinary project file
  ])('%s', (cmd) => {
    expect(secretPathIn(cmd, ctx)).toBeNull();
  });
});
