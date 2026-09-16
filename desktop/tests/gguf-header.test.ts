// Guards for the GGUF header reader (design §D1). Every fixture below is the
// shape of a REAL file: the numbers were read out of Destin's own GGUFs in
// ~/.cache/llama.cpp on 2026-09-05 with a throwaway dumper, and the layer rules
// were transcribed from llama.cpp's own source at /home/destin/src/llama.cpp.
//
// The fixtures are synthetic on purpose. The real files are 2–5 GB and are not
// on CI; probe-headers.mjs is the half of this that runs against real bytes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseGgufHeader, swaPatternMask, readLocalGgufHeader, fetchRemoteGgufHeader,
  GgufHeaderCache, hfHeaderStamp, localHeaderStamp,
  DENSE_FIRST_ARCHITECTURES, SWA_PATTERN_DEFAULTS, CHUNK_BYTES,
} from '../src/main/models/gguf-header';

// ---------------------------------------------------------------------------
// A minimal GGUF v3 writer, so a fixture is a list of key/value pairs.
// ---------------------------------------------------------------------------
const T = { u32: 4, i32: 5, f32: 6, bool: 7, string: 8, array: 9, u64: 10 } as const;

interface Kv { key: string; type: number; value: any; elemType?: number }

function u64(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function str(s: string): Buffer { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u64(b.length), b]); }

function scalar(type: number, v: any): Buffer {
  switch (type) {
    case T.u32: return u32(v);
    case T.i32: { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; }
    case T.f32: { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; }
    case T.bool: return Buffer.from([v ? 1 : 0]);
    case T.u64: return u64(v);
    case T.string: return str(v);
    default: throw new Error(`fixture writer has no case for type ${type}`);
  }
}

function value(kv: Kv): Buffer {
  if (kv.type !== T.array) return scalar(kv.type, kv.value);
  const et = kv.elemType!;
  const items = (kv.value as any[]).map((v) => scalar(et, v));
  return Buffer.concat([u32(et), u64(items.length), ...items]);
}

function buildGguf(kvs: Kv[], opts: { version?: number; magic?: string } = {}): Buffer {
  const parts: Buffer[] = [
    Buffer.from(opts.magic ?? 'GGUF', 'ascii'),
    u32(opts.version ?? 3),
    u64(0), // tensor count — the tensor table is never read
    u64(kvs.length),
  ];
  for (const kv of kvs) parts.push(str(kv.key), u32(kv.type), value(kv));
  return Buffer.concat(parts);
}

/** A tokenizer tail big enough that one 1 MB read cannot walk past it — the
 *  real Gemma 4 file's `tokenizer.ggml.tokens` is 262,144 strings. */
function tokenizerTail(): Kv[] {
  return [
    { key: 'tokenizer.ggml.model', type: T.string, value: 'gemma4' },
    { key: 'tokenizer.ggml.tokens', type: T.array, elemType: T.string, value: Array.from({ length: 30_000 }, (_, i) => `tok-${i}`.padEnd(64, 'x')) },
    { key: 'tokenizer.ggml.token_type', type: T.array, elemType: T.i32, value: Array.from({ length: 30_000 }, () => 1) },
  ];
}

// ---------------------------------------------------------------------------
// The real Gemma 4 E2B header, key for key.
// ---------------------------------------------------------------------------
// Read out of ~/.cache/llama.cpp/gemma-4-E2B-it-Q8_0.gguf: 35 layers, every 5th
// one full attention (28 slide, 7 don't), half-width keys and values on the
// sliding layers, and 20 layers that store no KV of their own.
const GEMMA4_PATTERN = Array.from({ length: 35 }, (_, i) => (i + 1) % 5 !== 0);

function gemma4Kvs(): Kv[] {
  return [
    { key: 'general.architecture', type: T.string, value: 'gemma4' },
    { key: 'general.name', type: T.string, value: 'Gemma-4-E2B-It' },
    { key: 'general.tags', type: T.array, elemType: T.string, value: ['unsloth', 'any-to-any'] },
    { key: 'gemma4.block_count', type: T.u32, value: 35 },
    { key: 'gemma4.context_length', type: T.u32, value: 131072 },
    { key: 'gemma4.embedding_length', type: T.u32, value: 1536 },
    // The real file writes this per-layer array too; it must be walked past.
    { key: 'gemma4.feed_forward_length', type: T.array, elemType: T.i32, value: Array.from({ length: 35 }, (_, i) => (i < 15 ? 6144 : 12288)) },
    { key: 'gemma4.attention.head_count', type: T.u32, value: 8 },
    { key: 'gemma4.attention.head_count_kv', type: T.u32, value: 1 },
    { key: 'gemma4.attention.key_length', type: T.u32, value: 512 },
    { key: 'gemma4.attention.value_length', type: T.u32, value: 512 },
    { key: 'gemma4.attention.sliding_window', type: T.u32, value: 512 },
    { key: 'gemma4.attention.shared_kv_layers', type: T.u32, value: 20 },
    { key: 'gemma4.attention.sliding_window_pattern', type: T.array, elemType: T.bool, value: GEMMA4_PATTERN },
    { key: 'gemma4.attention.key_length_swa', type: T.u32, value: 256 },
    { key: 'gemma4.attention.value_length_swa', type: T.u32, value: 256 },
  ];
}

