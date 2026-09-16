// ModelManager — composition root for the models:* IPC surface. Thin: real
// logic lives in the pure/unit-tested modules; this class only wires them to
// the EngineManager's cache dir and fans progress out as events.
import { EventEmitter } from 'events';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { NativeHome } from '../native-home';
import { EngineManager } from '../engine/engine-manager';
import { readEngineConfig, modelSettingsFor } from '../engine/engine-config';
import { readManifest, isManifestComplete, downloadDirFor, installedDirFor } from './download-manifest';
import { CuratedCatalog } from './curated-catalog';
import { HfClient, hfResolveUrl } from './hf-client';
import { ModelDownloader } from './model-downloader';
import { addVisionToModel, type AddVisionTiming } from './add-vision';
import {
  estimateFit, checkDiskSpace, checkMemoryForLoad, kvCacheBytes, contextLengthFor,
  poolFromDevices, availableMemoryBytes, isResident, type MemoryVerdict, type KvCacheTypes, type MemoryPool,
} from './fit-estimator';
import {
  GgufHeaderCache, readLocalGgufHeader, fetchRemoteGgufHeader, hfHeaderStamp, localHeaderStamp,
  type GgufHeader,
} from './gguf-header';
import { detectGpu } from './gpu-detector';
import { scanLocalDownloads } from '../engine/cache-scan';
import type { EngineModel } from '../../shared/engine-types';
import type {
  CuratedModel, DownloadProgress, FitEstimate, HFSearchHit, QuantOption,
} from '../../shared/model-manager-types';

/** The memory warning this model's user already dismissed, if any (§D4). Read
 *  defensively out of the raw `engine.models` section: the settings dialog that
 *  writes it may not exist yet, and a dismissal without the context length it
 *  was made at is unusable — the whole rule is "same model, same length". A
 *  malformed record therefore means "not dismissed", which asks again rather
 *  than silently swallowing a warning.
 *
 *  WHY it now asks config.json's own reader instead of checking the fields here
 *  (T12): `modelSettingsFor` refuses a record missing EITHER half, and the copy
 *  that used to live here checked only the context length. So a record with no
 *  `at` — what a half-finished or hand-edited write leaves behind — was dropped
 *  when the file was read and TRUSTED here, and the two answers to "did they
 *  dismiss this?" disagreed. One reader, one answer. */
function dismissedWarning(modelsSection: unknown, modelId: string): { contextLength: number } | null {
  return modelSettingsFor(modelsSection, modelId).memoryWarningDismissed;
}

export class ModelManager extends EventEmitter {
  private curated: CuratedCatalog;
  private hf: HfClient;
  private downloader: ModelDownloader | null = null; // rebuilt if cacheDir changes

  private headers: GgufHeaderCache;

  constructor(
    private home: NativeHome,
    private engine: EngineManager,
    userDataDir: string,
    // totalVramBytes lets tests pin GPU-aware fit; undefined = detect at runtime,
    // null = force RAM-only (Amendment 2026-07-14 F).
    private opts: {
      fetchImpl?: typeof fetch; totalMemBytes?: number; totalVramBytes?: number | null;
      /** Test seam: what the machine reports it has free right now. */
      availableMemBytes?: number;
      /** Test seam: bytes free on the volume holding the cache dir. `statfsSync`
       *  is an ESM export and cannot be spied on, so the disk guard — which has
       *  a refusal message with real numbers in it — would otherwise be
       *  untestable. */
      freeDiskBytes?: number;
      /** Test seam: "Add vision" waits up to ten minutes for a model to go idle
       *  and fifteen seconds for it to unload (design §E4). A guard that has to
       *  wait out either bound for real is a guard that gets deleted. */
      addVisionTiming?: AddVisionTiming;
    } = {}
  ) {
    super();
    this.curated = new CuratedCatalog(userDataDir, opts.fetchImpl as any);
    this.hf = new HfClient(opts.fetchImpl as any);
    // One parsed GGUF header per repo / per local file, beside the curated cache
    // (design §D1): reading a header costs a network round trip, and the Local
    // Models panel would otherwise re-fetch a dozen of them every time it opens.
    this.headers = new GgufHeaderCache(userDataDir);
  }

  private cacheDir(): string { return readEngineConfig(this.home).cacheDir; }

