// Honest fit estimation (spec §4.3, rebuilt 2026-09-05 for design §D2/§D3).
//
// The question every function here answers is "will this model run on THIS
// computer, right now?", and the answer is the number the user reads on a model
// card and the warning they get before loading one. Until this rewrite the
// answer was `model size + a flat 2 GB`; it is now the model file, its vision
// file, and the KV cache the model's OWN header says it will allocate at the
// context length it will actually run with (gguf-header.ts).
//
// ---------------------------------------------------------------------------
// THE DIRECTION RULE — read before changing any arithmetic below
// ---------------------------------------------------------------------------
// An OVER-estimate warns the user about a model that would have been fine.
// An UNDER-estimate tells them a model fits when it does not: they load it, the
// machine thrashes or the load fails, and nothing in the app explains why. So
// every rounding, every fallback and every unknown in this file errs HIGH, and
// each one says so at the line where it happens.
//
// The one place that rule reverses is `too-large`, which is a HARD BLOCK:
// RuntimeBinding.tsx refuses to create the session at all and §D4 makes it
// non-dismissible. Over-stating `need` there stops someone using a model that
// would have run. That is why the KV term may raise a verdict to `tight` and
// never to `too-large`, and why the last tier counts system memory as well as
// the graphics pool: llama-server's `-ngl` default is `auto`, which puts the
// layers that fit on the GPU and runs the rest on the CPU.
// ---------------------------------------------------------------------------
import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type { GgufHeader } from './gguf-header';
import type { EngineModelState } from '../../shared/engine-types';
import type { FitEstimate } from '../../shared/model-manager-types';

const GB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Engine + OS working memory on top of the weights and the KV cache: the
 *  compute buffers, the model's graph, the router itself. A blunt constant on
 *  purpose (spec: "no fake precision") — but a GENEROUS one, since it is added
 *  to every verdict. */
export const WORKING_HEADROOM_BYTES = 512 * MIB;

/** What one KV element costs, per llama.cpp's cache types. */
export type KvCacheType = 'f16' | 'q8_0';
const ELEMENT_BYTES: Record<KvCacheType, number> = { f16: 2, q8_0: 1 };

/** Block overhead on the KV cache. q8_0 stores 32 values in a 34-byte block —
 *  6.25%, not the 6% the design rounds to, so 6.25% is used: it is exact for
 *  q8_0 and errs high for f16 (which has no block overhead at all). Rounding
 *  the other way would under-count the cache, the one direction that turns a
 *  "tight" verdict into a wrong "fits". */
const KV_BLOCK_OVERHEAD = 34 / 32;

/** A SLIDING layer's cache is much bigger than its window. llama.cpp allocates
 *  `min(size_base, GGML_PAD(n_swa × n_seq_max + n_ubatch, 256))` for it
 *  (llama-kv-cache-iswa.cpp), and BOTH of the extra terms are engine defaults
 *  this app never overrides:
 *    - `n_ubatch` = 512 (`--ubatch-size`).
 *    - `n_seq_max` = **4**. llama-server's `--parallel` default is `auto`, which
 *      resolves to 4 slots, and engine-supervisor.ts passes no `-np`. MEASURED
 *      on b10665 with one model: `-np auto` → "SWA KV cache, size = 2560 cells"
 *      (512×4 + 512); `-np 1` → 1024 cells. Modelling one slot under-counts the
 *      sliding half of the cache THREE-fold, which on curated `gemma-4-12b-it`
 *      (1024-token window) is 1.459 GB of real cache read as 0.772 GB — enough
 *      to print "fits on your GPU" for a model that spills onto the processor.
 *  If T6's per-model `extraFlags` ever carries `--parallel` or `--ubatch-size`,
 *  these two constants stop being true for that model and the estimate would be
 *  wrong with no flag: read them off the model's own flags when that lands. */
const UBATCH_TOKENS = 512;
const SEQ_SLOTS = 4;
const CACHE_PAD_TOKENS = 256;

