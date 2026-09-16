import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanGgufCache, scanLocalDownloads, isComplete, ggufIdFromFileName } from '../src/main/engine/cache-scan';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-cache-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function touch(name: string, bytes = 8) {
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes));
}

describe('scanGgufCache', () => {
  it('lists .gguf files with ids derived from filenames', () => {
    touch('Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf', 16);
    touch('notes.txt');
    const models = scanGgufCache(dir);
    expect(models).toEqual([
      { id: 'Qwen3-4B-Instruct-2507-UD-Q4_K_XL', sizeBytes: 16, loaded: false, state: 'unloaded' },
    ]);
  });

  it('collapses multi-part sets to ONE entry keyed by the first part, summing sizes', () => {
    touch('Big-Model-UD-Q4_K_XL-00001-of-00002.gguf', 10);
    touch('Big-Model-UD-Q4_K_XL-00002-of-00002.gguf', 20);
    const models = scanGgufCache(dir);
    expect(models).toEqual([
      { id: 'Big-Model-UD-Q4_K_XL-00001-of-00002', sizeBytes: 30, loaded: false, state: 'unloaded' },
    ]);
  });

  it('returns [] for a missing directory', () => {
    expect(scanGgufCache(path.join(dir, 'nope'))).toEqual([]);
  });

  it('ggufIdFromFileName strips the extension only (router ids are filename-based)', () => {
    expect(ggufIdFromFileName('foo-Q4_K_M.gguf')).toBe('foo-Q4_K_M');
  });
});

// Unfinished-download surfacing (2026-08-27): a .partial left by a previous app
// run is invisible to scanGgufCache AND to the in-memory downloader — this scan
// is the UI's only way to find it, and it is the SAME scan scanGgufCache filters,
// so the two lists can never disagree (models:installed).

