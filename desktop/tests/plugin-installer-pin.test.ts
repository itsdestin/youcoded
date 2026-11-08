// Pins the "install exactly what the catalog listed" behaviour (marketplace
// overhaul Task 17).
//
// WHY this test exists: a `git clone --depth 1` lands on whatever the default
// branch happens to be at that second, which is NOT necessarily the commit the
// catalog listed and scanned. Pinning closes that gap. The third test is the
// important one: it guards against the tempting `?? entry.sourceSha` fallback,
// which would freeze 236 of the 302 live registry entries at a months-old commit
// forever and turn Update into a no-op that reports success.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

// Every git invocation the installer makes, in order, as argv arrays.
const calls: string[][] = [];
// Per-argv failure injection: first matching substring wins.
let failWhen: { match: string; output: string } | null = null;

// The installer shells out with execFile('git', argv, opts, cb). Replacing
// child_process is the only seam — runGit is module-private.
vi.mock('child_process', () => ({
  execFile: (file: string, args: string[], _opts: unknown, cb: (e: Error | null, so: string, se: string) => void) => {
    if (file !== 'git') { cb(null, '', ''); return; }
    calls.push(args);
    if (failWhen && args.join(' ').includes(failWhen.match)) {
      cb(Object.assign(new Error('git failed'), { code: 1 }), '', failWhen.output);
      return;
    }
    // `clone` must actually produce the directory the installer then inspects.
    if (args[0] === 'clone') {
      const target = args[args.length - 1];
      fs.mkdirSync(path.join(target, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(target, '.claude-plugin', 'plugin.json'), '{"name":"x","version":"1.0.0"}');
    }
    // `sparse-checkout set <subdir>` materialises that subdir in the clone.
    if (args[2] === 'sparse-checkout' && args[3] === 'set') {
      fs.mkdirSync(path.join(args[1], args[4]), { recursive: true });
      fs.writeFileSync(path.join(args[1], args[4], 'plugin.json'), '{"name":"y","version":"1.0.0"}');
    }
    // `rev-parse HEAD` prints the full sha of whatever we checked out.
    if (args.includes('rev-parse')) { cb(null, `${FULL_SHA}\n`, ''); return; }
    cb(null, '', '');
  },
}));

const FULL_SHA = 'e91a6c0ffffffffffffffffffffffffffffffff';

let home: string; let origHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-pin-'));
  origHome = process.env.HOME;
  process.env.HOME = home; process.env.USERPROFILE = home;
  calls.length = 0; failWhen = null;
  vi.resetModules();
});
afterEach(() => {
  process.env.HOME = origHome; delete process.env.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('pinToCommit', () => {
  it('fetches the commit shallowly and checks it out, in that order', async () => {
    const { pinToCommit } = await import('../src/main/plugin-installer');
    const r = await pinToCommit('/tmp/x', 'e91a6c0');
    expect(r.ok).toBe(true);
    expect(r.commit).toBe(FULL_SHA);
    expect(calls).toEqual([
      ['-C', '/tmp/x', 'fetch', '--depth', '1', 'origin', 'e91a6c0'],
      ['-C', '/tmp/x', 'checkout', '--detach', 'e91a6c0'],
      ['-C', '/tmp/x', 'rev-parse', 'HEAD'],
    ]);
  });

  it('returns git output verbatim when the fetch fails (no guessed cause)', async () => {
    const { pinToCommit } = await import('../src/main/plugin-installer');
    failWhen = { match: 'fetch', output: "fatal: couldn't find remote ref deadbeef" };
    const r = await pinToCommit('/tmp/x', 'deadbeef');
    expect(r.ok).toBe(false);
    expect(r.output).toContain("couldn't find remote ref");
    // It must not go on to check out a commit it never fetched.
    expect(calls.some((c) => c.includes('checkout'))).toBe(false);
  });
});

describe('installPlugin pins to the catalog commit', () => {
  it('records the checked-out commit on the result, so Update can compare it later', async () => {
    const { installPlugin } = await import('../src/main/plugin-installer');
    const r = await installPlugin({ id: 'x', sourceType: 'url', sourceRef: 'https://github.com/o/r.git', sourceCommit: 'e91a6c0' } as any);
    expect(r).toMatchObject({ status: 'installed', commit: FULL_SHA });
    expect(calls.some((c) => c[0] === 'clone')).toBe(true);
    expect(calls.some((c) => c.includes('checkout') && c.includes('--detach'))).toBe(true);
  });

  it('fails honestly, with git’s own words, when the listed commit cannot be checked out', async () => {
    const { installPlugin } = await import('../src/main/plugin-installer');
    failWhen = { match: 'fetch --depth 1 origin', output: "fatal: couldn't find remote ref e91a6c0" };
    const r = await installPlugin({ id: 'x', sourceType: 'url', sourceRef: 'https://github.com/o/r.git', sourceCommit: 'e91a6c0' } as any);
    expect(r.status).toBe('failed');
    expect((r as any).error).toContain("couldn't find remote ref");
  });

  it('refuses a third-party git plugin with no pinned commit (catalog down / fallback index)', async () => {
    // WHY (security audit SC-4): without a commit we would install the upstream
    // repo's HEAD, unreviewed. Also guards the `?? sourceSha` fallback: a stale
    // sourceSha must NOT count as a pin.
    const { installPlugin, upgradePluginFromGit } = await import('../src/main/plugin-installer');
    const r = await installPlugin({ id: 'x', sourceType: 'url', sourceRef: 'https://github.com/o/r.git', sourceSha: 'stale123' } as any);
    expect(r).toEqual({ status: 'failed', error: "Can't verify this plugin right now, try again later." });
    const r2 = await installPlugin({ id: 'y', sourceType: 'git-subdir', sourceRef: 'https://github.com/o/r.git', sourceSubdir: 'p' } as any);
    expect(r2.status).toBe('failed');
    const r3 = await upgradePluginFromGit({ id: 'x', sourceType: 'url', sourceRef: 'https://github.com/o/r.git' } as any);
    expect(r3.status).toBe('failed');
    expect(calls).toEqual([]); // never even ran git
  });

  it('still installs YouCoded\'s own git-sourced entries without a pin', async () => {
    const { installPlugin } = await import('../src/main/plugin-installer');
    const r = await installPlugin({ id: 'own', sourceType: 'url', sourceRef: 'https://github.com/o/r.git', sourceMarketplace: 'youcoded' } as any);
    expect(r.status).toBe('installed');
  });

  it('pins a git-subdir source only AFTER the sparse paths are set', async () => {
    const { installPlugin } = await import('../src/main/plugin-installer');
    // The sparse clone stages into a temp dir; make the subdir exist there.
    const r = await installPlugin({ id: 'y', sourceType: 'git-subdir', sourceRef: 'https://github.com/o/r.git', sourceSubdir: 'plugins/y', sourceCommit: 'e91a6c0' } as any);
    expect(r).toMatchObject({ status: 'installed', commit: FULL_SHA });
    const flat = calls.map((c) => c.join(' '));
    const sparse = flat.findIndex((c) => c.includes('sparse-checkout set'));
    const pin = flat.findIndex((c) => c.includes('checkout --detach'));
    expect(sparse).toBeGreaterThanOrEqual(0);
    expect(pin).toBeGreaterThan(sparse);
  });
});