  private getDownloader(): ModelDownloader {
    // cacheDir can change (Plan C panel shows it; later phases may make it
    // editable) — cheap to rebuild per call chain when it does.
    if (!this.downloader || (this.downloader as any).cacheDir !== this.cacheDir()) {
      this.downloader = new ModelDownloader(this.cacheDir(), this.opts.fetchImpl);
    }
    return this.downloader;
  }

  // Detected VRAM, cached once (undefined = not yet probed). Injected value in
  // opts wins so tests are deterministic. GPU-aware fit — Amendment 2026-07-14 F.
  private vramCache: number | null | undefined = undefined;
  private async vram(): Promise<number | null> {
    if (this.opts.totalVramBytes !== undefined) return this.opts.totalVramBytes;
    if (this.vramCache === undefined) this.vramCache = (await detectGpu()).totalVramBytes;
    return this.vramCache;
  }
  // ---- What this machine has, and what one model will cost on it (§D2) ----

  /** The pool a model is scored against: the installed engine's own first GPU
   *  device, else detected VRAM, else total RAM. See poolFromDevices.
   *
   *  `isDedicatedVram` comes from gpu-detector, which reports a number ONLY for
   *  a confidently-probed discrete card and null for integrated graphics. That
   *  is exactly the question the split tier needs answered: is the graphics
   *  pool memory the system does not also have? Nothing in the engine's device
   *  list can say — Vulkan reports this laptop's shared RAM as an 84 GiB
   *  "device" — so the probe is the only source. */
  private async pool(): Promise<MemoryPool & { isDedicatedVram: boolean }> {
    const vram = await this.vram();
    return {
      ...poolFromDevices(this.engine.installedDevices(), {
        totalMemBytes: this.opts.totalMemBytes ?? os.totalmem(),
        detectedVramBytes: vram,
      }),
      isDedicatedVram: vram !== null && vram > 0,
    };
  }

  private available(): number {
    return this.opts.availableMemBytes ?? availableMemoryBytes();
  }

  /** How many bytes of vision projector each installed model carries, by model
   *  id. A projector is loaded WITH its model (`--mmproj`) and is up to ~2.6 GB
   *  on Qwen2.5-Omni, so leaving it out under-states what loading that model
   *  costs. Read off the same scan as the model list, so the two can never
   *  disagree. Costs a readdir plus a stat per file, so callers that need it
   *  more than once pass the result down rather than asking again. */
  private visionBytesByModel(): Map<string, number> {
    const out = new Map<string, number>();
    for (const d of scanLocalDownloads(this.cacheDir())) {
      if (d.visionBytes > 0) out.set(d.modelId, d.visionBytes);
    }
    return out;
  }

  /** `config.json`'s `engine.models` section — the per-model settings, read raw
   *  and validated where it is used. Read defensively because the settings
   *  dialog that writes it may never have run: an absent section means every
   *  model is on the engine-wide defaults, which is exactly today's behaviour. */
  private modelSettings(): unknown {
    try { return (this.home.readJson('config.json') as any)?.engine?.models ?? null; } catch { return null; }
  }

  /** Which KV cache types the engine will actually allocate with. The supervisor
   *  passes `--cache-type-k q8_0` and NOT `--cache-type-v`: a quantized value
   *  cache is a fatal load error whenever flash attention resolves to off. So
   *  the value cache is always f16, and the key cache is 8-bit unless the
   *  "compress context memory" switch has been turned off. An ABSENT switch
   *  means compressed — that is what the engine is spawned with today, not a
   *  guess — and reading it the other way round would over-state every model's
   *  cache by 25%. */
  private cacheTypes(): KvCacheTypes {
    let compress = true;
    try {
      const speed = (this.home.readJson('config.json') as any)?.engine?.speed;
      if (speed && typeof speed === 'object' && typeof speed.compressCache === 'boolean') {
        compress = speed.compressCache;
      }
    } catch { /* absent config → the shipped default */ }
    return { k: compress ? 'q8_0' : 'f16', v: 'f16' };
  }

  /** The header of a model already on disk. Best-effort: an unreadable file
   *  means the KV cache is estimated from the fallback and reported as "up to",
   *  never that the panel fails. */
  private async localHeader(modelId: string): Promise<GgufHeader | null> {
    // A vision model's weights sit in a folder of its own (design §E2), so the
    // flat path is not where the file is. Reading the wrong path is silent —
    // the catch below turns it into "header unknown" and every such model's
    // context memory would quietly become an upper-bound guess.
    const filePath = path.join(installedDirFor(this.cacheDir(), modelId), `${modelId}.gguf`);
    try {
      const stamp = localHeaderStamp(fs.statSync(filePath).mtimeMs);
      const cached = this.headers.get(`local:${filePath}`, stamp);
      if (cached) return cached;
      const header = await readLocalGgufHeader(filePath);
      this.headers.set(`local:${filePath}`, stamp, header);
      return header;
    } catch {
      return null;
    }
  }

