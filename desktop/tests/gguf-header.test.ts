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

// Fixtures: `<arch>.<suffix>` entries, written through the GGUF writer above.
type E = [suffix: string, type: number, value: any, elemType?: number];
const hdr = (arch: string, entries: E[]) => parseGgufHeader(buildGguf([
  { key: 'general.architecture', type: T.string, value: arch },
  ...entries.map(([k, type, value, elemType]) => ({ key: `${arch}.${k}`, type, value, elemType })),
])).header;
const U = T.u32;
// A header followed by raw bytes the reader cannot size; kv count bumped to match.
const withRawKv = (tail: Buffer[]) => {
  const good = buildGguf([
    { key: 'general.architecture', type: T.string, value: 'llama' },
    { key: 'llama.block_count', type: T.u32, value: 32 },
  ]);
  const b = Buffer.concat([good, ...tail]);
  b.writeBigUInt64LE(BigInt(3), 16);
  return b;
};

describe('parseGgufHeader — the two sliding_window_pattern shapes', () => {
  it('Gemma 4: reads the 35-element BOOL ARRAY (GGUF type 9), not a number', () => {
    const { header, complete } = parseGgufHeader(buildGguf(gemma4Kvs()));
    expect(complete).toBe(true);
    expect(header.architecture).toBe('gemma4');
    // A reader that mistook the array header for a u32 would put a number here.
    expect(header.slidingWindowPattern).toBeNull();
    expect(header.slidingWindowPatternLayers).toEqual(GEMMA4_PATTERN);
    expect(header.slidingLayers).toEqual(GEMMA4_PATTERN);
    expect(header.slidingLayers!.filter(Boolean)).toHaveLength(28);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('Gemma 4: the half-width _swa lengths and shared_kv_layers are read', () => {
    const { header } = parseGgufHeader(buildGguf(gemma4Kvs()));
    expect([header.keyLength, header.valueLength, header.keyLengthSwa, header.valueLengthSwa]).toEqual([512, 512, 256, 256]);
    expect([header.sharedKvLayers, header.blockCount, header.headCountKv, header.contextLength]).toEqual([20, 35, 1, 131072]);
  });

  it('Gemma 3: reads the SCALAR shape and expands it with the arch layer rule', () => {
    const header = hdr('gemma3', [
      ['block_count', U, 48], ['attention.head_count_kv', U, 8],
      ['attention.sliding_window', U, 1024], ['attention.sliding_window_pattern', U, 6],
    ]);
    expect(header.slidingWindowPattern).toBe(6);
    expect(header.slidingWindowPatternLayers).toBeNull();
    expect(header.slidingLayers).toEqual(swaPatternMask(48, 6, false));
    expect(header.slidingLayers!.filter(Boolean)).toHaveLength(40); // every 6th is full attention
    expect(header.slidingLayers!.slice(0, 6)).toEqual([true, true, true, true, true, false]);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('Gemma 3 with a sliding window but NO pattern key falls back to llama.cpp\'s period of 6', () => {
    const header = hdr('gemma3', [['block_count', U, 48], ['attention.sliding_window', U, 1024]]);
    expect(header.slidingLayers).toEqual(swaPatternMask(48, 6, false));
    expect(header.contextBytesIsUpperBound).toBe(false);
  });
});

describe('parseGgufHeader — per-layer head counts (llama.cpp get_key_or_arr)', () => {
  // Real gemma-4-12b header: head_count_kv is a 48-element int32 ARRAY (8 on sliding layers, 1 on every 6th).
  // Reading only the first entry over-sizes the KV cache; reading the array header as a number is nonsense.
  const KV_HEADS_12B = Array.from({ length: 48 }, (_, i) => ((i + 1) % 6 === 0 ? 1 : 8));

  it('keeps the whole per-layer array and stays exact; the scalar is the MAXIMUM (over-count, never under)', () => {
    const header = hdr('gemma4', [
      ['block_count', U, 48], ['attention.head_count', U, 16],
      ['attention.head_count_kv', T.array, KV_HEADS_12B, T.i32],
      ['attention.key_length', U, 512], ['attention.value_length', U, 512],
      ['attention.sliding_window', U, 1024], ['attention.shared_kv_layers', U, 0],
      ['attention.sliding_window_pattern', T.array, Array.from({ length: 48 }, (_, i) => (i + 1) % 6 !== 0), T.bool],
    ]);
    expect(header.headCountKvLayers).toEqual(KV_HEADS_12B);
    expect(header.headCountKv).toBe(8);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('a uniform array collapses to a plain number', () => {
    const header = hdr('gemma4', [['block_count', U, 4], ['attention.head_count_kv', T.array, [4, 4, 4, 4], T.i32]]);
    expect(header.headCountKv).toBe(4);
    expect(header.headCountKvLayers).toBeNull();
  });

  it('no head_count_kv at all means multi-head attention — it inherits head_count', () => {
    const header = hdr('llama', [['block_count', U, 32], ['attention.head_count', U, 32]]);
    expect(header.headCountKv).toBe(32);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });
});

describe('parseGgufHeader — Qwen3.5 / Qwen3.6', () => {
  it('reads full_attention_interval as a scalar (GGUF type 4) and finds no sliding layers', () => {
    const header = hdr('qwen35', [
      ['block_count', U, 24], ['attention.head_count_kv', U, 2], ['full_attention_interval', U, 4],
    ]);
    expect(header.fullAttentionInterval).toBe(4);
    expect(header.slidingWindow).toBeNull();
    expect(header.slidingLayers).toBeNull();
    expect(header.contextBytesIsUpperBound).toBe(false);
    expect([header.blockCount, header.headCountKv]).toEqual([24, 2]);
  });

  it('derives the recurrent layers from full_attention_interval — every 4th holds KV', () => {
    const header = hdr('qwen35', [['block_count', U, 24], ['full_attention_interval', U, 4]]);
    expect(header.recurrentLayers!.slice(0, 8)).toEqual([true, true, true, false, true, true, true, false]);
    expect(header.recurrentLayers!.filter((r) => !r)).toHaveLength(6);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('an MTP/NextN block is never recurrent, even where the interval says it would be', () => {
    // 41 blocks, nextn_predict_layers = 1: the derivation runs over 40, so block 40 is dense attention that DOES hold KV.
    const header = hdr('qwen35moe', [['block_count', U, 41], ['full_attention_interval', U, 4], ['nextn_predict_layers', U, 1]]);
    expect(header.nextnPredictLayers).toBe(1);
    expect(header.recurrentLayers![40]).toBe(false);
    expect(header.recurrentLayers).toHaveLength(41);
  });

  it('attention.recurrent_layers WINS over full_attention_interval when the file has both', () => {
    // llama.cpp reads the array first; this one disagrees with the interval on every layer.
    const byArray = [false, false, false, true, false, false, false, true];
    const header = hdr('qwen35', [
      ['block_count', U, 8], ['attention.recurrent_layers', T.array, byArray, T.bool], ['full_attention_interval', U, 4],
    ]);
    expect(header.recurrentLayers).toEqual(byArray);
    expect(header.fullAttentionInterval).toBe(4);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it.each([
    ['wrong element type', 8, [1, 1, 1, 0, 1, 1, 1, 0], T.i32],
    ['too short', 24, [true, false], T.bool],
  ])('a recurrent_layers array that is %s is an upper bound, never a silent fallback', (_n, blocks, arr, elem) => {
    const header = hdr('qwen35', [['block_count', U, blocks], ['attention.recurrent_layers', T.array, arr, elem], ['full_attention_interval', U, 4]]);
    expect(header.recurrentLayers).toBeNull();
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('no interval and no array means no recurrent layers — nothing is invented', () => {
    const header = hdr('llama', [['block_count', U, 32]]);
    expect(header.recurrentLayers).toBeNull();
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('falls back to embedding_length / head_count when the explicit widths are absent', () => {
    const header = hdr('llama', [
      ['block_count', U, 32], ['embedding_length', U, 4096], ['attention.head_count', U, 32], ['attention.head_count_kv', U, 8],
    ]);
    expect([header.keyLength, header.valueLength]).toEqual([128, 128]);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });
});

describe('swaPatternMask — llama.cpp\'s set_swa_pattern, per architecture', () => {
  // Formula: dense_first ? (il % n != 0) : (il % n < n - 1); examples 1 and 2 are llama-hparams.h's own.
  it.each([
    [6, 3, false, [true, true, false, true, true, false]],
    [4, 2, true, [false, true, false, true]],
    [4, 0, false, [true, true, true, true]], // n_pattern 0 = every layer slides
    [4, 1, false, [false, false, false, false]], // 1 = none do
  ])('swaPatternMask(%i, %i, dense_first=%s)', (layers, n, denseFirst, want) => {
    expect(swaPatternMask(layers, n, denseFirst)).toEqual(want);
  });

  // set_swa_pattern has 17 call sites in llama.cpp src/models; exactly three pass dense_first = true.
  it('exactly three architectures are dense-first', () => {
    expect([...DENSE_FIRST_ARCHITECTURES].sort()).toEqual(['cohere2moe', 'modern-bert', 'smallthinker']);
  });

  it('cohere2moe puts the DENSE layer first; cohere2 puts it last', () => {
    const kvs = (): E[] => [['block_count', U, 8], ['attention.sliding_window', U, 4096], ['attention.sliding_window_pattern', U, 4]];
    expect(hdr('cohere2moe', kvs()).slidingLayers).toEqual([false, true, true, true, false, true, true, true]);
    expect(hdr('cohere2', kvs()).slidingLayers).toEqual([true, true, true, false, true, true, true, false]);
  });

  // Each default is the `swa_period` in that architecture's src/models/*.cpp; a wrong one mis-sizes the whole family's KV cache.
  it('the per-architecture default periods match llama.cpp', () => {
    expect(SWA_PATTERN_DEFAULTS).toEqual({
      afmoe: 4, cohere2: 4, cohere2moe: 4, 'exaone-moe': 4, exaone4: 4,
      gemma2: 2, gemma3: 6, gemma3n: 5, 'gemma-embedding': 6, 'gpt-oss': 2,
      llama4: 4, mellum: 4, 'modern-bert': 3, olmo2: 4, plamo3: 8, smallthinker: 4,
    });
  });
});

describe('parseGgufHeader — what the reader cannot interpret sets the upper-bound flag', () => {
  it.each([
    ['a wanted key in the wrong scalar type (a string block_count)', 'llama',
      [['block_count', T.string, '32'], ['attention.head_count_kv', U, 8]] as E[], 'blockCount'],
    ['sliding_window_pattern as an array of the WRONG element type', 'gemma4',
      [['block_count', U, 4], ['attention.sliding_window', U, 512], ['attention.sliding_window_pattern', T.array, [1, 0, 1, 0], T.f32]] as E[], 'slidingLayers'],
    ['a per-layer pattern array that does not cover every layer', 'gemma4',
      [['block_count', U, 35], ['attention.sliding_window_pattern', T.array, [true, false], T.bool]] as E[], 'slidingLayers'],
    ['an architecture with a sliding window but no known period (not a guess)', 'some-future-arch',
      [['block_count', U, 32], ['attention.sliding_window', U, 1024]] as E[], 'slidingLayers'],
  ])('%s', (_n, arch, entries, nullField) => {
    const header = hdr(arch, entries) as any;
    expect(header[nullField]).toBeNull();
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('a GGUF value type id this reader cannot even measure stops there; what came before still counts', () => {
    const { header } = parseGgufHeader(withRawKv([str('llama.mystery'), u32(99), u32(1)]));
    expect(header.blockCount).toBe(32);
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('a header with no architecture keys is NOT flagged — the ESTIMATOR sees blockCount === null and refuses', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'llama' },
      { key: 'general.name', type: T.string, value: 'nothing useful' },
    ]));
    expect(header.blockCount).toBeNull();
    expect(header.slidingLayers).toBeNull();
    expect(header.contextBytesIsUpperBound).toBe(false);
  });
});

describe('parseGgufHeader — refuses bytes that are not a GGUF v3 header', () => {
  const llamaOnly: Kv[] = [{ key: 'general.architecture', type: T.string, value: 'llama' }];
  it('names the magic it actually found', () => {
    expect(() => parseGgufHeader(buildGguf(llamaOnly, { magic: 'NOPE' }))).toThrow(/expected the magic "GGUF", found "NOPE"/);
  });
  it('names the version it actually found', () => {
    expect(() => parseGgufHeader(buildGguf(llamaOnly, { version: 1 }))).toThrow(/Unsupported GGUF version 1/);
  });
  it('names how few bytes it was given', () => {
    expect(() => parseGgufHeader(Buffer.from('GG'))).toThrow(/only 2 bytes/);
  });

  it('ACCEPTS v2 — its KV table is laid out like v3 (TheBloke Llama-2 GGUFs are v2; refusing them shows an error on that card)', () => {
    const { header } = parseGgufHeader(buildGguf([
      { key: 'general.architecture', type: T.string, value: 'llama' },
      { key: 'llama.block_count', type: T.u32, value: 32 },
      { key: 'llama.embedding_length', type: T.u32, value: 4096 },
      { key: 'llama.attention.head_count', type: T.u32, value: 32 },
    ], { version: 2 }));
    expect([header.blockCount, header.headCountKv, header.keyLength]).toEqual([32, 32, 128]);
    expect(header.contextBytesIsUpperBound).toBe(false);
  });
});

describe('parseGgufHeader — hostile or corrupt bytes never crash the app', () => {
  it('a NESTED array is refused instead of blowing the call stack', () => {
    // A crafted file can nest arrays 12 bytes per level; the parser once recursed per level and died with "Maximum call stack size exceeded".
    const nest: Buffer[] = [];
    for (let i = 0; i < 50_000; i++) nest.push(u32(T.array), u64(1));
    nest.push(u32(T.u32), u64(1), u32(7));
    const { header } = parseGgufHeader(withRawKv([str('llama.nested'), u32(T.array), ...nest])); // must NOT throw
    expect(header.blockCount).toBe(32);
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('a per-layer head-count array shorter than the model is dropped (a short one would index undefined -> NaN on the card)', () => {
    const header = hdr('gemma4', [['block_count', U, 48], ['attention.head_count_kv', T.array, [8, 1, 8], T.i32]]);
    expect(header.headCountKvLayers).toBeNull();
    expect(header.headCountKv).toBe(8);
    expect(header.contextBytesIsUpperBound).toBe(true);
  });

  it('the per-head width fallback divides by the SMALLEST head count (the max would under-count and turn "tight" into "fits")', () => {
    const header = hdr('gemma4', [
      ['block_count', U, 4], ['embedding_length', U, 1024], ['attention.head_count', T.array, [8, 2, 8, 2], T.i32],
    ]);
    expect(header.headCount).toBe(8);
    expect([header.keyLength, header.valueLength]).toEqual([512, 512]);
    expect(header.contextBytesIsUpperBound).toBe(true);
  });
});

describe('parseGgufHeader — the architectures llama.cpp overrides or gates', () => {
  it('phi3 has NO sliding layers even when its file advertises a window and a pattern', () => {
    // phi3.cpp switches SWA back off; believing the file's pattern of 4 would under-count the cache.
    const header = hdr('phi3', [['block_count', U, 32], ['attention.sliding_window', U, 2048], ['attention.sliding_window_pattern', U, 4]]);
    expect(header.slidingLayers).toEqual(new Array(32).fill(false));
    expect(header.contextBytesIsUpperBound).toBe(false);
  });

  it('exaone4 slides only at 64 layers — llama.cpp gates the whole block on it', () => {
    const exaone = (layers: number) => hdr('exaone4', [['block_count', U, layers], ['attention.sliding_window', U, 4096]]);
    expect(exaone(64).slidingLayers).toEqual(swaPatternMask(64, 4, false));
    expect(exaone(30).slidingLayers).toBeNull();
    expect(exaone(30).contextBytesIsUpperBound).toBe(false);
  });
});

describe('the 1 MB early stop', () => {
  const withTail = () => buildGguf([...gemma4Kvs(), ...tokenizerTail()]);

  it('one 1 MB read is enough, even though the file continues for megabytes', () => {
    const full = withTail();
    expect(full.length).toBeGreaterThan(2 * CHUNK_BYTES);
    const { header, complete } = parseGgufHeader(full.subarray(0, CHUNK_BYTES));
    expect(complete).toBe(true);
    expect(header.slidingLayers).toEqual(GEMMA4_PATTERN);
    expect(header.sharedKvLayers).toBe(20);
    expect(header.contextBytesIsUpperBound).toBe(false);
    expect(header.archBytes).toBeLessThan(4096); // the fact the one-request design rests on
  });

  it('does NOT stop early while the architecture keys are still coming', () => {
    // archBytes is ~952; 800 bytes is still inside the block, so the reader must ask for more.
    const { header, complete } = parseGgufHeader(withTail().subarray(0, 800));
    expect(complete).toBe(false);
    expect(header.blockCount).toBe(35);
    expect(header.slidingWindowPatternLayers).toBeNull();
  });

  it('a half-read header is ALWAYS an upper bound, whatever architecture it is', () => {
    // gemma3 has a default period, so no layer-map condition fires: the flag must come from the truncation itself.
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

  // A 200 to a range request must never be buffered whole (a chunked 200 once read as length 0 and OOM'd the main process).
  it.each([
    ['a huge content-length', '5048350848', /ignored the range request \(HTTP 200, 5048350848 bytes\)/],
    ['NO content-length at all', null, /ignored the range request \(HTTP 200, no content-length\)/],
    ['an unparseable content-length', 'lots', /ignored the range request \(HTTP 200, lots bytes\)/],
  ])('refuses to buffer the body when the server ignores the range request (%s)', async (_n, len, msg) => {
    let bodyRead = 0;
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: (n: string) => (n === 'content-length' || len === 'lots' ? len : null) },
      arrayBuffer: async () => { bodyRead++; return new ArrayBuffer(8 * 1024 * 1024); },
    });
    await expect(fetchRemoteGgufHeader('https://example.invalid/m.gguf', fetchImpl as any)).rejects.toThrow(msg);
    expect(bodyRead).toBe(0);
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
