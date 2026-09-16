// §E3 — the backfill that gives a model downloaded BEFORE this feature a record
// of where it came from. Nothing here is invented: the filenames are the six
// models actually sitting in this machine's ~/.cache/llama.cpp, the curated rows
// are the real shipped list, and the byte counts and publisher pairs in the
// identity tests were measured against the live Hugging Face API on 2026-09-05.
//
// The hashes ARE REAL — computed here over the fixture files with node's own
// crypto, exactly as the shipping code computes them. Handing the fake lookups a
// made-up oid would make every identity test pass for the wrong reason.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager } from '../src/main/engine/engine-manager';
import { updateEngineConfig } from '../src/main/engine/engine-config';
import { ManifestBackfill, curatedRepoStem, isStaleBackfillMiss } from '../src/main/models/manifest-backfill';
import type { BackfillCandidate, BackfillLookups } from '../src/main/models/manifest-backfill';
import { SHIPPED_CURATED } from '../src/main/models/curated-models';
import { parseGgufName } from '../src/main/models/quant-parser';
import { readManifest, manifestPathFor } from '../src/main/models/download-manifest';
import type { CuratedModel, DownloadManifest, QuantOption } from '../src/shared/model-manager-types';

let root: string;
let dir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  dir = path.join(root, 'cache');
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const MMPROJ = { path: 'mmproj-F16.gguf', size: 900, sha256: null };

function option(o: {
  quant: string; files: string[]; totalSizeBytes: number;
  sha256?: string | null; visionFile?: typeof MMPROJ;
}): QuantOption {
  const { sha256 = null, ...rest } = o;
  return {
    description: '',
    // Only the FIRST file's hash is ever read — that is the part on disk the
    // backfill hashes. The rest are null, as Hugging Face leaves them when a
    // file is not stored in LFS.
    sha256ByFile: Object.fromEntries(o.files.map((f, i) => [f, i === 0 ? sha256 : null])),
    ...rest,
  };
}

/** Plant a published .gguf and return the candidate row the cache scan would
 *  produce for it. `fill` makes two files of the SAME SIZE differ in content,
 *  which is the whole point of the identity tests. */
function plant(fileName: string, bytes: number, fill = 0, parts = 1): BackfillCandidate {
  fs.writeFileSync(path.join(dir, fileName), Buffer.alloc(bytes, fill));
  return { dir, firstFileName: fileName, parts, bytesPublished: bytes };
}

/** The real SHA-256 of a planted file — what the shipping code will compute. */
function hashOnDisk(fileName: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, fileName))).digest('hex');
}

interface Spec {
  curated?: CuratedModel[];
  /** Repos the one search returns, most-downloaded first. */
  hits?: string[];
  trees?: Record<string, QuantOption[]>;
  /** The search fails the way an offline machine or a rate limit fails it. */
  searchFails?: boolean;
  /** Listing THESE repos fails — a lookup that could not finish, mid-pass. */
  treeFails?: string[];
  /** Every lookup blocks on this before answering. */
  gate?: Promise<unknown>;
  now?: number;
}

/** Answers to the questions the backfill asks, with a full call record.
 *  `maxConcurrent` is what proves the pass is sequential: each answer marks
 *  itself in flight, yields, and only then unmarks, so two overlapping lookups
 *  are visible even though neither blocks. */
function fakeLookups(spec: Spec) {
  const calls = { curated: 0, search: [] as string[], trees: [] as string[], maxConcurrent: 0 };
  let live = 0;
  const answer = async <T>(produce: () => T): Promise<T> => {
    live += 1;
    calls.maxConcurrent = Math.max(calls.maxConcurrent, live);
    try {
      await (spec.gate ?? Promise.resolve());
      return produce();
    } finally {
      live -= 1;
    }
  };
  const look: BackfillLookups = {
    curated: async () => { calls.curated += 1; return answer(() => spec.curated ?? []); },
    search: async (q) => {
      calls.search.push(q);
      return answer(() => {
        if (spec.searchFails) throw new Error('Hugging Face search is not reachable right now — try again in a moment.');
        return (spec.hits ?? []).map((repo, i) => ({ repo, downloads: 1000 - i, likes: 0 }));
      });
    },
    quantOptions: async (repo) => {
      calls.trees.push(repo);
      return answer(() => {
        if (spec.treeFails?.includes(repo)) throw new Error("Could not list this model's files on Hugging Face — try again in a moment.");
        return spec.trees?.[repo] ?? [];
      });
    },
    now: () => spec.now ?? 1_700_000_000_000,
  };
  return { look, calls };
}

