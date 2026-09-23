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
    ['cat "my secrets/.env"', 'my secrets/.env'],
    ["cat '/home/someone/.ssh/id_rsa'", '/home/someone/.ssh/id_rsa'],
    ['cat .env.local', '.env.local'],
    ['source .envrc', '.envrc'],
    ['docker run --env-file=.env app', '.env'],
    ['cat $HOME/.netrc', '$HOME/.netrc'],
    ['cat ~/.config/gh/hosts.yml', '~/.config/gh/hosts.yml'],
    ['git add .env && git commit -m x', '.env'],
    ['cat ~/.git-credentials', '~/.git-credentials'],
    // Input redirects attached to the name, and a substitution that reads it.
    ['cat <.env', '.env'],
    ['cat < .env', '.env'],
    ['x=$(<.env)', '.env'],
    ['echo "$(cat ~/.ssh/id_rsa)"', '~/.ssh/id_rsa'],
    // A secret as the SOURCE of a copy or move is still read.
    ['cp .env backup/', '.env'],
    ['mv .env .env.bak', '.env'],
    ['AWS_SHARED_CREDENTIALS_FILE=~/.aws/credentials aws s3 ls', '~/.aws/credentials'],
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
    // Only WRITING a secret file exposes nothing (decided 2026-09-23).
    'cp .env.example .env',
    'echo KEY=1 > .env',
    'printf "x" >> .env',
    'tee .env < template.txt',
    'touch .env',
    // Text and patterns that merely name the file.
    'echo ".env" >> .gitignore',
    'git commit -m ".env"',
    'git commit --message=.env',
    'grep -r X --exclude=.env .',
    'rg X -g .env',
    'find . -name .env',
    'cat <<EOF\n.env\nEOF',
    // Dotenv templates hold no secrets.
    'git add .env.example',
    'cat .env.sample',
    'cp .env.template .env.local.dist',
  ])('%s', (cmd) => {
    expect(secretPathIn(cmd, ctx)).toBeNull();
  });
});

// A command that only checks a secret file exists, or shows its name, size or
// counts, reads nothing — so it stays quiet (Destin via coordinator, 2026-09-23).
describe('secret-path floor: existence and metadata checks stay quiet', () => {
  it.each([
    'ls .env',
    'ls -la .env',
    'ls ~/.ssh',
    'ls -la ~/.ssh',
    'test -f .env',
    '[ -f .env ]',
    '[[ -e .env ]]',
    '[ -f .env ] || cp .env.example .env',
    'stat .env',
    'wc -c .env',
    'du -h ~/.ssh',
    'find . -name .env',
  ])('%s', (cmd) => {
    expect(secretPathIn(cmd, ctx)).toBeNull();
  });

  it.each([
    ['cat .env', '.env'],
    ['ls .env && cat .env', '.env'],
    ['[ -f .env ] && source .env', '.env'],
    ['head .env', '.env'],
    ['less .env', '.env'],
    ['grep KEY .env', '.env'],
    ['cp .env x', '.env'],
    ['ssh -i ~/.ssh/key', '~/.ssh/key'],
    ['cat ~/.ssh/id_rsa', '~/.ssh/id_rsa'],
  ])('%s still asks', (cmd, hit) => {
    expect(secretPathIn(cmd, ctx)).toBe(hit);
  });
});
