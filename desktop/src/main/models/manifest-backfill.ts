// §E3 — giving a model that was downloaded BEFORE this feature its history back.
//
// Every download now leaves a manifest beside it recording which Hugging Face
// repo the files came from and whether that repo ships a vision projector.
// Downloads made before that existed have no manifest at all, so the app has no
// way to know those models can see images — which means they can never show the
// eye, and can never offer "Add vision", permanently. This resolves the repo
// ONCE per model and writes the manifest the download would have written.
//
// Two rules keep it out of the user's way:
//   - It never blocks the model list. installedModels() hands over the
//     candidates and returns; the lookups start on a later tick.
//   - It is strictly SEQUENTIAL — one model, one request in flight. Nobody is
//     waiting for this, and a burst of parallel Hugging Face calls is exactly
//     what earns an IP a rate limit.
//
// Two rules keep it honest:
//   - A WRONG REPO IS IMPOSSIBLE, because identity is decided by the FILE'S
//     SHA-256 and by nothing else. A repo is written only when it publishes a
//     file whose hash is the hash of the bytes on this disk, and only when
//     exactly one repo does. Everything else — filename, part count, size — is
//     a cheap pre-filter that decides whether the hash is worth computing; none
//     of it can admit a repo on its own. See `confirm` and `sameFile`.
//
//     MEASURED, and the reason this is not size-based: on 2026-09-05,
//     ggml-org/gemma-4-E2B-it-GGUF and lmstudio-community/gemma-4-E2B-it-GGUF
//     both publish 'gemma-4-E2B-it-Q8_0.gguf' at the IDENTICAL 4,967,497,152
//     bytes, with different content (sha 996d0877… vs 1265ad3b…) and different
//     projectors (986,833,664 vs 986,833,248 bytes). A size-based rule writes
//     whichever of the two the search happens to list, "Add vision" then fetches
//     the wrong account's projector, and it VERIFIES against that account's own
//     hash — so nothing downstream ever notices.
//   - A FAILURE IS NOT A MISS. `repo: null` — the "we looked and could not find
//     it" record — is written only when every lookup SUCCEEDED and the answer
//     was genuinely "none of these". A search that is offline, times out, is
//     rate-limited or 5xxs writes NOTHING and is tried again on the next app
//     start. Even a SUCCESSFUL miss is not forever: it is stamped
//     `repoCheckedAt` and re-asked after RECHECK_AFTER_MS, because a 200 can
//     still be wrong (an empty list during an incident, or an index that has
//     not seen a new repo yet).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type {
  CuratedModel, DownloadManifest, HFSearchHit, QuantOption,
} from '../../shared/model-manager-types';
import { parseGgufName } from './quant-parser';
import { writeBackfillManifest } from './download-manifest';
import { CuratedCatalog } from './curated-catalog';
import { HfClient } from './hf-client';

/** One complete download on disk that has no manifest — everything the lookup
 *  needs to identify it, read straight off the cache scan. */
export interface BackfillCandidate {
  /** The directory the files and the manifest live in (a model's own folder
   *  when it has one, else the cache dir). */
  dir: string;
  /** The FIRST file's basename including `.gguf` — the manifest's key. */
  firstFileName: string;
  /** Declared part count from the `-of-000NN` suffix; 1 for a single file. */
  parts: number;
  /** Published weight bytes, exactly as the cache scan measured them. */
  bytesPublished: number;
}

/** The questions the backfill asks the outside world, injected so the tests can
 *  answer them without a network — and so nothing that merely constructs an
 *  EngineManager can accidentally reach Hugging Face. */
export interface BackfillLookups {
  curated(): Promise<CuratedModel[]>;
  search(query: string): Promise<HFSearchHit[]>;
  quantOptions(repo: string): Promise<QuantOption[]>;
  now(): number;
}

// How many of a search's hits are listed. Hugging Face returns up to 30, sorted
// by downloads.
//
// WHY this can be generous now, and could not be before: while identity was
// decided by SIZE, the cap was a correctness knob — the true publisher could sit
// outside it while a same-sized impostor sat inside, and raising it turned
// resolved models into permanent misses. Now that only a SHA-256 match is ever
// written, a wrong repo cannot be admitted however many are listed, so the cap
// is purely a traffic budget: a bigger one finds more publishers and costs more
// listings. Each listing is one small JSON request, on a background pass that
// runs once per model for the life of that model.
const MAX_SEARCH_CANDIDATES = 30;