async function runPass(look: BackfillLookups, candidates: BackfillCandidate[]): Promise<void> {
  const backfill = new ManifestBackfill(look);
  backfill.kick(candidates);
  await backfill.whenIdle();
}

describe('manifest backfill — a wrong publisher is impossible', () => {
  // The pair that disproved a size-based rule, live on 2026-09-05: ggml-org and
  // lmstudio-community both publish 'gemma-4-E2B-it-Q8_0.gguf' at the IDENTICAL
  // 4,967,497,152 bytes, with different content and different projectors. Every
  // cheap test — quant, part count, filename, size — passes for BOTH.
  const SHARED_SIZE = 4_967_497_152;
  const GGML = 'ggml-org/gemma-4-E2B-it-GGUF';
  const LMSTUDIO = 'lmstudio-community/gemma-4-E2B-it-GGUF';
  const FILE = 'gemma-4-E2B-it-Q8_0.gguf';

  /** The two repos' listings, given which content the user actually has. */
  function bothPublishers(mine: string, theirs: string) {
    return {
      [GGML]: [option({ quant: 'Q8_0', files: [FILE], totalSizeBytes: SHARED_SIZE, sha256: mine, visionFile: MMPROJ })],
      [LMSTUDIO]: [option({ quant: 'Q8_0', files: [FILE], totalSizeBytes: SHARED_SIZE, sha256: theirs, visionFile: { path: 'mmproj-F16.gguf', size: 986_833_248, sha256: null } })],
    };
  }

  it('picks the account whose bytes these ARE, not the one the search listed first', async () => {
    const c = plant(FILE, 64, 0xa1);
    c.bytesPublished = SHARED_SIZE;              // the real file is 5 GB; only its size matters
    const mine = hashOnDisk(FILE);
    const theirs = crypto.createHash('sha256').update(Buffer.alloc(64, 0xb2)).digest('hex');
    const { look } = fakeLookups({
      // lmstudio-community is listed FIRST and ggml-org second, so a rule that
      // took the first survivor would take the wrong one.
      hits: [LMSTUDIO, GGML],
      trees: bothPublishers(mine, theirs),
    });
    await runPass(look, [c]);

    const got = readManifest(dir, FILE);
    expect(got?.repo).toBe(GGML);
    // …and therefore Add vision fetches ggml-org's projector, not the 986,833,248
    // byte one, which would verify fine against lmstudio's own hash.
    expect(got?.visionFile).toEqual(MMPROJ);
  });

  it('writes NO repo when the true publisher is not among the results at all', async () => {
    // The user has ggml-org's copy, but only lmstudio-community comes back —
    // the exact shape of the live defect: same filename, same byte count, every
    // cheap test passes, and the two-survivor refusal never fires because there
    // is only one survivor.
    const c = plant(FILE, 64, 0xa1);
    c.bytesPublished = SHARED_SIZE;
    const theirs = crypto.createHash('sha256').update(Buffer.alloc(64, 0xb2)).digest('hex');
    const { look, calls } = fakeLookups({
      hits: [LMSTUDIO],
      trees: bothPublishers(hashOnDisk(FILE), theirs),
    });
    await runPass(look, [c]);

    expect(calls.trees).toEqual([LMSTUDIO]);
    expect(readManifest(dir, FILE)?.repo).toBeNull();
    expect(readManifest(dir, FILE)?.visionFile).toBeUndefined();
  });

  it('writes NO repo when two accounts publish byte-identical copies', async () => {
    // Genuine mirrors. The weights are the same file, but their projectors need
    // not be, and choosing between them would be a guess.
    const c = plant(FILE, 64, 0xa1);
    c.bytesPublished = SHARED_SIZE;
    const mine = hashOnDisk(FILE);
    const { look } = fakeLookups({ hits: [LMSTUDIO, GGML], trees: bothPublishers(mine, mine) });
    await runPass(look, [c]);
    expect(readManifest(dir, FILE)?.repo).toBeNull();
  });

  it('refuses a repo that states no hash for its file', async () => {
    // Hugging Face omits `lfs.oid` for a file it does not store in LFS. A repo
    // that will not say what its bytes are cannot prove it holds these ones.
    const c = plant(FILE, 64, 0xa1);
    const { look } = fakeLookups({
      hits: [GGML],
      trees: { [GGML]: [option({ quant: 'Q8_0', files: [FILE], totalSizeBytes: 64, sha256: null, visionFile: MMPROJ })] },
    });
    await runPass(look, [c]);
    expect(readManifest(dir, FILE)?.repo).toBeNull();
  });
});

