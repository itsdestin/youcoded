// Security hardening 2026-10-30: the assistant's file tools follow symlinks before judging a path,
// refuse the app's own secret files and common secret files, and protect their own settings files.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkPathGuard, canonicalize } from '../src/main/harness/tools/guards';
import { isCredentialPath, isPhoneDeniedPath, APP_SECRET_BASENAMES } from '../src/main/harness/tools/credential-paths';
import { isProtectedConfigPath, bashTouchesProtectedConfig } from '../src/main/harness/tools/protected-config';

const isWin = process.platform === 'win32';
const HOME = os.homedir();

describe('symlinks are followed before the folder limit and the secret check', () => {
  let root: string; let outside: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sym-proj-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sym-out-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const link = (target: string, name: string) => {
    const p = path.join(root, name);
    try { fs.symlinkSync(target, p, fs.statSync(target).isDirectory() ? 'dir' : 'file'); } catch { return null; }
    return p;
  };

  it.skipIf(isWin)('a link inside the project to a file outside it is treated as outside (Write/Edit would ask)', () => {
    const secretish = path.join(outside, 'notes.txt');
    fs.writeFileSync(secretish, 'x');
    const l = link(secretish, 'notes-link.txt')!;
    expect(checkPathGuard(l, root).kind).toBe('external');
    expect(checkPathGuard(path.join(root, 'plain.txt'), root).kind).toBe('ok');
  });

  it.skipIf(isWin)('a link to a folder outside the project covers files that do not exist yet', () => {
    const l = link(outside, 'out-dir')!;
    expect(checkPathGuard(path.join(l, 'new-file.txt'), root).kind).toBe('external');
  });

  it.skipIf(isWin)('a link inside the project to a secret file is DENIED, not just flagged', () => {
    const key = path.join(outside, 'id_rsa');
    fs.writeFileSync(key, 'PRIVATE');
    const l = link(key, 'docs-notes.txt')!;
    const v = checkPathGuard(l, root);
    expect(v.kind).toBe('deny');
  });

  it.skipIf(isWin)('a link to a .env file or a .pem file is DENIED', () => {
    fs.writeFileSync(path.join(outside, '.env'), 'A=1');
    fs.writeFileSync(path.join(outside, 'server.pem'), 'x');
    expect(checkPathGuard(link(path.join(outside, '.env'), 'cfg.txt')!, root).kind).toBe('deny');
    expect(checkPathGuard(link(path.join(outside, 'server.pem'), 'cert.txt')!, root).kind).toBe('deny');
  });

  it.skipIf(isWin)('a project reached through a link (workspace folder itself is a link) still counts as inside', () => {
    const viaLink = path.join(outside, 'proj-link');
    fs.symlinkSync(root, viaLink, 'dir');
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    expect(checkPathGuard(path.join(viaLink, 'a.txt'), viaLink).kind).toBe('ok');
  });
});

describe('the assistant refuses the same app secret files the phone door refuses', () => {
  const home = canonicalize(HOME, HOME);
  const at = (rel: string) => canonicalize(path.join(HOME, rel), HOME);
  it.each([
    '.config/youcoded/marketplace-auth.json', '.config/youcoded/github-token.json', '.config/youcoded/page-connections.json',
    '.config/youcoded/search-providers.json', '.claude/youcoded-remote.json', '.claude/youcoded-remote.dev.json',
    '.claude/.remote-devices.json', '.config/youcoded/.remote-tokens.json',
  ])('denies ~/%s', (rel) => { expect(isCredentialPath(at(rel), home)).toBe(true); });

  it('every app secret file the phone list names is also on the assistant list (one shared list)', () => {
    for (const b of APP_SECRET_BASENAMES) {
      expect(isCredentialPath(at(`.config/youcoded/${b}`), home), b).toBe(true);
      expect(isPhoneDeniedPath(at(`.config/youcoded/${b}`), home), b).toBe(true);
    }
  });

  it.each([
    '.npmrc', '.pypirc', '.git-credentials', '.netrc', 'projects/app/.npmrc', 'projects/app/id_rsa', 'projects/app/id_ed25519_work',
    'projects/app/deploy.pem', 'projects/app/store.p12', 'projects/app/store.pfx',
  ])('denies common secret file %s wherever it sits', (rel) => { expect(isCredentialPath(at(rel), home)).toBe(true); });

  it.each(['projects/app/id_rsa.pub', 'projects/app/notes.md', 'projects/app/keys.ts', 'projects/app/pem-guide.md'])(
    'still allows %s', (rel) => { expect(isCredentialPath(at(rel), home)).toBe(false); });
});

describe('protected settings files (always ask)', () => {
  const CWD = path.join(os.tmpdir(), 'protected-cfg-proj');
  it.each([
    path.join(HOME, '.youcoded', 'permissions.json'),
    path.join(HOME, '.youcoded', 'permission-modes.json'),
    path.join(HOME, '.youcoded', 'config.json'),
    path.join(HOME, '.claude', 'settings.json'),
    path.join(HOME, '.claude', 'settings.local.json'),
    path.join(HOME, '.claude', 'hooks', 'x.sh'),
    path.join(HOME, '.config', 'youcoded', 'settings.json'),
    path.join(CWD, '.git', 'hooks', 'pre-commit'),
    path.join(CWD, '.git', 'config'),
    path.join(CWD, '.claude', 'settings.json'),
  ])('%s is protected', (p) => { expect(isProtectedConfigPath(p, CWD)).toBe(true); });

  it.each([
    path.join(CWD, 'src', 'a.ts'), path.join(CWD, '.claude', 'rules', 'x.md'), path.join(CWD, '.github', 'workflows', 'a.yml'),
    path.join(HOME, 'Documents', 'a.md'), path.join(HOME, '.claude', 'topics', 'topic-1'),
  ])('%s is not', (p) => { expect(isProtectedConfigPath(p, CWD)).toBe(false); });

  it.skipIf(isWin)('a link in the project that points at ~/.youcoded/permissions.json is protected', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-prot-'));
    try {
      const l = path.join(proj, 'innocent.json');
      fs.symlinkSync(path.join(HOME, '.youcoded', 'permissions.json'), l);
      expect(isProtectedConfigPath(l, proj)).toBe(true);
    } finally { fs.rmSync(proj, { recursive: true, force: true }); }
  });

  it.each([
    'echo x > ~/.youcoded/permissions.json', 'cp a $HOME/.claude/settings.json', 'sed -i s/a/b/ ~/.youcoded/permission-modes.json',
    'cat evil >> .git/hooks/pre-commit', 'cat ~/.youcoded/config.json; rm ~/.youcoded/permissions.json',
  ])('Bash %s asks', (c) => { expect(bashTouchesProtectedConfig(c)).toBe(true); });
  it.each(['cat ~/.youcoded/config.json', 'ls .git/hooks', 'npm test', 'git status', 'echo hi > out.txt'])(
    'Bash %s does not', (c) => { expect(bashTouchesProtectedConfig(c)).toBe(false); });
});