  /** The header of a repo we have not downloaded, over HTTP Range — a few
   *  kilobytes, not the model. One header per repo: every quant of a repo is the
   *  same model shape, and only the shape (layers, heads, head widths, which
   *  layers slide) feeds the KV estimate. Best-effort, as above. */
  private async repoHeader(repo: string, opts: QuantOption[]): Promise<GgufHeader | null> {
    const first = opts.find((o) => o.files.length > 0);
    if (!first) return null;
    const filePath = first.files[0];
    const stamp = hfHeaderStamp(first.sha256ByFile[filePath] ?? null);
    const cached = this.headers.get(`hf:${repo}`, stamp);
    if (cached) return cached;
    try {
      const header = await fetchRemoteGgufHeader(hfResolveUrl(repo, filePath), this.opts.fetchImpl as any);
      this.headers.set(`hf:${repo}`, stamp, header);
      return header;
    } catch {
      return null;
    }
  }

  /** Memory the models resident RIGHT NOW are holding: their weights plus the
   *  KV cache each one allocated at its own context length.
   *
   *  'sleeping' rows are deliberately excluded — the router frees a slept
   *  model's memory and wakes it on the next request, so counting it would
   *  reserve memory nothing is using. 'loading' rows ARE counted: that memory is
   *  being taken this second, and leaving it out is the under-count that tells a
   *  user a second model fits while the first is still arriving. */
  private async loadedBytes(
    models: EngineModel[], excludeId: string | null, vision = this.visionBytesByModel()
  ): Promise<number> {
    const cfg = readEngineConfig(this.home);
    const settings = this.modelSettings();
    const cache = this.cacheTypes();
    let sum = 0;
    for (const m of models) {
      if (m.id === excludeId) continue;
      if (!isResident(m.state)) continue;
      const ctx = contextLengthFor(m.id, settings, cfg.contextSize);
      const header = await this.localHeader(m.id);
      // + its projector: a resident vision model is holding that too, and
      // `sizeBytes` is the weights file alone (cache-scan keeps them apart).
      sum += (m.sizeBytes ?? 0) + (vision.get(m.id) ?? 0)
        + kvCacheBytes(header, ctx, cache, m.sizeBytes ?? 0).bytes;
    }
    return sum;
  }

  /** Curated RECOMMENDATIONS — plain list, no baked sizes (Amendment D). The
   *  panel fetches each card's default-quant size + fit via quants(hfRepo). */
  curatedList(): Promise<CuratedModel[]> { return this.curated.get(); }

  search(query: string): Promise<HFSearchHit[]> { return this.hf.search(query); }

  /** Each quant variant decorated with a GPU-aware fit label. This is also the
   *  call the panel uses to size + fit a curated card (find the quantDefault). */
  async quants(repo: string): Promise<Array<QuantOption & { fit: FitEstimate }>> {
    const opts = await this.hf.quantOptions(repo);
    // A model not yet downloaded has no per-model setting, so the context that
    // sizes its cache is the engine-wide one (§D3).
    const contextLength = readEngineConfig(this.home).contextSize;
    const [header, pool, loadedBytes] = await Promise.all([
      this.repoHeader(repo, opts),
      this.pool(),
      this.engine.liveModels().then((m) => this.loadedBytes(m, null)).catch(() => 0),
    ]);
    const cache = this.cacheTypes();
    const availableBytes = this.available();
    const totalMemBytes = this.opts.totalMemBytes ?? os.totalmem();
    return opts.map((o) => {
      // Per quant, not once per repo: when the header could not be read the
      // fallback scales with the model's own size, and the quants of one repo
      // differ by several gigabytes.
      const kv = kvCacheBytes(header, contextLength, cache, o.totalSizeBytes);
      return {
      ...o,
      fit: estimateFit({
        modelBytes: o.totalSizeBytes,
        // The vision file downloads WITH the model and is resident with it, so
        // it belongs in the verdict. Without this the row's size (which already
        // includes it) and the fit label beside it disagree — a repo can read
        // "fits" while the real download is 2.6 GB bigger than what was scored.
        visionBytes: o.visionBytes ?? 0,
        kvBytes: kv.bytes,
        kvIsUpperBound: kv.isUpperBound,
        contextLength,
        poolBytes: pool.poolBytes,
        poolIsGpu: pool.poolIsGpu,
        poolIsDedicatedVram: pool.isDedicatedVram,
        totalMemBytes,
        availableBytes,
        loadedBytes,
      }),
      };
    });
  }