describe('parseGgufHeader — the two sliding_window_pattern shapes', () => {
  it('Gemma 4: reads the 35-element BOOL ARRAY (GGUF type 9), not a number', () => {
    const { header, complete } = parseGgufHeader(buildGguf(gemma4Kvs()));
    expect(complete).toBe(true);
    expect(header.architecture).toBe('gemma4');
    // The scalar field stays null — a reader that mistook the array header for a
    // u32 would put a number here (and a nonsense one).
    expect(header.slidingWindowPattern).toBeNull();
    expect(header.slidingWindowPatternLayers).toEqual(GEMMA4_PATTERN);
    expect(header.slidingWindowPatternLayers).toHaveLength(35);
    expect(header.slidingWindowPatternLayers!.filter(Boolean)).toHaveLength(28); // slide
    expect(header.slidingWindowPatternLayers!.filter((v) => !v)).toHaveLength(7); // full
    expect(header.slidingLayers).toEqual(GEMMA4_PATTERN);
    // Gemma 4 is a recognised family, so the estimate must be stated exactly.
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('Gemma 4: the half-width _swa lengths and shared_kv_layers are read', () => {
    const { header } = parseGgufHeader(buildGguf(gemma4Kvs()));
    expect(header.keyLength).toBe(512);
    expect(header.valueLength).toBe(512);
    expect(header.keyLengthSwa).toBe(256);
    expect(header.valueLengthSwa).toBe(256);
    expect(header.sharedKvLayers).toBe(20);
    expect(header.blockCount).toBe(35);
    expect(header.headCountKv).toBe(1);
    expect(header.contextLength).toBe(131072);
  });

  it('Gemma 3: reads the SCALAR shape and expands it with the arch layer rule', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'gemma3' },
      { key: 'gemma3.block_count', type: T.u32, value: 48 },
      { key: 'gemma3.context_length', type: T.u32, value: 131072 },
      { key: 'gemma3.attention.head_count', type: T.u32, value: 16 },
      { key: 'gemma3.attention.head_count_kv', type: T.u32, value: 8 },
      { key: 'gemma3.attention.key_length', type: T.u32, value: 256 },
      { key: 'gemma3.attention.value_length', type: T.u32, value: 256 },
      { key: 'gemma3.attention.sliding_window', type: T.u32, value: 1024 },
      { key: 'gemma3.attention.sliding_window_pattern', type: T.u32, value: 6 },
    ]));
    expect(header.slidingWindowPattern).toBe(6);
    expect(header.slidingWindowPatternLayers).toBeNull();
    expect(header.slidingLayers).toEqual(swaPatternMask(48, 6, false));
    // Every 6th layer is full attention: 40 slide, 8 don't.
    expect(header.slidingLayers!.filter(Boolean)).toHaveLength(40);
    expect(header.slidingLayers!.slice(0, 6)).toEqual([true, true, true, true, true, false]);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('Gemma 3 with a sliding window but NO pattern key falls back to llama.cpp\'s period of 6', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'gemma3' },
      { key: 'gemma3.block_count', type: T.u32, value: 48 },
      { key: 'gemma3.attention.sliding_window', type: T.u32, value: 1024 },
    ]));
    expect(header.slidingLayers).toEqual(swaPatternMask(48, 6, false));
    expect(header.contextBytesIsUpperBound).toBe(false);
  });
});

