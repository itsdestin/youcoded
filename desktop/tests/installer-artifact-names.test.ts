import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findCachedDownload, deriveDownloadFilename } from '../src/main/update-installer';

// WHY this file exists: the installer names in electron-builder.yml are read by
// three things that never import the config — the in-app updater's "already
// downloaded?" lookup, its per-platform extension check, and the website's
// download buttons (docs/index.html). A rename that breaks any of them ships
// silently: the build is green and users just re-download, or get no button.
// So each test expands the REAL pattern from the config and feeds the result to
// the same checks those readers apply.

const CONFIG = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');

/** `key:` inside a top-level `section:` of the YAML, unquoted. Comment lines are skipped. */
function sectionValue(section: string, key: string): string | null {
  const lines = CONFIG.split('\n');
  const start = lines.indexOf(`${section}:`);
  if (start < 0) return null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // reached the next top-level section
    if (/^\s*#/.test(line)) continue;
    const m = line.match(new RegExp(`^\\s+${key}:\\s*"?(.*?)"?\\s*$`));
    if (m) return m[1];
  }
  return null;
}

/** Mirrors electron-builder's expandMacro for the macros these patterns use. */
function expand(pattern: string, v: { version: string; arch: string; ext: string }): string {
  return pattern
    .replace(/\$\{productName\}/g, 'YouCoded')
    .replace(/\$\{version\}/g, v.version)
    .replace(/\$\{arch\}/g, v.arch)
    .replace(/\$\{ext\}/g, v.ext);
}

// A beta version: the hardest shape for the version-token lookup (extra dots and a dash).
const VERSION = '1.3.0-beta.77';
const releaseUrl = (name: string) => `https://github.com/itsdestin/youcoded/releases/download/${VERSION}/${name}`;

// The website's matchers, copied from docs/index.html (dl-windows / dl-macos-arm64 / dl-macos-intel).
const site = {
  windows: (n: string) => /\.exe$/i.test(n),
  macArm: (n: string) => /arm64\.dmg$/i.test(n),
  macIntel: (n: string) => /\.dmg$/i.test(n) && !/arm64/i.test(n),
};

describe('installer file names (electron-builder.yml)', () => {
  let cacheDir: string;
  beforeEach(() => { cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-names-')); });
  afterEach(() => { fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3 }); });

  it('Windows: says Installer, and every reader still finds it', () => {
    const pattern = sectionValue('nsis', 'artifactName');
    expect(pattern, 'nsis.artifactName must be set — the default name is "YouCoded Setup"').toBeTruthy();
    const name = expand(pattern!, { version: VERSION, arch: 'x64', ext: 'exe' });

    expect(name).toBe('YouCoded-Installer-1.3.0-beta.77.exe');
    // GitHub turns spaces into dots, which is what broke the cached lookup before.
    expect(name).not.toMatch(/\s/);
    expect(site.windows(name)).toBe(true);
    expect(deriveDownloadFilename(releaseUrl(name), 'win32')).toBe(name);

    fs.writeFileSync(path.join(cacheDir, name), 'x');
    expect(findCachedDownload(cacheDir, VERSION, 'win32')?.filePath).toBe(path.join(cacheDir, name));
  });

  it('macOS: both chips say Installer, and the website and updater tell them apart', () => {
    const pattern = sectionValue('dmg', 'artifactName');
    expect(pattern, 'dmg.artifactName must be set').toBeTruthy();
    const arm = expand(pattern!, { version: VERSION, arch: 'arm64', ext: 'dmg' });
    const intel = expand(pattern!, { version: VERSION, arch: 'x64', ext: 'dmg' });

    for (const name of [arm, intel]) {
      expect(name).toMatch(/^YouCoded-Installer-/);
      expect(name).not.toMatch(/\s/);
      expect(deriveDownloadFilename(releaseUrl(name), 'darwin')).toBe(name);
    }
    expect(site.macArm(arm)).toBe(true);
    expect(site.macIntel(arm)).toBe(false);
    expect(site.macIntel(intel)).toBe(true);
    expect(site.macArm(intel)).toBe(false);
    // The updater's own arch pick (ipc-handlers.ts): `name.includes('arm64') === wantArm`.
    expect(arm.includes('arm64')).toBe(true);
    expect(intel.includes('arm64')).toBe(false);

    fs.writeFileSync(path.join(cacheDir, intel), 'x');
    expect(findCachedDownload(cacheDir, VERSION, 'darwin')?.filePath).toBe(path.join(cacheDir, intel));
  });

  it('macOS: the opened disk is named as the installer', () => {
    // The literal `${productName}` is electron-builder's macro text as written in the
    // YAML, not a mistyped template string.
    // eslint-disable-next-line no-template-curly-in-string
    expect(sectionValue('dmg', 'title')).toBe('Install ${productName}');
  });

  it('Linux: the AppImage keeps its name, because it IS the app, not an installer', () => {
    expect(sectionValue('appImage', 'artifactName')).toBeNull();
    expect(sectionValue('linux', 'artifactName')).toBeNull();
  });
});
