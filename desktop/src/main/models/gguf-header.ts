// GGUF header reader (design §D1). Reads a model file's metadata KV table —
// magic, version, key/value pairs — and NEVER the tensor data behind it, so the
// memory estimator can size a KV cache from the model's real shape (layers, KV
// heads, head widths, which layers slide) instead of the flat 2 GB constant
// fit-estimator.ts has used until now.
//
// WHY it must read from the network as well as disk: the "will this fit?"
// question is answered on the model CARD, before a single byte is downloaded.
// The remote loader therefore walks the file in 1 MB HTTP Range steps and stops
// the moment the keys it wants are behind it — measured on the five GGUFs in
// ~/.cache/llama.cpp and on all eleven curated repos, every key below sits
// inside the first 2.2 KB, while the tokenizer arrays that follow run past
// 4 MB. probe-headers.mjs pins that against the live repos on every bump.
//
// WHY the honesty flag: `contextBytesIsUpperBound` is set whenever the reader
// could not fully understand the header — an unknown architecture, a key in a
// type it does not handle, or a truncated read. The caller then says "up to
// N GB" rather than stating a precise number it cannot stand behind (§D2's "no
// fake precision" rule).
//
// ---------------------------------------------------------------------------
// ONE KNOWN GAP, FOR WHOEVER BUILDS THE ESTIMATOR ON TOP OF THIS (§D2 / T11)
// ---------------------------------------------------------------------------
// A sliding layer's real cache is BIGGER than `min(context, slidingWindow)`.
// llama-kv-cache-iswa.cpp:52 allocates
// `GGML_PAD(min(size_base, n_swa + n_ubatch), 256)`, and `n_ubatch` defaults to
// 512 — so every sliding layer holds 512 extra tokens' worth, rounded up to a
// multiple of 256. Measured against the curated headers that is about 170 MB
// unaccounted on gemma-4-12b and 105 MB on gemma-4-26B-A4B. Small beside a
// 12 GB model, but it lands on the wrong side of the fits/tight boundary, which
// is the one place a small error changes what the user sees. It is arithmetic
// over what this file reports, not a key this file can read, so it belongs in
// the estimator.
//
// (The other gap found in the same review — `attention.recurrent_layers` — is
// fixed here rather than worked around there: which layers are recurrent is a
// statement about the FILE, so it is this reader's job. See `recurrentLayers`.)
// ---------------------------------------------------------------------------
import * as fs from 'fs';
import * as path from 'path';

const MAGIC = 'GGUF';
// v2 and v3 lay the metadata table out identically — only v1 used 32-bit
// lengths, which this reader would mis-walk. Refusing v2 would refuse
// TheBloke's Llama-2 GGUFs, still among the most-downloaded on the Hub, whose
// headers this exact parser reads correctly (verified 2026-09-05:
// arch=llama layers=32 kv_heads=32 dK/dV=128/128 ctx=4096, exact).
const SUPPORTED_VERSIONS = [2, 3];

/** One HTTP Range step / one local read step. */
export const CHUNK_BYTES = 1024 * 1024;
/** Hard stop. A header that has not resolved inside this much file is reported
 *  as an upper bound rather than downloaded further — the tokenizer arrays of a
 *  large-vocabulary model are tens of megabytes and none of it is useful here. */
const MAX_HEADER_BYTES = 16 * CHUNK_BYTES;

// GGUF metadata value types (ggml's `gguf_type`). The number is the value's
// size in bytes; -1 means variable-length, i.e. it must be walked rather than
// skipped by arithmetic. An id absent from this table is a GGUF version we do
// not know how to walk at all — see UnknownTypeError below.
const TYPE_SIZES: Record<number, number> = {
  0: 1, // uint8
  1: 1, // int8
  2: 2, // uint16
  3: 2, // int16
  4: 4, // uint32
  5: 4, // int32
  6: 4, // float32
  7: 1, // bool
  8: -1, // string
  9: -1, // array
  10: 8, // uint64
  11: 8, // int64
  12: 8, // float64
};
const T_BOOL = 7;
const T_STRING = 8;
const T_ARRAY = 9;

/** The architecture-relative keys this reader collects. Everything else in the
 *  table is walked past without being materialised — `tokenizer.ggml.tokens` is
 *  a quarter of a million strings and allocating it would cost more than the
 *  whole estimate. */