describe('parseGgufHeader — per-layer head counts (llama.cpp get_key_or_arr)', () => {
  // Measured 2026-09-05 against unsloth/gemma-4-12b-it-GGUF's real header via
  // probe-headers.mjs: 48 layers, `attention.head_count_kv` written as a
  // 48-element int32 ARRAY — 8 KV heads on the five sliding layers of each
  // repeat, 1 on the sixth (full-attention) layer. Reading only the first entry
  // would over-size that model's KV cache six-fold on one layer in six; reading
  // the array header as a number would produce nonsense.
  const KV_HEADS_12B = Array.from({ length: 48 }, (_, i) => ((i + 1) % 6 === 0 ? 1 : 8));

  const kvs12b = (): Kv[] => [
    { key: 'general.architecture', type: T.string, value: 'gemma4' },
    { key: 'gemma4.block_count', type: T.u32, value: 48 },
    { key: 'gemma4.attention.head_count', type: T.u32, value: 16 },
    { key: 'gemma4.attention.head_count_kv', type: T.array, elemType: T.i32, value: KV_HEADS_12B },
    { key: 'gemma4.attention.key_length', type: T.u32, value: 512 },
    { key: 'gemma4.attention.value_length', type: T.u32, value: 512 },
    { key: 'gemma4.attention.sliding_window', type: T.u32, value: 1024 },
    { key: 'gemma4.attention.shared_kv_layers', type: T.u32, value: 0 },
    { key: 'gemma4.attention.sliding_window_pattern', type: T.array, elemType: T.bool, value: Array.from({ length: 48 }, (_, i) => (i + 1) % 6 !== 0) },
  ];

  it('keeps the whole per-layer array, and is still exact', () => {
    const { header } = parseGgufHeader(buildGguf(kvs12b()));
    expect(header.headCountKvLayers).toEqual(KV_HEADS_12B);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('the scalar alongside it is the MAXIMUM, so a naive reader over-counts, never under-counts', () => {
    const { header } = parseGgufHeader(buildGguf(kvs12b()));
    expect(header.headCountKv).toBe(8);
  });

  it('a uniform array collapses to a plain number', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'gemma4' },
      { key: 'gemma4.block_count', type: T.u32, value: 4 },
      { key: 'gemma4.attention.head_count_kv', type: T.array, elemType: T.i32, value: [4, 4, 4, 4] },
    ]));
    expect(header.headCountKv).toBe(4);
    expect(header.headCountKvLayers).toBeNull();
  });

  it('no head_count_kv at all means multi-head attention — it inherits head_count', () => {
    // llama.cpp seeds n_head_kv_arr from n_head_arr before looking for the key.
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'llama' },
      { key: 'llama.block_count', type: T.u32, value: 32 },
      { key: 'llama.attention.head_count', type: T.u32, value: 32 },
    ]));
    expect(header.headCountKv).toBe(32);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });
});

