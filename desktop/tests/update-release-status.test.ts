import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { readReleaseStatus } from '../src/main/update-release-status';
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

const COMPUTERS: Array<{ label: string; platform: NodeJS.Platform; arch: string; file: string }> = [
  { label: 'Windows', platform: 'win32', arch: 'x64', file: NAMES.win },
  { label: 'Apple silicon Mac', platform: 'darwin', arch: 'arm64', file: NAMES.macArm },
  { label: 'Intel Mac', platform: 'darwin', arch: 'x64', file: NAMES.macIntel },
  { label: 'Linux', platform: 'linux', arch: 'x64', file: NAMES.appImage },
];

describe('readReleaseStatus — is there an update, and which file', () => {
  for (const c of COMPUTERS) {
    it(`offers 1.3.0 to a beta on ${c.label}, with that computer's installer`, () => {
      const s = readReleaseStatus(FULL_RELEASE, BETA, c.platform, c.arch);
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