const WANTED = new Set([
  'block_count',
  'context_length',
  'embedding_length',
  'attention.head_count',
  'attention.head_count_kv',
  'attention.key_length',
  'attention.value_length',
  'attention.key_length_swa',
  'attention.value_length_swa',
  'attention.sliding_window',
  'attention.sliding_window_pattern',
  'attention.shared_kv_layers',
  'attention.recurrent_layers',
  'full_attention_interval',
  'nextn_predict_layers',
  // The recurrent (Mamba-style) layers of a hybrid model do not hold an
  // attention cache, but they DO hold a state of their own, and it is not
  // small — 598 MiB on Qwen3.8-27B. These four keys are what sizes it.
  'ssm.conv_kernel',
  'ssm.state_size',
  'ssm.inner_size',
  'ssm.group_count',
]);

/** Architectures whose sliding-window pattern starts with a DENSE layer.
 *  Read straight off llama.cpp `src/models/*.cpp` (the third argument to
 *  `set_swa_pattern`, which defaults to false) — every other architecture that
 *  calls it starts with sliding layers. Pinned in gguf-header.test.ts. */
export const DENSE_FIRST_ARCHITECTURES = new Set(['cohere2moe', 'smallthinker', 'modern-bert']);

/** The pattern period llama.cpp assumes when a file carries a sliding window
 *  but no `sliding_window_pattern` key. Also read off `src/models/*.cpp`; an
 *  architecture missing from this table is one whose layer map we cannot
 *  reproduce, and it sets the upper-bound flag rather than guessing. */
export const SWA_PATTERN_DEFAULTS: Record<string, number> = {
  afmoe: 4,
  cohere2: 4,
  cohere2moe: 4,
  'exaone-moe': 4,
  exaone4: 4,
  gemma2: 2,
  gemma3: 6,
  gemma3n: 5,
  'gemma-embedding': 6,
  'gpt-oss': 2,
  llama4: 4,
  mellum: 4,
  'modern-bert': 3,
  olmo2: 4,
  plamo3: 8,
  smallthinker: 4,
};

/** Architectures where llama.cpp overrides the file's own
 *  `sliding_window_pattern`. phi3.cpp does the opposite of what its file asks:
 *  when it FINDS a sliding window it logs a warning and turns SWA back off
 *  (`swa_type = NONE; n_swa = 0; set_swa_pattern(1)`) — a deliberate upstream
 *  workaround for converters that populate the key wrongly. A period of 1
 *  means every layer is dense, so a phi3 model that advertises a window still
 *  has no sliding layers. Believing its key instead would under-count KV,
 *  which is the one direction that can turn a "tight" verdict into a wrong
 *  "fits". */
const SWA_PATTERN_FIXED: Record<string, number> = { phi3: 1 };

/** Architectures where llama.cpp enables sliding attention at ONE layer count
 *  only. exaone4.cpp wraps its whole SWA block in `if (n_layer() == 64)`, so a
 *  smaller EXAONE 4 has no sliding layers even though its file still carries a
 *  sliding_window key — applying the period anyway would under-count its
 *  cache. */
const SWA_LAYER_GATE: Record<string, number> = { exaone4: 64 };

/** What the reader could pull out of one model file's metadata. Every numeric
 *  field is null when the file did not carry it (never a guessed default). */