describe('parseGgufHeader — Qwen3.5 / Qwen3.6', () => {
  // Read out of ~/.cache/llama.cpp/Qwen3.5-2B-Q8_0.gguf. full_attention_interval
  // is a GENUINE scalar (GGUF type 4) — the contrast that makes the array case
  // above a real hazard rather than a hypothetical one.
  it('reads full_attention_interval as a scalar and finds no sliding layers', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'qwen35' },
      { key: 'qwen35.block_count', type: T.u32, value: 24 },
      { key: 'qwen35.context_length', type: T.u32, value: 262144 },
      { key: 'qwen35.embedding_length', type: T.u32, value: 2048 },
      { key: 'qwen35.attention.head_count', type: T.u32, value: 8 },
      { key: 'qwen35.attention.head_count_kv', type: T.u32, value: 2 },
      { key: 'qwen35.attention.key_length', type: T.u32, value: 256 },
      { key: 'qwen35.attention.value_length', type: T.u32, value: 256 },
      { key: 'qwen35.full_attention_interval', type: T.u32, value: 4 },
    ]));
    expect(header.fullAttentionInterval).toBe(4);
    expect(header.slidingWindow).toBeNull();
    expect(header.slidingLayers).toBeNull(); // no sliding window at all
    expect(header.contextBytesIsUpperBound).toBe(false);
    expect(header.blockCount).toBe(24);
    expect(header.headCountKv).toBe(2);
  });

  it('derives the recurrent layers from full_attention_interval — every 4th holds KV', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'qwen35' },
      { key: 'qwen35.block_count', type: T.u32, value: 24 },
      { key: 'qwen35.full_attention_interval', type: T.u32, value: 4 },
    ]));
    // llama.cpp qwen35.cpp: is_recr[i] = (i + 1) % interval != 0.
    expect(header.recurrentLayers!.slice(0, 8)).toEqual([true, true, true, false, true, true, true, false]);
    expect(header.recurrentLayers!.filter((r) => !r)).toHaveLength(6); // 6 of 24 keep KV
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('an MTP/NextN block is never recurrent, even where the interval says it would be', () => {
    // Measured in ~/.cache/llama.cpp/Qwen3.6-35B-A3B-UD-Q6_K_XL.gguf: 41 blocks
    // with nextn_predict_layers = 1. block_count is llama.cpp's n_layer_all and
    // the derivation runs over n_layer() = n_layer_all - nextn, so the last
    // block is a dense attention layer that DOES hold KV. (41 + 0) % 4 != 0
    // would otherwise mark index 40 recurrent and under-count the cache.
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'qwen35moe' },
      { key: 'qwen35moe.block_count', type: T.u32, value: 41 },
      { key: 'qwen35moe.full_attention_interval', type: T.u32, value: 4 },
      { key: 'qwen35moe.nextn_predict_layers', type: T.u32, value: 1 },
    ]));
    expect(header.nextnPredictLayers).toBe(1);
    expect(header.recurrentLayers![40]).toBe(false);
    expect(header.recurrentLayers).toHaveLength(41);
  });

  it('attention.recurrent_layers WINS over full_attention_interval when the file has both', () => {
    // llama.cpp qwen35.cpp:21 reads the array first and only computes the
    // interval when that key is ABSENT. Scoring a file that carries the array
    // off its interval instead would put the wrong layers in the cache — this
    // fixture makes the two disagree on every layer so nothing can coincide.
    const byArray = [false, false, false, true, false, false, false, true]; // only layers 3 and 7 are recurrent
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'qwen35' },
      { key: 'qwen35.block_count', type: T.u32, value: 8 },
      { key: 'qwen35.attention.recurrent_layers', type: T.array, elemType: T.bool, value: byArray },
      { key: 'qwen35.full_attention_interval', type: T.u32, value: 4 },
    ]));
    expect(header.recurrentLayers).toEqual(byArray);
    // The interval is still reported raw, but it must NOT be what was used:
    // its derivation is the exact inverse of the array here.
    expect(header.fullAttentionInterval).toBe(4);
    const fromInterval = Array.from({ length: 8 }, (_, il) => (il + 1) % 4 !== 0);
    expect(header.recurrentLayers).not.toEqual(fromInterval);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('a recurrent_layers array of the wrong shape is an upper bound, never a silent fallback', () => {
    const wrongType = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'qwen35' },
      { key: 'qwen35.block_count', type: T.u32, value: 8 },
      { key: 'qwen35.attention.recurrent_layers', type: T.array, elemType: T.i32, value: [1, 1, 1, 0, 1, 1, 1, 0] },
      { key: 'qwen35.full_attention_interval', type: T.u32, value: 4 },
    ])).header;
    expect(wrongType.recurrentLayers).toBeNull();
    expect(wrongType.contextBytesIsUpperBound).toBe(true);

    const tooShort = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'qwen35' },
      { key: 'qwen35.block_count', type: T.u32, value: 24 },
      { key: 'qwen35.attention.recurrent_layers', type: T.array, elemType: T.bool, value: [true, false] },
    ])).header;
    expect(tooShort.recurrentLayers).toBeNull();
    expect(tooShort.contextBytesIsUpperBound).toBe(true);
  });

  it('no interval and no array means no recurrent layers — nothing is invented', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'llama' },
      { key: 'llama.block_count', type: T.u32, value: 32 },
    ]));
    expect(header.recurrentLayers).toBeNull();
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('falls back to embedding_length / head_count when the explicit widths are absent', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'llama' },
      { key: 'llama.block_count', type: T.u32, value: 32 },
      { key: 'llama.embedding_length', type: T.u32, value: 4096 },
      { key: 'llama.attention.head_count', type: T.u32, value: 32 },
      { key: 'llama.attention.head_count_kv', type: T.u32, value: 8 },
    ]));
    expect(header.keyLength).toBe(128);
    expect(header.valueLength).toBe(128);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });
});

