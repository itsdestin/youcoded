import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { selectRelease, isPreRelease, readReleaseStatus } from '../src/main/update-release-status';
import { NativeHome } from '../src/main/native-home';
import { UpdateSettings, resolveBetaChannel } from '../src/main/update-settings';

// The ordering Destin asked for on 2026-09-13, end to end:
//   a newer beta updates an older beta, even when both are 1.3.0,
//   and the official 1.3.0 wins over both.
//
// The compare that makes the last part true landed 2026-09-11
// (update-manifest-verify.test.ts pins it). What this file pins is the half
// that compare could not fix on its own: GitHub's /releases/latest omits
// pre-releases entirely, so before selectRelease NOTHING ever offered a beta
// tester another beta — the versions sorted correctly and were never fetched.

const urlOf = (tag: string, name: string) =>
  `https://github.com/itsdestin/youcoded/releases/download/${tag}/${name}`;

/** A release as GitHub lists it, carrying every platform's installer. */
function release(tag: string, opts: { prerelease?: boolean; draft?: boolean; assets?: string[] } = {}) {
  const version = tag.replace(/^v/, '');
  const names = opts.assets ?? [
    `YouCoded-Installer-${version}.exe`,
    `YouCoded-Installer-${version}-arm64.dmg`,
    `YouCoded-Installer-${version}-x64.dmg`,
    `YouCoded-${version}.AppImage`,
  ];
  return {
    tag_name: tag,
    html_url: `https://github.com/itsdestin/youcoded/releases/tag/${tag}`,
    prerelease: opts.prerelease ?? false,
    draft: opts.draft ?? false,
    assets: names.map((name) => ({ name, browser_download_url: urlOf(tag, name) })),
  };
}

// Newest-published first, the order GitHub returns — deliberately NOT version
// order, so a test that passed by reading entry 0 would be lying.
const LISTING = [
  release('1.3.0-beta.78', { prerelease: true }),
  release('v1.3.0'),
  release('1.3.0-beta.77', { prerelease: true }),
  release('v1.2.4'),
];

const ON = { includePrereleases: true, platform: 'linux' as NodeJS.Platform, arch: 'x64' };
const OFF = { ...ON, includePrereleases: false };

const tagOf = (r: { tag_name?: unknown } | null) => (r ? String(r.tag_name) : null);
const offered = (listing: unknown, opts: typeof ON, current: string) =>
  readReleaseStatus(selectRelease(listing, opts), current, opts.platform, opts.arch);

describe('isPreRelease', () => {
  it('is the -suffix rule, so it can never disagree with compareVersions', () => {
    expect(isPreRelease('1.3.0-beta.77')).toBe(true);
    expect(isPreRelease('v1.3.0-beta')).toBe(true);
    expect(isPreRelease('1.3.0')).toBe(false);
    expect(isPreRelease('v1.2.4')).toBe(false);
    // Build metadata is not a pre-release marker.
    expect(isPreRelease('1.3.0+build.5')).toBe(false);
  });
});