export interface GgufHeader {
  architecture: string;
  blockCount: number | null;
  contextLength: number | null;
  /** Attention heads. Gemma 4's larger models write these PER LAYER (measured
   *  2026-09-05: gemma-4-12b's `head_count_kv` is a 48-element int32 array —
   *  8 KV heads on its sliding layers, 1 on its full-attention layers), which
   *  is what `get_key_or_arr` reads in llama.cpp. When the file gives an array
   *  whose entries differ, the scalar below is its MAXIMUM, so a consumer that
   *  reads only the scalar over-estimates the KV cache rather than under-
   *  estimating it, and `headCountKvLayers` carries the exact per-layer truth. */
  headCount: number | null;
  headCountLayers: number[] | null;
  headCountKv: number | null;
  headCountKvLayers: number[] | null;
  embeddingLength: number | null;
  /** Per-head key/value width. Resolved: the explicit `attention.key_length` /
   *  `.value_length` when present, else `embedding_length / head_count`. */
  keyLength: number | null;
  valueLength: number | null;
  /** Gemma 4 gives its sliding layers HALF-width keys and values (256 against a
   *  full-attention 512), so a sliding layer costs half what a full one does. */
  keyLengthSwa: number | null;
  valueLengthSwa: number | null;
  /** How many tokens a sliding layer keeps. */
  slidingWindow: number | null;
  /** Scalar form of the pattern: "every Nth layer is full attention". */
  slidingWindowPattern: number | null;
  /** Per-layer form of the SAME key (Gemma 4 writes a 35-element bool array).
   *  true = that layer slides. */
  slidingWindowPatternLayers: boolean[] | null;
  /** Qwen3.5/3.6: layers where `(il + 1) % n != 0` are linear/recurrent and
   *  store no attention KV at all. Prefer `recurrentLayers` below, which
   *  already applies this and the key that overrides it. */
  fullAttentionInterval: number | null;
  /** Extra prediction (MTP/NextN) blocks appended past the main stack. They are
   *  counted in `blockCount` but are never recurrent, so the derivation below
   *  has to exclude them. */
  nextnPredictLayers: number | null;
  /** The resolved per-layer recurrent map (true = this layer is linear /
   *  recurrent and stores NO attention KV at all). Straight off
   *  `attention.recurrent_layers` when the file has it — llama.cpp's
   *  qwen35.cpp reads that array IN PREFERENCE TO `full_attention_interval` —
   *  otherwise derived from the interval. null = no such layers, or the reader
   *  could not tell. */
  recurrentLayers: boolean[] | null;
  /** Gemma 4: the last n layers reuse an earlier layer's KV and store none. */
  sharedKvLayers: number | null;
  /** The shape of a recurrent (Mamba/SSM) layer's own state, for the hybrid
   *  models — every Qwen 3.5/3.6/3.8 is one. llama.cpp allocates a separate
   *  `llama_memory_recurrent` for exactly the layers `recurrentLayers` marks,
   *  and it is real memory the estimator must count: measured 77 MiB on
   *  Qwen3.5-2B, 201 MiB on 9B and 598 MiB on 27B. All null on a model with no
   *  recurrent layers. */
  ssmConvKernel: number | null;
  ssmStateSize: number | null;
  ssmInnerSize: number | null;
  ssmGroupCount: number | null;
  /** The resolved per-layer sliding map (true = this layer slides), from the
   *  bool array when the file has one, else from the scalar period and the
   *  architecture's dense-first rule. null = the reader could not build one. */
  slidingLayers: boolean[] | null;
  /** True when anything above could not be read as expected. The caller must
   *  present its number as "up to", never as an exact figure. */
  contextBytesIsUpperBound: boolean;
  /** The offset just past the LAST architecture key — i.e. how far into the
   *  file a reader has to go to learn everything the estimator wants.
   *  probe-headers.mjs asserts it stays inside one CHUNK_BYTES step for every
   *  curated repo, which is what makes the single-range-request loader safe. */
  archBytes: number;
}

/** llama.cpp's `llama_hparams::set_swa_pattern`, transcribed exactly.
 *  `n_pattern` counts layers per repeat: 0 = every layer slides, 1 = none do.
 *  With dense_first the repeat starts on the dense layer instead of ending on
 *  it. Pinned against the C++ in gguf-header.test.ts. */
