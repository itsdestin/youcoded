// Security audit item 24: built-in plugins install only from the commit baked into the app.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { BUNDLED_PLUGIN_IDS } from '../src/shared/bundled-plugins';
import { BUNDLED_PLUGIN_PINS } from '../src/shared/bundled-plugin-pins';
import { planBundledSync, getBundledPin } from '../src/main/bundled-plugin-sync';
import { materializePinnedSource } from '../src/main/plugin-installer';
import { parseBundledIds, renderPinsFile, computePins } from '../scripts/refresh-bundled-plugin-pins.mjs';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

describe('pins file is complete (a release cannot ship with a missing pin)', () => {
  it('has exactly one well-formed pin per bundled plugin', () => {
    expect(Object.keys(BUNDLED_PLUGIN_PINS).sort()).toEqual([...BUNDLED_PLUGIN_IDS].sort());
    for (const id of BUNDLED_PLUGIN_IDS) {
      const p = getBundledPin(id)!;
      expect(p.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(p.sourceRef).toBe(id);
      expect(p.version).toBeTruthy();
    }
  });
  it('the script reads the same id list the app uses and renders a stable file', () => {
    const ids = parseBundledIds(fs.readFileSync(path.join(__dirname, '../src/shared/bundled-plugins.ts'), 'utf8'));
    expect(ids).toEqual([...BUNDLED_PLUGIN_IDS]);
    expect(fs.readFileSync(path.join(__dirname, '../src/shared/bundled-plugin-pins.ts'), 'utf8')).toBe(renderPinsFile(BUNDLED_PLUGIN_PINS));
  });
});

describe('planBundledSync', () => {
  const pin = { commit: 'a'.repeat(40) };
  it('upgrades an older install', () => expect(planBundledSync({ installedVersion: '1.0.0', installedMarker: null, pin, pinnedVersion: '1.1.0' })).toBe('upgrade'));
  it('keeps a newer install (no downgrade, no reinstall loop)', () => expect(planBundledSync({ installedVersion: '1.2.0', installedMarker: null, pin, pinnedVersion: '1.1.0' })).toBe('keep-newer'));
  it('re-syncs once when same version but not known to be the pinned commit', () => expect(planBundledSync({ installedVersion: '1.1.0', installedMarker: null, pin, pinnedVersion: '1.1.0' })).toBe('upgrade'));
  it('does nothing once the marker matches', () => expect(planBundledSync({ installedVersion: '1.1.0', installedMarker: pin.commit, pin, pinnedVersion: '1.1.0' })).toBe('unchanged'));
});

describe('materializePinnedSource (real git)', () => {
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yc-pin-'));
  function setup() {
    const origin = mk();
    git(origin, 'init', '-q', '-b', 'master');
    git(origin, 'config', 'user.email', 't@t'); git(origin, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(origin, 'plug'));
    fs.writeFileSync(path.join(origin, 'plug', 'plugin.json'), '{"version":"1.0.0"}');
    git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'one');
    const pinned = git(origin, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(origin, 'plug', 'plugin.json'), '{"version":"2.0.0"}');
    fs.writeFileSync(path.join(origin, 'plug', 'extra.txt'), 'later');
    git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'two');
    const cache = mk(); fs.rmSync(cache, { recursive: true });
    execFileSync('git', ['clone', '-q', '--depth', '1', 'file://' + origin, cache]); // cache sits at the NEWER commit
    return { origin, cache, pinned };
  }
  it('installs the pinned commit, not the newest, and drops files the pin lacks', async () => {
    const { cache, pinned } = setup();
    expect((await materializePinnedSource(cache, pinned, 'plug')).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(cache, 'plug/plugin.json'), 'utf8')).version).toBe('1.0.0');
    expect(fs.existsSync(path.join(cache, 'plug/extra.txt'))).toBe(false);
  });
  it('works offline once the commit is on disk', async () => {
    const { cache, origin, pinned } = setup();
    await materializePinnedSource(cache, pinned, 'plug');
    fs.rmSync(origin, { recursive: true });
    expect((await materializePinnedSource(cache, pinned, 'plug')).ok).toBe(true);
  });
  it('refuses a commit that does not exist and leaves files untouched', async () => {
    const { cache } = setup();
    const r = await materializePinnedSource(cache, 'b'.repeat(40), 'plug');
    expect(r.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(cache, 'plug/plugin.json'), 'utf8')).version).toBe('2.0.0');
  });
  it('refuses odd commit text and escaping folders', async () => {
    const { cache, pinned } = setup();
    expect((await materializePinnedSource(cache, 'master', 'plug')).ok).toBe(false);
    expect((await materializePinnedSource(cache, pinned, '../x')).ok).toBe(false);
    expect((await materializePinnedSource(cache, pinned, '.')).ok).toBe(false);
  });
  it('script pins each folder to its LAST touching commit', () => {
    const { origin, pinned } = setup();
    const pins: Record<string, { commit: string; version: string }> = computePins(origin, 'master', ['plug']);
    expect(pins['plug'].commit).not.toBe(pinned);
    expect(pins['plug'].version).toBe('2.0.0');
  });
});

describe('wiring guard', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '../src/main', f), 'utf8');
  it('launch reconcile no longer pulls newest master', () => {
    const sp = src('skill-provider.ts');
    expect(sp).not.toMatch(/refreshLocalMarketplaceCache\(/);
    expect(sp).toMatch(/planBundledSync/);
  });
  it('both local install paths use the pin', () => {
    const pi = src('plugin-installer.ts');
    expect((pi.match(/materializePinnedSource\(cacheRepo/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
