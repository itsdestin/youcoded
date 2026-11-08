// Pins the git-source Update path.
//
// WHY THIS EXISTS: `update()` re-runs `installPlugin`, and installPlugin returns
// `already_installed` the moment the plugin directory exists — BEFORE it reaches any
// clone. Only the `local` branch then had a real upgrade (`upgradePluginFromLocal`), so
// for `url` and `git-subdir` sources pressing Update touched no files at all. Measured
// against the live registry on 2026-08-31: 237 of the 302 live entries are url or
// git-subdir, so that was 79% of the store — the large majority of the plugins whose
// Update button the overhaul just made clickable.
//
// The safety property the tests below encode: a FAILED upgrade must leave the installed
// copy exactly as it was. The new files are cloned into a staging directory first and
// only swapped in once the clone and the pin have both succeeded, mirroring
// upgradePluginFromLocal's staging/retire/rollback dance.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const calls: string[][] = [];
let failWhen: { match: string; output: string } | null = null;
const FULL_SHA = 'abc1234ffffffffffffffffffffffffffffffff';

vi.mock('child_process', () => ({
  execFile: (file: string, args: string[], _o: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
    if (file !== 'git') { cb(null, '', ''); return; }
    calls.push(args);
    if (failWhen && args.join(' ').includes(failWhen.match)) {
      cb(Object.assign(new Error('git failed'), { code: 1 }), '', failWhen.output); return;
    }
    if (args[0] === 'clone') {
      const target = args[args.length - 1];
      fs.mkdirSync(path.join(target, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(target, '.claude-plugin', 'plugin.json'), '{"name":"x","version":"2.0.0"}');
      fs.writeFileSync(path.join(target, 'NEW.txt'), 'new');
    }
    if (args[2] === 'sparse-checkout' && args[3] === 'set') {
      const sub = path.join(args[1], args[4]);
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'plugin.json'), '{"name":"y","version":"2.0.0"}');
      fs.writeFileSync(path.join(sub, 'NEW.txt'), 'new');
    }
    if (args.includes('rev-parse')) { cb(null, `${FULL_SHA}\n`, ''); return; }
    cb(null, '', '');
  },
}));

let home: string; let origHome: string | undefined;
const pluginsDir = () => path.join(home, '.claude', 'plugins', 'marketplaces', 'youcoded', 'plugins');