export function swaPatternMask(nLayers: number, nPattern: number, denseFirst: boolean): boolean[] {
  const out: boolean[] = [];
  for (let il = 0; il < nLayers; il++) {
    out.push(nPattern === 0 || (denseFirst ? il % nPattern !== 0 : il % nPattern < nPattern - 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pure parser
// ---------------------------------------------------------------------------

/** Thrown when a read runs off the end of the buffer we have so far. It is not
 *  a failure — it is the loaders' signal to fetch another chunk. */
class TruncatedError extends Error {}
/** Thrown when the table contains a value type this reader cannot even measure,
 *  so it cannot walk past it to reach the keys after it. */
class UnknownTypeError extends Error {}

class Cursor {
  offset = 0;
  private buf: Buffer;

  // Written out rather than declared as a constructor parameter property so
  // this module can be imported straight from source by test-engine's probes,
  // which run under plain Node's strip-only TypeScript support.
  constructor(buf: Buffer) { this.buf = buf; }

  private need(n: number): number {
    if (this.offset + n > this.buf.length) throw new TruncatedError();
    const at = this.offset;
    this.offset += n;
    return at;
  }

  u32(): number { return this.buf.readUInt32LE(this.need(4)); }

  // GGUF v3 lengths and counts are u64. Model headers never approach 2^53, so
  // reading them as JS numbers is exact; a file claiming more is malformed and
  // is caught by the bounds check in need().
  u64(): number { return Number(this.buf.readBigUInt64LE(this.need(8))); }

  str(): string {
    const len = this.u64();
    const at = this.need(len);
    return this.buf.toString('utf8', at, at + len);
  }

  /** Read one value of `type`, or walk past it when `keep` is false. Returns
   *  null for a value that was walked past or that has no numeric/bool form. */
  value(type: number, keep: boolean): number | boolean | string | (number | boolean)[] | null {
    const size = TYPE_SIZES[type];
    if (size === undefined) throw new UnknownTypeError(`GGUF value type ${type}`);
    if (size > 0) {
      const at = this.need(size);
      if (!keep) return null;
      switch (type) {
        case 0: return this.buf.readUInt8(at);
        case 1: return this.buf.readInt8(at);
        case 2: return this.buf.readUInt16LE(at);
        case 3: return this.buf.readInt16LE(at);
        case 4: return this.buf.readUInt32LE(at);
        case 5: return this.buf.readInt32LE(at);
        case 6: return this.buf.readFloatLE(at);
        case T_BOOL: return this.buf.readUInt8(at) !== 0;
        case 10: return Number(this.buf.readBigUInt64LE(at));
        case 11: return Number(this.buf.readBigInt64LE(at));
        case 12: return this.buf.readDoubleLE(at);
        default: return null;
      }
    }
    if (type === T_STRING) {
      const s = this.str();
      return keep ? s : null;
    }
    // The only other variable-length type is an array: element type, count,
    // then the elements.
    if (type !== T_ARRAY) throw new UnknownTypeError(`GGUF value type ${type}`);
    const elemType = this.u32();
    // Refuse an array OF arrays before recursing into it. GGUF does not define
    // one, and a crafted (or corrupt) file can nest thousands deep at twelve
    // bytes a level — which blows the JS call stack and would put a raw
    // "Maximum call stack size exceeded" in front of the user. Routing it into
    // UnknownTypeError instead reports the file as an upper bound, which is the
    // honest answer for bytes we cannot walk.
    if (elemType === T_ARRAY) throw new UnknownTypeError('a nested GGUF array');
    const count = this.u64();
    const elemSize = TYPE_SIZES[elemType];
    if (elemSize === undefined) throw new UnknownTypeError(`GGUF array element type ${elemType}`);
    if (!keep && elemSize > 0) {
      // Fixed-width elements can be skipped by arithmetic — this is what lets
      // the reader step over `tokenizer.ggml.token_type` (a quarter-million
      // int32s) without ever holding it, or fetching it.
      this.need(elemSize * count);
      return null;
    }
    const out: (number | boolean)[] = [];
    for (let i = 0; i < count; i++) {
      const v = this.value(elemType, keep);
      if (typeof v === 'boolean' || typeof v === 'number') out.push(v);
    }
    // Numbers and bools are the only element kinds any wanted key uses (Gemma 4
    // writes its sliding pattern as bools and its KV head counts as int32s);
    // anything else that was kept comes back as an empty array, which the
    // caller reads as "a shape I do not handle".
    return keep ? out : null;
  }
}

export interface GgufParseResult {
  header: GgufHeader;
  /** True when the whole KV table was read, or when everything the estimator
   *  needs was read and the architecture's run of keys had already ended. */
  complete: boolean;
}

function emptyHeader(architecture: string): GgufHeader {
  return {
    architecture,
    blockCount: null, contextLength: null,
    headCount: null, headCountLayers: null, headCountKv: null, headCountKvLayers: null,
    embeddingLength: null, keyLength: null, valueLength: null,
    keyLengthSwa: null, valueLengthSwa: null, slidingWindow: null,
    slidingWindowPattern: null, slidingWindowPatternLayers: null,
    fullAttentionInterval: null, nextnPredictLayers: null,
    recurrentLayers: null, sharedKvLayers: null, slidingLayers: null,
    ssmConvKernel: null, ssmStateSize: null, ssmInnerSize: null, ssmGroupCount: null,
    contextBytesIsUpperBound: false, archBytes: 0,
  };
}

/**
 * Parse as much of a GGUF metadata table as `buf` holds.
 *
 * Throws only when the bytes are not a GGUF v3 header at all — a real,
 * specific message, never a guessed cause. Everything else (a truncated
 * buffer, a key in an unexpected type, an architecture with no known layer
 * map) comes back as a header with `contextBytesIsUpperBound: true`.
 */
export function parseGgufHeader(buf: Buffer): GgufParseResult {
  if (buf.length < 8) throw new Error(`Not a GGUF file: only ${buf.length} bytes to read.`);
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== MAGIC) throw new Error(`Not a GGUF file: expected the magic "${MAGIC}", found ${JSON.stringify(magic)}.`);
  const version = buf.readUInt32LE(4);
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(`Unsupported GGUF version ${version} — this reader understands versions ${SUPPORTED_VERSIONS.join(' and ')}.`);
  }

  const cur = new Cursor(buf);
  cur.offset = 8;
  const h = emptyHeader('');
  const raw = new Map<string, number | boolean | string | (number | boolean)[]>();
  let kvCount = 0;
  let complete = false;
  // Every key the estimator wants sits in the FIRST run of architecture keys,
  // ahead of the tokenizer block. Architecture keys as a whole are NOT all
  // contiguous — Qwen3.8-Flash-Next writes `qwen4exp.ple.image_token_id` at
  // offset 10,945,998, ten megabytes past the tokenizer — but nothing in WANTED
  // has ever been out there, which is the claim probe-headers.mjs re-checks
  // against the live repos on every bump. So once a key with a different prefix
  // follows that first run, running out of bytes is no longer a problem;
  // until then, it is.
  let sawArchKey = false;
  let archRunEnded = false;
  let archKeysEnd = 0;

  try {
    cur.u64(); // tensor count — the tensor table itself is never read
    kvCount = cur.u64();
    for (let i = 0; i < kvCount; i++) {
      const key = cur.str();
      const type = cur.u32();
      if (key === 'general.architecture') {
        const v = cur.value(type, true);
        h.architecture = typeof v === 'string' ? v : '';
        // An architecture that is not a plain string means we cannot even name
        // the model's key prefix; nothing below can be trusted.
        if (typeof v !== 'string') h.contextBytesIsUpperBound = true;
        continue;
      }
      const prefix = h.architecture ? `${h.architecture}.` : null;
      const isArchKey = prefix !== null && key.startsWith(prefix);
      if (isArchKey) sawArchKey = true;
      else if (sawArchKey) archRunEnded = true;
      const suffix = isArchKey ? key.slice(prefix.length) : '';
      const keep = isArchKey && WANTED.has(suffix);
      const v = cur.value(type, keep);
      if (keep && v !== null) raw.set(suffix, v);
      if (isArchKey) archKeysEnd = cur.offset;
    }
    complete = true;
  } catch (e) {
    if (e instanceof UnknownTypeError) {
      // We cannot measure this value, so we cannot walk past it to reach any
      // key after it. Report what we have as an upper bound.
      h.contextBytesIsUpperBound = true;
    } else if (e instanceof TruncatedError) {
      // Out of bytes. Fine if the architecture's run of keys is already behind
      // us; otherwise the caller must fetch another chunk.
      if (archRunEnded) complete = true;
    } else {
      throw e;
    }
  }

  h.archBytes = archKeysEnd || cur.offset;
  applyRaw(h, raw);
  // §D1 lists a truncated read as one of the conditions. The two loaders below
  // re-parse with more bytes and never return an incomplete header, but this
  // function is exported: a direct caller must not be handed a half-read header
  // stamped "exact".
  if (!complete) h.contextBytesIsUpperBound = true;
  return { header: h, complete };
}

/** Read one collected key as a whole number, flagging any other shape. */
function num(h: GgufHeader, raw: Map<string, unknown>, suffix: string): number | null {
  if (!raw.has(suffix)) return null;
  const v = raw.get(suffix);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // The key was there but in a type this reader does not turn into a number —
  // exactly the case §D1 says must flag rather than be silently dropped.
  h.contextBytesIsUpperBound = true;
  return null;
}

/** Read a key that llama.cpp's `get_key_or_arr` accepts in either form: one
 *  number for the whole model, or one per layer. A uniform array collapses to
 *  the scalar; a varying one keeps both (see the note on `headCount`). */
function numOrLayers(h: GgufHeader, raw: Map<string, unknown>, suffix: string): { scalar: number | null; layers: number[] | null } {
  if (!raw.has(suffix)) return { scalar: null, layers: null };
  const v = raw.get(suffix);
  if (typeof v === 'number' && Number.isFinite(v)) return { scalar: v, layers: null };
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    const layers = v as number[];
    const uniform = layers.every((x) => x === layers[0]);
    return uniform ? { scalar: layers[0], layers: null } : { scalar: Math.max(...layers), layers };
  }
  h.contextBytesIsUpperBound = true;
  return { scalar: null, layers: null };
}

function applyRaw(h: GgufHeader, raw: Map<string, number | boolean | string | (number | boolean)[]>): void {
  h.blockCount = num(h, raw, 'block_count');
  h.contextLength = num(h, raw, 'context_length');
  const heads = numOrLayers(h, raw, 'attention.head_count');
  h.headCount = heads.scalar;
  h.headCountLayers = heads.layers;
  // llama.cpp seeds n_head_kv_arr from n_head_arr before looking for the KV
  // key, so a model that omits head_count_kv is plain multi-head attention.
  const kvHeads = numOrLayers(h, raw, 'attention.head_count_kv');
  h.headCountKv = kvHeads.scalar ?? h.headCount;
  h.headCountKvLayers = kvHeads.layers ?? (kvHeads.scalar === null ? h.headCountLayers : null);
  // A per-layer array that does not cover every layer would hand the estimator
  // `undefined` for the layers past its end — NaN, and a nonsense figure on the
  // model card. Drop it and fall back to the scalar (the array's maximum, so an
  // over-count), exactly as the sliding pattern below is handled.
  const shortArray = (a: number[] | null) => a !== null && h.blockCount !== null && a.length !== h.blockCount;
  if (shortArray(h.headCountLayers) || shortArray(h.headCountKvLayers)) {
    h.headCountLayers = null;
    h.headCountKvLayers = null;
    h.contextBytesIsUpperBound = true;
  }
  h.embeddingLength = num(h, raw, 'embedding_length');
  h.keyLengthSwa = num(h, raw, 'attention.key_length_swa');
  h.valueLengthSwa = num(h, raw, 'attention.value_length_swa');
  h.slidingWindow = num(h, raw, 'attention.sliding_window');
  h.fullAttentionInterval = num(h, raw, 'full_attention_interval');
  h.nextnPredictLayers = num(h, raw, 'nextn_predict_layers');
  h.sharedKvLayers = num(h, raw, 'attention.shared_kv_layers');
  h.ssmConvKernel = num(h, raw, 'ssm.conv_kernel');
  h.ssmStateSize = num(h, raw, 'ssm.state_size');
  h.ssmInnerSize = num(h, raw, 'ssm.inner_size');
  h.ssmGroupCount = num(h, raw, 'ssm.group_count');

  // Per-head width: the explicit key when the file has one, else the classic
  // embedding ÷ heads. Falling back silently is safe — it is what llama.cpp
  // itself does for models that predate the explicit keys.
  //
  // The DIVISOR is the SMALLEST head count, not `headCount`. `headCount` holds
  // the maximum, which is the safe direction everywhere it is used as a
  // multiplier — but in a denominator the max yields the NARROWEST possible
  // head, i.e. an under-count of the cache, the one direction that can turn a
  // "tight" verdict into a wrong "fits". And one width for a model whose head
  // count varies per layer is an estimate however it is computed, so it is
  // reported as an upper bound rather than printed as a fact.
  const divisor = h.headCountLayers ? Math.min(...h.headCountLayers) : h.headCount;
  const fallback = h.embeddingLength !== null && divisor ? h.embeddingLength / divisor : null;
  const explicitK = num(h, raw, 'attention.key_length');
  const explicitV = num(h, raw, 'attention.value_length');
  h.keyLength = explicitK ?? fallback;
  h.valueLength = explicitV ?? fallback;
  if (h.headCountLayers !== null && (explicitK === null || explicitV === null)) {
    h.contextBytesIsUpperBound = true;
  }

  // The two shapes of sliding_window_pattern (§D1). A scalar says "every Nth
  // layer is full attention"; Gemma 4 writes a per-layer bool array instead,
  // and a reader expecting a u32 here would read that array's header as a
  // number.
  const pattern = raw.get('attention.sliding_window_pattern');
  if (typeof pattern === 'number') {
    h.slidingWindowPattern = pattern;
  } else if (Array.isArray(pattern) && pattern.length > 0 && pattern.every((x) => typeof x === 'boolean')) {
    h.slidingWindowPatternLayers = pattern as boolean[];
  } else if (pattern !== undefined) {
    h.contextBytesIsUpperBound = true;
  }

  h.slidingLayers = resolveSlidingLayers(h);
  h.recurrentLayers = resolveRecurrentLayers(h, raw.get('attention.recurrent_layers'));
}

/** Which layers are linear/recurrent, i.e. hold no attention KV. Transcribed
 *  from llama.cpp's qwen35.cpp: it reads `attention.recurrent_layers` FIRST and
 *  only falls back to `full_attention_interval` when that key is absent, so a
 *  file using the array form must not be scored off the interval. */
function resolveRecurrentLayers(h: GgufHeader, fromFile: unknown): boolean[] | null {
  if (fromFile !== undefined) {
    const ok = Array.isArray(fromFile) && fromFile.length > 0 && fromFile.every((x) => typeof x === 'boolean');
    if (!ok) {
      // The key is there in a shape we do not read. Counting every layer as
      // attention over-states the cache, which is the safe direction — but it
      // is an estimate, so say so.
      h.contextBytesIsUpperBound = true;
      return null;
    }
    const flags = fromFile as boolean[];
    if (h.blockCount !== null && flags.length !== h.blockCount) {
      h.contextBytesIsUpperBound = true;
      return null;
    }
    return flags;
  }
  // No array: derive from the interval, but ONLY when the file actually states
  // one. llama.cpp defaults it to 4 inside the Qwen loaders; applying that to
  // an architecture we have not identified would invent recurrent layers and
  // under-count the cache.
  const interval = h.fullAttentionInterval;
  if (interval === null || interval <= 0 || h.blockCount === null) return null;
  // `block_count` is llama.cpp's n_layer_all; the MTP blocks at the end are
  // outside n_layer() and are dense attention, never recurrent.
  const mainLayers = h.blockCount - (h.nextnPredictLayers ?? 0);
  return Array.from({ length: h.blockCount }, (_, il) => il < mainLayers && (il + 1) % interval !== 0);
}

function resolveSlidingLayers(h: GgufHeader): boolean[] | null {
  const layers = h.blockCount;
  if (h.slidingWindowPatternLayers) {
    // The array IS the answer — no architecture table involved. It must still
    // cover every layer; a short one would silently make late layers full.
    if (layers !== null && h.slidingWindowPatternLayers.length !== layers) {
      h.contextBytesIsUpperBound = true;
      return null;
    }
    return h.slidingWindowPatternLayers;
  }
  if (layers === null || layers <= 0) return null;

  // Some families only switch sliding attention on at one size (see
  // SWA_LAYER_GATE). At any other size there are no sliding layers at all —
  // an exact answer, not an upper bound.
  const gate = SWA_LAYER_GATE[h.architecture];
  if (gate !== undefined && layers !== gate) return null;

  const fixed = SWA_PATTERN_FIXED[h.architecture];
  if (fixed !== undefined) return swaPatternMask(layers, fixed, DENSE_FIRST_ARCHITECTURES.has(h.architecture));

  const denseFirst = DENSE_FIRST_ARCHITECTURES.has(h.architecture);
  if (h.slidingWindowPattern !== null) return swaPatternMask(layers, h.slidingWindowPattern, denseFirst);

  // No pattern key. A file with no sliding window at all simply has no sliding
  // layers; one that HAS a window but no pattern follows its architecture's
  // built-in period, and an architecture we do not have that period for is one
  // whose layer map we would be inventing.
  if (h.slidingWindow === null || h.slidingWindow <= 0) return null;
  const period = SWA_PATTERN_DEFAULTS[h.architecture];
  if (period === undefined) {
    h.contextBytesIsUpperBound = true;
    return null;
  }
  return swaPatternMask(layers, period, denseFirst);
}

// ---------------------------------------------------------------------------
// The two loaders
// ---------------------------------------------------------------------------

type ChunkReader = (offset: number, length: number) => Promise<Buffer>;

/** Walk a file in CHUNK_BYTES steps until the parser says it has what it needs.
 *  Shared by both loaders so the stop condition can only ever be defined once. */
async function loadInChunks(read: ChunkReader, totalBytes: number | null): Promise<GgufHeader> {
  let buf: Buffer = Buffer.alloc(0);
  for (;;) {
    const chunk = await read(buf.length, CHUNK_BYTES);
    if (chunk.length === 0) break; // end of file — parse what we have
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    const { header, complete } = parseGgufHeader(buf);
    if (complete) return header;
    if (buf.length >= MAX_HEADER_BYTES || (totalBytes !== null && buf.length >= totalBytes)) {
      // Give up on precision rather than on the answer: the caller still gets
      // every key we did read, marked as an upper bound.
      header.contextBytesIsUpperBound = true;
      return header;
    }
  }
  const { header } = parseGgufHeader(buf);
  header.contextBytesIsUpperBound = true;
  return header;
}

/** Read a GGUF header off local disk. */
export async function readLocalGgufHeader(filePath: string): Promise<GgufHeader> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const size = (await fd.stat()).size;
    return await loadInChunks(async (offset, length) => {
      const want = Math.min(length, Math.max(0, size - offset));
      if (want === 0) return Buffer.alloc(0);
      const out = Buffer.alloc(want);
      const { bytesRead } = await fd.read(out, 0, want, offset);
      return out.subarray(0, bytesRead);
    }, size);
  } finally {
    await fd.close();
  }
}