describe('swaPatternMask — llama.cpp\'s set_swa_pattern, per architecture', () => {
  // Transcribed from /home/destin/src/llama.cpp/src/llama-hparams.cpp:
  //   dense_first ? (il % n != 0) : (il % n < n - 1)
  // The two examples below are the ones spelled out in llama-hparams.h's own
  // comment, so this test fails if either side drifts.
  it('matches llama-hparams.h example 1 (n_pattern = 3, dense_first = false)', () => {
    expect(swaPatternMask(6, 3, false)).toEqual([true, true, false, true, true, false]);
  });
  it('matches llama-hparams.h example 2 (n_pattern = 2, dense_first = true)', () => {
    expect(swaPatternMask(4, 2, true)).toEqual([false, true, false, true]);
  });
  it('n_pattern 0 = every layer slides; 1 = none do', () => {
    expect(swaPatternMask(4, 0, false)).toEqual([true, true, true, true]);
    expect(swaPatternMask(4, 1, false)).toEqual([false, false, false, false]);
  });

  // The dense_first flag is the third argument to set_swa_pattern in
  // llama.cpp/src/models/*.cpp. Verified 2026-09-05:
  //   rg -n "set_swa_pattern" src/models/  →  17 call sites, exactly three of
  //   which pass `true` (cohere2moe.cpp:33, smallthinker.cpp:11,
  //   modern-bert.cpp:10). Every other caller takes the default, false.
  it('exactly three architectures are dense-first', () => {
    expect([...DENSE_FIRST_ARCHITECTURES].sort()).toEqual(['cohere2moe', 'modern-bert', 'smallthinker']);
  });

  it('cohere2moe puts the DENSE layer first; cohere2 puts it last', () => {
    const kvs = (arch: string): Kv[] => [
      { key: 'general.architecture', type: T.string, value: arch },
      { key: `${arch}.block_count`, type: T.u32, value: 8 },
      { key: `${arch}.attention.sliding_window`, type: T.u32, value: 4096 },
      { key: `${arch}.attention.sliding_window_pattern`, type: T.u32, value: 4 },
    ];
    expect(parseGgufHeader(buildGguf(kvs('cohere2moe'))).header.slidingLayers)
      .toEqual([false, true, true, true, false, true, true, true]);
    expect(parseGgufHeader(buildGguf(kvs('cohere2'))).header.slidingLayers)
      .toEqual([true, true, true, false, true, true, true, false]);
  });

  // Each default is the local `uint32_t swa_period = N;` in that architecture's
  // src/models/*.cpp, read 2026-09-05. They are the periods llama.cpp uses when
  // the file carries no pattern key, so getting one wrong silently mis-sizes
  // the KV cache for that whole family.
  it('the per-architecture default periods match llama.cpp', () => {
    expect(SWA_PATTERN_DEFAULTS).toEqual({
      afmoe: 4, cohere2: 4, cohere2moe: 4, 'exaone-moe': 4, exaone4: 4,
      gemma2: 2, gemma3: 6, gemma3n: 5, 'gemma-embedding': 6, 'gpt-oss': 2,
      llama4: 4, mellum: 4, 'modern-bert': 3, olmo2: 4, plamo3: 8, smallthinker: 4,
    });
  });

  it('an architecture with a sliding window but no known period is an UPPER BOUND, not a guess', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'some-future-arch' },
      { key: 'some-future-arch.block_count', type: T.u32, value: 32 },
      { key: 'some-future-arch.attention.sliding_window', type: T.u32, value: 1024 },
    ]));
    expect(header.slidingLayers).toBeNull();
    expect(header.contextBytesIsUpperBound).toBe(true);
  });
});

describe('parseGgufHeader — a key type the reader does not handle sets the upper-bound flag', () => {
  it('a wanted key in the wrong scalar type (a string block_count)', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'llama' },
      { key: 'llama.block_count', type: T.string, value: '32' },
      { key: 'llama.attention.head_count_kv', type: T.u32, value: 8 },
    ]));
    expect(header.blockCount).toBeNull();
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('sliding_window_pattern as an array of the WRONG element type', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'gemma4' },
      { key: 'gemma4.block_count', type: T.u32, value: 4 },
      { key: 'gemma4.attention.sliding_window', type: T.u32, value: 512 },
      { key: 'gemma4.attention.sliding_window_pattern', type: T.array, elemType: T.f32, value: [1, 0, 1, 0] },
    ]));
    expect(header.slidingLayers).toBeNull();
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('a per-layer pattern array that does not cover every layer', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'gemma4' },
      { key: 'gemma4.block_count', type: T.u32, value: 35 },
      { key: 'gemma4.attention.sliding_window_pattern', type: T.array, elemType: T.bool, value: [true, false] },
    ]));
    expect(header.slidingLayers).toBeNull();
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('a GGUF value type id this reader cannot even measure', () => {
    // Type 99 does not exist. The reader cannot skip a value it cannot size, so
    // it stops there and reports everything after it as unknown.
    const good = buildGguf([
      { key: 'general.architecture', type: T.string, value: 'llama' },
      { key: 'llama.block_count', type: T.u32, value: 32 },
    ]);
    const tail = Buffer.concat([str('llama.mystery'), u32(99), u32(1)]);
    const withUnknown = Buffer.concat([good, tail]);
    withUnknown.writeBigUInt64LE(BigInt(3), 16); // bump the kv count to 3
    const { header } = parseGgufHeader(withUnknown);
    expect(header.blockCount).toBe(32); // what was read before it still counts
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('a header with no architecture keys at all is an upper bound', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'llama' },
      { key: 'general.name', type: T.string, value: 'nothing useful' },
    ]));
    expect(header.blockCount).toBeNull();
    expect(header.slidingLayers).toBeNull();
    // Nothing was mis-read, so the flag is not set here — the ESTIMATOR sees
    // blockCount === null and is the one that refuses to state a number.
    expect(header.contextBytesIsUpperBound).toBe(false);
  });
});