// How close a repo's copy has to be before its hash is worth checking. This is a
// PRE-FILTER, not evidence: it decides whether to bother, never who wins.
//
// It is deliberately loose, because size separates almost nothing. MEASURED on
// 2026-09-05, live, over repos publishing the same filename at the same quant as
// a single file: genuinely DIFFERENT builds sat 640, 704, 800, 832, 1,120, 2,656
// and 2,688 bytes apart — while the same build re-uploaded after a metadata edit
// sat 2,016 bytes away. There is no threshold that tells those apart, which is
// exactly why the hash decides. What 1% does buy: it skips a wrong QUANT (this
// machine's gemma Q6_K is 11% from its Q8_0) and any obviously unrelated file,
// so a 5 GB read is not started for a candidate that cannot possibly match.
const SIZE_TOLERANCE = 0.01;

// How long a "we looked and could not find it" record stands before the question
// is asked again. A search can succeed and still be wrong — Hugging Face answers
// 200 with an empty list during an incident, and its index takes time to see a
// newly published repo — so a miss is dated rather than final. A month is long
// enough that this is not a retry loop (the cost is one search per model per
// month, only for models that never resolved) and short enough that a model does
// not stay blind for a year over one bad minute.
const RECHECK_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Is this manifest a §E3 miss old enough to be worth re-asking? Exported for
 *  engine-manager, which decides what goes on the candidate list.
 *
 *  `repo: null` WITH a `completedAt` is unambiguously a backfill miss: nothing
 *  else in the app can write one — `writeManifest` requires a repo name. */
export function isStaleBackfillMiss(manifest: DownloadManifest, now: number): boolean {
  if (manifest.repo !== null || manifest.completedAt == null) return false;
  return now - (manifest.repoCheckedAt ?? 0) > RECHECK_AFTER_MS;
}

/** The SHA-256 of a file on disk, streamed. This is the one expensive thing the
 *  backfill does — it reads the whole first part, which for a big model is tens
 *  of gigabytes — so it is computed at most ONCE per model, only after at least
 *  one repo has passed the cheap filters, and only on a background pass. */
function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function defaultBackfillLookups(userDataDir: string, fetchImpl?: typeof fetch): BackfillLookups {
  const curated = new CuratedCatalog(userDataDir, fetchImpl as any);
  const hf = new HfClient(fetchImpl as any);
  return {
    curated: () => curated.get(),
    search: (q) => hf.search(q),
    quantOptions: (repo) => hf.quantOptions(repo),
    now: () => Date.now(),
  };
}

/** The filename stem a curated entry's repo publishes its quants under:
 *  'unsloth/gemma-4-12b-it-GGUF' → 'gemma-4-12b-it', which is exactly what
 *  parseGgufName reads out of 'gemma-4-12b-it-UD-Q4_K_XL.gguf'. Exported for
 *  the test that pins it against the shipped list. */
export function curatedRepoStem(hfRepo: string): string {
  const name = hfRepo.split('/').pop() ?? hfRepo;
  return name.replace(/-GGUF$/i, '');
}

/** Every part's filename, derived from the first one. llama.cpp's split naming
 *  is positional (`<name>-000kk-of-000NN.gguf`), so the whole set is known from
 *  part 1 plus the count — which is all a MISS has to record. */
function partFileNames(c: BackfillCandidate): string[] {
  const suffix = /-(\d{5})-of-(\d{5})\.gguf$/i;
  const m = suffix.exec(c.firstFileName);
  if (!m || c.parts <= 1) return [c.firstFileName];
  const out: string[] = [];
  for (let i = 1; i <= c.parts; i++) {
    out.push(c.firstFileName.replace(suffix, `-${String(i).padStart(5, '0')}-of-${m[2]}.gguf`));
  }
  return out;
}

/** When the weights were last written — the closest honest reading of when this
 *  download actually finished, which is what `completedAt` means. */
function fileModifiedAt(file: string): number | null {
  try { return Math.round(fs.statSync(file).mtimeMs); } catch { return null; }
}

function keyOf(c: BackfillCandidate): string { return path.join(c.dir, c.firstFileName); }

