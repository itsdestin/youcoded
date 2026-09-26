// desktop/tests/transcript-cwd.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { isForeignCwd, firstCwd, r1CwdForDir } from '../src/main/transcript-cwd';
import { ccProjectSlug } from '../src/main/slug-encoding';

const line = (o: object) => JSON.stringify(o) + '\n';
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcwd-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('R1 vs R2 — a transcript whose cwd switches past line 200', () => {
  const PROJ = '/home/u/My Proj, & Stuff';
  const HOME = '/home/u';

  function writeForkFile(dir: string): string {
    // cwd first appears on line 4 (the modal case, 359/648 on the reporting
    // device), switches to $HOME at line 279 — PAST R2's 200-line cap.
    const f = path.join(dir, 'fork.jsonl');
    const rows: string[] = [line({ type: 'last-prompt' }), line({ type: 'mode' }), line({ type: 'permission-mode' })];
    rows.push(line({ type: 'user', uuid: 'u1', cwd: PROJ }));
    for (let i = 0; i < 274; i++) rows.push(line({ type: 'assistant', uuid: `a${i}`, cwd: PROJ }));
    for (let i = 0; i < 20; i++) rows.push(line({ type: 'user', uuid: `h${i}`, cwd: HOME }));
    fs.writeFileSync(f, rows.join(''));
    return f;
  }

  it('R2 returns the FIRST cwd (session origin), not the later switch', async () => {
    const dir = path.join(tmp, ccProjectSlug(HOME)); fs.mkdirSync(dir);
    // Pin platform to 'linux' explicitly — these fixtures use POSIX paths as
    // the LOCAL cwd, so leaving this on the default process.platform would
    // silently only pass on POSIX CI runners (it fails on windows-latest).
    expect(await firstCwd(writeForkFile(dir), 'linux')).toBe(PROJ);
  });

  it('R1 asked of the $HOME directory finds the LATE matching cwd (line 279 — no cap)', async () => {
    const dir = path.join(tmp, ccProjectSlug(HOME)); fs.mkdirSync(dir);
    writeForkFile(dir);
    expect(await r1CwdForDir(dir, 'linux')).toBe(HOME);
  });

  it('R1 skips foreign cwds and picks the one that re-slugs to the dirname', async () => {
    const dir = path.join(tmp, ccProjectSlug(PROJ)); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'win.jsonl'), line({ type: 'user', uuid: 'w', cwd: 'C:\\Users\\desti\\x' }));
    fs.writeFileSync(path.join(dir, 'ours.jsonl'), line({ type: 'user', uuid: 'o', cwd: PROJ }));
    expect(await r1CwdForDir(dir, 'linux')).toBe(PROJ);
  });

  it('R2 skips metadata head lines and foreign values', async () => {
    const f = path.join(tmp, 'a.jsonl');
    fs.writeFileSync(f, line({ type: 'last-prompt' }) + line({ type: 'user', cwd: 'C:\\Users\\x' }) + line({ type: 'user', cwd: PROJ }));
    expect(await firstCwd(f, 'linux')).toBe(PROJ);
    // Platform inversion, same fixture: under win32 the POSIX cwd becomes
    // foreign and the Windows cwd becomes local, so the winner flips. This
    // pins the seam itself, not just that it exists.
    expect(await firstCwd(f, 'win32')).toBe('C:\\Users\\x');
  });

  it('isForeignCwd: drive-letter on linux, POSIX-absolute on win32', () => {
    expect(isForeignCwd('C:\\Users\\x', 'linux')).toBe(true);
    expect(isForeignCwd('/home/u', 'linux')).toBe(false);
    expect(isForeignCwd('/home/u', 'win32')).toBe(true);
    expect(isForeignCwd('C:\\Users\\x', 'win32')).toBe(false);
  });
});

describe('a failing file close never costs the read', () => {
  // WHY: a rejection inside `finally` replaces the return value. Uncaught, a
  // failed close would turn a good read into a throw that climbs
  // firstCwd -> r1CwdForDir -> resolveSlugToPath, which the Resume Browser
  // awaits outside any try — so the whole listing would come back empty.
  it('firstCwd still returns the cwd it read when close() rejects', async () => {
    const PROJ = '/home/u/proj';
    const f = path.join(tmp, 'close-fails.jsonl');
    fs.writeFileSync(f, line({ type: 'user', uuid: 'u1', cwd: PROJ }));

    const realOpen = fs.promises.open.bind(fs.promises);
    let closeRejections = 0;
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const fh = await realOpen(...args);
      const realClose = fh.close.bind(fh);
      // Close the real descriptor (no leak), THEN report failure, like an EIO on close.
      fh.close = async () => {
        await realClose();
        closeRejections++;
        throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' });
      };
      return fh;
    });
    try {
      await expect(firstCwd(f, 'linux')).resolves.toBe(PROJ);
      // Non-vacuity: the failing close really ran on this path.
      expect(closeRejections).toBe(1);
    } finally {
      openSpy.mockRestore();
    }
  });
});

// firstCwd reads the head in 16 KB pieces and stops at the first match. These pin
// that it still scans exactly the lines the old "decode 512 KB, split, take 200"
// read did — no line lost at a piece boundary, no line past either bound.
describe('firstCwd reads in pieces but scans the same lines as a whole-head read', () => {
  const PROJ = '/home/u/prøject — ünïcode';
  const write = (name: string, text: string) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f; };
  const pad = (bytes: number) => line({ type: 'mode', pad: 'x'.repeat(Math.max(0, bytes - 30)) });

  it('finds a cwd line that straddles a 16 KB piece boundary, multi-byte characters included', async () => {
    const head = pad(16 * 1024 - 20);                       // the cwd line starts ~20 bytes before the boundary
    const f = write('straddle.jsonl', head + line({ type: 'user', cwd: PROJ }));
    expect(Buffer.byteLength(head)).toBeLessThan(16 * 1024);
    expect(await firstCwd(f, 'linux')).toBe(PROJ);
  });

  it('reads the last line when the file has no trailing newline', async () => {
    const f = write('no-newline.jsonl', line({ type: 'mode' }) + JSON.stringify({ type: 'user', cwd: PROJ }));
    expect(await firstCwd(f, 'linux')).toBe(PROJ);
  });

  it('still stops at the 200-line cap: a cwd first seen on line 201 is not the session origin', async () => {
    const rows = Array.from({ length: 200 }, () => line({ type: 'mode' })).join('');
    expect(await firstCwd(write('line-201.jsonl', rows + line({ type: 'user', cwd: PROJ })), 'linux')).toBeNull();
    const rows199 = Array.from({ length: 199 }, () => line({ type: 'mode' })).join('');
    expect(await firstCwd(write('line-200.jsonl', rows199 + line({ type: 'user', cwd: PROJ })), 'linux')).toBe(PROJ);
  });

  it('still stops at 512 KB: a cwd that begins past it is not read', async () => {
    const f = write('past-512k.jsonl', pad(600 * 1024) + line({ type: 'user', cwd: PROJ }));
    expect(await firstCwd(f, 'linux')).toBeNull();
  });
});
