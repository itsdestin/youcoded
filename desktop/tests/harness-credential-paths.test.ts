import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { isCredentialPath, CREDENTIAL_EXCLUDE_GLOBS } from '../src/main/harness/tools/credential-paths';
import * as fs from 'fs';
import { checkPathGuard, canonicalize } from '../src/main/harness/tools/guards';
import { GrepTool } from '../src/main/harness/tools/grep';
import type { ToolContext } from '../src/main/harness/tools/types';

const CWD = path.join(os.tmpdir(), 'cred-test-workspace');
const HOME = os.homedir();
const canonHome = canonicalize(HOME, CWD);
const canon = (rel: string) => canonicalize(path.join(HOME, rel), CWD);

// Pure-credential files the AI's file tools must never read (2026-09-10 review).
// These are NOT in editable-path-policy's SENSITIVE_* set, so the file viewer is
// unaffected; the deny lives only in the harness guard.
describe('isCredentialPath — pure-credential files, home-anchored', () => {
  it.each([
    '.git-credentials',
    '.docker/config.json',
    '.gem/credentials',
    '.config/hub',
    '.claude.json',
    '.cargo/credentials',
    '.cargo/credentials.toml',
    '.terraform.d/credentials.tfrc.json',
    '.pgpass',
    '.config/git/credentials',
    '.config/gcloud/legacy_credentials/x',
    '.local/share/keyrings/login.keyring',
    '.password-store/github.gpg',
    '.config/google-chrome/Default/Cookies',
    '.config/google-chrome/Default/Login Data',
    '.mozilla/firefox/abc.default/logins.json',
    '.mozilla/firefox/abc.default/key4.db',
  ])('denies ~/%s', (rel) => {
    expect(isCredentialPath(canon(rel), canonHome)).toBe(true);
  });

  it('denies YouCoded\'s own encrypted stores under home, but not a same-named project file', () => {
    expect(isCredentialPath(canon('.config/youcoded/native-secrets.json'), canonHome)).toBe(true);
    expect(isCredentialPath(canon('.config/youcoded/chatgpt-account.json'), canonHome)).toBe(true);
    // A project fixture that merely shares the name (outside home) stays readable (F3).
    expect(isCredentialPath(canonicalize('/opt/other/native-secrets.json', CWD), canonHome)).toBe(false);
  });

  it.each([
    // Mixed config files carry legitimate "fix my config" requests — NOT denied
    // (they go through the ask-per-website path, a separate decision).
    '.npmrc',
    '.pypirc',
    '.bash_history',
    // A project file that merely shares a basename with a browser DB.
    'projects/app/Cookies',
    // config.json outside .docker.
    'projects/app/config.json',
    // A browser cred name outside any browser root.
    '.config/whatever/key4.db',
  ])('does NOT deny ~/%s', (rel) => {
    expect(isCredentialPath(canon(rel), canonHome)).toBe(false);
  });

  it('a project config.json inside the workspace is not a credential', () => {
    expect(isCredentialPath(canonicalize(path.join(CWD, 'config.json'), CWD), canonHome)).toBe(false);
  });
});

describe('checkPathGuard blocks the credential files (cannot be overridden)', () => {
  it.each([
    '.git-credentials',
    '.docker/config.json',
    '.config/gcloud/legacy_credentials/x',
    '.config/google-chrome/Default/Login Data',
  ])('~/%s -> deny', (rel) => {
    const v = checkPathGuard(path.join(HOME, rel), CWD);
    expect(v.kind).toBe('deny');
  });

  it('~/.npmrc is NOT a hard deny (it is outside the workspace → external ask)', () => {
    expect(checkPathGuard(path.join(HOME, '.npmrc'), CWD).kind).toBe('external');
  });
});

describe('Grep does not descend into credential directories (--hidden gap)', () => {
  it('the exclusion list covers the segments and the credential files', () => {
    expect(CREDENTIAL_EXCLUDE_GLOBS).toContain('!**/.aws/**');
    expect(CREDENTIAL_EXCLUDE_GLOBS).toContain('!**/.git-credentials');
    expect(CREDENTIAL_EXCLUDE_GLOBS).toContain('!**/Keychains/**');
    expect(CREDENTIAL_EXCLUDE_GLOBS).toContain('!**/.config/gcloud/**');
  });

  // A REAL ripgrep run (F2 review): the source-ordering check alone would not
  // catch a ripgrep whose glob precedence changed. Build a workspace holding a
  // secret under .aws/, then search WITH a caller include-glob that tries to pull
  // it back in, and confirm the secret never appears.
  it('never returns a hit from a credential dir, even when a caller glob targets it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-cred-'));
    try {
      fs.mkdirSync(path.join(root, '.aws'), { recursive: true });
      fs.writeFileSync(path.join(root, '.aws', 'credentials'), 'aws_secret_access_key = SECRETVAL\n');
      fs.writeFileSync(path.join(root, 'notes.txt'), 'ordinary SECRETVAL note\n');
      const ctx: ToolContext = {
        sessionId: 'grep-cred-test', cwd: root,
        signal: new AbortController().signal, readRegistry: new Map(), todos: [],
      };
      // The caller tries to include the credential file explicitly.
      const r = await GrepTool.execute(
        { pattern: 'SECRETVAL', output_mode: 'files_with_matches', glob: '**/.aws/credentials' } as any,
        ctx,
      );
      const text = JSON.stringify(r);
      expect(text).not.toContain('.aws/credentials');
      // and an ordinary search still finds the ordinary file
      const r2 = await GrepTool.execute({ pattern: 'SECRETVAL', output_mode: 'files_with_matches' } as any, ctx);
      expect(JSON.stringify(r2)).toContain('notes.txt');
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
    }
  });
});
