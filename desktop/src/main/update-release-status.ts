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

export interface ReleaseAssetJson {
  name: string;
  browser_download_url: string;
}

export interface ReleaseJson {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: unknown;
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

/** The installer this computer would download from a release, if it has one. */
export function pickInstallerAsset(
  assets: ReleaseAssetJson[],
  platform: NodeJS.Platform,
  arch: string,
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
  // Linux: the AppImage can replace itself in place; a .deb only opens the browser.
  return assets.find((a) => a.name.endsWith('.AppImage')) ?? assets.find((a) => a.name.endsWith('.deb'));
}

/**
 * Read one `/releases/latest` response. Returns null when the body is not a
 * release at all (GitHub's rate-limit reply has no tag) so the caller keeps what
 * it already knew instead of announcing a blank version.
 */
export function readReleaseStatus(
  release: ReleaseJson | null | undefined,
  currentVersion: string,
  platform: NodeJS.Platform,
  arch: string,
): UpdateStatus | null {
  const tagName = typeof release?.tag_name === 'string' ? release.tag_name : '';
  if (!tagName) return null;
  const latestVersion = tagName.replace(/^v/, '');
  const assets: ReleaseAssetJson[] = Array.isArray(release?.assets)
    ? (release!.assets as unknown[]).filter((a): a is ReleaseAssetJson =>
        !!a && typeof (a as ReleaseAssetJson).name === 'string'
        && typeof (a as ReleaseAssetJson).browser_download_url === 'string')
    : [];
  const htmlUrl = typeof release?.html_url === 'string' ? release.html_url : null;
  const installer = pickInstallerAsset(assets, platform, arch);

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
