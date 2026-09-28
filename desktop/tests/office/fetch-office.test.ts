import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exitCodeFor, planFetch, stageAndReplace, sweepStaleStaging } from '../../scripts/fetch-office.mjs';

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
    expect(planFetch(pin, null, 'win-x64')).toEqual({ action: 'unsupported' });
  });

  it('reports unsupported when there is no platform key at all', () => {
    expect(planFetch(pin, null, null)).toEqual({ action: 'unsupported' });
  });
});

// Pins the --required gate: a release build (contract R2 — Office ships INSIDE the installer)
// must fail loudly if it cannot fetch the add-on, but an offline dev start must not block.
describe('exitCodeFor', () => {
  it('is always 0 for a successful fetch or skip, required or not', () => {
    expect(exitCodeFor('ok', false)).toBe(0);
    expect(exitCodeFor('ok', true)).toBe(0);
  });

  it('lets an unsupported platform pass without --required, but fails with it', () => {
    expect(exitCodeFor('unsupported', false)).toBe(0);
    expect(exitCodeFor('unsupported', true)).toBe(1);
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