/** The guess for a model whose header could not be read at all. Scaled by BOTH
 *  the context length and the model's own size, because a cache is roughly
 *  proportional to the model's depth and width and a flat constant is wrong by
 *  a factor of four on a big model: a dense 70B at 32k really needs 8.05 GB,
 *  and the old flat 2 GB was printed to the user as "up to 2.0 GB" — a
 *  statement that was simply false. The fraction covers a dense 70B even at a
 *  4-bit quant (0.15 × 40 GB = 10 GB ≥ 8.05). It does NOT cover a pre-GQA model
 *  (a 7B with 32 KV heads needs ~13 GB at 32k), which is why this path is
 *  always flagged as an upper bound rather than presented as a reading. */
const FALLBACK_KV_MIN_BYTES = 2 * GB;
const FALLBACK_KV_MODEL_FRACTION = 0.25;
const FALLBACK_KV_CONTEXT = 32768;

/** Bytes per element of a recurrent layer's state — llama.cpp keeps both the
 *  SSM state and its convolution state in f32. */
const RECURRENT_ELEMENT_BYTES = 4;

function padUp(n: number, multiple: number): number {
  return Math.ceil(n / multiple) * multiple;
}

export interface KvCacheTypes { k: KvCacheType; v: KvCacheType }
export interface KvEstimate {
  bytes: number;
  /** True when the number above is a ceiling rather than a figure we can stand
   *  behind — the caller must present it as "up to N GB" (§D2, R1-25). */
  isUpperBound: boolean;
}

/**
 * How much memory this model's KV cache takes at `contextLength` tokens.
 *
 * Per layer, per kept token: `kvHeads × (dK×bytes(kType) + dV×bytes(vType))`.
 * What varies per layer, and where each fact comes from:
 *   - `header.recurrentLayers` — a recurrent/linear layer holds NO attention KV.
 *   - `header.slidingLayers`   — a sliding layer keeps only a window of tokens,
 *                                at the half-width `_swa` head sizes when the
 *                                file gives them (Gemma 4).
 *   - `header.sharedKvLayers`  — the TRAILING n layers reuse an earlier layer's
 *                                cache and store none of their own.
 *   - `header.headCountKvLayers` — the per-layer KV head count. NEVER the
 *     scalar: gemma-4-12b writes 48 entries, 8 KV heads on its sliding layers
 *     and 1 on its full-attention ones, and a flat 8 over-sizes the
 *     full-attention layers eightfold.
 */