describe('manifest backfill — the cheap filters, before anything is read', () => {
  it('reads a curated repo down to the stem its own files carry', () => {
    expect(curatedRepoStem('unsloth/gemma-4-12b-it-GGUF')).toBe('gemma-4-12b-it');
    expect(curatedRepoStem('unsloth/Qwen3.5-122B-A10B-GGUF')).toBe('Qwen3.5-122B-A10B');
    // Against the REAL shipped list, the two facts the curated match is built
    // on: no stem may keep the '-GGUF' suffix (a stem that did would never
    // equal a filename's), and every stem must be exactly what parseGgufName
    // reads back out of that repo's own default-quant filename.
    for (const m of SHIPPED_CURATED) {
      const stem = curatedRepoStem(m.hfRepo);
      expect(stem, m.hfRepo).not.toMatch(/-GGUF$/i);
      expect(parseGgufName(`${stem}-${m.quantDefault}.gguf`)?.base, m.hfRepo).toBe(stem);
      expect(parseGgufName(`${stem}-${m.quantDefault}.gguf`)?.quant, m.hfRepo).toBe(m.quantDefault);
    }
  });

  it('a curated model PROVED to come from its listed repo resolves with no search', async () => {
    // A real row of the shipped list — 'gemma4-12b' — at the exact filename its
    // repo publishes that default quant under.
    const c = plant('gemma-4-12b-it-UD-Q4_K_XL.gguf', 120);
    const { look, calls } = fakeLookups({
      curated: SHIPPED_CURATED,
      // Any search at all is a failure here, loudly: nothing should reach this.
      searchFails: true,
      trees: {
        'unsloth/gemma-4-12b-it-GGUF': [option({
          quant: 'UD-Q4_K_XL', files: ['gemma-4-12b-it-UD-Q4_K_XL.gguf'], totalSizeBytes: 120,
          sha256: hashOnDisk('gemma-4-12b-it-UD-Q4_K_XL.gguf'), visionFile: MMPROJ,
        })],
      },
    });
    await runPass(look, [c]);

    expect(calls.search).toEqual([]);
    expect(calls.trees).toEqual(['unsloth/gemma-4-12b-it-GGUF']);
    const got = readManifest(dir, c.firstFileName);
    expect(got?.repo).toBe('unsloth/gemma-4-12b-it-GGUF');
    expect(got?.quant).toBe('UD-Q4_K_XL');
    expect(got?.visionFile).toEqual(MMPROJ);
    expect(got?.repoCheckedAt).toBeUndefined();   // settled; nothing to re-ask
    // completedAt is the weights' own mtime — when the download really landed —
    // not the clock at backfill time.
    expect(got?.completedAt).toBe(Math.round(fs.statSync(path.join(dir, c.firstFileName)).mtimeMs));
    expect(got?.completedAt).not.toBe(1_700_000_000_000);
  });

  it('a curated repo that is only PLAUSIBLE is arbitrated by the search, not written', async () => {
    // The curated list names unsloth for this filename, and unsloth's copy passes
    // every cheap test — but the bytes are someone else's. The curated shortcut
    // must not short-circuit that, or the whole hash rule has a hole in it where
    // the shipped list happens to have an entry.
    const file = 'gemma-4-12b-it-UD-Q4_K_XL.gguf';
    const c = plant(file, 120, 0xc3);
    const notMine = crypto.createHash('sha256').update(Buffer.alloc(120, 0xd4)).digest('hex');
    const { look, calls } = fakeLookups({
      curated: SHIPPED_CURATED,
      hits: ['someone-else/gemma-4-12b-it-GGUF'],
      trees: {
        'unsloth/gemma-4-12b-it-GGUF': [option({ quant: 'UD-Q4_K_XL', files: [file], totalSizeBytes: 120, sha256: notMine, visionFile: MMPROJ })],
        'someone-else/gemma-4-12b-it-GGUF': [option({ quant: 'UD-Q4_K_XL', files: [file], totalSizeBytes: 120, sha256: hashOnDisk(file), visionFile: MMPROJ })],
      },
    });
    await runPass(look, [c]);

    expect(calls.search).toEqual(['gemma-4-12b-it']);
    expect(readManifest(dir, file)?.repo).toBe('someone-else/gemma-4-12b-it-GGUF');
  });

  it('a model the curated list does not name falls through to exactly ONE search', async () => {
    // Really on this machine. The shipped list DOES carry Qwen3.5 2B — but at
    // UD-Q4_K_XL, and this copy is Q8_0, so the curated match does not fire.
    const c = plant('Qwen3.5-2B-Q8_0.gguf', 240);
    const { look, calls } = fakeLookups({
      curated: SHIPPED_CURATED,
      hits: ['unsloth/Qwen3.5-2B-GGUF'],
      trees: {
        'unsloth/Qwen3.5-2B-GGUF': [option({
          quant: 'Q8_0', files: ['Qwen3.5-2B-Q8_0.gguf'], totalSizeBytes: 240,
          sha256: hashOnDisk('Qwen3.5-2B-Q8_0.gguf'), visionFile: MMPROJ,
        })],
      },
    });
    await runPass(look, [c]);

    expect(calls.search).toEqual(['Qwen3.5-2B']);
    expect(readManifest(dir, c.firstFileName)?.repo).toBe('unsloth/Qwen3.5-2B-GGUF');
  });

  it('matches the quant string WHOLE — never as a substring of another', async () => {
    const c = plant('Qwen3.8-27B-Q8_0.gguf', 300);
    const { look } = fakeLookups({
      hits: ['x/Qwen3.8-27B-GGUF'],
      trees: {
        // 'Q8_0' is a substring of neither of these, and neither is a substring
        // of it — but a loose comparison (startsWith, includes, strip the UD-)
        // would let one through, and each is a genuinely different file.
        'x/Qwen3.8-27B-GGUF': [
          option({ quant: 'UD-Q8_K_XL', files: ['Qwen3.8-27B-Q8_0.gguf'], totalSizeBytes: 300, sha256: hashOnDisk('Qwen3.8-27B-Q8_0.gguf') }),
          option({ quant: 'Q8_0_L', files: ['Qwen3.8-27B-Q8_0.gguf'], totalSizeBytes: 300, sha256: hashOnDisk('Qwen3.8-27B-Q8_0.gguf') }),
        ],
      },
    });
    await runPass(look, [c]);
    expect(readManifest(dir, c.firstFileName)?.repo).toBeNull();
  });

  it('a repo that calls the file something else is refused, however right the rest looks', async () => {
    const c = plant('Qwen3.5-9B-Q8_0.gguf', 500);
    const { look } = fakeLookups({
      hits: ['someone/Qwen3.5-9B-GGUF'],
      trees: {
        // Right quant, right size, right hash — and still refused, because this
        // is not the file the user has; the repo renamed it.
        'someone/Qwen3.5-9B-GGUF': [option({
          quant: 'Q8_0', files: ['Qwen3.5-9B-instruct-Q8_0.gguf'], totalSizeBytes: 500,
          sha256: hashOnDisk('Qwen3.5-9B-Q8_0.gguf'),
        })],
      },
    });
    await runPass(look, [c]);
    expect(readManifest(dir, c.firstFileName)?.repo).toBeNull();
  });

  it('a repo offering this quant as a different NUMBER of parts is refused', async () => {
    const c = plant('Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf', 400, 0, 4);
    const { look } = fakeLookups({
      hits: ['x/Qwen3.8-Flash-Next-GGUF'],
      trees: {
        // Deliberately identical on every other test — same first filename, same
        // total size, same hash — so ONLY the part count can refuse it.
        'x/Qwen3.8-Flash-Next-GGUF': [option({
          quant: 'UD-Q4_K_XL',
          files: [
            'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf',
            'Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00004.gguf',
            'Qwen3.8-Flash-Next-UD-Q4_K_XL-00003-of-00004.gguf',
          ],
          totalSizeBytes: 400,
          sha256: hashOnDisk('Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf'),
        })],
      },
    });
    await runPass(look, [c]);
    expect(readManifest(dir, c.firstFileName)?.repo).toBeNull();
  });

  it('never reads the file for a candidate whose size rules it out', async () => {
    // The size gate exists to avoid a multi-gigabyte read, so the only way to
    // see it work is to make reading IMPOSSIBLE: the file is gone. If a
    // hopeless candidate is hashed anyway the read throws, which is a lookup
    // that could not finish — nothing is written and the model is retried
    // forever. With the gate, the answer is a clean, determinate miss.
    const c = plant('Qwen3.5-2B-Q8_0.gguf', 240);
    fs.rmSync(path.join(dir, c.firstFileName));
    const { look } = fakeLookups({
      hits: ['x/Qwen3.5-2B-GGUF'],
      trees: { 'x/Qwen3.5-2B-GGUF': [option({ quant: 'Q8_0', files: ['Qwen3.5-2B-Q8_0.gguf'], totalSizeBytes: 999_999, sha256: 'a'.repeat(64) })] },
    });
    await runPass(look, [c]);
    expect(readManifest(dir, c.firstFileName)).toMatchObject({ repo: null, quant: 'Q8_0' });
  });

  it('a split set that resolves to nothing still records every part', async () => {
    const c = plant('Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf', 400, 0, 4);
    const { look, calls } = fakeLookups({ hits: [] });
    await runPass(look, [c]);

    expect(calls.search).toEqual(['Qwen3.8-Flash-Next']);
    expect(readManifest(dir, c.firstFileName)).toMatchObject({
      repo: null,
      quant: 'UD-Q4_K_XL',
      totalSizeBytes: 400,
      files: [
        'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf',
        'Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00004.gguf',
        'Qwen3.8-Flash-Next-UD-Q4_K_XL-00003-of-00004.gguf',
        'Qwen3.8-Flash-Next-UD-Q4_K_XL-00004-of-00004.gguf',
      ],
    });
  });

  it('leaves a filename it cannot read a quant out of completely alone', async () => {
    // No quant, so nothing honest can be written — a manifest needs the exact
    // string Hugging Face uses. Not even looked up.
    const c = plant('some-random-download.gguf', 50);
    const { look, calls } = fakeLookups({ curated: SHIPPED_CURATED, hits: ['a/b'] });
    await runPass(look, [c]);

    expect(calls.curated).toBe(0);
    expect(calls.search).toEqual([]);
    expect(fs.existsSync(manifestPathFor(dir, c.firstFileName))).toBe(false);
  });
});