/** An existing v1 install, as it would be on disk before the user presses Update. */
function seedInstalled(id: string) {
  const dir = path.join(pluginsDir(), id);
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"x","version":"1.0.0"}');
  fs.writeFileSync(path.join(dir, 'OLD.txt'), 'old');
  return dir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-gitup-'));
  origHome = process.env.HOME;
  process.env.HOME = home; process.env.USERPROFILE = home;
  calls.length = 0; failWhen = null;
  vi.resetModules();
});
afterEach(() => {
  process.env.HOME = origHome; delete process.env.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('upgradePluginFromGit', () => {
  it('replaces a url-sourced install with the newly cloned tree', async () => {
    const { upgradePluginFromGit } = await import('../src/main/plugin-installer');
    const dir = seedInstalled('u1');
    const r = await upgradePluginFromGit({ id: 'u1', sourceType: 'url', sourceRef: 'https://github.com/o/r.git', sourceCommit: 'abc1234' } as any);
    expect(r).toMatchObject({ status: 'installed', commit: FULL_SHA });
    expect(fs.existsSync(path.join(dir, 'NEW.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'OLD.txt'))).toBe(false);   // really replaced, not merged
  });

  it('replaces a git-subdir install, pinning AFTER sparse-checkout', async () => {
    const { upgradePluginFromGit } = await import('../src/main/plugin-installer');
    const dir = seedInstalled('g1');
    const r = await upgradePluginFromGit({ id: 'g1', sourceType: 'git-subdir', sourceRef: 'https://github.com/o/r.git', sourceSubdir: 'plugins/g1', sourceCommit: 'abc1234' } as any);
    expect(r.status).toBe('installed');
    expect(fs.existsSync(path.join(dir, 'NEW.txt'))).toBe(true);
    const flat = calls.map((c) => c.join(' '));
    expect(flat.findIndex((c) => c.includes('sparse-checkout set'))).toBeLessThan(flat.findIndex((c) => c.includes('checkout --detach')));
  });

  // THE IMPORTANT ONE. A user must never lose a working plugin to a failed update.
  it('leaves the existing install untouched when the clone fails', async () => {
    const { upgradePluginFromGit } = await import('../src/main/plugin-installer');
    const dir = seedInstalled('u2');
    failWhen = { match: 'clone', output: 'fatal: could not read from remote repository' };
    const r = await upgradePluginFromGit({ id: 'u2', sourceType: 'url', sourceRef: 'https://github.com/o/r.git', sourceCommit: 'abc1234' } as any);
    expect(r.status).toBe('failed');
    expect((r as { error: string }).error).toContain('could not read from remote repository');  // git's words, not a guess
    expect(fs.readFileSync(path.join(dir, 'OLD.txt'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('leaves the existing install untouched when the pin fails', async () => {
    const { upgradePluginFromGit } = await import('../src/main/plugin-installer');
    const dir = seedInstalled('u3');
    failWhen = { match: 'fetch --depth 1 origin', output: "fatal: couldn't find remote ref deadbeef" };
    const r = await upgradePluginFromGit({ id: 'u3', sourceType: 'url', sourceRef: 'https://github.com/o/r.git', sourceCommit: 'deadbeef' } as any);
    expect(r.status).toBe('failed');
    expect(fs.readFileSync(path.join(dir, 'OLD.txt'), 'utf8')).toBe('old');
  });

  it('leaves no staging or retired directories behind on success', async () => {
    const { upgradePluginFromGit } = await import('../src/main/plugin-installer');
    seedInstalled('u4');
    await upgradePluginFromGit({ id: 'u4', sourceType: 'url', sourceRef: 'https://github.com/o/r.git', sourceCommit: 'abc1234' } as any);
    expect(fs.readdirSync(pluginsDir()).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('refuses a non-https url without touching anything', async () => {
    const { upgradePluginFromGit } = await import('../src/main/plugin-installer');
    const dir = seedInstalled('u5');
    const r = await upgradePluginFromGit({ id: 'u5', sourceType: 'url', sourceRef: 'ext::sh -c whoami' } as any);
    expect(r.status).toBe('failed');
    expect(fs.existsSync(path.join(dir, 'OLD.txt'))).toBe(true);
    expect(calls).toEqual([]);
  });
});

// The wiring, not just the helper: pressing Update on a git-sourced plugin must
// actually reach upgradePluginFromGit. Before this, update() fell through
// installPlugin's `already_installed` guard and returned success having rewritten
// nothing — which is the whole bug.
describe('update() reaches the git upgrade path', () => {
  it('rewrites the files of an installed url plugin', async () => {
    const { upgradePluginFromGit } = await import('../src/main/plugin-installer');
    const { installPlugin } = await import('../src/main/plugin-installer');
    const dir = seedInstalled('wired');
    // installPlugin alone refuses — this is the guard update() used to stop at.
    const blocked = await installPlugin({ id: 'wired', sourceType: 'url', sourceRef: 'https://github.com/o/r.git', sourceCommit: 'abc1234' } as any);
    expect(blocked.status).toBe('already_installed');
    expect(fs.existsSync(path.join(dir, 'NEW.txt'))).toBe(false);
    // The upgrade path is the one that actually replaces the tree.
    const upgraded = await upgradePluginFromGit({ id: 'wired', sourceType: 'url', sourceRef: 'https://github.com/o/r.git', sourceCommit: 'abc1234' } as any);
    expect(upgraded.status).toBe('installed');
    expect(fs.existsSync(path.join(dir, 'NEW.txt'))).toBe(true);
  });
});