export class ManifestBackfill {
  // The pass currently running, or null. One at a time, always — see the header.
  private pass: Promise<void> | null = null;
  // Every model this app run has already spent a lookup on, whatever the
  // outcome. A model that RESOLVED drops out on its own (it has a manifest now
  // and stops being a candidate); this set is what stops a model whose lookup
  // FAILED from being retried on every render of the Local Models screen. A new
  // app run starts with an empty set, which is the retry.
  private attempted = new Set<string>();

  constructor(private look: BackfillLookups) {}

  /** Hand over the complete downloads that have no manifest. Returns at once —
   *  the caller is a screen's data fetch and must not wait on the network. */
  kick(candidates: BackfillCandidate[]): void {
    if (this.pass) return;
    const todo = candidates.filter((c) => !this.attempted.has(keyOf(c)));
    if (todo.length === 0) return;
    // setImmediate, not a bare async call: an async function body runs
    // synchronously up to its first await, and CuratedCatalog reads its disk
    // cache before awaiting anything. Deferring the whole thing keeps every
    // byte of this work off installedModels()' tick.
    this.pass = new Promise<void>((resolve) => {
      setImmediate(() => {
        void (async () => {
          try {
            await this.run(todo);
          } catch {
            // UNREACHABLE with the candidates installedModels() builds, and
            // deliberately kept anyway: run() catches per model, so the only way
            // here is a throw between models. If one ever happened, a latch left
            // set would wedge the backfill for the life of the app and leave
            // whenIdle() hanging forever — a far worse failure than the lookup
            // that caused it. NOT pinned by a test, because a test would have to
            // fake a malformed candidate that nothing can produce, and a guard
            // whose fixture invents its own precondition proves nothing.
          } finally {
            // Cleared BEFORE resolving, so anything awaiting whenIdle() can kick
            // a fresh pass the instant it wakes up.
            this.pass = null;
            resolve();
          }
        })();
      });
    });
  }

  /** Settles when the pass in flight is over. Used by the tests, which must
   *  await this before their fixture directory is torn down. */
  whenIdle(): Promise<void> { return this.pass ?? Promise.resolve(); }

  private async run(todo: BackfillCandidate[]): Promise<void> {
    for (const c of todo) {
      this.attempted.add(keyOf(c));
      try {
        await this.resolveOne(c);
      } catch {
        // The lookup could not FINISH — offline, a timeout, a rate limit, a
        // 5xx, an aborted request. Nothing is written, because a temporary
        // failure must never harden into the permanent `repo: null` record.
        // The next app run tries this model again.
      }
    }
  }

  private async resolveOne(c: BackfillCandidate): Promise<void> {
    const parsed = parseGgufName(c.firstFileName);
    // A filename we cannot read a quant out of. A manifest requires the exact
    // string Hugging Face uses, and inventing one would put a made-up value
    // where a real fact belongs — so this model is left alone, not recorded.
    if (!parsed) return;

    // The hash of the bytes on this disk, computed AT MOST ONCE and only when
    // some repo has already passed the cheap filters. For a 30 GB model this is
    // a 30 GB read, so it must never happen per candidate and never happen at
    // all for a model nothing plausible was found for.
    let diskHash: string | null = null;
    const sameFile = async (option: QuantOption): Promise<boolean> => {
      // Hugging Face reports an LFS blob's sha256 as `lfs.oid`. It is absent for
      // small non-LFS files; a repo that does not state a hash cannot be proved
      // to hold these bytes, so it is refused rather than assumed.
      const oid = option.sha256ByFile[option.files[0]];
      if (!oid) return false;
      if (diskHash === null) diskHash = await sha256OfFile(path.join(c.dir, c.firstFileName));
      return oid === diskHash;
    };

    // 1. The curated list, offline. CuratedCatalog.get() never throws and falls
    //    back to the copy shipped inside the app, so a curated model that can be
    //    PROVED to come from its listed repo resolves with no search at all.
    //    Anything short of proof falls through — the curated list names a likely
    //    publisher, and a likely publisher is exactly what must not be written.
    const named = await this.curatedRepoFor(parsed.base, parsed.quant);
    if (named) {
      const option = await this.confirm(named, c, parsed.quant);
      if (option && await sameFile(option)) { this.record(c, named, parsed.quant, option); return; }
    }

    // 2. One search on the filename stem, then every hit is listed — no early
    //    exit. Only a hash match is ever collected, so a wrong repo cannot enter
    //    this list however many are checked.
    const hits = await this.look.search(parsed.base);
    const repos = hits.map((h) => h.repo).filter((r) => r !== named).slice(0, MAX_SEARCH_CANDIDATES);
    const confirmed: { repo: string; option: QuantOption }[] = [];
    for (const repo of repos) {
      const option = await this.confirm(repo, c, parsed.quant);
      if (option && await sameFile(option)) confirmed.push({ repo, option });
    }
    // Every lookup answered. Exactly one repo proved it holds these bytes, or
    // the honest record is "we looked and could not find it". TWO is also a
    // refusal: byte-identical mirrors are the same weights but need not ship the
    // same projector, and choosing between them would be a guess.
    const match = confirmed.length === 1 ? confirmed[0] : null;
    this.record(c, match?.repo ?? null, parsed.quant, match?.option ?? null);
  }