describe('manifest backfill — what is permanent and what is retried', () => {
  it('a search that FAILS writes nothing at all, and the next app run tries again', async () => {
    // Destin's own pre-feature download, and the case §E3 exists for.
    const c = plant('gemma-4-E2B-it-Q8_0.gguf', 80);

    const offline = fakeLookups({ curated: SHIPPED_CURATED, searchFails: true });
    await runPass(offline.look, [c]);
    expect(offline.calls.search).toEqual(['gemma-4-E2B-it']);
    // NOT a miss: a manifest here would be the "we looked and could not find it"
    // record, written on the strength of a network failure.
    expect(fs.existsSync(manifestPathFor(dir, c.firstFileName))).toBe(false);
    expect(readManifest(dir, c.firstFileName)).toBeNull();

    // A new app run — a new ManifestBackfill — with Hugging Face reachable.
    const online = fakeLookups({
      curated: SHIPPED_CURATED,
      hits: ['unsloth/gemma-4-E2B-it-GGUF'],
      trees: {
        'unsloth/gemma-4-E2B-it-GGUF': [option({
          quant: 'Q8_0', files: ['gemma-4-E2B-it-Q8_0.gguf'], totalSizeBytes: 80,
          sha256: hashOnDisk('gemma-4-E2B-it-Q8_0.gguf'), visionFile: MMPROJ,
        })],
      },
    });
    await runPass(online.look, [c]);
    expect(readManifest(dir, c.firstFileName)?.repo).toBe('unsloth/gemma-4-E2B-it-GGUF');
    expect(readManifest(dir, c.firstFileName)?.visionFile).toEqual(MMPROJ);
  });

  it('a repo listing that fails mid-pass abandons that model rather than calling it a miss', async () => {
    const c = plant('gpt-oss-20b-MXFP4.gguf', 300);
    const { look } = fakeLookups({
      hits: ['unsloth/gpt-oss-20b-GGUF', 'other/gpt-oss-20b-GGUF'],
      treeFails: ['other/gpt-oss-20b-GGUF'],
      trees: {
        'unsloth/gpt-oss-20b-GGUF': [option({
          quant: 'MXFP4', files: ['gpt-oss-20b-MXFP4.gguf'], totalSizeBytes: 300,
          sha256: hashOnDisk('gpt-oss-20b-MXFP4.gguf'),
        })],
      },
    });
    await runPass(look, [c]);
    // One repo DID prove it holds these bytes — but the second could not be
    // checked, so a byte-identical rival cannot be ruled out. Writing either
    // answer would be a guess.
    expect(readManifest(dir, c.firstFileName)).toBeNull();
  });

  it('a failed lookup is not retried for the rest of the app run', async () => {
    const c = plant('Qwen3.5-2B-Q8_0.gguf', 240);
    const { look, calls } = fakeLookups({ searchFails: true });
    const backfill = new ManifestBackfill(look);
    backfill.kick([c]);
    await backfill.whenIdle();
    // The Local Models screen re-opening must not re-run a lookup that just
    // failed — that would hammer Hugging Face once per render.
    backfill.kick([c]);
    await backfill.whenIdle();
    expect(calls.search).toEqual(['Qwen3.5-2B']);
  });

  it('dates a successful miss, and calls it stale only after a month', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const miss: DownloadManifest = {
      v: 1, repo: null, quant: 'Q8_0', files: ['M-Q8_0.gguf'], totalSizeBytes: 10,
      sha256ByFile: {}, startedAt: 1, completedAt: 1, repoCheckedAt: 1_000 * DAY,
    };
    expect(isStaleBackfillMiss(miss, 1_000 * DAY + 29 * DAY)).toBe(false);
    expect(isStaleBackfillMiss(miss, 1_000 * DAY + 31 * DAY)).toBe(true);
    // A miss written before this field existed has no date, so it is asked again
    // at the first opportunity rather than standing forever unexamined.
    expect(isStaleBackfillMiss({ ...miss, repoCheckedAt: undefined }, 1_000 * DAY)).toBe(true);
    // A real, resolved manifest is never re-asked, however old.
    expect(isStaleBackfillMiss({ ...miss, repo: 'a/b' }, 9_999 * DAY)).toBe(false);
    // Nor is an UNFINISHED download's manifest — it has bytes still coming.
    expect(isStaleBackfillMiss({ ...miss, completedAt: undefined }, 9_999 * DAY)).toBe(false);
  });
});