export function kvCacheBytes(
  header: GgufHeader | null,
  contextLength: number,
  cache: KvCacheTypes,
  /** The model's weights, used only by the fallback below when the header could
   *  not be read. Omitted → the fallback is the flat minimum. */
  modelBytes = 0,
): KvEstimate {
  const fallback = (): KvEstimate => ({
    // A rule of thumb, not a reading of this model — hence the flag.
    bytes: Math.max(FALLBACK_KV_MIN_BYTES, modelBytes * FALLBACK_KV_MODEL_FRACTION)
      * (Math.max(1, contextLength) / FALLBACK_KV_CONTEXT),
    isUpperBound: true,
  });
  if (!header || !contextLength || contextLength <= 0) return fallback();

  const layers = header.blockCount;
  const dK = header.keyLength;
  const dV = header.valueLength;
  if (layers === null || layers <= 0 || dK === null || dV === null) return fallback();

  const kBytes = ELEMENT_BYTES[cache.k];
  const vBytes = ELEMENT_BYTES[cache.v];
  // Gemma 4 gives its sliding layers half-width keys and values; a file without
  // the `_swa` keys uses the same width everywhere.
  const dKswa = header.keyLengthSwa ?? dK;
  const dVswa = header.valueLengthSwa ?? dV;

  let isUpperBound = header.contextBytesIsUpperBound;

  // llama.cpp pads a cache to a multiple of 256 tokens. Padding UP is the safe
  // direction and it is what the engine really allocates.
  const fullTokens = padUp(contextLength, CACHE_PAD_TOKENS);
  const window = header.slidingWindow;
  const hasWindow = window !== null && window > 0;
  // min(size_base, PAD(n_swa × n_seq_max + n_ubatch, 256)) — the padding is
  // applied INSIDE the min, so a sliding layer never costs more than a full one.
  const slidingTokens = hasWindow
    ? Math.min(fullTokens, padUp(window * SEQ_SLOTS + UBATCH_TOKENS, CACHE_PAD_TOKENS))
    : fullTokens;
  if (header.slidingLayers && !hasWindow) {
    // The file says which layers slide but not how wide the window is. Those
    // layers are then counted as full-attention — an over-count, so the number
    // is safe, but it is a ceiling and has to say so.
    isUpperBound = true;
  }

  // `shared_kv_layers = n` means the LAST n layers store no KV of their own:
  // llama.cpp's Gemma 4 loader computes n_layer_kv_from_start = n_layer_all − n
  // (src/models/gemma4.cpp), so on E2B only the first 15 of 35 layers have a
  // cache. A value at or past the layer count would leave the model with NO
  // cache at all, which is not a thing a model does — so it is read as "we do
  // not understand this file", every layer is counted, and the answer is
  // flagged. (A silent zero here is the worst possible failure: it is an
  // under-count of the whole cache, presented as exact.)
  const shared = header.sharedKvLayers ?? 0;
  let layersWithOwnKv = layers;
  if (shared > 0 && shared < layers) layersWithOwnKv = layers - shared;
  else if (shared >= layers) isUpperBound = true;

  let bytes = 0;
  for (let il = 0; il < layers; il++) {
    if (il >= layersWithOwnKv) continue;              // shares an earlier layer's cache
    if (header.recurrentLayers?.[il]) continue;       // linear/recurrent: no attention KV
    const heads = header.headCountKvLayers?.[il] ?? header.headCountKv;
    if (heads === null || heads === undefined || !Number.isFinite(heads) || heads <= 0) {
      // One layer we cannot size means the whole figure is a guess; a partial
      // sum here would UNDER-count, so throw it away and use the ceiling.
      return fallback();
    }
    const slides = header.slidingLayers?.[il] === true && hasWindow;
    const perToken = heads * ((slides ? dKswa : dK) * kBytes + (slides ? dVswa : dV) * vBytes);
    bytes += (slides ? slidingTokens : fullTokens) * perToken;
  }

  const recurrentState = recurrentStateBytes(header);
  // A hybrid model whose SSM shape we cannot read would be under-counted by up
  // to 600 MB if we simply added zero — so it takes the generous fallback, the
  // same way an unreadable head count does.
  if (recurrentState === null) return fallback();

  return { bytes: bytes * KV_BLOCK_OVERHEAD + recurrentState, isUpperBound };
}

/**
 * The memory a hybrid model's RECURRENT layers hold (`llama_memory_recurrent`).
 *
 * Those layers hold no attention KV — the loop above skips them, correctly —
 * but they are not free: llama.cpp allocates one SSM state and one convolution
 * state per layer per sequence slot. Formula transcribed from llama.cpp and
 * verified to the byte against three of Destin's own models at `-np auto`:
 * Qwen3.5-2B 77.06 MiB, Qwen3.5-9B 201.00 MiB, Qwen3.8-27B **598.50 MiB** —
 * which is more than the whole working-memory cushion this file adds.
 *
 * It does NOT scale with the context length, so lowering a model's context
 * cannot shrink it; it is counted here rather than in the weights because it is
 * runtime memory, and the size bubble's "Model file" row must keep matching the
 * download. Every Qwen 3.5/3.6/3.8 is a hybrid, curated ones included.
 */
function recurrentStateBytes(header: GgufHeader): number | null {
  const recurrent = header.recurrentLayers?.filter(Boolean).length ?? 0;
  if (recurrent === 0) return 0;
  const dState = header.ssmStateSize;
  const dInner = header.ssmInnerSize;
  const dConv = header.ssmConvKernel;
  const nGroup = Number.isFinite(header.ssmGroupCount) ? header.ssmGroupCount! : 1;
  // Recurrent layers with no SSM shape in the file: null, so the caller falls
  // back rather than adding a zero that would under-count by hundreds of MB.
  // Tested for FINITENESS, not for null: a missing field on a header built by
  // hand is `undefined`, and `undefined * 4` is NaN — which compares false
  // against every threshold and would silently make a model "too large".
  if (![dState, dInner, dConv].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) return null;
  const perLayer = dState! * dInner! + (dConv! - 1) * (dInner! + 2 * nGroup * dState!);
  return recurrent * SEQ_SLOTS * perLayer * RECURRENT_ELEMENT_BYTES;
}

