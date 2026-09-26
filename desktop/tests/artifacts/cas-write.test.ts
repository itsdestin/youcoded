import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { casWrite, CAS_REPLACE_ANY, renameReplacing } from '../../src/main/artifacts/cas-write';

describe('casWrite', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cas-test-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it('writes new file atomically when no prior file exists', async () => {
    const target = join(dir, 'foo.json');
    const result = await casWrite(target, null, '{"v":1}');
    expect(result.committed).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"v":1}');
  });

  it('writes when expectedUpdatedAt matches', async () => {
    const target = join(dir, 'foo.json');
    writeFileSync(target, '{"updatedAt":"2026-01-01T00:00:00Z"}');
    const result = await casWrite(
      target,
      '2026-01-01T00:00:00Z',
      '{"updatedAt":"2026-01-02T00:00:00Z"}',
      (json) => JSON.parse(json).updatedAt
    );
    expect(result.committed).toBe(true);
  });

  it('rejects when expectedUpdatedAt does not match', async () => {
    const target = join(dir, 'foo.json');
    writeFileSync(target, '{"updatedAt":"2026-01-05T00:00:00Z"}');
    const result = await casWrite(
      target,
      '2026-01-01T00:00:00Z',
      '{"updatedAt":"2026-01-02T00:00:00Z"}',
      (json) => JSON.parse(json).updatedAt
    );
    expect(result.committed).toBe(false);
    expect(result.actualUpdatedAt).toBe('2026-01-05T00:00:00Z');
  });

  it('leaves no .tmp file behind on success', async () => {
    // WHY readdir instead of existsSync(target + '.tmp'): the temp name is
    // pid+time-suffixed now, so probing one fixed name would pass even on a
    // leak. Assert NO entry in the dir ends with .tmp, whatever its name.
    const target = join(dir, 'foo.json');
    await casWrite(target, null, '{}');
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('unlinks its temp file when the rename fails (no permanent orphan)', async () => {
    // A pid+time temp name is never overwritten by the next write, so a strand
    // from a failed rename (e.g. Windows AV EPERM) would linger forever unless
    // the error path unlinks it. The hold never lets go (mockRejectedValue, not
    // …Once): on Windows renameReplacing retries a brief EPERM, so a one-shot
    // hold would succeed there and never reach the error path this pins.
    const renameSpy = vi
      .spyOn(fsp, 'rename')
      .mockRejectedValue(Object.assign(new Error('EPERM: simulated AV hold'), { code: 'EPERM' }));
    try {
      const target = join(dir, 'foo.json');
      await expect(casWrite(target, null, '{}')).rejects.toThrow('EPERM');
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('sweeps a stale crash-orphaned tmp for the same target before writing', async () => {
    const target = join(dir, 'foo.json');
    // Plant an orphan matching OUR tmp shape, aged past the 1h staleness bar,
    // plus a fresh one and a foreign target's orphan — only the stale own-target
    // orphan may be swept.
    const staleOrphan = `${target}.99999.123.tmp`;
    const freshOrphan = `${target}.99998.456.tmp`;
    const foreignOrphan = join(dir, 'bar.json.99999.123.tmp');
    writeFileSync(staleOrphan, 'junk');
    writeFileSync(freshOrphan, 'junk');
    writeFileSync(foreignOrphan, 'junk');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(staleOrphan, old, old);
    utimesSync(foreignOrphan, old, old);
    await casWrite(target, null, '{}');
    expect(existsSync(staleOrphan)).toBe(false);
    expect(existsSync(freshOrphan)).toBe(true); // could be a live write in flight
    expect(existsSync(foreignOrphan)).toBe(true); // not our target — left alone
  });

  it('uses a per-process temp name (pid-suffixed), never a fixed <file>.tmp', async () => {
    // WHY: dev instance and built app share ~/.claude — a fixed '<file>.tmp'
    // lets two processes race the same temp path (loser's rename ENOENTs).
    const renameSpy = vi.spyOn(fsp, 'rename');
    try {
      const target = join(dir, 'pid.json');
      const result = await casWrite(target, null, '{"v":1}');
      expect(result.committed).toBe(true);
      const tmpSources = renameSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.endsWith('.tmp'));
      expect(tmpSources.length).toBeGreaterThan(0);
      for (const src of tmpSources) {
        expect(src).toContain(`.${process.pid}.`);
      }
    } finally {
      renameSpy.mockRestore();
    }
  });
});

// 2026-08-27 OOM fix: the CAS comparand is ONE timestamp, but the check used
// to hand the extractor the WHOLE file — 6.4 MB of artifacts.json parsed to
// read 24 bytes, on every write. casWrite now offers the extractor a bounded
// head first and falls back to the whole file only when the head has no answer.
describe('casWrite — head probe before whole-file read', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cas-head-')); });
  afterEach(() => { vi.restoreAllMocks(); try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  const probe = (json: string) => /"updatedAt"\s*:\s*"([^"]*)"/.exec(json)?.[1];

  it('never reads the whole file when the head probe answers', async () => {
    const target = join(dir, 'big.json');
    // updatedAt near the front, then a body far larger than the probe window.
    writeFileSync(target, `{"updatedAt":"2026-01-01T00:00:00Z","pad":"${'x'.repeat(200_000)}"}`);
    const whole = vi.spyOn(fsp, 'readFile');
    const result = await casWrite(target, '2026-01-01T00:00:00Z', '{"updatedAt":"2026-01-02T00:00:00Z"}', probe);
    expect(result.committed).toBe(true);
    expect(whole.mock.calls.filter((c) => String(c[0]) === target)).toHaveLength(0);
  });

  it('falls back to the whole file when the head has no answer (updatedAt past the probe window)', async () => {
    const target = join(dir, 'tail.json');
    writeFileSync(target, `{"pad":"${'y'.repeat(200_000)}","updatedAt":"2026-03-03T00:00:00Z"}`);
    const ok = await casWrite(target, '2026-03-03T00:00:00Z', '{"updatedAt":"2026-03-04T00:00:00Z"}', probe);
    expect(ok.committed).toBe(true);
  });

  it('an extractor that THROWS on the truncated head (JSON.parse) still gets the whole file', async () => {
    const target = join(dir, 'parse.json');
    writeFileSync(target, `{"pad":"${'z'.repeat(200_000)}","updatedAt":"2026-05-05T00:00:00Z"}`);
    const result = await casWrite(target, 'stale', '{"updatedAt":"x"}', (json) => JSON.parse(json).updatedAt);
    expect(result.committed).toBe(false);
    expect(result.actualUpdatedAt).toBe('2026-05-05T00:00:00Z');
  });

  // ROADMAP L696. Two first-ever writes in a project each found no sidecar,
  // each wrote a fresh page-one, and the second silently overwrote the first —
  // both reporting committed: true, one record gone with no error.
  describe('null expects ABSENCE, not "write regardless" (ROADMAP L696)', () => {
    it('refuses the write when a file appeared after the caller read nothing', async () => {
      const target = join(dir, 'race.json');
      // The other writer got there first.
      writeFileSync(target, '{"updatedAt":"2026-01-01T00:00:00Z","artifacts":["theirs"]}');

      const result = await casWrite(target, null, '{"updatedAt":"2026-01-01T00:00:01Z","artifacts":["mine"]}', probe);

      expect(result.committed).toBe(false);
      // Their record survives — that is the whole point.
      expect(readFileSync(target, 'utf8')).toContain('theirs');
    });

    it('still refuses when the existing file has no comparand at all', async () => {
      // An unreadable/garbage file is still a file. Only CAS_REPLACE_ANY may
      // overwrite one, and a creating writer is not that.
      const target = join(dir, 'garbage.json');
      writeFileSync(target, 'not json at all');
      const result = await casWrite(target, null, '{"v":1}', probe);
      expect(result.committed).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('not json at all');
    });

    it('needs no extractor to do it — creation has nothing to compare', async () => {
      const target = join(dir, 'noextract.json');
      writeFileSync(target, '{"updatedAt":"2026-01-01T00:00:00Z"}');
      expect((await casWrite(target, null, '{"v":1}')).committed).toBe(false);
    });

    it('still creates normally when nothing is there', async () => {
      const target = join(dir, 'fresh.json');
      expect((await casWrite(target, null, '{"v":1}', probe)).committed).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('{"v":1}');
    });
  });

  describe('CAS_REPLACE_ANY overwrites deliberately (ROADMAP L696)', () => {
    it('replaces a corrupt file the extractor cannot read', async () => {
      const target = join(dir, 'corrupt.json');
      writeFileSync(target, '{"updatedAt": trunc');
      const result = await casWrite(target, CAS_REPLACE_ANY, '{"updatedAt":"2026-02-02T00:00:00Z"}', probe);
      expect(result.committed).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('{"updatedAt":"2026-02-02T00:00:00Z"}');
    });

    it('replaces a perfectly readable file too — it is an explicit override, not a fallback', async () => {
      const target = join(dir, 'fine.json');
      writeFileSync(target, '{"updatedAt":"2026-01-01T00:00:00Z"}');
      expect((await casWrite(target, CAS_REPLACE_ANY, '{"v":2}', probe)).committed).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('{"v":2}');
    });

    it('creates the file when there is nothing to replace', async () => {
      const target = join(dir, 'absent.json');
      expect((await casWrite(target, CAS_REPLACE_ANY, '{"v":1}', probe)).committed).toBe(true);
    });
  });

  it('a string expectation is refused when the file has vanished', async () => {
    // Amending something that is no longer there must not silently re-create it.
    const target = join(dir, 'gone.json');
    const result = await casWrite(target, '2026-01-01T00:00:00Z', '{"v":1}', probe);
    expect(result.committed).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});

// Windows refuses to rename over a file another handle has open for that
// instant (a reader, antivirus); one un-retried attempt lost the whole write.
describe('renameReplacing — a momentarily busy target on Windows', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cas-rename-')); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  const busy = (code: string) => Object.assign(new Error(code), { code });

  it('on Windows, retries a busy rename and lands the write', async () => {
    const tmp = join(dir, 'a.tmp'); const target = join(dir, 'a.json');
    writeFileSync(tmp, 'new'); writeFileSync(target, 'old');
    const real = fsp.rename.bind(fsp);
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      calls++;
      if (calls <= 2) throw busy(calls === 1 ? 'EPERM' : 'EBUSY');
      return real(a, b);
    });
    await renameReplacing(tmp, target, 'win32');
    expect(calls).toBe(3);
    expect(readFileSync(target, 'utf8')).toBe('new');
  });

  it('on Windows, gives up and throws once the target stays busy', async () => {
    const spy = vi.spyOn(fsp, 'rename').mockRejectedValue(busy('EACCES'));
    await expect(renameReplacing(join(dir, 'x.tmp'), join(dir, 'x.json'), 'win32')).rejects.toMatchObject({ code: 'EACCES' });
    expect(spy.mock.calls.length).toBeGreaterThan(1);
  });

  it('elsewhere, a permission error is real and throws on the first attempt', async () => {
    const spy = vi.spyOn(fsp, 'rename').mockRejectedValue(busy('EACCES'));
    await expect(renameReplacing(join(dir, 'x.tmp'), join(dir, 'x.json'), 'linux')).rejects.toMatchObject({ code: 'EACCES' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
