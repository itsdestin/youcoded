import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { isCredentialPath, CREDENTIAL_EXCLUDE_GLOBS } from '../src/main/harness/tools/credential-paths';
import { checkPathGuard, canonicalize } from '../src/main/harness/tools/guards';
import { readStripped } from './helpers/guard-scope';

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

  it('denies YouCoded\'s own encrypted stores by basename, anywhere', () => {
    expect(isCredentialPath(canonicalize('/opt/youcoded/native-secrets.json', CWD), canonHome)).toBe(true);
    expect(isCredentialPath(canon('.config/youcoded/chatgpt-account.json'), canonHome)).toBe(true);
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

  it('grep.ts pushes the exclusions AFTER the caller glob — so exclusion wins', () => {
    // ripgrep applies globs in order, last match wins. If a caller sends
    // `--glob **/.aws/credentials` (include) our exclusion must come later to
    // still win. Pin the source ordering: the CREDENTIAL_EXCLUDE_GLOBS push must
    // appear after the args.glob push.
    const src = readStripped(path.join(__dirname, '../src/main/harness/tools/grep.ts'));
    const callerGlob = src.indexOf("rgArgs.push('--glob', args.glob)");
    const exclude = src.indexOf('CREDENTIAL_EXCLUDE_GLOBS');
    // the import mention is first; find the push, which is the LAST mention.
    const excludePush = src.lastIndexOf('CREDENTIAL_EXCLUDE_GLOBS');
    expect(callerGlob).toBeGreaterThan(-1);
    expect(exclude).toBeGreaterThan(-1);
    expect(excludePush).toBeGreaterThan(callerGlob);
  });
});