// ---------------------------------------------------------------------------
// Where the numbers on the right-hand side of the comparison come from
// ---------------------------------------------------------------------------

/** One entry of the device list `llama-server --list-devices` reports, as the
 *  engine's `.complete` marker records it (design §A2, EngineDevice in
 *  engine-acquisition.ts). Every field is optional and every value is validated
 *  here, never trusted: this is read out of a JSON file that older installs
 *  wrote before the field existed.
 *
 *  `totalMiB` is `number | null` at the source — null means "the engine printed
 *  a device line this parser could not measure", NOT "this chip has no memory".
 *  A null read as 0 would make every model too-large, which is a hard block on
 *  session creation, so a null device is skipped and the pool falls back. */
export interface EngineMarkerDevice {
  /** The engine's own printed id — `Vulkan0`, `CUDA0`, `ROCm0` — not a backend
   *  name, so anything matching it matches by prefix. */
  backend?: string;
  name?: string;
  totalMiB?: number | null;
  freeMiB?: number | null;
  /** The engine install already classified this device; a software renderer
   *  (llvmpipe, SwiftShader) is the processor wearing a graphics card's name
   *  and reports system RAM as its "VRAM". */
  isGpu?: boolean;
}

export interface MemoryPool {
  /** The ceiling a model is scored against first. */
  poolBytes: number;
  /** True when that ceiling is a graphics chip's own pool, which is the only
   *  case where "fits on your GPU" is a true thing to say. */
  poolIsGpu: boolean;
}

/** A device whose name marks it as a software rasteriser pretending to be a
 *  GPU. Its "pool" is system RAM, so counting it as graphics memory would
 *  double-count the machine's memory and over-state every verdict. */
const SOFTWARE_RASTERISERS = /llvmpipe|swiftshader|softwarerasterizer/i;

/**
 * The memory pool a model is scored against: the first GPU device the installed
 * engine reported (§D2), else system RAM.
 *
 * `devices` is whatever sits in the `.complete` marker's `devices` key — which
 * is ABSENT on every install made before that field existed. That is not an
 * error: we fall back to the dedicated VRAM gpu-detector.ts probed, and failing
 * that to total RAM, and the label then never claims the model "fits on your
 * GPU" because nothing here established that it does.
 */
export function poolFromDevices(
  devices: unknown,
  opts: { totalMemBytes: number; detectedVramBytes?: number | null },
): MemoryPool {
  const list = Array.isArray(devices) ? (devices as EngineMarkerDevice[]) : [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    // The install's own classification wins; the name and backend checks below
    // only catch a marker written by something that did not set the flag.
    if (d.isGpu === false) continue;
    const backend = typeof d.backend === 'string' ? d.backend : '';
    const name = typeof d.name === 'string' ? d.name : '';
    if (/^cpu/i.test(backend)) continue;
    if (SOFTWARE_RASTERISERS.test(name) || SOFTWARE_RASTERISERS.test(backend)) continue;
    // Unmeasured (null) or nonsensical memory is no pool at all — skip to the
    // next device, and fall back below rather than scoring against a zero.
    const total = typeof d.totalMiB === 'number' && Number.isFinite(d.totalMiB) ? d.totalMiB : 0;
    if (total <= 0) continue;
    return { poolBytes: total * MIB, poolIsGpu: true };
  }
  const vram = opts.detectedVramBytes ?? null;
  if (vram !== null && vram > 0) return { poolBytes: vram, poolIsGpu: true };
  return { poolBytes: opts.totalMemBytes, poolIsGpu: false };
}

/**
 * Whether a model in this state is holding memory right now (§D2, R1-14).
 *
 * 'sleeping' is NOT resident: the router frees a slept model's memory after
 * `--sleep-idle-seconds` and reloads it on the next request, so counting it
 * would reserve memory nothing is using and warn about models that are fine.
 * 'loading' IS resident — that memory is being taken this second, and leaving
 * it out is the under-count that tells a user a second model fits while the
 * first is still arriving. That is a DELIBERATE widening of §D2's "loaded rows
 * only": it preserves what shipped before, and the cost is understood — it
 * shrinks the free pool, which is the same side as a hard block, so it can only
 * push a verdict towards a warning for the few seconds a load takes.
 */