type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean; status: number;
  headers: { get: (name: string) => string | null };
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

const FETCH_TIMEOUT_MS = 15_000;

/** Read a GGUF header over HTTP without downloading the model. Each step is one
 *  Range request; in practice exactly one is made, because every architecture
 *  key sits in the first few kilobytes. */
export async function fetchRemoteGgufHeader(url: string, fetchImpl: FetchLike = fetch as any): Promise<GgufHeader> {
  return loadInChunks(async (offset, length) => {
    const end = offset + length - 1;
    const res = await fetchImpl(url, {
      headers: { Range: `bytes=${offset}-${end}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 416 = we asked past the end of the file; that is the natural stop.
    if (res.status === 416) return Buffer.alloc(0);
    if (!res.ok) throw new Error(`Could not read this model's header from Hugging Face: HTTP ${res.status}.`);
    if (res.status !== 206) {
      // The server ignored the Range header and is about to hand back the whole
      // file. Refuse BEFORE reading a byte of it: this runs in the Electron main
      // process, and buffering a multi-gigabyte GGUF freezes the window or gets
      // the app OOM-killed, taking the user's live session with it. Any repo on
      // Hugging Face can be searched and read, so the server is not ours.
      //
      // A MISSING or unparseable content-length is the same refusal, not a pass
      // (fixed 2026-09-05, measured buffering 8 MB and climbing): a chunked
      // response has no length, and "I won't tell you how big it is" from a
      // server that has already ignored the range is not a reason to trust it.
      const advertised = res.headers.get('content-length');
      const len = advertised === null ? NaN : Number(advertised);
      if (!Number.isFinite(len) || len <= 0 || len > MAX_HEADER_BYTES) {
        throw new Error(
          `Could not read this model's header: the server ignored the range request ` +
          `(HTTP ${res.status}, ${advertised === null ? 'no content-length' : `${advertised} bytes`}).`,
        );
      }
    }
    // Through a Uint8Array view so the result is a Buffer over a plain
    // ArrayBuffer, which is what the chunk reader's signature promises.
    return Buffer.from(new Uint8Array(await res.arrayBuffer()));
  }, null);
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

const CACHE_FILE = 'gguf-headers-cache.json';
const CACHE_VERSION = 1;

interface CacheEntry { stamp: string; header: GgufHeader }
interface CacheFile { version: number; entries: Record<string, CacheEntry> }

/** Freshness stamp for a Hugging Face repo: the default quant's sha. A repo
 *  that re-uploads its files gets a new sha and so a fresh read. */
export function hfHeaderStamp(sha256: string | null): string { return `sha:${sha256 ?? 'none'}`; }
/** Freshness stamp for a file on disk: its modification time. */
export function localHeaderStamp(mtimeMs: number): string { return `mtime:${Math.round(mtimeMs)}`; }

/**
 * One parsed header per repo (or per local model), stored beside
 * curated-models-cache.json in userData. Parsing costs a network round trip, so
 * the Local Models panel would otherwise re-fetch a dozen headers every time it
 * opens. Best-effort throughout: a corrupt or unwritable cache is a slower
 * panel, never an error the user sees.
 */
export class GgufHeaderCache {
  private cachePath: string;
  private data: CacheFile | null = null;

  constructor(cacheDir: string) {
    this.cachePath = path.join(cacheDir, CACHE_FILE);
  }

  private load(): CacheFile {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (parsed?.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
        this.data = { version: CACHE_VERSION, entries: parsed.entries };
        return this.data;
      }
    } catch { /* absent or corrupt — start empty */ }
    this.data = { version: CACHE_VERSION, entries: {} };
    return this.data;
  }

  /** The cached header for `id`, or null when there is none or the model has
   *  changed since (`stamp` differs). */
  get(id: string, stamp: string): GgufHeader | null {
    const entry = this.load().entries[id];
    return entry && entry.stamp === stamp ? entry.header : null;
  }

  /** Replace this model's single entry. One header per repo, by design: a repo
   *  has one default quant and that quant's first file is the one we read. */
  set(id: string, stamp: string, header: GgufHeader): void {
    const data = this.load();
    data.entries[id] = { stamp, header };
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(data));
    } catch { /* cache write is best-effort */ }
  }
}
