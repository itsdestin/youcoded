// desktop/tests/transcript-cwd.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { isForeignCwd, firstCwd, r1CwdForDir } from '../src/main/transcript-cwd';
import { ccProjectSlug } from '../src/main/slug-encoding';

const line = (o: object) => JSON.stringify(o) + '\n';
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcwd-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('R1 vs R2 — the shape that broke the earlier draft (spec §5.4/§7)', () => {
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