export function isResident(state: EngineModelState): boolean {
  return state === 'loaded' || state === 'loading';
}

/** Seams for the three platform readers below, so tests pin each one without a
 *  real /proc, a real vm_stat or a real machine. */
export interface MemoryProbe {
  platform?: NodeJS.Platform;
  readFileSync?: (path: string, encoding: 'utf8') => string;
  runCommand?: (command: string, args: string[]) => string;
  freemem?: () => number;
}

/**
 * Memory this machine could hand a new model RIGHT NOW (§D2).
 *
 * Linux `/proc/meminfo` MemAvailable and macOS `vm_stat` both count memory the
 * kernel would reclaim (page cache, inactive pages) as available, which is the
 * honest figure. Windows has no equivalent, so `os.freemem()` — documented in
 * Node as free memory only — is used there and UNDER-states what is really
 * available: a Windows verdict therefore errs towards warning, never towards a
 * model that will not load.
 */
export function availableMemoryBytes(probe: MemoryProbe = {}): number {
  const platform = probe.platform ?? process.platform;
  const freemem = probe.freemem ?? os.freemem;
  try {
    if (platform === 'linux') {
      const text = (probe.readFileSync ?? fs.readFileSync)('/proc/meminfo', 'utf8');
      const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
      if (m) return Number(m[1]) * 1024;
    } else if (platform === 'darwin') {
      const text = (probe.runCommand ?? defaultRunCommand)('vm_stat', []);
      const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 4096);
      const pages = (label: string) => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1] ?? 0);
      // free + inactive + purgeable: the three classes the kernel can hand over
      // without swapping anything out.
      const total = pages('free') + pages('inactive') + pages('purgeable');
      if (total > 0) return total * pageSize;
    }
  } catch {
    // A reader that failed tells us nothing, so fall through to the number the
    // Node runtime always has. It is smaller than the truth on both platforms,
    // which over-warns rather than over-promises.
  }
  return freemem();
}

function defaultRunCommand(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' });
}

/**
 * The context length one model will actually run with (§D3): its own setting
 * when it has one, else the engine-wide default.
 *
 * `modelsSection` is `config.json`'s `engine.models` — a section written by the
 * per-model settings dialog, which may not exist at all (nothing has saved a
 * setting yet, or this install predates the feature). Everything is validated
 * rather than assumed: an absent or malformed entry means "use the engine's".
 */