describe('selectRelease — which release an install is offered', () => {
  it('on the beta channel, offers the highest VERSION, not the newest published', () => {
    expect(tagOf(selectRelease(LISTING, ON))).toBe('v1.3.0');
  });

  it('offers a newer beta over an older one when both are 1.3.0', () => {
    const betasOnly = LISTING.filter((r) => r.prerelease);
    expect(tagOf(selectRelease(betasOnly, ON))).toBe('1.3.0-beta.78');
    // …and that is a real offer, not just a pick.
    const status = offered(betasOnly, ON, '1.3.0-beta.77');
    expect(status?.update_available).toBe(true);
    expect(status?.latest).toBe('1.3.0-beta.78');
  });

  it('lets the full 1.3.0 end a beta run', () => {
    const status = offered(LISTING, ON, '1.3.0-beta.78');
    expect(status?.update_available).toBe(true);
    expect(status?.latest).toBe('1.3.0');
  });

  it('does not walk a 1.3.0 install back onto a beta', () => {
    expect(offered(LISTING, ON, '1.3.0')?.update_available).toBe(false);
  });

  it('off the beta channel, never picks a pre-release', () => {
    expect(tagOf(selectRelease(LISTING, OFF))).toBe('v1.3.0');
    // A stable user with only betas available is offered nothing at all —
    // this is what keeps ordinary users off beta software.
    expect(selectRelease(LISTING.filter((r) => r.prerelease), OFF)).toBeNull();
  });

  it('never offers a draft, even on the beta channel', () => {
    const withDraft = [release('1.9.0-beta.1', { prerelease: true, draft: true }), ...LISTING];
    expect(tagOf(selectRelease(withDraft, ON))).toBe('v1.3.0');
  });

  it('skips a release that has no installer for THIS computer', () => {
    // A tag mid-build: Android's APK is up, the desktop workflows have not
    // finished. Same bar readReleaseStatus applies to the pill.
    const androidOnly = release('v1.4.0', { assets: ['YouCoded-1.4.0.apk'] });
    expect(tagOf(selectRelease([androidOnly, ...LISTING], ON))).toBe('v1.3.0');
  });

  it('reads a body that is not a listing as no answer, rather than throwing', () => {
    expect(selectRelease({ message: 'API rate limit exceeded' }, ON)).toBeNull();
    expect(selectRelease(null, ON)).toBeNull();
    expect(selectRelease([null, 'nonsense', {}], ON)).toBeNull();
  });
});

describe('resolveBetaChannel — what an install that was never asked does', () => {
  it('follows the running build when unset', () => {
    expect(resolveBetaChannel(null, '1.3.0-beta.77')).toBe(true);
    expect(resolveBetaChannel(null, '1.3.0')).toBe(false);
  });

  it('lets an explicit choice win in both directions', () => {
    expect(resolveBetaChannel(false, '1.3.0-beta.77')).toBe(false);
    expect(resolveBetaChannel(true, '1.3.0')).toBe(true);
  });
});

describe('UpdateSettings — persistence', () => {
  // Always awaited, even for the synchronous cases: an earlier version returned
  // fn()'s promise and removed the directory in a synchronous `finally`, so the
  // write it was testing landed in a directory that no longer existed.
  async function withHome(fn: (settings: UpdateSettings, dir: string) => unknown): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-update-settings-'));
    try {
      await fn(new UpdateSettings(new NativeHome(dir)), dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  it('reads as unset before anything is written', async () => {
    await withHome((settings) => {
      expect(settings.read().betaChannel).toBeNull();
      // …so a beta build still checks the beta channel on a fresh install.
      expect(settings.resolve('1.3.0-beta.77')).toBe(true);
      expect(settings.resolve('1.3.0')).toBe(false);
    });
  });

  it('round-trips a choice, and off means off even on a beta build', async () => {
    await withHome(async (settings) => {
      await settings.setBetaChannel(false);
      expect(settings.read().betaChannel).toBe(false);
      expect(settings.resolve('1.3.0-beta.77')).toBe(false);
      await settings.setBetaChannel(true);
      expect(settings.resolve('1.2.4')).toBe(true);
    });
  });

  it('refuses a non-boolean rather than storing it', async () => {
    await withHome(async (settings) => {
      await expect(settings.setBetaChannel('yes')).rejects.toThrow(TypeError);
      expect(settings.read().betaChannel).toBeNull();
    });
  });

  it('leaves the rest of config.json alone', async () => {
    await withHome(async (settings, dir) => {
      const file = path.join(dir, '.youcoded', 'config.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: 1, naming: { mode: 'ai' } }));
      await settings.setBetaChannel(true);
      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(after.naming).toEqual({ mode: 'ai' });
      expect(after.updates).toEqual({ betaChannel: true });
    });
  });

  it('treats a hand-edited value as unset, not as off', async () => {
    await withHome((settings, dir) => {
      const file = path.join(dir, '.youcoded', 'config.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ updates: { betaChannel: 'maybe' } }));
      expect(settings.read().betaChannel).toBeNull();
      expect(settings.resolve('1.3.0-beta.77')).toBe(true);
    });
  });
});