  /** Create-time / swap-time memory guard for an INSTALLED model id: is it safe
   *  to load it given what's already resident? Blocks only when clearly too
   *  large; otherwise warns (see checkMemoryForLoad). Unknown model/size → 'ok'
   *  (never block on missing data). Used by the new-session picker + swap popup. */
  async memoryCheck(modelId: string): Promise<MemoryVerdict> {
    const models = await this.engine.liveModels();
    const chosen = models.find((m) => m.id === modelId);
    const chosenBytes = chosen?.sizeBytes ?? 0;
    if (chosenBytes <= 0) return { verdict: 'ok', headline: '', detail: '' };
    const settings = this.modelSettings();
    // ONE scan, shared with loadedBytes below — it is a readdir plus a stat per
    // file, and this method would otherwise run it twice for the same answer.
    const vision = this.visionBytesByModel();
    // An installed model uses ITS OWN context length when it has one (§D3) —
    // the whole point of the per-model setting is that this model is the one
    // running at 128k, and scoring it at the engine-wide 32k would under-count
    // its cache fourfold.
    const contextLength = contextLengthFor(modelId, settings, readEngineConfig(this.home).contextSize);
    const [header, pool, loadedBytes] = await Promise.all([
      this.localHeader(modelId),
      this.pool(),
      this.loadedBytes(models, modelId, vision),
    ]);
    const kv = kvCacheBytes(header, contextLength, this.cacheTypes(), chosenBytes);
    return checkMemoryForLoad({
      modelBytes: chosenBytes,
      // T15: the cache scan now reports an installed model's projector, so the
      // create-time guard counts it like the download-time one does. A
      // projector is up to ~2.6 GB — five times the working-memory cushion —
      // so it can flip this verdict on its own.
      visionBytes: vision.get(modelId) ?? 0,
      kvBytes: kv.bytes,
      kvIsUpperBound: kv.isUpperBound,
      contextLength,
      poolBytes: pool.poolBytes,
      poolIsGpu: pool.poolIsGpu,
      poolIsDedicatedVram: pool.isDedicatedVram,
      totalMemBytes: this.opts.totalMemBytes ?? os.totalmem(),
      availableBytes: this.available(),
      loadedBytes,
      dismissed: dismissedWarning(settings, modelId),
    });
  }

