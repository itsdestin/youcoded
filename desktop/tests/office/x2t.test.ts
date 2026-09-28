import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { convert, FORMAT, formatFor, killRunningConverters, X2tError } from '../../src/main/office/x2t';

const ROOT = fileURLToPath(new URL('../../office-addon/', import.meta.url));
const MEMO = fileURLToPath(new URL('./fixtures/memo.docx', import.meta.url));
const HAS_ADDON = existsSync(path.join(ROOT, 'manifest.json'));
if (!HAS_ADDON) console.warn('[x2t.test] skipping real-x2t tests: office-addon/manifest.json is missing (run scripts/fetch-office.mjs)');

// WHY a named budget: the first x2t run pays a one-time cost (loading its libraries and the
// font list from a cold disk cache). That belongs here, not inside a test's own timeout.
const X2T_WARMUP_BUDGET_MS = 120_000;

describe('formatFor', () => {
  it('maps the three document kinds case-insensitively and refuses others', () => {
    expect(formatFor('a.DOCX')).toBe(65);
    expect(formatFor('b.xlsx')).toBe(FORMAT.xlsx);
    expect(formatFor('c.pptx')).toBe(FORMAT.pptx);
    expect(formatFor('a.odt')).toBeNull();
    expect(formatFor('a.bin')).toBeNull();
  });
});

describe.skipIf(!HAS_ADDON)('convert with the bundled x2t', () => {
  let dir: string;

  beforeAll(async () => {
    const warm = await mkdtemp(path.join(tmpdir(), 'x2t-warm-'));
    try {
      await convert(ROOT, MEMO, path.join(warm, 'Editor.bin'), FORMAT.bin, warm);
    } finally {
      await rm(warm, { recursive: true, force: true, maxRetries: 3 });
    }
  }, X2T_WARMUP_BUDGET_MS);

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'x2t-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('round-trips a docx through the editor form back to a real docx', async () => {
    const bin = path.join(dir, 'Editor.bin');
    const back = path.join(dir, 'back.docx');
    await convert(ROOT, MEMO, bin, FORMAT.bin, dir);
    await convert(ROOT, bin, back, FORMAT.docx, dir);
    expect((await stat(back)).size).toBeGreaterThan(1024);
  });

  it('leaves no job folders behind in the temp base', async () => {
    await convert(ROOT, MEMO, path.join(dir, 'Editor.bin'), FORMAT.bin, dir);
    expect((await readdir(dir)).filter((n) => n.startsWith('job-'))).toEqual([]);
  });

  it('rejects with X2tError when the input file does not exist', async () => {
    await expect(convert(ROOT, path.join(dir, 'missing.docx'), path.join(dir, 'Editor.bin'), FORMAT.bin, dir)).rejects.toBeInstanceOf(
      X2tError,
    );
    expect((await readdir(dir)).filter((n) => n.startsWith('job-'))).toEqual([]);
  });

  it('handles a folder name containing XML special characters', async () => {
    const odd = await mkdtemp(path.join(dir, 'Tom & <Jerry> "q"-'));
    const bin = path.join(odd, 'Editor.bin');
    await convert(ROOT, MEMO, bin, FORMAT.bin, dir);
    expect((await stat(bin)).size).toBeGreaterThan(0);
  });
});

describe('convert when its temp base is gone', () => {
  it('rejects without recreating a removed temp base', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'x2t-gone-'));
    try {
      const gone = path.join(parent, 'base');
      await expect(convert('/unused', '/unused/in.docx', path.join(parent, 'Editor.bin'), FORMAT.bin, gone)).rejects.toThrow();
      expect(existsSync(gone)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

// A stand-in converter: a tiny shell script at <root>/converter/x2t. POSIX only (it is a
// shell script); it lets the failure shapes be tested without the real x2t.
describe.skipIf(process.platform === 'win32')('convert failure shapes with a stand-in converter', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'x2t-fake-'));
    await mkdir(path.join(root, 'converter'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  async function fakeX2t(script: string) {
    const bin = path.join(root, 'converter', 'x2t');
    await writeFile(bin, `#!/bin/sh\n${script}\n`);
    await chmod(bin, 0o755);
  }

  it('reports output overflowing its buffer as its own failure, not a timeout', async () => {
    await fakeX2t('head -c 70000000 /dev/zero');
    const err = await convert(root, '/in.docx', path.join(root, 'out.bin'), FORMAT.bin, root).catch((e) => e);
    expect(err).toBeInstanceOf(X2tError);
    expect((err as X2tError).code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  });

  it('stops a running converter at quit and reports it as stopped', async () => {
    await fakeX2t('echo started; exec sleep 30');
    const pending = convert(root, '/in.docx', path.join(root, 'out.bin'), FORMAT.bin, root).catch((e) => e);
    // Wait for the child to exist (positive signal) before stopping it.
    await vi.waitFor(() => expect(killRunningConverters()).toBeGreaterThan(0));
    const err = await pending;
    expect(err).toBeInstanceOf(X2tError);
    expect((err as X2tError).code).toBe('stopped');
  });
});