describe('scanLocalDownloads', () => {
  it('counts a complete split set as complete', () => {
    touch('Big-UD-Q4_K_XL-00001-of-00002.gguf', 10);
    touch('Big-UD-Q4_K_XL-00002-of-00002.gguf', 20);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'Big-UD-Q4_K_XL-00001-of-00002',
      firstFileName: 'Big-UD-Q4_K_XL-00001-of-00002.gguf',
      partsDeclared: 2, partsPresent: 2, bytesPublished: 30, bytesPartial: 0,
      hasPartial: false, hasManifest: false,
    });
    expect(isComplete(d)).toBe(true);
  });

  it('a split set missing parts is NOT complete, and reports partial bytes separately', () => {
    // Destin's 2026-08-26 case in miniature: parts 1-2 published, part 3 half-written.
    touch('Big-UD-Q4_K_XL-00001-of-00004.gguf', 10);
    touch('Big-UD-Q4_K_XL-00002-of-00004.gguf', 20);
    touch('Big-UD-Q4_K_XL-00003-of-00004.gguf.partial', 5);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'Big-UD-Q4_K_XL-00001-of-00004',
      partsDeclared: 4, partsPresent: 2, bytesPublished: 30, bytesPartial: 5, hasPartial: true,
    });
    expect(isComplete(d)).toBe(false);
  });

  it('reports a download with ONLY a .partial and no published file', () => {
    touch('Solo-Q4_K_M.gguf.partial', 7);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'Solo-Q4_K_M', firstFileName: 'Solo-Q4_K_M.gguf',
      partsDeclared: 1, partsPresent: 0, bytesPublished: 0, bytesPartial: 7, hasPartial: true,
    });
    expect(isComplete(d)).toBe(false);
  });

  it('a manifest ALONE is a download — one that stopped before its first byte', () => {
    // The manifest is written before any fetch (model-downloader.ts start()).
    // Without this row a download that failed on its first request would be
    // invisible, unresumable, and its manifest would never be cleaned up.
    touch('New-UD-Q4_K_XL-00001-of-00003.gguf.download.json', 100);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'New-UD-Q4_K_XL-00001-of-00003', firstFileName: 'New-UD-Q4_K_XL-00001-of-00003.gguf',
      partsDeclared: 3, partsPresent: 0, bytesPublished: 0, bytesPartial: 0,
      hasPartial: false, hasManifest: true,
    });
    expect(isComplete(d)).toBe(false);
  });

  it('a manifest beside its published parts is the SAME download, not a second one', () => {
    touch('M-Q4_K_M.gguf', 5);
    touch('M-Q4_K_M.gguf.download.json', 100);
    touch('notes.txt', 100);
    const downloads = scanLocalDownloads(dir);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({ bytesPublished: 5, hasManifest: true });
  });

  it('a complete set with a stray .partial is still complete', () => {
    // Publication is an atomic rename, so this should not happen — but if it
    // does, a stray file must not demote a working model (spec §3.2).
    touch('Big-UD-Q4_K_XL-00001-of-00002.gguf', 10);
    touch('Big-UD-Q4_K_XL-00002-of-00002.gguf', 20);
    touch('Big-UD-Q4_K_XL-00002-of-00002.gguf.partial', 3);
    const [d] = scanLocalDownloads(dir);
    expect(isComplete(d)).toBe(true);
    expect(d.bytesPublished).toBe(30);
  });

  it('returns [] for a missing directory', () => {
    expect(scanLocalDownloads(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('scanGgufCache is scanLocalDownloads filtered to complete sets', () => {
  it('omits an incomplete split model entirely — the picker must never offer it', () => {
    touch('Whole-Q4_K_M.gguf', 5);
    touch('Half-UD-Q4_K_XL-00001-of-00004.gguf', 10);
    touch('Half-UD-Q4_K_XL-00003-of-00004.gguf.partial', 5);
    touch('New-Q4_K_M.gguf.download.json', 50);
    expect(scanGgufCache(dir).map((m) => m.id)).toEqual(['Whole-Q4_K_M']);
  });

  it('a complete set reports published bytes only', () => {
    touch('Big-UD-Q4_K_XL-00001-of-00002.gguf', 10);
    touch('Big-UD-Q4_K_XL-00002-of-00002.gguf', 20);
    touch('Big-UD-Q4_K_XL-00002-of-00002.gguf.partial', 3);
    expect(scanGgufCache(dir)).toEqual([
      { id: 'Big-UD-Q4_K_XL-00001-of-00002', sizeBytes: 30, loaded: false, state: 'unloaded' },
    ]);
  });
});

// ── Vision models live in a folder of their own (design §E2) ────────────────
// llama-server only pairs a model with its `mmproj*.gguf` when the two sit
// together in ONE subdirectory of --models-dir, and it then names that model by
// the FOLDER. Every claim below was probed against the pinned b10665 on
// 2026-09-05 before it was written down; the scan has to agree with the router
// about what exists and what it is called, or the app offers models the engine
// will not serve (the 2026-08-16 class of bug).

function touchIn(sub: string, name: string, bytes = 8) {
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, sub, name), Buffer.alloc(bytes));
}

describe('scanLocalDownloads — one level of folders', () => {
  it('a model folder is ONE download, and the projector is NOT one of its parts', () => {
    touchIn('V-Q4_K_M', 'V-Q4_K_M.gguf', 10);
    touchIn('V-Q4_K_M', 'mmproj-F16.gguf', 4);
    touchIn('V-Q4_K_M', 'V-Q4_K_M.gguf.download.json', 100);
    const downloads = scanLocalDownloads(dir);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toEqual({
      modelId: 'V-Q4_K_M',
      firstFileName: 'V-Q4_K_M.gguf',
      subdir: 'V-Q4_K_M',
      // 1, not 2: counting the projector as a published part is what would let
      // a half-arrived model read as complete.
      partsDeclared: 1, partsPresent: 1,
      // 10, not 14: bytesPublished stays the model's own weights, which is what
      // the engine-off model list reports as a model's size.
      bytesPublished: 10, bytesPartial: 0,
      hasPartial: false, hasManifest: true,
      hasProjector: true, visionBytes: 4,
    });
    expect(isComplete(downloads[0])).toBe(true);
  });

  it('the id is the FOLDER name, not the file inside it', () => {
    // Probed: a cache dir holding `weird-folder/C-Q8_0.gguf` served the model
    // under the id `weird-folder`. Deriving the id from the filename here would
    // hand the app an id GET /models does not answer to.
    touchIn('Weird-Name', 'C-Q8_0.gguf', 9);
    const [d] = scanLocalDownloads(dir);
    expect(d.modelId).toBe('Weird-Name');
    expect(d.firstFileName).toBe('C-Q8_0.gguf');
  });

  it('a split set inside a folder is ONE model, named by the folder', () => {
    touchIn('S-Q8_0-00001-of-00002', 'S-Q8_0-00001-of-00002.gguf', 10);
    touchIn('S-Q8_0-00001-of-00002', 'S-Q8_0-00002-of-00002.gguf', 20);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'S-Q8_0-00001-of-00002', subdir: 'S-Q8_0-00001-of-00002',
      partsDeclared: 2, partsPresent: 2, bytesPublished: 30,
    });
    expect(isComplete(d)).toBe(true);
  });

  it('TWO levels deep is not a model — the router does not look there either', () => {
    // Probed: `deep/inner/B-Q8_0.gguf` was absent from GET /models entirely.
    // Listing it here would offer a row that can never load.
    touchIn(path.join('deep', 'inner'), 'B-Q8_0.gguf', 10);
    expect(scanLocalDownloads(dir)).toEqual([]);
  });

  it('a projector still arriving is in-flight bytes of the same download', () => {
    // The second leg of one job: the weights are published and the model works,
    // so the SET is complete, but the folder is not finished downloading.
    touchIn('V-Q4_K_M', 'V-Q4_K_M.gguf', 10);
    touchIn('V-Q4_K_M', 'mmproj-F16.gguf.partial', 7);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'V-Q4_K_M', partsPresent: 1, bytesPublished: 10,
      hasProjector: false, visionBytes: 0, bytesPartial: 7, hasPartial: true,
    });
    expect(isComplete(d)).toBe(true);
  });

  it('a projector sitting FLAT is not a model row of its own', () => {
    // Real repos ship names like `gemma-3-12b-it.mmproj-f16.gguf`, which the
    // quant grammar would happily read as a model called `gemma-3-12b-it`.
    touch('Flat-Q4_K_M.gguf', 5);
    touch('gemma-3-12b-it.mmproj-f16.gguf', 900);
    expect(scanLocalDownloads(dir).map((d) => d.modelId)).toEqual(['Flat-Q4_K_M']);
  });

  it('a folder holding ONLY a projector is still a row — or it can never be deleted', () => {
    // The leftover of a download whose weights were removed, or of a move that
    // stopped half way. It can be gigabytes, and a row that is never listed is
    // also a row the user has no way to get rid of. Never complete, so it is
    // never offered as a model.
    touchIn('Orphan-Q4_K_M', 'mmproj-F16.gguf', 900);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'Orphan-Q4_K_M', subdir: 'Orphan-Q4_K_M',
      partsDeclared: 1, partsPresent: 0, bytesPublished: 0,
      hasProjector: true, visionBytes: 900,
    });
    expect(isComplete(d)).toBe(false);
    expect(scanGgufCache(dir)).toEqual([]);
  });

  it('a folder with no GGUFs at all is not a row', () => {
    // The other half of the rule above: "empty folder" must stay invisible, or
    // any stray directory in the cache dir becomes a phantom model.
    touchIn('NotAModel', 'readme.txt', 10);
    fs.mkdirSync(path.join(dir, 'Empty'), { recursive: true });
    expect(scanLocalDownloads(dir)).toEqual([]);
  });

  it('a flat model and a folder model are listed side by side', () => {
    touch('Flat-Q4_K_M.gguf', 5);
    touchIn('V-Q4_K_M', 'V-Q4_K_M.gguf', 10);
    touchIn('V-Q4_K_M', 'mmproj-F16.gguf', 4);
    expect(scanGgufCache(dir)).toEqual([
      { id: 'Flat-Q4_K_M', sizeBytes: 5, loaded: false, state: 'unloaded' },
      { id: 'V-Q4_K_M', sizeBytes: 10, loaded: false, state: 'unloaded' },
    ]);
  });
});