  /** Free bytes on the volume holding `dir`, walking UP to the nearest EXISTING
   *  ancestor when the cache dir doesn't exist yet (Amendment 2026-07-14 J — the
   *  old code skipped the guard entirely on a fresh cache dir). null = couldn't
   *  determine (guard skipped). */
  private freeBytesNear(dir: string): number | null {
    if (this.opts.freeDiskBytes !== undefined) return this.opts.freeDiskBytes;
    let d = dir;
    for (let i = 0; i < 40; i++) {
      try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch { /* try parent */ }
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    return null;
  }

  // Remaining bytes of in-flight downloads (K5): the disk guard reserves them so
  // two large downloads can't each pass against the same free space and then
  // collectively overflow the disk.
  private inflight = new Map<string, { total: number; received: number }>();
  private reservedBytes(): number {
    let sum = 0;
    for (const d of this.inflight.values()) sum += Math.max(0, d.total - d.received);
    return sum;
  }

  /** Bytes of THIS download's file set already on disk — published parts plus
   *  the .partial. Feeds the disk guard so a resume is judged on what is left. */
  private bytesOnDiskFor(quant: QuantOption): number {
    // The download's OWN directory — a vision model's is its folder, and
    // charging a resume the full size because we looked in the wrong place is
    // the 2026-08-26 "delete the partial to make room" trap all over again.
    const dir = downloadDirFor(this.cacheDir(), quant);
    let sum = 0;
    const paths = quant.visionFile ? [...quant.files, quant.visionFile.path] : quant.files;
    for (const filePath of paths) {
      const base = path.basename(filePath);
      for (const candidate of [base, `${base}.partial`]) {
        try { sum += fs.statSync(path.join(dir, candidate)).size; } catch { /* absent */ }
      }
    }
    return sum;
  }

  /** Disk guard (reserving in-flight downloads and crediting bytes already
   *  fetched), then start; progress fans out on 'download-progress'. */
  async download(repo: string, quant: QuantOption): Promise<{ downloadId: string }> {
    const free = this.freeBytesNear(this.cacheDir());
    if (free != null) {
      const refusal = checkDiskSpace(
        // The projector is fetched by the SAME job, so the guard has to reserve
        // it too. `QuantOption.totalSizeBytes` deliberately excludes it (it is
        // the size of one quant's split set), which left this check short by
        // the projector's size — ~175 MB on gemma-4-12b, ~2.6 GB on
        // Qwen2.5-Omni. A user with just enough space passed the check and then
        // ran out mid-download (design §E2, T15 handoff 2).
        quant.totalSizeBytes + (quant.visionFile?.size ?? 0),
        Math.max(0, free - this.reservedBytes()),
        this.bytesOnDiskFor(quant),
      );
      if (refusal) throw new Error(refusal);
    }
    const dl = this.getDownloader();
    const downloadId = dl.start(repo, quant, (p: DownloadProgress) => {
      this.inflight.set(downloadId, { total: p.totalBytes, received: p.receivedBytes });
      this.emit('download-progress', p);
    });
    // Outcome is delivered via progress events; swallow the rejection here so an
    // error can't become an unhandled rejection in main (the UI reads the
    // 'error' progress event). Clear the reservation once the download settles.
    void dl.wait(downloadId).catch(() => {}).finally(() => this.inflight.delete(downloadId));
    return { downloadId };
  }

  cancel(downloadId: string): void { this.getDownloader().cancel(downloadId); }

  /** `models:add-vision` (design §E4): fetch the vision projector for a model
   *  that is already installed without one. When the model is still flat it is
   *  first moved into a folder of its own, because the engine only pairs a model
   *  with its projector inside one subdirectory — the ordering that keeps the
   *  user's model safe through that move lives in add-vision.ts.
   *
   *  The projector is fetched by this.download, the ordinary path: the same disk
   *  guard, the same in-flight reservation, and the same 'download-progress'
   *  stream the row already listens on. */
  async addVision(modelId: string): Promise<{ downloadId: string }> {
    return addVisionToModel(
      this.cacheDir(),
      modelId,
      {
        running: () => this.engine.engineRunning(),
        inFlightFor: (id) => this.engine.inFlightFor(id),
        unload: (id) => this.engine.unloadModel(id),
        modelState: (id) => this.engine.routerModelState(id),
        refreshModels: () => this.engine.refreshModels(),
      },
      (repo, quant) => this.download(repo, quant),
      this.opts.addVisionTiming ?? {},
    );
  }

  /** Continue an interrupted download from the manifest beside it. Deliberately
   *  no network: the interruption that stranded the download is often the
   *  network itself. The downloader skips published parts and Range-continues
   *  the .partial, so this is the original download(repo, quant) call replayed. */
  async resume(modelId: string): Promise<{ downloadId: string }> {
    const manifest = readManifest(installedDirFor(this.cacheDir(), modelId), `${modelId}.gguf`);
    // A null repo is the same situation as no manifest at all: the record
    // exists, but it says "we never found out where this came from".
    if (!manifest || manifest.repo === null) {
      // Specific and accurate, per docs/error-message-standards.md — this names
      // the real cause and what the user can do instead. The UI never offers
      // Resume on such a row; this guards the IPC and remote surfaces.
      throw new Error(
        "This download has no record of where it came from, so it can't be resumed automatically. "
        + 'Find the model in search and download it again — it will continue from where it stopped.'
      );
    }
    if (isManifestComplete(manifest)) {
      // WHY this guard exists at all: the manifest now stays on disk after the
      // download finishes, so its mere presence no longer proves there is
      // something to resume. Its own message, because the cause is different
      // from the one above and a shared one would be a guess.
      throw new Error('This download already finished, so there is nothing to resume.');
    }
    return this.download(manifest.repo, {
      quant: manifest.quant,
      description: '',
      files: manifest.files,
      totalSizeBytes: manifest.totalSizeBytes,
      sha256ByFile: manifest.sha256ByFile,
      // Carried forward, or the resumed job would decide this model is
      // text-only and write its remaining parts FLAT — beside the folder that
      // already holds the rest of them, where the engine would serve neither.
      ...(manifest.visionFile
        ? { visionFile: manifest.visionFile, visionBytes: manifest.visionFile.size }
        : {}),
    });
  }
}