describe('parseGgufHeader — refuses bytes that are not a GGUF v3 header', () => {
  it('names the magic it actually found', () => {
    const bad = buildGguf([{ key: 'general.architecture', type: T.string, value: 'llama' }], { magic: 'NOPE' });
    expect(() => parseGgufHeader(bad)).toThrow(/expected the magic "GGUF", found "NOPE"/);
  });
  it('names the version it actually found', () => {
    const bad = buildGguf([{ key: 'general.architecture', type: T.string, value: 'llama' }], { version: 1 });
    expect(() => parseGgufHeader(bad)).toThrow(/Unsupported GGUF version 1/);
  });

  it('ACCEPTS v2 — its KV table is laid out exactly like v3', () => {
    // TheBloke's Llama-2 GGUFs are v2 and still among the most-downloaded on
    // the Hub. Refusing them would show an error on that card where every other
    // model shows a memory line. Only v1 used 32-bit lengths, which this reader
    // genuinely cannot walk. Verified 2026-09-05 against
    // TheBloke/Llama-2-7B-GGUF's real header.
    const v2 = buildGguf([
      { key: 'general.architecture', type: T.string, value: 'llama' },
      { key: 'llama.block_count', type: T.u32, value: 32 },
      { key: 'llama.context_length', type: T.u32, value: 4096 },
      { key: 'llama.embedding_length', type: T.u32, value: 4096 },
      { key: 'llama.attention.head_count', type: T.u32, value: 32 },
    ], { version: 2 });
    const { header } = parseGgufHeader(v2);
    expect(header.blockCount).toBe(32);
    expect(header.headCountKv).toBe(32);
    expect(header.keyLength).toBe(128);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });
  it('names how few bytes it was given', () => {
    expect(() => parseGgufHeader(Buffer.from('GG'))).toThrow(/only 2 bytes/);
  });
});

describe('parseGgufHeader — hostile or corrupt bytes never crash the app', () => {
  it('a NESTED array is refused instead of blowing the call stack', () => {
    // GGUF defines no array-of-arrays, but a crafted file can nest one at
    // twelve bytes per level. The parser used to recurse per level and die with
    // a raw "Maximum call stack size exceeded" — a message the user can do
    // nothing with, in front of a model they merely searched for.
    const head = buildGguf([
      { key: 'general.architecture', type: T.string, value: 'llama' },
      { key: 'llama.block_count', type: T.u32, value: 32 },
    ]);
    // One array whose ELEMENT type is itself an array, 50,000 deep.
    const depth = 50_000;
    const nest: Buffer[] = [];
    for (let i = 0; i < depth; i++) nest.push(u32(T.array), u64(1));
    nest.push(u32(T.u32), u64(1), u32(7));
    const withNested = Buffer.concat([head, str('llama.nested'), u32(T.array), ...nest]);
    withNested.writeBigUInt64LE(BigInt(3), 16); // kv count 2 -> 3

    const { header } = parseGgufHeader(withNested); // must NOT throw
    expect(header.blockCount).toBe(32);             // what came before still counts
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('a per-layer head-count array that is shorter than the model is dropped', () => {
    // The estimator indexes headCountKvLayers per layer; a short array would
    // give it undefined -> NaN -> a nonsense number on the card.
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'gemma4' },
      { key: 'gemma4.block_count', type: T.u32, value: 48 },
      { key: 'gemma4.attention.head_count_kv', type: T.array, elemType: T.i32, value: [8, 1, 8] },
    ]));
    expect(header.headCountKvLayers).toBeNull();
    expect(header.headCountKv).toBe(8); // the array's maximum — an over-count
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('the per-head width fallback divides by the SMALLEST head count, not the largest', () => {
    // Dividing by the max gives the narrowest head, i.e. an UNDER-count of the
    // cache — the one direction that can turn "tight" into a wrong "fits".
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'gemma4' },
      { key: 'gemma4.block_count', type: T.u32, value: 4 },
      { key: 'gemma4.embedding_length', type: T.u32, value: 1024 },
      { key: 'gemma4.attention.head_count', type: T.array, elemType: T.i32, value: [8, 2, 8, 2] },
    ]));
    expect(header.headCount).toBe(8);   // the max, safe as a multiplier
    expect(header.keyLength).toBe(512); // 1024 / 2, not 1024 / 8
    expect(header.valueLength).toBe(512);
    // One width for a model whose heads vary per layer is an estimate.
    expect(header.contextBytesIsUpperBound).toBe(true);
  });
});

describe('parseGgufHeader — the architectures llama.cpp overrides or gates', () => {
  it('phi3 has NO sliding layers even when its file advertises a window and a pattern', () => {
    // phi3.cpp turns SWA back OFF when it finds a window (swa_type = NONE,
    // n_swa = 0, set_swa_pattern(1)) — a deliberate upstream workaround for
    // converters that fill the key in wrongly. Believing the file's pattern of
    // 4 would say three layers in four slide, under-counting the cache.
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'phi3' },
      { key: 'phi3.block_count', type: T.u32, value: 32 },
      { key: 'phi3.attention.sliding_window', type: T.u32, value: 2048 },
      { key: 'phi3.attention.sliding_window_pattern', type: T.u32, value: 4 },
    ]));
    expect(header.slidingLayers).toEqual(new Array(32).fill(false));
    expect(header.slidingLayers!.some(Boolean)).toBe(false);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('exaone4 slides only at 64 layers — llama.cpp gates the whole block on it', () => {
    const exaone = (layers: number) => parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'exaone4' },
      { key: 'exaone4.block_count', type: T.u32, value: layers },
      { key: 'exaone4.attention.sliding_window', type: T.u32, value: 4096 },
    ])).header;
    expect(exaone(64).slidingLayers).toEqual(swaPatternMask(64, 4, false));
    // A 30-layer EXAONE 4 carries the same key and still has no sliding layers.
    expect(exaone(30).slidingLayers).toBeNull();
    expect(exaone(30).contextBytesIsUpperBound).toBe(false);
  });
});