describe('manifest backfill — one at a time, and never on the render path', () => {
  it('backfills models sequentially, never two lookups at once', async () => {
    const cs = [
      plant('Qwen3.5-2B-Q8_0.gguf', 10),
      plant('Qwen3.5-9B-Q8_0.gguf', 20),
      plant('Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf', 30),
    ];
    const { look, calls } = fakeLookups({ hits: [] });
    await runPass(look, cs);

    expect(calls.maxConcurrent).toBe(1);
    // …and all three really were done, so "one at a time" isn't just "one ran".
    expect(calls.search).toEqual(['Qwen3.5-2B', 'Qwen3.5-9B', 'Qwen3.6-35B-A3B']);
  });

  it('a second kick while a pass is running is ignored, so no model is looked up twice', async () => {
    const cs = [
      plant('Qwen3.5-2B-Q8_0.gguf', 10),
      plant('Qwen3.5-9B-Q8_0.gguf', 20),
    ];
    let release = () => { /* replaced below */ };
    const gate = new Promise<void>((r) => { release = r; });
    const { look, calls } = fakeLookups({ hits: [], gate });
    const backfill = new ManifestBackfill(look);
    backfill.kick(cs);
    backfill.kick(cs);          // the screen re-rendered while the first pass is mid-flight
    release();
    await backfill.whenIdle();
    expect(calls.search).toEqual(['Qwen3.5-2B', 'Qwen3.5-9B']);
  });

});

