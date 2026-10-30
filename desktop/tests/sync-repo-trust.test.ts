// desktop/tests/sync-repo-trust.test.ts
// Pins the security hardening of the hidden sync repo (2026-10-30): a project folder that
// ships its own .youcoded/sync.git must not get to run programs or receive the GitHub token.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { GitTransport, GIT_CREDENTIAL_HELPER, SAFE_GIT_OVERRIDES } from '../src/main/sync-spaces/git-transport';
import { isTrustedRemoteUrl, findUntrustedConfigEntry } from '../src/main/sync-spaces/repo-trust';
import type { SyncSpace } from '../src/main/sync-spaces/types';

describe('credential helper only answers for https://github.com', () => {
  const run = (input: string) =>
    execFileSync('sh', ['-c', `${GIT_CREDENTIAL_HELPER.slice(1)} get`], {
      input, encoding: 'utf8', env: { ...process.env, YOUCODED_GIT_TOKEN: 'tok_abc' },
    });
  it('hands over the token for github.com over https', () => {
    expect(run('protocol=https\nhost=github.com\n\n')).toContain('password=tok_abc');
  });
  it.each([
    'protocol=https\nhost=evil.example\n\n',
    'protocol=http\nhost=github.com\n\n',
    'protocol=https\nhost=github.com.evil.example\n\n',
    '\n',
  ])('hands over nothing for %j', (input) => {
    expect(run(input)).not.toContain('tok_abc');
  });
  it('is registered only for the github.com URL scope', async () => {
    const { GIT_CREDENTIAL_SCOPE } = await import('../src/main/sync-spaces/git-transport');
    expect(GIT_CREDENTIAL_SCOPE).toBe('credential.https://github.com.helper');
  });
});

describe('config / remote judgement', () => {
  const root = path.resolve('/proj');
  it('accepts what the app itself writes', () => {
    expect(findUntrustedConfigEntry([
      ['core.repositoryformatversion', '0'], ['core.filemode', 'true'], ['core.bare', 'false'],
      ['core.logallrefupdates', 'true'], ['user.name', 'YouCoded Sync (X)'], ['user.email', 'sync@youcoded.local'],
      ['core.autocrlf', 'false'], ['remote.origin.url', 'https://github.com/dana/repo.git'],
      ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['branch.main.remote', 'origin'], ['branch.main.merge', 'refs/heads/main'],
    ], root)).toBeNull();
  });
  it.each([
    ['core.fsmonitor', 'x'], ['core.hooksPath', '/x'], ['core.sshCommand', 'sh -c x'], ['core.pager', 'x'],
    ['include.path', 'x'], ['url.http://evil/.insteadOf', 'https://github.com/'], ['http.proxy', 'http://evil'],
    ['credential.helper', 'x'], ['remote.origin.pushurl', 'https://evil/x'], ['remote.evil.url', 'https://github.com/a/b'],
    ['commit.gpgsign', 'true'], ['gpg.program', 'x'], ['filter.x.clean', 'x'], ['alias.status', '!x'],
  ])('rejects %s', (k, v) => {
    expect(findUntrustedConfigEntry([[k, v]], root)).toBe(k);
  });
  it.each([
    'https://evil.example/a/b.git', 'http://github.com/a/b', 'ssh://git@github.com/a/b', 'git@github.com:a/b.git',
    'ext::sh -c "touch /tmp/x"', 'https://github.com@evil.example/a/b', 'https://github.com/', '../sibling.git', 'sub/dir',
    '/proj/inside.git', 'file:///proj/inside.git',
  ])('does not trust remote %s', (u) => {
    expect(isTrustedRemoteUrl(u, root)).toBe(false);
  });
  it('trusts github over https and an absolute local path outside the project', () => {
    expect(isTrustedRemoteUrl('https://github.com/dana/repo.git', root)).toBe(true);
    expect(isTrustedRemoteUrl(path.resolve('/elsewhere/remote.git'), root)).toBe(true);
  });
});

describe('GitTransport refuses a sync folder it did not create (real git)', () => {
  const setup = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-trust-'));
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(root);
    const space: SyncSpace = { id: 'project:trust', kind: 'project', root };
    return { tmp, root, space, gd: path.join(root, '.youcoded', 'sync.git') };
  };
  const cleanup = (tmp: string) => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  it('adopts a repo the app made, and refuses it once a helper-program setting appears', async () => {
    const { tmp, space, gd } = setup();
    try {
      const t = new GitTransport({ deviceName: 'T' });
      await t.init(space);
      await expect(new GitTransport({ deviceName: 'T' }).init(space)).resolves.toBeUndefined();
      fs.appendFileSync(path.join(gd, 'config'), '[core]\n\tfsmonitor = /tmp/evil.sh\n');
      const err = await new GitTransport({ deviceName: 'T' }).init(space).catch((e) => e);
      expect(err.syncErrorCode).toBe('sync-repo-untrusted');
      expect(String(err.message)).toContain('did not create');
      // Every other operation refuses too, not just init.
      await expect(new GitTransport({ deviceName: 'T' }).hasRemote(space)).rejects.toMatchObject({ syncErrorCode: 'sync-repo-untrusted' });
    } finally { cleanup(tmp); }
  });

  it('refuses a planted remote that is not GitHub', async () => {
    const { tmp, space, gd } = setup();
    try {
      await new GitTransport({ deviceName: 'T' }).init(space);
      fs.appendFileSync(path.join(gd, 'config'), '[remote "origin"]\n\turl = https://evil.example/x/y.git\n');
      await expect(new GitTransport({ deviceName: 'T' }).hasRemote(space)).rejects.toMatchObject({ syncErrorCode: 'sync-repo-untrusted' });
    } finally { cleanup(tmp); }
  });

  it('a hook script planted in sync.git never runs', async () => {
    const { tmp, root, space, gd } = setup();
    try {
      const t = new GitTransport({ deviceName: 'T' });
      await t.init(space);
      const proof = path.join(tmp, 'hook-ran');
      fs.mkdirSync(path.join(gd, 'hooks'), { recursive: true });
      for (const h of ['pre-commit', 'post-commit', 'pre-push', 'pre-auto-gc']) {
        const f = path.join(gd, 'hooks', h);
        fs.writeFileSync(f, `#!/bin/sh\ntouch "${proof}"\n`);
        fs.chmodSync(f, 0o755);
      }
      fs.writeFileSync(path.join(root, 'note.md'), 'hello');
      await t.push(space, 'first').catch(() => undefined);
      expect(fs.existsSync(proof)).toBe(false);
    } finally { cleanup(tmp); }
  });

  it('every sync git call carries the safe overrides', () => {
    const joined = SAFE_GIT_OVERRIDES.join(' ');
    expect(joined).toContain('core.hooksPath=');
    expect(joined).toContain('core.fsmonitor=false');
    expect(joined).toContain('core.sshCommand=ssh');
  });
});