describe('the 1 MB early stop', () => {
  const withTail = () => buildGguf([...gemma4Kvs(), ...tokenizerTail()]);

  it('one 1 MB read is enough, even though the file continues for megabytes', () => {
    const full = withTail();
    expect(full.length).toBeGreaterThan(2 * CHUNK_BYTES); // the tail really is big
    const { header, complete } = parseGgufHeader(full.subarray(0, CHUNK_BYTES));
    expect(complete).toBe(true);
    expect(header.slidingLayers).toEqual(GEMMA4_PATTERN);
    expect(header.sharedKvLayers).toBe(20);
    expect(header.contextBytesIsUpperBound).toBe(false);
    // Every architecture key is inside the first few kilobytes — the probed
    // fact the whole one-request design rests on.
    expect(header.archBytes).toBeLessThan(4096);
  });

  it('does NOT stop early while the architecture keys are still coming', () => {
    // Cut the buffer inside the architecture block: the reader must ask for more
    // rather than report a half-read header as final.
    const full = withTail();
    // 952 bytes in, the last architecture key is behind us (header.archBytes,
    // asserted above); 800 is still inside the block.
    const { header, complete } = parseGgufHeader(full.subarray(0, 800));
    expect(complete).toBe(false);
    expect(header.blockCount).toBe(35);
    expect(header.slidingWindowPatternLayers).toBeNull(); // not reached yet
  });

  it('a half-read header is ALWAYS an upper bound, whatever architecture it is', () => {
    // gemma3 IS in SWA_PATTERN_DEFAULTS, so no layer-map condition can fire
    // here: the flag has to come from the truncation itself. (The gemma4 case
    // above would pass either way, which is why this fixture exists.)
    const full = buildGguf([
      { key: 'general.architecture', type: T.string, value: 'gemma3' },
      { key: 'gemma3.block_count', type: T.u32, value: 48 },
      { key: 'gemma3.attention.sliding_window', type: T.u32, value: 1024 },
      { key: 'gemma3.attention.sliding_window_pattern', type: T.u32, value: 6 },
      { key: 'gemma3.attention.head_count_kv', type: T.u32, value: 8 },
    ]);
    expect(parseGgufHeader(full).header.contextBytesIsUpperBound).toBe(false);
    const cut = parseGgufHeader(full.subarray(0, full.length - 4));
    expect(cut.complete).toBe(false);
    expect(cut.header.contextBytesIsUpperBound).toBe(true);
  });
});

