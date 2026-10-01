import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { exitCodeFor, planFetch, platformKey, releaseDest, releaseKeys, stageAndReplace, sweepStaleStaging } from '../../scripts/fetch-office.mjs';
import realPin from '../../office-pin.json';
import pkg from '../../package.json';
import { readSource } from '../helpers/guard-scope';

// Pins the fetch-vs-skip decision fetch-office.mjs makes at dev/build time, without touching
// the network: office comes down as a real tar.gz (~104MB) that a unit test should never fetch.
const pin = {
  version: '0.1.0',
  platforms: {
    'linux-x64': {
      url: 'https://example.invalid/youcoded-office-0.1.0-linux-x64.tar.gz',
      sha256: 'a'.repeat(64),
    },
  },
};

describe('planFetch', () => {
  it('skips when the installed manifest already matches the pinned version', () => {
    const manifest = { version: '0.1.0' };
    expect(planFetch(pin, manifest, 'linux-x64')).toEqual({ action: 'skip' });
  });

  it('downloads the pinned url and checksum when no manifest is present', () => {
    expect(planFetch(pin, null, 'linux-x64')).toEqual({
      action: 'download',
      url: pin.platforms['linux-x64'].url,
      sha256: pin.platforms['linux-x64'].sha256,
    });
  });

  it('downloads again when the installed manifest is an older version', () => {
    const manifest = { version: '0.0.9' };
    expect(planFetch(pin, manifest, 'linux-x64')).toEqual({
      action: 'download',
      url: pin.platforms['linux-x64'].url,
      sha256: pin.platforms['linux-x64'].sha256,
    });
  });

  it('reports unsupported for a platform key with no pinned bundle', () => {
    expect(planFetch(pin, null, 'linux-arm64')).toEqual({ action: 'unsupported' });
  });

  it('reports unsupported when there is no platform key at all', () => {
    expect(planFetch(pin, null, null)).toEqual({ action: 'unsupported' });
  });
});

// Task 9: keys use Node's own platform/arch names, which is what electron-builder's ${platform}
// and ${arch} expand to — so the pin, the add-on's tarballs and the installer agree.
describe('platformKey', () => {
  it("names each platform the way Node and electron-builder do", () => {
    expect(platformKey('linux', 'x64')).toBe('linux-x64');
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
    expect(platformKey('freebsd', 'x64')).toBeNull();
  });
});

describe('releaseKeys', () => {
  const many = { version: '0.1.0', platforms: { 'darwin-x64': {}, 'darwin-arm64': {}, 'linux-x64': {}, 'win32-x64': {} } };
  it('takes every arch pinned for the build OS, since one Mac build cuts both dmgs', () => {
    expect(releaseKeys(many, 'darwin')).toEqual(['darwin-arm64', 'darwin-x64']);
    expect(releaseKeys(many, 'win32')).toEqual(['win32-x64']);
  });
  it('takes nothing for an OS with no pinned bundle', () => {
    expect(releaseKeys(many, 'freebsd')).toEqual([]);
  });
});

// Pins the --required gate: a release build (contract R2 — Office ships INSIDE the installer)
// must fail loudly if it cannot fetch the add-on, but an offline dev start must not block.
describe('exitCodeFor', () => {
  it('is always 0 for a successful fetch or skip, required or not', () => {
    expect(exitCodeFor('ok', false)).toBe(0);
    expect(exitCodeFor('ok', true)).toBe(0);
  });

  // Task 9: a platform with no bundle at all (ARM Linux — upstream ships no converter for it)
  // must still build; it ships without Office, so even a release build passes.
  it('lets an unsupported platform pass, even with --required', () => {
    expect(exitCodeFor('unsupported', false)).toBe(0);
    expect(exitCodeFor('unsupported', true)).toBe(0);
  });

  it('lets a network failure pass without --required, but fails with it', () => {
    expect(exitCodeFor('network-failed', false)).toBe(0);
    expect(exitCodeFor('network-failed', true)).toBe(1);
  });
});