export function contextLengthFor(modelId: string, modelsSection: unknown, engineContextSize: number): number {
  const models = modelsSection && typeof modelsSection === 'object' ? (modelsSection as Record<string, unknown>) : null;
  const entry = models?.[modelId];
  const own = entry && typeof entry === 'object' ? (entry as { contextLength?: unknown }).contextLength : undefined;
  if (typeof own === 'number' && Number.isFinite(own) && own > 0) return Math.floor(own);
  return engineContextSize;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export interface FitInputs {
  /** The model's weights on disk. */
  modelBytes: number;
  /** The vision projector that downloads with it, when the model has one.
   *  BOTH callers pass it: `models.quants` before the download (the size the
   *  row shows and the label beside it are then the same number), and
   *  `memoryCheck` at create time, off the cache scan's folder reading (T15).
   *  Qwen2.5-Omni's projector is ~2.6 GB, five times the working-memory cushion
   *  below, so it can flip a verdict on its own. */
  visionBytes?: number;
  /** From kvCacheBytes(), at the context length this model will run with. */
  kvBytes: number;
  kvIsUpperBound?: boolean;
  contextLength: number;
  /** From poolFromDevices(). */
  poolBytes: number;
  poolIsGpu: boolean;
  /** True only when the pool is a discrete card's OWN memory — i.e. memory that
   *  is not also the system RAM below. On a shared-memory machine (this Z13's
   *  Vulkan pool is 84 GiB of the same 121.5 GiB the OS uses) the pool and the
   *  available memory are the SAME BYTES, and adding them would let a 150 GB
   *  model score as merely "tight" on a 121.5 GB machine. */
  poolIsDedicatedVram?: boolean;
  /** Physical RAM. Only used to cap the split tier on a shared-memory machine —
   *  nothing can exceed what the machine physically has. */
  totalMemBytes?: number;
  /** From availableMemoryBytes(). */
  availableBytes: number;
  /** Weights + KV of the models resident right now (`loaded`, never
   *  `sleeping` — a sleeping model's memory has been freed). */
  loadedBytes: number;
}

const ADVICE = "Lower this model's context length in its Settings to shrink this.";

/**
 * The four tiers (§D2, R2-10 as corrected by R3-3), where
 * `need = model + vision + KV + working headroom`:
 *
 *   need ≤ (pool − loaded) × 0.9        → fits      (runs entirely on the GPU)
 *   need ≤ (pool − loaded)              → tight
 *   need ≤ (pool − loaded) + available  → tight     (splits GPU + system RAM)
 *   above that                          → too-large (a hard block)
 *
 * The third tier is the one that must not be got wrong: `-ngl` defaults to
 * `auto`, so a 12 GB model on an 8 GB card with 32 GB of RAM loads and answers
 * fine. Scoring it against the graphics pool alone would refuse to create the
 * session at all.
 */
export function estimateFit(input: FitInputs): FitEstimate {
  const vision = input.visionBytes ?? 0;
  const base = input.modelBytes + vision + WORKING_HEADROOM_BYTES;
  const need = base + input.kvBytes;
  // What is left of the pool once the resident models are counted. Never
  // negative: a machine already over-committed is at zero, not below it.
  const poolFree = Math.max(0, input.poolBytes - input.loadedBytes);

  // The split tier's ceiling: the graphics pool plus what the system has free.
  // On a machine whose "graphics memory" IS system memory those are the same
  // bytes, so the sum is capped at what the machine physically has — otherwise
  // 84 GiB of Vulkan pool + 74 GiB of free RAM would offer 158 GiB on a 121.5
  // GiB laptop. A discrete card really is extra memory, so it is not capped.
  const splitCeiling = input.poolIsDedicatedVram || input.totalMemBytes === undefined
    ? poolFree + input.availableBytes
    : Math.min(poolFree + input.availableBytes, input.totalMemBytes);

  const tierFor = (n: number): FitEstimate['fit'] => {
    if (n <= poolFree * 0.9) return 'fits';
    if (n <= poolFree) return 'tight';
    if (n <= splitCeiling) return 'tight';
    return 'too-large';
  };

  let fit = tierFor(need);
  // "The KV term may raise a verdict to tight, never to too-large" (R1-10): the
  // KV cache is the part of this estimate we compute rather than measure, and
  // too-large is a hard block. So a model that would be blocked ONLY because of
  // its context cache is warned about instead — lowering its context length is
  // exactly what the advice line tells the user to do.
  const clamped = fit === 'too-large' && tierFor(base) !== 'too-large';
  if (clamped) fit = 'tight';

  // Only a model that fits SOMEWHERE really "splits and runs". When the clamp
  // above is what rescued it, its context cache does not fit at all — saying it
  // "splits across your GPU and memory" would be an optimistic reading of a
  // case we just decided not to block.
  const splits = fit === 'tight' && need > poolFree && !clamped;
  return {
    fit,
    label: clamped ? 'Will be tight — lower its context length' : labelFor(fit, input.poolIsGpu, splits),
    breakdown: {
      modelBytes: input.modelBytes,
      contextBytes: input.kvBytes,
      contextLength: input.contextLength,
      ...(vision > 0 ? { visionBytes: vision } : {}),
      ...(input.kvIsUpperBound ? { contextBytesIsUpperBound: true } : {}),
      ...(fit === 'fits' ? {} : { advice: ADVICE }),
    },
  };
}

function labelFor(fit: FitEstimate['fit'], poolIsGpu: boolean, splits: boolean): string {
  if (fit === 'too-large') return 'Too large for this machine';
  if (fit === 'fits') return poolIsGpu ? 'Runs fast — fits on your GPU' : 'Should run well on this machine';
  // A split model RUNS — saying only "tight" would read as a near-failure, and
  // saying "runs well" would hide that it is slower than a model that fits.
  if (splits && poolIsGpu) return 'Runs, but splits across your GPU and memory';
  return 'Will be tight — close other apps first';
}

/** Create-time / swap-time memory guard. Answers "is it safe to load THIS model
 *  given what this machine has free right now?" — distinct from estimateFit,
 *  which asks "could this machine ever run it?". Decision (Destin): BLOCK only
 *  when clearly too large; otherwise WARN, and the warning is dismissible per
 *  model per context length (§D4). PURE — every number is injected. */
export interface MemoryVerdict {
  verdict: 'ok' | 'tight' | 'too-large';
  /** The one numbers line the warning row opens to (R28); '' when ok. This is
   *  the ONLY field the warning row draws today. */
  headline: string;
  /** One sentence of explanation, plus the advice line; '' when ok.
   *  NOTE: nothing renders this — `RuntimeBinding.tsx` shows `headline` alone.
   *  It is kept because it is part of the IPC shape and because the same
   *  sentence is what a "why?" affordance would need; the advice itself does
   *  reach the user, through `breakdown.advice` on the model card (R8). */
  detail: string;
}

export interface MemoryCheckInputs extends FitInputs {
  /** What the user dismissed for this model, if anything (§D4). A dismissal is
   *  only good for the context length it was made at: raising the context —
   *  the model's own setting OR the engine-wide default — asks again, because
   *  the memory the model needs has changed. `too-large` is never dismissible. */
  dismissed?: { contextLength: number } | null;
}

export function checkMemoryForLoad(input: MemoryCheckInputs): MemoryVerdict {
  const vision = input.visionBytes ?? 0;
  const need = input.modelBytes + vision + input.kvBytes + WORKING_HEADROOM_BYTES;
  const fit = estimateFit(input);
  const g = (n: number) => (n / GB).toFixed(1);
  const ctxK = Math.round(input.contextLength / 1024);
  // R28: model + its context memory + what is already loaded, on ONE line. The
  // vision file only appears for a model that has one, so a text-only model's
  // line does not carry a "0.0 GB" nobody can act on.
  const upTo = input.kvIsUpperBound ? 'up to ' : '';
  const headline =
    `${g(input.modelBytes)} GB model`
    + (vision > 0 ? ` + ${g(vision)} GB vision file` : '')
    + ` + ${upTo}${g(input.kvBytes)} GB for ${ctxK}k context`
    + `, with ${g(input.loadedBytes)} GB already loaded.`;

  if (fit.fit === 'too-large') {
    return {
      verdict: 'too-large',
      headline,
      detail:
        `That is more than this computer can give it, even with nothing else running. `
        + `It would fail to load or run extremely slowly. ${ADVICE} `
        + `A smaller model, or a more compressed version of this one (a lower "quant"), also works.`,
    };
  }

  // The available side (§D2): resident models are ALREADY excluded from the
  // memory the system reports as available, so `loadedBytes` is not subtracted
  // again here — doing so would double-count them and warn about models that
  // are fine.
  if (need > input.availableBytes) {
    if (input.dismissed && input.dismissed.contextLength === input.contextLength) {
      // Asked and answered, at this exact context length (§D4).
      return { verdict: 'ok', headline: '', detail: '' };
    }
    return {
      verdict: 'tight',
      headline,
      detail:
        `That is more than the ${g(input.availableBytes)} GB this computer has free right now. `
        + `YouCoded will unload an older model to make room, and if it still does not fit your `
        + `computer falls back to slower disk-backed memory. You can continue. ${ADVICE}`,
    };
  }

  return { verdict: 'ok', headline: '', detail: '' };
}

/** Pre-download disk guard (spec §4.3). Returns null when OK, else a
 *  plain-language refusal. 5% margin covers the in-flight .partial file.
 *  `alreadyOnDiskBytes` is what a resume has already fetched — charging the
 *  FULL size against a resume tells the user "not enough space" for something
 *  that fits, and the obvious reaction is to delete the partial, destroying
 *  the very thing that made it fit (2026-08-26). */
export function checkDiskSpace(downloadBytes: number, freeBytes: number, alreadyOnDiskBytes = 0): string | null {
  const needBytes = Math.max(0, downloadBytes - alreadyOnDiskBytes);
  if (freeBytes >= needBytes * 1.05) return null;
  const needGb = (needBytes / GB).toFixed(1);
  const freeGb = (freeBytes / GB).toFixed(1);
  return `Not enough free space: this download needs about ${needGb} GB but only ${freeGb} GB is free.`;
}