describe('manifest backfill — through installedModels()', () => {
  let userData: string;
  let cacheDir: string;
  let home: NativeHome;

  beforeEach(async () => {
    userData = path.join(root, 'userData');
    cacheDir = path.join(root, 'llama-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    home = new NativeHome(path.join(root, 'home'));
    await updateEngineConfig(home, { cacheDir });
  });

  const shaOf = (file: string) =>
    crypto.createHash('sha256').update(fs.readFileSync(path.join(cacheDir, file))).digest('hex');

  it('installedModels() answers before the backfill has asked anything', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Qwen3.5-2B-Q8_0.gguf'), Buffer.alloc(240));
    let release = () => { /* replaced below */ };
    const gate = new Promise<void>((r) => { release = r; });
    const { look, calls } = fakeLookups({ gate, searchFails: true });
    const mgr = new EngineManager(home, userData, 9999, { backfillLookups: look });

    const rows = await mgr.installedModels();
    expect(rows).toHaveLength(1);
    // Nothing has even been ASKED yet. kick() defers the whole pass to a later
    // tick, so a slow Hugging Face can never hold up the model list. (If the
    // list waited on the pass instead, this await would hang on the gate.)
    expect(calls.curated).toBe(0);

    release();
    await mgr.backfillIdle();
  });

  it('gives a pre-feature download its repo and its eye — and never looks twice', async () => {
    // Destin's own model, byte-for-byte the case §E3 was written for.
    fs.writeFileSync(path.join(cacheDir, 'gemma-4-E2B-it-Q8_0.gguf'), Buffer.alloc(80, 0x7f));
    const { look, calls } = fakeLookups({
      curated: SHIPPED_CURATED,
      hits: ['unsloth/gemma-4-E2B-it-GGUF'],
      trees: {
        'unsloth/gemma-4-E2B-it-GGUF': [option({
          quant: 'Q8_0', files: ['gemma-4-E2B-it-Q8_0.gguf'], totalSizeBytes: 80,
          sha256: shaOf('gemma-4-E2B-it-Q8_0.gguf'), visionFile: MMPROJ,
        })],
      },
    });
    const mgr = new EngineManager(home, userData, 9999, { backfillLookups: look });

    // Before: a complete model that nothing knows anything about.
    expect(await mgr.installedModels()).toEqual([expect.objectContaining({
      id: 'gemma-4-E2B-it-Q8_0', status: 'complete', repo: null, vision: 'none', visionBytes: null,
    })]);
    await mgr.backfillIdle();

    // After: its publisher is known, and the row offers "Add vision".
    expect(await mgr.installedModels()).toEqual([expect.objectContaining({
      id: 'gemma-4-E2B-it-Q8_0', status: 'complete',
      repo: 'unsloth/gemma-4-E2B-it-GGUF', vision: 'available', visionBytes: 900,
    })]);
    await mgr.backfillIdle();
    // The record on disk is the answer now — the second open looked nothing up.
    expect(calls.search).toEqual(['gemma-4-E2B-it']);
    expect(calls.trees).toEqual(['unsloth/gemma-4-E2B-it-GGUF']);
  });

  it('a model nobody publishes is recorded as untraceable, and is not searched again', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf'), Buffer.alloc(50));
    const { look, calls } = fakeLookups({ hits: [] });   // the search succeeds, and finds nothing
    const mgr = new EngineManager(home, userData, 9999, { backfillLookups: look });

    await mgr.installedModels();
    await mgr.backfillIdle();
    expect(calls.search).toEqual(['Mystery']);
    expect(readManifest(cacheDir, 'Mystery-Q4_K_M.gguf')).toMatchObject({
      repo: null, quant: 'Q4_K_M', files: ['Mystery-Q4_K_M.gguf'], totalSizeBytes: 50,
      repoCheckedAt: 1_700_000_000_000,
    });

    // Re-opening the screen costs no lookup at all.
    expect(await mgr.installedModels()).toEqual([expect.objectContaining({
      id: 'Mystery-Q4_K_M', status: 'complete', repo: null, vision: 'none',
    })]);
    await mgr.backfillIdle();
    expect(calls.search).toEqual(['Mystery']);
  });

  it('asks again about a miss that is a month old, and gets the answer this time', async () => {
    // The failure this exists for: Hugging Face answers 200 with an empty list
    // during an incident, or has not indexed a repo published yesterday. Without
    // a re-ask, one unlucky minute costs the model its vision forever.
    const DAY = 24 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(cacheDir, 'Newcomer-Q8_0.gguf'), Buffer.alloc(70, 0x5a));

    const blank = fakeLookups({ hits: [], now: 1_000 * DAY });
    const first = new EngineManager(home, userData, 9999, { backfillLookups: blank.look });
    await first.installedModels();
    await first.backfillIdle();
    expect(readManifest(cacheDir, 'Newcomer-Q8_0.gguf')).toMatchObject({ repo: null, repoCheckedAt: 1_000 * DAY });

    // A month later, with the repo now in the index.
    const later = fakeLookups({
      now: 1_031 * DAY,
      hits: ['newcomer/Newcomer-GGUF'],
      trees: {
        'newcomer/Newcomer-GGUF': [option({
          quant: 'Q8_0', files: ['Newcomer-Q8_0.gguf'], totalSizeBytes: 70,
          sha256: shaOf('Newcomer-Q8_0.gguf'), visionFile: MMPROJ,
        })],
      },
    });
    const second = new EngineManager(home, userData, 9999, { backfillLookups: later.look });
    await second.installedModels();
    await second.backfillIdle();

    expect(later.calls.search).toEqual(['Newcomer']);
    expect(await second.installedModels()).toEqual([expect.objectContaining({
      id: 'Newcomer-Q8_0', repo: 'newcomer/Newcomer-GGUF', vision: 'available',
    })]);
    await second.backfillIdle();
  });

  it('does NOT re-ask about a miss recorded yesterday', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(cacheDir, 'Newcomer-Q8_0.gguf'), Buffer.alloc(70, 0x5a));
    const blank = fakeLookups({ hits: [], now: 1_000 * DAY });
    const first = new EngineManager(home, userData, 9999, { backfillLookups: blank.look });
    await first.installedModels();
    await first.backfillIdle();

    const tomorrow = fakeLookups({ hits: [], now: 1_001 * DAY });
    const second = new EngineManager(home, userData, 9999, { backfillLookups: tomorrow.look });
    await second.installedModels();
    await second.backfillIdle();
    expect(tomorrow.calls.search).toEqual([]);
  });

  it('leaves a model that already has a manifest alone', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Done-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Done-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: 'unsloth/Done-GGUF', quant: 'Q4_K_M', files: ['Done-Q4_K_M.gguf'],
      totalSizeBytes: 50, sha256ByFile: {}, startedAt: 1, completedAt: 2,
    }));
    const { look, calls } = fakeLookups({ curated: SHIPPED_CURATED, searchFails: true });
    const mgr = new EngineManager(home, userData, 9999, { backfillLookups: look });

    await mgr.installedModels();
    await mgr.backfillIdle();
    expect(calls.curated).toBe(0);
    expect(calls.search).toEqual([]);
    expect(readManifest(cacheDir, 'Done-Q4_K_M.gguf')?.completedAt).toBe(2);
  });

  it('leaves an UNFINISHED download alone — it has bytes still coming, not a lost history', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00004.gguf'), Buffer.alloc(10));
    const { look, calls } = fakeLookups({ curated: SHIPPED_CURATED, searchFails: true });
    const mgr = new EngineManager(home, userData, 9999, { backfillLookups: look });

    const rows = await mgr.installedModels();
    expect(rows[0]).toMatchObject({ status: 'untraceable', partsPresent: 1, parts: 4 });
    await mgr.backfillIdle();
    // A set that is short of parts has no complete file to hash, so there is
    // nothing here that could be resolved honestly.
    expect(calls.curated).toBe(0);
  });
});