// Pins atomic replace: a failed extraction must never leave office-addon/ half-written.
// Uses a fake extractor (never a real tar) against the test's own mkdtemp'd directories.
describe('stageAndReplace', () => {
  const pin = { version: '0.1.0' };

  async function tempDest() {
    const dir = await mkdtemp(path.join(tmpdir(), 'office-stage-test-'));
    return path.join(dir, 'office-addon');
  }

  it('installs the extracted bundle when the extractor succeeds with a matching manifest', async () => {
    const dest = await tempDest();
    await stageAndReplace({
      dest,
      pin,
      extract: async (stagingDir: string) => {
        await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify({ version: '0.1.0' }));
      },
    });
    const manifest = JSON.parse(await readFile(path.join(dest, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe('0.1.0');
    // No staging directory left behind beside the finished install.
    await expect(readFile(`${dest}.staging-${process.pid}`, 'utf8')).rejects.toThrow();
    await rm(path.dirname(dest), { recursive: true, force: true });
  });

  it('leaves no destination when a fresh install extraction fails midway', async () => {
    const dest = await tempDest();
    await expect(
      stageAndReplace({
        dest,
        pin,
        extract: async (stagingDir: string) => {
          // A real tar failure can still have written some files before dying.
          await writeFile(path.join(stagingDir, 'partial-file.txt'), 'partial');
          throw new Error('tar: unexpected end of file');
        },
      })
    ).rejects.toThrow('tar: unexpected end of file');
    await expect(readFile(path.join(dest, 'manifest.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(`${dest}.staging-${process.pid}`, 'utf8')).rejects.toThrow();
    await rm(path.dirname(dest), { recursive: true, force: true });
  });

  it('leaves the previous install untouched when a re-fetch extraction fails midway', async () => {
    const dest = await tempDest();
    await stageAndReplace({
      dest,
      pin,
      extract: async (stagingDir: string) => {
        await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify({ version: '0.1.0' }));
      },
    });

    await expect(
      stageAndReplace({
        dest,
        pin: { version: '0.2.0' },
        extract: async (stagingDir: string) => {
          await writeFile(path.join(stagingDir, 'partial-file.txt'), 'partial');
          throw new Error('tar: unexpected end of file');
        },
      })
    ).rejects.toThrow('tar: unexpected end of file');

    const manifest = JSON.parse(await readFile(path.join(dest, 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe('0.1.0');
    await expect(readFile(`${dest}.staging-${process.pid}`, 'utf8')).rejects.toThrow();
    await rm(path.dirname(dest), { recursive: true, force: true });
  });

  it('rejects and leaves the destination untouched when the extracted manifest is the wrong version', async () => {
    const dest = await tempDest();
    await expect(
      stageAndReplace({
        dest,
        pin,
        extract: async (stagingDir: string) => {
          await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify({ version: '9.9.9' }));
        },
      })
    ).rejects.toThrow('wrong version');
    await expect(readFile(path.join(dest, 'manifest.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(`${dest}.staging-${process.pid}`, 'utf8')).rejects.toThrow();
    await rm(path.dirname(dest), { recursive: true, force: true });
  });
});

// Pins the leak fix: a run killed mid-extraction must not leave its ~104MB staging directory
// behind forever, but a sweep must never touch a directory another still-running fetch owns.
describe('sweepStaleStaging', () => {
  async function tempDest() {
    const dir = await mkdtemp(path.join(tmpdir(), 'office-sweep-test-'));
    return path.join(dir, 'office-addon');
  }

  it('removes a staging directory whose pid is no longer alive', async () => {
    const dest = await tempDest();
    // A pid this high is not a real running process in a normal test run — process.kill(pid, 0)
    // reliably throws ESRCH for it, standing in for "the run that made this dir is gone".
    const deadPidDir = `${dest}.staging-999999`;
    await mkdir(deadPidDir, { recursive: true });
    await sweepStaleStaging(dest);
    expect(await readdirOrEmpty(path.dirname(dest))).not.toContain(path.basename(deadPidDir));
    await rm(path.dirname(dest), { recursive: true, force: true });
  });

  it('keeps this process\'s own staging directory', async () => {
    const dest = await tempDest();
    const ownDir = `${dest}.staging-${process.pid}`;
    await mkdir(ownDir, { recursive: true });
    await sweepStaleStaging(dest);
    expect(await readdirOrEmpty(path.dirname(dest))).toContain(path.basename(ownDir));
    await rm(path.dirname(dest), { recursive: true, force: true });
  });

  it('keeps a fresh staging directory belonging to a different, still-alive pid', async () => {
    const dest = await tempDest();
    // process.ppid is a real, live pid distinct from this test process — the parent that
    // launched it — standing in for "some other concurrent fetch, still running".
    const liveDir = `${dest}.staging-${process.ppid}`;
    await mkdir(liveDir, { recursive: true });
    await sweepStaleStaging(dest);
    expect(await readdirOrEmpty(path.dirname(dest))).toContain(path.basename(liveDir));
    await rm(path.dirname(dest), { recursive: true, force: true });
  });

  it('removes a directory older than an hour even with a live pid', async () => {
    const dest = await tempDest();
    const oldDir = `${dest}.staging-${process.ppid}`;
    await mkdir(oldDir, { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(oldDir, twoHoursAgo, twoHoursAgo);
    await sweepStaleStaging(dest);
    expect(await readdirOrEmpty(path.dirname(dest))).not.toContain(path.basename(oldDir));
    await rm(path.dirname(dest), { recursive: true, force: true });
  });
});

async function readdirOrEmpty(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

// WHY (release build): three things must agree for an installer to carry Office —
// office-pin.json's platform keys, the folder `npm run build` fetches each one into
// (fetch-office.mjs --release), and the folder electron-builder.yml packs for each
// platform/arch. None of them imports the others, so a rename in one ships an installer with
// no Office and every build still green. Each test reads the REAL files.
const DESKTOP = path.join(__dirname, '..', '..');
const CONFIG: Record<string, any> = parseYaml(readSource(path.join(DESKTOP, 'electron-builder.yml')));
const office = (CONFIG.extraResources as { from: string; to: string }[]).find((r) => r.to === 'office')!;
// The installers the release workflows build: Windows x64, both Mac arches, Linux x64.
const SHIPPED = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];

describe('the release build finds every platform\'s Office bundle', () => {
  it('pins a bundle for every installer the release builds', () => {
    expect(Object.keys(realPin.platforms).sort()).toEqual(SHIPPED);
  });

  it.each(Object.entries(realPin.platforms))('%s points at that platform\'s tarball of the pinned version, with a checksum', (key, entry) => {
    expect(entry.url).toBe(
      `https://github.com/itsdestin/youcoded-office/releases/download/v${realPin.version}/youcoded-office-${realPin.version}-${key}.tar.gz`,
    );
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(SHIPPED)('electron-builder packs %s from the folder the build fetched it into', (key) => {
    const [platform, arch] = key.split('-');
    // WHY regexes, not '${…}' strings: these are electron-builder's own macros, written literally.
    const from = office.from.replace(/\$\{platform\}/, platform).replace(/\$\{arch\}/, arch);
    expect(path.join(DESKTOP, from)).toBe(releaseDest(key));
  });

  it('builds installers with fetch-office --release --required before packaging', () => {
    expect(pkg.scripts.build).toMatch(/^node scripts\/fetch-office\.mjs --release --required &&/);
  });
});

// The Mac signer skips the add-on's non-code files but must sign the converter: Apple silicon
// will not run unsigned code, and our app seal replaces upstream's signature.
describe('macOS signing of the Office converter', () => {
  const ignore = (CONFIG.mac.signIgnore as string[]).map((r) => new RegExp(r));
  const skipped = (f: string) => ignore.some((r) => r.test(`/x/YouCoded.app/Contents/Resources/office/${f}`));
  it('signs x2t and its libraries', () => {
    expect(skipped('converter/x2t')).toBe(false);
    expect(skipped('converter/libkernel.dylib')).toBe(false);
  });
  it('skips the editor files, fonts and templates', () => {
    for (const f of ['editors/sdkjs/word/sdk-all-min.js', 'editors/web-apps/x.png', 'converter/fonts/Carlito-Bold.ttf', 'templates/blank.docx', 'converter/DoctRenderer.config'])
      expect(skipped(f)).toBe(true);
  });
  it('leaves the rest of the app alone', () => {
    expect(ignore.some((r) => r.test('/x/YouCoded.app/Contents/MacOS/YouCoded'))).toBe(false);
  });
});