  /** The curated entry that publishes this filename, if any. The match is two
   *  exact string equalities — the repo's own stem against the filename's, and
   *  the entry's default quant against the filename's quant. */
  private async curatedRepoFor(stem: string, quant: string): Promise<string | null> {
    const curated = await this.look.curated();
    const hit = curated.find((m) => curatedRepoStem(m.hfRepo) === stem && m.quantDefault === quant);
    return hit?.hfRepo ?? null;
  }

  /** Is this repo worth HASHING against? Four cheap tests, in order, every one
   *  of which a repo must pass — but passing them all still proves nothing on
   *  its own. This is a filter over what to read from disk, and the caller's
   *  `sameFile` is what decides identity:
   *    1. it offers this EXACT quant string ('Q8_0', 'UD-Q4_K_XL', …) — no
   *       substring, no normalising, so 'Q8_0' never matches 'UD-Q8_K_XL';
   *    2. as EXACTLY this many parts, so half of a split set cannot pass;
   *    3. whose first file is called EXACTLY what the file on disk is called,
   *       which is the model's own name — so a repo that renames its files
   *       (bartowski prefixes them with the original account) is refused;
   *    4. at all but the same total size — see SIZE_TOLERANCE, which is here to
   *       avoid a pointless multi-gigabyte read, NOT to establish identity.
   *  There is no fuzzy name matching anywhere, and nothing is inferred from
   *  which repo is more popular. */
  private async confirm(
    repo: string, c: BackfillCandidate, quant: string
  ): Promise<QuantOption | null> {
    const options = await this.look.quantOptions(repo);
    const option = options.find((o) => o.quant === quant);
    if (!option) return null;
    if (option.files.length !== c.parts) return null;
    if ((option.files[0].split('/').pop() ?? option.files[0]) !== c.firstFileName) return null;
    if (Math.abs(option.totalSizeBytes - c.bytesPublished) > c.bytesPublished * SIZE_TOLERANCE) return null;
    return option;
  }

  private record(
    c: BackfillCandidate, repo: string | null, quant: string, option: QuantOption | null
  ): void {
    const at = fileModifiedAt(path.join(c.dir, c.firstFileName)) ?? this.look.now();
    // On a hit these are the repo-relative paths a real download would have
    // written (unsloth keeps dynamic quants in subfolders); on a miss the only
    // names anyone knows are the ones on disk.
    const files = option ? option.files : partFileNames(c);
    const manifest: DownloadManifest = {
      v: 1,
      repo,
      quant,
      files,
      // The bytes that are HERE, always — a manifest must not describe a file
      // the user does not have. On a hit this is the repo's number too: the
      // first part's hash matched, so the set is the same set.
      totalSizeBytes: c.bytesPublished,
      // No hashes for a miss: Hugging Face is the only source of them and we
      // never reached it. null per file is what "not known" already means here.
      sha256ByFile: option?.sha256ByFile ?? Object.fromEntries(files.map((f) => [f, null])),
      // This download finished in the past and nothing recorded when. The
      // weights' own mtime is the closest honest reading; both fields carry it,
      // because a completed manifest's startedAt is never read for anything
      // else and a fabricated "started now" would read as a live download.
      startedAt: at,
      completedAt: at,
      ...(option?.visionFile ? { visionFile: option.visionFile } : {}),
      // Dated ONLY on a miss, and read only by isStaleBackfillMiss. A hit is
      // settled — the hash matched — and needs no expiry.
      ...(repo === null ? { repoCheckedAt: this.look.now() } : {}),
    };
    writeBackfillManifest(c.dir, c.firstFileName, manifest);
  }
}
