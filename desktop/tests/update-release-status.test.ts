import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { readReleaseStatus, selectRelease, isPreRelease } from '../src/main/update-release-status';
import type { LinuxInstallKind } from '../src/main/linux-install-kind';
import { deriveDownloadFilename } from '../src/main/update-installer';
import { verifyDownloadedUpdate } from '../src/main/update-manifest-verify';
import { buildManifest, serializeManifest, signManifest } from '../scripts/generate-release-manifest.mjs';

// What someone on a 1.3 beta goes through when the full 1.3.0 ships: the status
// check sees the release, picks this computer's installer, and the install gate
// verifies it against the signed manifest. Before 2026-09-11 the check read the
// beta as NEWER than 1.3.0 and the gate called 1.3.0 a downgrade, so testers
// would have been stranded on the beta.

const V = '1.3.0';
const BETA = '1.3.0-beta.77';
// File names exactly as a tagged release carries them: electron-builder.yml's
// artifactName patterns (nsis, dmg), its defaults for the Linux packages, and
// android-release.yml's "Name outputs after the version".
const NAMES = {
  win: `YouCoded-Installer-${V}.exe`,
  macArm: `YouCoded-Installer-${V}-arm64.dmg`,
  macIntel: `YouCoded-Installer-${V}-x64.dmg`,
  appImage: `YouCoded-${V}.AppImage`,
  deb: `youcoded_${V}_amd64.deb`,
  rpm: `youcoded-${V}.x86_64.rpm`,
  pacman: `youcoded-${V}.pacman`,
  apk: `YouCoded-${V}.apk`,
};
const MANIFEST_FILES = ['youcoded-release.json', 'youcoded-release.json.sig'];
const HTML_URL = `https://github.com/itsdestin/youcoded/releases/tag/v${V}`;
const urlOf = (name: string) => `https://github.com/itsdestin/youcoded/releases/download/v${V}/${name}`;
const releaseWith = (names: string[]) => ({
  tag_name: `v${V}`,
  html_url: HTML_URL,
  assets: names.map((name) => ({ name, browser_download_url: urlOf(name) })),
});
const FULL_RELEASE = releaseWith([...Object.values(NAMES), ...MANIFEST_FILES]);

// Linux carries one row per INSTALL KIND, not one row for "Linux": an install
// can only apply the package format it was installed from (linux-install-kind.ts).
const COMPUTERS: Array<{ label: string; platform: NodeJS.Platform; arch: string; file: string; kind?: LinuxInstallKind }> = [
  { label: 'Windows', platform: 'win32', arch: 'x64', file: NAMES.win },
  { label: 'Apple silicon Mac', platform: 'darwin', arch: 'arm64', file: NAMES.macArm },
  { label: 'Intel Mac', platform: 'darwin', arch: 'x64', file: NAMES.macIntel },
  { label: 'Linux AppImage', platform: 'linux', arch: 'x64', file: NAMES.appImage, kind: 'appimage' },
  { label: 'Linux pacman install', platform: 'linux', arch: 'x64', file: NAMES.pacman, kind: 'pacman' },
  { label: 'Linux deb install', platform: 'linux', arch: 'x64', file: NAMES.deb, kind: 'deb' },
  { label: 'Linux rpm install', platform: 'linux', arch: 'x64', file: NAMES.rpm, kind: 'rpm' },
  { label: 'Linux dev checkout', platform: 'linux', arch: 'x64', file: NAMES.appImage, kind: 'unknown' },
];

describe('readReleaseStatus — is there an update, and which file', () => {
  for (const c of COMPUTERS) {
    it(`offers 1.3.0 to a beta on ${c.label}, with that computer's installer`, () => {
      const s = readReleaseStatus(FULL_RELEASE, BETA, c.platform, c.arch, c.kind);
      expect(s).toMatchObject({
        current: BETA,
        latest: V,
        update_available: true,
        download_url: urlOf(c.file),
        manifest_url: urlOf('youcoded-release.json'),
        signature_url: urlOf('youcoded-release.json.sig'),
        tag: `v${V}`,
      });
    });
  }

  it('offers 1.3.0 to v1.2.4', () => {
    expect(readReleaseStatus(FULL_RELEASE, '1.2.4', 'win32', 'x64')?.update_available).toBe(true);
  });

  it('does not offer it to 1.3.0 itself, or to a later beta', () => {
    expect(readReleaseStatus(FULL_RELEASE, V, 'win32', 'x64')?.update_available).toBe(false);
    expect(readReleaseStatus(FULL_RELEASE, '1.3.1-beta.2', 'win32', 'x64')?.update_available).toBe(false);
  });

  it('waits while the release has no installer for this computer yet', () => {
    // The Android workflow can create the release before the desktop files are uploaded.
    const early = readReleaseStatus(releaseWith([NAMES.apk]), BETA, 'win32', 'x64');
    expect(early).toMatchObject({ update_available: false, download_url: HTML_URL, manifest_url: null });
    // Mac files attached, Windows not yet: a Mac is offered it, Windows waits.
    const partial = releaseWith([NAMES.apk, NAMES.macArm, NAMES.macIntel]);
    expect(readReleaseStatus(partial, BETA, 'darwin', 'arm64')?.update_available).toBe(true);
    expect(readReleaseStatus(partial, BETA, 'win32', 'x64')?.update_available).toBe(false);
  });

  it('returns null for a reply that is not a release (the rate-limit body)', () => {
    expect(readReleaseStatus({ message: 'API rate limit exceeded' } as never, BETA, 'win32', 'x64')).toBeNull();
    expect(readReleaseStatus(null, BETA, 'win32', 'x64')).toBeNull();
  });
});