describe('readLocalGgufHeader', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-header-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads a file on disk without loading the whole thing', async () => {
    const file = path.join(dir, 'model.gguf');
    fs.writeFileSync(file, Buffer.concat([buildGguf([...gemma4Kvs(), ...tokenizerTail()]), Buffer.alloc(4 * CHUNK_BYTES)]));
    const header = await readLocalGgufHeader(file);
    expect(header.architecture).toBe('gemma4');
    expect(header.slidingLayers).toEqual(GEMMA4_PATTERN);
    expect(header.keyLengthSwa).toBe(256);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('a file shorter than one chunk still parses', async () => {
    const file = path.join(dir, 'small.gguf');
    fs.writeFileSync(file, buildGguf(gemma4Kvs()));
    const header = await readLocalGgufHeader(file);
    expect(header.blockCount).toBe(35);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('surfaces the real reason a file is not readable, never a guess', async () => {
    await expect(readLocalGgufHeader(path.join(dir, 'missing.gguf'))).rejects.toThrow(/ENOENT/);
  });
});

describe('fetchRemoteGgufHeader', () => {
  function fakeServer(body: Buffer) {
    const ranges: string[] = [];
    const fetchImpl = async (_url: string, init: any) => {
      const range = init.headers.Range as string;
      ranges.push(range);
      const [start, end] = range.replace('bytes=', '').split('-').map(Number);
      if (start >= body.length) return { ok: false, status: 416, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      const slice = body.subarray(start, Math.min(end + 1, body.length));
      return {
        ok: true, status: 206,
        headers: { get: (n: string) => (n === 'content-length' ? String(slice.length) : null) },
        arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
      };
    };
    return { ranges, fetchImpl };
  }

  it('asks for exactly one 1 MB range and stops', async () => {
    const { ranges, fetchImpl } = fakeServer(buildGguf([...gemma4Kvs(), ...tokenizerTail()]));
    const header = await fetchRemoteGgufHeader('https://example.invalid/model.gguf', fetchImpl as any);
    expect(ranges).toEqual([`bytes=0-${CHUNK_BYTES - 1}`]);
    expect(header.slidingLayers).toEqual(GEMMA4_PATTERN);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('a file smaller than one chunk ends on the 416', async () => {
    const { ranges, fetchImpl } = fakeServer(buildGguf(gemma4Kvs()));
    const header = await fetchRemoteGgufHeader('https://example.invalid/model.gguf', fetchImpl as any);
    expect(header.blockCount).toBe(35);
    expect(ranges).toHaveLength(1);
  });

  it('reports the server\'s real status, never a guessed cause', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(fetchRemoteGgufHeader('https://example.invalid/m.gguf', fetchImpl as any)).rejects.toThrow(/HTTP 403/);
  });

  it('refuses to buffer a whole model when the server ignores the range request', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: (n: string) => (n === 'content-length' ? '5048350848' : null) },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(fetchRemoteGgufHeader('https://example.invalid/m.gguf', fetchImpl as any))
      .rejects.toThrow(/ignored the range request \(HTTP 200, 5048350848 bytes\)/);
  });

  it('refuses the same way when the response has NO content-length at all', async () => {
    // A chunked 200 advertises no length. The old guard read that as 0, decided
    // 0 was small, and buffered the whole file into the Electron main process —
    // a freeze or an OOM kill for any mirror that answers this way, on a repo
    // the user merely searched for. The body must never be read.
    let bodyRead = 0;
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => { bodyRead++; return new ArrayBuffer(8 * 1024 * 1024); },
    });
    await expect(fetchRemoteGgufHeader('https://example.invalid/m.gguf', fetchImpl as any))
      .rejects.toThrow(/ignored the range request \(HTTP 200, no content-length\)/);
    expect(bodyRead).toBe(0);
  });

  it('refuses an unparseable content-length too', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: () => 'lots' },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await expect(fetchRemoteGgufHeader('https://example.invalid/m.gguf', fetchImpl as any))
      .rejects.toThrow(/ignored the range request \(HTTP 200, lots bytes\)/);
  });
});

describe('GgufHeaderCache', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-cache-test-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const header = () => parseGgufHeader(buildGguf(gemma4Kvs())).header;

  it('writes gguf-headers-cache.json beside the curated cache and reads it back', () => {
    const stamp = hfHeaderStamp('a'.repeat(64));
    new GgufHeaderCache(dir).set('unsloth/gemma-4-E2B-it-GGUF', stamp, header());
    expect(fs.existsSync(path.join(dir, 'gguf-headers-cache.json'))).toBe(true);
    // A FRESH instance, so this reads the file rather than an in-memory copy.
    const got = new GgufHeaderCache(dir).get('unsloth/gemma-4-E2B-it-GGUF', stamp);
    expect(got?.slidingLayers).toEqual(GEMMA4_PATTERN);
  });

  it('a changed sha or mtime misses, so a re-uploaded model is re-read', () => {
    const cache = new GgufHeaderCache(dir);
    cache.set('repo', hfHeaderStamp('a'.repeat(64)), header());
    expect(cache.get('repo', hfHeaderStamp('b'.repeat(64)))).toBeNull();
    cache.set('/models/x.gguf', localHeaderStamp(1000), header());
    expect(cache.get('/models/x.gguf', localHeaderStamp(1000))).not.toBeNull();
    expect(cache.get('/models/x.gguf', localHeaderStamp(2000))).toBeNull();
  });

  it('keeps ONE entry per repo — a new sha replaces the old row', () => {
    const cache = new GgufHeaderCache(dir);
    cache.set('repo', hfHeaderStamp('a'.repeat(64)), header());
    cache.set('repo', hfHeaderStamp('b'.repeat(64)), header());
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'gguf-headers-cache.json'), 'utf8'));
    expect(Object.keys(onDisk.entries)).toEqual(['repo']);
    expect(onDisk.entries.repo.stamp).toBe(hfHeaderStamp('b'.repeat(64)));
  });

  it('a corrupt cache file is a miss, not a crash', () => {
    fs.writeFileSync(path.join(dir, 'gguf-headers-cache.json'), '{not json');
    const cache = new GgufHeaderCache(dir);
    expect(cache.get('repo', 'sha:x')).toBeNull();
    cache.set('repo', 'sha:x', header());
    expect(cache.get('repo', 'sha:x')).not.toBeNull();
  });
});
