import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MANIFEST_SUFFIX, manifestPathFor, writeManifest, readManifest, removeManifest,
  markManifestComplete, isManifestComplete, writeBackfillManifest,
} from '../src/main/models/download-manifest';
import type { DownloadManifest, QuantOption } from '../src/shared/model-manager-types';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const quant: QuantOption = {
  quant: 'UD-Q4_K_XL',
  description: 'x',
  files: ['UD-Q4_K_XL/M-UD-Q4_K_XL-00001-of-00002.gguf', 'UD-Q4_K_XL/M-UD-Q4_K_XL-00002-of-00002.gguf'],
  totalSizeBytes: 1234,
  sha256ByFile: {
    'UD-Q4_K_XL/M-UD-Q4_K_XL-00001-of-00002.gguf': 'a'.repeat(64),
    'UD-Q4_K_XL/M-UD-Q4_K_XL-00002-of-00002.gguf': null,
  },
};

describe('download manifest', () => {
  it('is named for the FIRST file basename, beside the download', () => {
    expect(MANIFEST_SUFFIX).toBe('.download.json');
    expect(manifestPathFor(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf'))
      .toBe(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf.download.json'));
  });

  it('round-trips the whole quant option plus the repo', () => {
    writeManifest(dir, 'unsloth/M-GGUF', quant, 1700000000000);
    const got = readManifest(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf');
    expect(got).toEqual({
      v: 1,
      repo: 'unsloth/M-GGUF',
      quant: 'UD-Q4_K_XL',
      files: quant.files,
      totalSizeBytes: 1234,
      sha256ByFile: quant.sha256ByFile,
      startedAt: 1700000000000,
    });
  });

  it('returns null for an absent manifest', () => {
    expect(readManifest(dir, 'nope.gguf')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    fs.writeFileSync(path.join(dir, 'M-Q4_K_M.gguf.download.json'), '{not json');
    expect(readManifest(dir, 'M-Q4_K_M.gguf')).toBeNull();
  });

  it('returns null for a manifest from a future version', () => {
    fs.writeFileSync(path.join(dir, 'M-Q4_K_M.gguf.download.json'), JSON.stringify({ v: 2, repo: 'a/b' }));
    expect(readManifest(dir, 'M-Q4_K_M.gguf')).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    fs.writeFileSync(path.join(dir, 'M-Q4_K_M.gguf.download.json'), JSON.stringify({ v: 1, repo: 'a/b' }));
    expect(readManifest(dir, 'M-Q4_K_M.gguf')).toBeNull();
  });

  it('leaves no .tmp behind after a write', () => {
    writeManifest(dir, 'unsloth/M-GGUF', quant, 1);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('remove is a no-op when there is nothing to remove', () => {
    expect(() => removeManifest(dir, 'nope.gguf')).not.toThrow();
  });
});

// The manifest OUTLIVES the download (2026-09-05). Presence used to mean
// "unfinished"; completedAt is the test now, and these pin it.
describe('a manifest that outlives its download', () => {
  const FIRST = 'M-UD-Q4_K_XL-00001-of-00002.gguf';

  it('a fresh manifest is not complete; stamping it makes it complete', () => {
    writeManifest(dir, 'unsloth/M-GGUF', quant, 1700000000000);
    expect(isManifestComplete(readManifest(dir, FIRST))).toBe(false);

    markManifestComplete(dir, FIRST, 1700000009999);
    const got = readManifest(dir, FIRST);
    expect(got?.completedAt).toBe(1700000009999);
    expect(isManifestComplete(got)).toBe(true);
    // Still on disk — that is the whole point.
    expect(fs.existsSync(manifestPathFor(dir, FIRST))).toBe(true);
  });

  it('stamping keeps every other field, leaves no .tmp, and never re-stamps', () => {
    writeManifest(dir, 'unsloth/M-GGUF', quant, 1700000000000);
    markManifestComplete(dir, FIRST, 111);
    markManifestComplete(dir, FIRST, 222);   // a second scan must not rewrite history
    expect(readManifest(dir, FIRST)).toEqual({
      v: 1,
      repo: 'unsloth/M-GGUF',
      quant: 'UD-Q4_K_XL',
      files: quant.files,
      totalSizeBytes: 1234,
      sha256ByFile: quant.sha256ByFile,
      startedAt: 1700000000000,
      completedAt: 111,
    });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('stamping a manifest that is not there is a no-op, not a throw', () => {
    expect(() => markManifestComplete(dir, 'nope.gguf', 1)).not.toThrow();
    expect(isManifestComplete(null)).toBe(false);
  });

  it('re-downloading the same model KEEPS visionFile and clears completedAt', () => {
    // The finished download, with the projector its repo was found to ship.
    fs.writeFileSync(manifestPathFor(dir, FIRST), JSON.stringify({
      v: 1, repo: 'unsloth/M-GGUF', quant: 'UD-Q4_K_XL', files: quant.files,
      totalSizeBytes: 1234, sha256ByFile: quant.sha256ByFile, startedAt: 1,
      completedAt: 2, visionFile: { path: 'mmproj-F16.gguf', size: 900, sha256: 'b'.repeat(64) },
    }));

    writeManifest(dir, 'unsloth/M-GGUF', quant, 3);   // the user downloads it again

    const got = readManifest(dir, FIRST);
    expect(got?.visionFile).toEqual({ path: 'mmproj-F16.gguf', size: 900, sha256: 'b'.repeat(64) });
    expect(got?.completedAt).toBeUndefined();          // in flight again
    expect(got?.startedAt).toBe(3);
  });

  it('a re-download from a DIFFERENT publisher does NOT inherit the old projector', () => {
    // Byte-identical GGUF filenames are published by many Hugging Face accounts.
    // Carrying the projector across would point Add vision at a path that does
    // not exist in the new repo — or at weights it does not match.
    fs.writeFileSync(manifestPathFor(dir, FIRST), JSON.stringify({
      v: 1, repo: 'unsloth/M-GGUF', quant: 'UD-Q4_K_XL', files: quant.files,
      totalSizeBytes: 1234, sha256ByFile: quant.sha256ByFile, startedAt: 1,
      completedAt: 2, visionFile: { path: 'unsloth-mmproj-F16.gguf', size: 900, sha256: null },
    }));

    writeManifest(dir, 'bartowski/M-GGUF', quant, 3);

    const got = readManifest(dir, FIRST);
    expect(got?.repo).toBe('bartowski/M-GGUF');
    expect(got?.visionFile).toBeUndefined();
  });

  it('round-trips repo: null — §E3 records a failed repo lookup that way', () => {
    fs.writeFileSync(manifestPathFor(dir, FIRST), JSON.stringify({
      v: 1, repo: null, quant: 'Q4_K_M', files: [FIRST],
      totalSizeBytes: 10, sha256ByFile: {}, startedAt: 1, completedAt: 2,
    }));
    const got = readManifest(dir, FIRST);
    expect(got).not.toBeNull();       // NOT rejected — a miss is a real record
    expect(got?.repo).toBeNull();
    expect(isManifestComplete(got)).toBe(true);
  });

  it('still rejects a repo that is neither a name nor null', () => {
    const base = {
      v: 1, quant: 'Q4_K_M', files: [FIRST], totalSizeBytes: 10, sha256ByFile: {}, startedAt: 1,
    };
    for (const repo of ['', 7, {}]) {
      fs.writeFileSync(manifestPathFor(dir, FIRST), JSON.stringify({ ...base, repo }));
      expect(readManifest(dir, FIRST)).toBeNull();
    }
  });

  it('reads a manifest with no completedAt or visionFile — every manifest written before this', () => {
    fs.writeFileSync(manifestPathFor(dir, FIRST), JSON.stringify({
      v: 1, repo: 'a/b', quant: 'Q4_K_M', files: [FIRST],
      totalSizeBytes: 10, sha256ByFile: {}, startedAt: 1,
    }));
    expect(readManifest(dir, FIRST)?.repo).toBe('a/b');
  });

  it('returns null when completedAt or visionFile is the wrong shape', () => {
    const base = {
      v: 1, repo: 'a/b', quant: 'Q4_K_M', files: [FIRST],
      totalSizeBytes: 10, sha256ByFile: {}, startedAt: 1,
    };
    fs.writeFileSync(manifestPathFor(dir, FIRST), JSON.stringify({ ...base, completedAt: 'yes' }));
    expect(readManifest(dir, FIRST)).toBeNull();
    fs.writeFileSync(manifestPathFor(dir, FIRST), JSON.stringify({ ...base, visionFile: { size: 1 } }));
    expect(readManifest(dir, FIRST)).toBeNull();
  });

  // §E3's writer. The lookup behind a backfill takes as long as Hugging Face
  // does, and the user can start a real download of the same filename in that
  // time — so the backfill must never land on top of one.
  it('the backfill writer records a repo we could not find, and refuses to overwrite', () => {
    const record: DownloadManifest = {
      v: 1, repo: null, quant: 'UD-Q4_K_XL', files: [FIRST],
      totalSizeBytes: 10, sha256ByFile: { [FIRST]: null }, startedAt: 5, completedAt: 5,
    };
    expect(writeBackfillManifest(dir, FIRST, record)).toBe(true);
    expect(readManifest(dir, FIRST)).toEqual(record);

    // A real download started while the lookup was out: its manifest wins, and
    // stays UNSTAMPED so its Resume still works.
    fs.rmSync(manifestPathFor(dir, FIRST));
    writeManifest(dir, 'unsloth/M-GGUF', quant, 1700000000000);
    expect(writeBackfillManifest(dir, FIRST, record)).toBe(false);
    expect(readManifest(dir, FIRST)?.repo).toBe('unsloth/M-GGUF');
    expect(readManifest(dir, FIRST)?.completedAt).toBeUndefined();
  });

  // The ONE thing it may replace: an earlier miss of its own. A search can
  // answer 200 and still be wrong, so §E3 dates a miss and asks again later.
  it('replaces its own earlier miss, and nothing else', () => {
    const miss: DownloadManifest = {
      v: 1, repo: null, quant: 'UD-Q4_K_XL', files: [FIRST],
      totalSizeBytes: 10, sha256ByFile: { [FIRST]: null }, startedAt: 5, completedAt: 5,
      repoCheckedAt: 5,
    };
    expect(writeBackfillManifest(dir, FIRST, miss)).toBe(true);
    const found: DownloadManifest = { ...miss, repo: 'unsloth/M-GGUF', repoCheckedAt: undefined };
    expect(writeBackfillManifest(dir, FIRST, found)).toBe(true);
    expect(readManifest(dir, FIRST)?.repo).toBe('unsloth/M-GGUF');

    // …but never a manifest it cannot read. installedModels sweeps those; a
    // blind overwrite here could destroy a download's only record.
    fs.writeFileSync(manifestPathFor(dir, FIRST), '{not json');
    expect(writeBackfillManifest(dir, FIRST, miss)).toBe(false);
    expect(fs.readFileSync(manifestPathFor(dir, FIRST), 'utf8')).toBe('{not json');
  });
});