describe('beta → full release, end to end through the signed manifest', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  let releaseDir: string;
  let cacheDir: string;

  beforeAll(() => {
    releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-release-'));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-update-cache-'));
    for (const name of Object.values(NAMES)) fs.writeFileSync(path.join(releaseDir, name), crypto.randomBytes(1024));
  });
  afterAll(() => {
    fs.rmSync(releaseDir, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3 });
  });

  for (const c of COMPUTERS) {
    it(`a ${c.label} beta downloads and verifies 1.3.0`, async () => {
      // What CI publishes for the v1.3.0 tag.
      const manifestBytes = serializeManifest(buildManifest(releaseDir, `v${V}`));
      const signatureBytes = signManifest(manifestBytes, privateKeyPem);

      // What the beta sees and downloads.
      const status = readReleaseStatus(FULL_RELEASE, BETA, c.platform, c.arch)!;
      expect(status.update_available).toBe(true);
      const fileName = deriveDownloadFilename(status.download_url!, c.platform);
      const filePath = path.join(cacheDir, fileName);
      fs.copyFileSync(path.join(releaseDir, fileName), filePath);

      // The gate the Update button runs before launching it.
      await expect(verifyDownloadedUpdate({
        filePath, fileName, manifestBytes, signatureBytes,
        tag: status.tag!, currentVersion: BETA, publicKeyPem,
      })).resolves.toMatchObject({ version: V });
    });
  }
});

describe('the beta channel — which release is offered', () => {
  // The ordering Destin asked for on 2026-09-13, end to end:
  //   a newer beta updates an older beta, even when both are 1.3.0,
  //   and the official 1.3.0 wins over both.
  //
  // The compare that makes the last part true landed 2026-09-11
  // (update-manifest-verify.test.ts pins it). What this section pins is the half
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
});

describe('a Mac is only ever offered a build its chip can run', () => {
  const ONLY_ARM = releaseWith([NAMES.macArm, ...MANIFEST_FILES]);
  const ONLY_INTEL = releaseWith([NAMES.macIntel, ...MANIFEST_FILES]);

  it('moves an Apple-silicon Mac running the Intel build onto the native build', () => {
    // macOS emulates the Intel build, so process.arch reads 'x64' on an M-series
    // Mac and the Intel build would keep updating to itself forever. Electron's
    // runningUnderARM64Translation is the only thing that tells the two apart.
    const s = readReleaseStatus(FULL_RELEASE, BETA, 'darwin', 'x64', undefined, true);
    expect(s?.download_url).toBe(urlOf(NAMES.macArm));
  });

  it('leaves a real Intel Mac on the Intel build', () => {
    expect(readReleaseStatus(FULL_RELEASE, BETA, 'darwin', 'x64', undefined, false)?.download_url)
      .toBe(urlOf(NAMES.macIntel));
  });

  it('never offers an Intel Mac a build that will not open', () => {
    // An arm64-only dmg does not run on Intel hardware, so "no installer for this
    // computer" is the honest answer — the same rule the Linux packages follow.
    const s = readReleaseStatus(ONLY_ARM, BETA, 'darwin', 'x64');
    expect(s?.update_available).toBe(false);
    expect(s?.download_url).toBe(HTML_URL);
  });

  it('never offers an Apple-silicon Mac the Intel-only build', () => {
    const s = readReleaseStatus(ONLY_INTEL, BETA, 'darwin', 'arm64');
    expect(s?.update_available).toBe(false);
  });
});

// Reported 2026-09-20 on an Arch install (`youcoded 1.3.0_beta.80-1`): clicking
// the update pill downloaded ~180 MB of AppImage, could not apply it — the
// self-replace path needs a running AppImage — and opened the download page.
describe('a Linux install is only ever offered its own package format', () => {
  const KINDS: Array<[LinuxInstallKind, string]> = [
    ['pacman', NAMES.pacman],
    ['deb', NAMES.deb],
    ['rpm', NAMES.rpm],
    ['appimage', NAMES.appImage],
  ];

  for (const [kind, file] of KINDS) {
    it(`hands a ${kind} install ${file}`, () => {
      expect(readReleaseStatus(FULL_RELEASE, BETA, 'linux', 'x64', kind)?.download_url).toBe(urlOf(file));
    });
  }

  it('never hands a system-package install the AppImage', () => {
    for (const kind of ['pacman', 'deb', 'rpm'] as LinuxInstallKind[]) {
      expect(readReleaseStatus(FULL_RELEASE, BETA, 'linux', 'x64', kind)?.download_url)
        .not.toBe(urlOf(NAMES.appImage));
    }
  });

  it('makes no offer when the release lacks this install’s package, and points at the release page', () => {
    // Better than offering a file this computer cannot apply: the pill stays
    // quiet and "Open in browser" still reaches the downloads.
    const noPacman = releaseWith([NAMES.win, NAMES.appImage, NAMES.deb, ...MANIFEST_FILES]);
    const s = readReleaseStatus(noPacman, BETA, 'linux', 'x64', 'pacman');
    expect(s?.update_available).toBe(false);
    expect(s?.download_url).toBe(HTML_URL);
  });
});
