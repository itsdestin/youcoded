// update-release-status.ts — turning GitHub's "latest release" answer into what
// the update pill and the Update button act on.
//
// WHY its own pure module (2026-09-11): this decision lived inside ipc-handlers.ts
// with a private version compare that read `1.3.0-beta.76` as [1,3,0,76] — HIGHER
// than `1.3.0` — so nobody on a beta would ever have been told the full release
// existed. Pulled out so the whole path (is it newer, which file suits this
// computer, where the signed manifest is) can be tested against a realistic
// release listing, beta → full release included.

import { compareVersions } from './update-manifest-verify';
import type { LinuxInstallKind } from './linux-install-kind';

export interface ReleaseAssetJson {
  name: string;
  browser_download_url: string;
}

export interface ReleaseJson {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: unknown;
  /** GitHub's own flag. A beta published by hand carries `prerelease: true`. */
  prerelease?: unknown;
  /** A draft is invisible to everyone and has no tag yet — never an offer. */
  draft?: unknown;
}

export interface UpdateStatus {
  current: string;
  latest: string;
  update_available: boolean;
  download_url: string | null;
  manifest_url: string | null;
  signature_url: string | null;
  tag: string | null;
}

/** The file a Linux install of each kind can actually apply to itself. */
const LINUX_ASSET_SUFFIX: Record<LinuxInstallKind, string> = {
  appimage: '.AppImage',
  pacman: '.pacman',
  deb: '.deb',
  rpm: '.rpm',
  // A dev checkout, a tarball, Nix: nothing owns the binary, so the portable
  // AppImage is the only thing that could stand in.
  unknown: '.AppImage',
};

/** The installer this computer would download from a release, if it has one. */
export function pickInstallerAsset(
  assets: ReleaseAssetJson[],
  platform: NodeJS.Platform,
  arch: string,
  linuxKind: LinuxInstallKind = 'unknown',
): ReleaseAssetJson | undefined {
  if (platform === 'win32') return assets.find((a) => a.name.endsWith('.exe'));
  if (platform === 'darwin') {
    // electron-builder cuts an arm64 and an Intel dmg and GitHub lists them in no
    // fixed order, so a bare `.endsWith('.dmg')` could hand an Intel Mac the Apple
    // silicon build, which will not open. Match the arch first, then any dmg.
    const wantArm = arch === 'arm64';
    return assets.find((a) => a.name.endsWith('.dmg') && a.name.includes('arm64') === wantArm)
      ?? assets.find((a) => a.name.endsWith('.dmg'));
  }
  // Linux: ONE suffix per install kind, and no fallback to another one. WHY no
  // "…else the AppImage": that fallback WAS the bug (2026-09-20) — a pacman
  // install downloaded 180 MB of AppImage it could not apply. A release missing
  // this computer's package is better read as "no installer for this computer",
  // which hides the offer rather than promising an update that cannot happen.
  const suffix = LINUX_ASSET_SUFFIX[linuxKind];
  return assets.find((a) => a.name.endsWith(suffix));
}

/** The well-formed assets of a release, ignoring anything GitHub shaped oddly. */
export function readAssets(release: ReleaseJson | null | undefined): ReleaseAssetJson[] {
  return Array.isArray(release?.assets)
    ? (release!.assets as unknown[]).filter((a): a is ReleaseAssetJson =>
        !!a && typeof (a as ReleaseAssetJson).name === 'string'
        && typeof (a as ReleaseAssetJson).browser_download_url === 'string')
    : [];
}

/**
 * Is this version a pre-release? `1.3.0-beta.77` yes, `1.3.0` no — the same
 * `-suffix` rule `compareVersions` sorts by, so "is a beta" and "sorts below
 * its release" can never disagree.
 */
export function isPreRelease(version: string): boolean {
  return version.replace(/^v/, '').split('+')[0].includes('-');
}

/**
 * Pick the release this computer should be offered out of a `/releases` listing.
 *
 * WHY a listing and not `/releases/latest` (2026-09-13): GitHub defines "latest"
 * as the newest STABLE release and omits pre-releases entirely, so someone on
 * `1.3.0-beta.71` was never told `1.3.0-beta.72` existed — the semver fix let a
 * beta accept the full release, but nothing ever offered it another beta. Only
 * callers on the beta channel pass `includePrereleases`, so an ordinary install
 * still sees exactly what it saw before.
 *
 * Highest version wins rather than newest-published, so re-publishing an old tag
 * cannot walk anyone backwards; `compareVersions` already sorts `1.3.0` above
 * every `1.3.0-beta.N`, which is what makes the full release end a beta run.
 */
export function selectRelease(
  releases: unknown,
  opts: { includePrereleases: boolean; platform: NodeJS.Platform; arch: string; linuxKind?: LinuxInstallKind },
): ReleaseJson | null {
  if (!Array.isArray(releases)) return null;
  let best: ReleaseJson | null = null;
  let bestVersion = '';
  for (const entry of releases) {
    if (!entry || typeof entry !== 'object') continue;
    const release = entry as ReleaseJson;
    const tagName = typeof release.tag_name === 'string' ? release.tag_name : '';
    if (!tagName) continue;
    if (release.draft === true) continue;
    if (release.prerelease === true && !opts.includePrereleases) continue;
    // Same bar the pill uses below: a release carrying no installer for THIS
    // computer is not an offer yet. One tag starts the Android and desktop
    // workflows separately, so a fresh tag is briefly assets-less.
    if (!pickInstallerAsset(readAssets(release), opts.platform, opts.arch, opts.linuxKind)) continue;
    const version = tagName.replace(/^v/, '');
    if (!best || compareVersions(version, bestVersion) > 0) {
      best = release;
      bestVersion = version;
    }
  }
  return best;
}

/**
 * Read one release object into the status the pill and the Update button act on.
 * Returns null when the body is not a release at all (GitHub's rate-limit reply
 * has no tag) so the caller keeps what it already knew instead of announcing a
 * blank version.
 */
export function readReleaseStatus(
  release: ReleaseJson | null | undefined,
  currentVersion: string,
  platform: NodeJS.Platform,
  arch: string,
  linuxKind: LinuxInstallKind = 'unknown',
): UpdateStatus | null {
  const tagName = typeof release?.tag_name === 'string' ? release.tag_name : '';
  if (!tagName) return null;
  const latestVersion = tagName.replace(/^v/, '');
  const assets = readAssets(release);
  const htmlUrl = typeof release?.html_url === 'string' ? release.html_url : null;
  const installer = pickInstallerAsset(assets, platform, arch, linuxKind);

  return {
    current: currentVersion,
    latest: latestVersion,
    // WHY "and this computer's installer is attached": one tag starts the Android
    // and desktop release workflows separately, and whichever finishes first
    // creates the GitHub release. The desktop files arrive only after all three
    // desktop builds finish, and /releases/latest already points at the release
    // in the meantime — so the pill used to say "update available" while the
    // Update button could only fail, and that answer is cached for 30 minutes.
    update_available: compareVersions(latestVersion, currentVersion) > 0 && !!installer,
    // No installer yet → the release page, which is what "Open in browser" shows.
    download_url: installer?.browser_download_url ?? htmlUrl,
    // Signed-manifest assets (2026-09-10 security review #7). An unsigned release
    // has neither, and the app then refuses to launch what it cannot verify.
    manifest_url: assets.find((a) => a.name === 'youcoded-release.json')?.browser_download_url ?? null,
    signature_url: assets.find((a) => a.name === 'youcoded-release.json.sig')?.browser_download_url ?? null,
    tag: tagName,
  };
}
