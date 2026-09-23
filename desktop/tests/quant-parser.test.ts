import { describe, it, expect } from 'vitest';
import { parseGgufName, groupQuantOptions, quantDescription, findVisionFile } from '../src/main/models/quant-parser';

describe('parseGgufName', () => {
  it('parses standard quants', () => {
    expect(parseGgufName('Qwen3-4B-Instruct-2507-Q4_K_M.gguf')).toEqual({
      base: 'Qwen3-4B-Instruct-2507', quant: 'Q4_K_M', dynamic: false, part: null,
    });
    expect(parseGgufName('gemma-3-12b-it-Q8_0.gguf')?.quant).toBe('Q8_0');
    expect(parseGgufName('model-IQ2_XXS.gguf')?.quant).toBe('IQ2_XXS');
    expect(parseGgufName('model-F16.gguf')?.quant).toBe('F16');
    expect(parseGgufName('model-BF16.gguf')?.quant).toBe('BF16');
    // MXFP4 / MXFP4_MOE — gpt-oss / MoE native format (Amendment 2026-07-14 E).
    expect(parseGgufName('gpt-oss-20b-MXFP4.gguf')?.quant).toBe('MXFP4');
    expect(parseGgufName('gemma-4-26B-A4B-it-MXFP4_MOE.gguf')?.quant).toBe('MXFP4_MOE');
  });

  it('parses unsloth dynamic quants (UD- prefix)', () => {
    expect(parseGgufName('Qwen3-14B-UD-Q4_K_XL.gguf')).toEqual({
      base: 'Qwen3-14B', quant: 'UD-Q4_K_XL', dynamic: true, part: null,
    });
    expect(parseGgufName('gemma-3-27b-it-UD-IQ2_XXS.gguf')?.quant).toBe('UD-IQ2_XXS');
  });

  it('parses multi-part split suffixes', () => {
    expect(parseGgufName('Llama-4-Scout-17B-16E-Instruct-UD-Q4_K_XL-00001-of-00002.gguf')).toEqual({
      base: 'Llama-4-Scout-17B-16E-Instruct', quant: 'UD-Q4_K_XL', dynamic: true,
      part: { index: 1, of: 2 },
    });
  });

  it('DENYLISTS aux files — vision projectors + MTP draft models (real shapes)', () => {
    // Real repos ship UPPERCASE mmproj projectors next to the chat model. The
    // old regex parsed 'mmproj-BF16.gguf' as a "BF16" quant AND collided with
    // the real '<model>-BF16.gguf', dropping BOTH. Denylist by basename prefix.
    expect(parseGgufName('mmproj-BF16.gguf')).toBeNull();
    expect(parseGgufName('mmproj-F16.gguf')).toBeNull();
    expect(parseGgufName('mmproj-F32.gguf')).toBeNull();
    // MTP speculative-decode draft models — in an 'MTP/' subfolder and/or an
    // 'mtp-' basename. Not chat models. Basename check catches both.
    expect(parseGgufName('MTP/mtp-gemma-4-12B-it-Q4_0.gguf')).toBeNull();
    expect(parseGgufName('mtp-gemma-4-12B-it.gguf')).toBeNull();
    // 2026-09-05: the token does NOT always come first. Two of twelve surveyed
    // publishers put the model name ahead of it, and a start-anchored denylist
    // let those projectors onto the pick list as if they were chat quants.
    expect(parseGgufName('gemma-3-12b-it.mmproj-Q8_0.gguf')).toBeNull();
    expect(parseGgufName('google_gemma-3-4b-it-mmproj-f16.gguf')).toBeNull();
    // Unrecognized / non-gguf → null (drop silently — Amendment 2026-07-14 E).
    expect(parseGgufName('README.md')).toBeNull();
  });
});

describe('groupQuantOptions', () => {
  // Real tree shape for ONE model: single quants at root, a multi-part set
  // under a per-quant subfolder (gpt-oss convention), an mmproj projector
  // (uppercase — must be excluded), and a README.
  const files = [
    { path: 'M-Q4_K_M.gguf', size: 9_000, sha256: 'a'.repeat(64) },
    { path: 'M-BF16.gguf', size: 30_000, sha256: 'd'.repeat(64) },
    { path: 'Q8_0/M-Q8_0-00001-of-00002.gguf', size: 5_000, sha256: 'c'.repeat(64) },
    { path: 'Q8_0/M-Q8_0-00002-of-00002.gguf', size: 4_000, sha256: null },
    { path: 'mmproj-BF16.gguf', size: 500, sha256: 'e'.repeat(64) },   // aux — must be excluded
    { path: 'README.md', size: 10, sha256: null },
  ];

  it('groups by quant, orders multi-part sets, sums sizes, excludes aux', () => {
    const opts = groupQuantOptions(files);
    // Multi-part set grouped in order, sizes summed.
    const q8 = opts.find((o) => o.quant === 'Q8_0')!;
    expect(q8.files).toEqual([
      'Q8_0/M-Q8_0-00001-of-00002.gguf',
      'Q8_0/M-Q8_0-00002-of-00002.gguf',
    ]);
    expect(q8.totalSizeBytes).toBe(9_000);
    expect(q8.sha256ByFile['Q8_0/M-Q8_0-00002-of-00002.gguf']).toBeNull();
    expect(opts.find((o) => o.quant === 'Q4_K_M')!.totalSizeBytes).toBe(9_000);
    // The REAL BF16 survives — mmproj-BF16 was denylisted, NOT merged into it
    // (the collision that dropped both in the pre-hardening parser).
    const bf16 = opts.find((o) => o.quant === 'BF16')!;
    expect(bf16.files).toEqual(['M-BF16.gguf']);
    expect(bf16.totalSizeBytes).toBe(30_000);
    expect(opts.some((o) => o.quant === 'README')).toBe(false);
    expect(opts.every((o) => !o.files.some((f) => f.includes('mmproj')))).toBe(true);
  });

  it('drops INCOMPLETE multi-part sets (a missing part = undownloadable)', () => {
    const partial = [{ path: 'M-UD-Q4_K_XL-00002-of-00002.gguf', size: 1, sha256: null }];
    expect(groupQuantOptions(partial)).toEqual([]);
  });

  // 2026-09-05 §E1: the projector is reported ALONGSIDE the quant list, never
  // inside it. The denylist above already proves it is not a pickable quant.
  it('reports the repo projector on EVERY quant, and never inside files', () => {
    const opts = groupQuantOptions(files);
    expect(opts.length).toBeGreaterThan(1);
    for (const o of opts) {
      expect(o.visionFile).toEqual({ path: 'mmproj-BF16.gguf', size: 500, sha256: 'e'.repeat(64) });
      expect(o.visionBytes).toBe(500);
      // The projector must stay OUT of the file set: `files` is what later code
      // reads as "the complete 1..N parts of this quant".
      expect(o.files.some((f) => f.includes('mmproj'))).toBe(false);
      expect(o.sha256ByFile['mmproj-BF16.gguf']).toBeUndefined();
    }
    // And it is not folded into the download size either — that stays this
    // quant's own bytes (the projector is a separate leg of the job, §E2).
    expect(opts.find((o) => o.quant === 'Q4_K_M')!.totalSizeBytes).toBe(9_000);
  });

  // 2026-09-05: mradermacher/gemma-3-12b-it-GGUF ships exactly this shape, and
  // before the separator-anchored denylist its 590 MB projector was the ONLY
  // option the app offered — labelled 'Q8_0 · Highest quality quantization'.
  // Downloading it produced a file that cannot load.
  it('never offers an mmproj file as a quant, wherever the token sits in the name', () => {
    const opts = groupQuantOptions([
      { path: 'gemma-3-12b-it.mmproj-Q8_0.gguf', size: 590_179_104, sha256: null },
      { path: 'google_gemma-3-4b-it-mmproj-f16.gguf', size: 854_200_448, sha256: null },
      { path: 'gemma-3-12b-it-Q4_K_M.gguf', size: 9_000, sha256: null },
    ]);
    expect(opts.map((o) => o.quant)).toEqual(['Q4_K_M']);
    expect(opts[0].files).toEqual(['gemma-3-12b-it-Q4_K_M.gguf']);
  });

  it('finds the projector when the model name comes FIRST in the filename', () => {
    const opts = groupQuantOptions([
      { path: 'gemma-3-12b-it-Q4_K_M.gguf', size: 9_000, sha256: null },
      { path: 'gemma-3-12b-it.mmproj-f16.gguf', size: 854_200_448, sha256: 'f'.repeat(64) },
    ]);
    expect(opts).toHaveLength(1);
    expect(opts[0].visionFile).toEqual({
      path: 'gemma-3-12b-it.mmproj-f16.gguf', size: 854_200_448, sha256: 'f'.repeat(64),
    });
    expect(opts[0].visionBytes).toBe(854_200_448);
  });

  it('a text-only repo reports no projector at all', () => {
    const opts = groupQuantOptions([
      { path: 'M-Q4_K_M.gguf', size: 9_000, sha256: null },
      { path: 'MTP/mtp-M-Q4_0.gguf', size: 100, sha256: null }, // aux, but NOT a projector
      { path: 'README.md', size: 10, sha256: null },
    ]);
    expect(opts).toHaveLength(1);
    expect(opts[0].visionFile).toBeUndefined();
    expect(opts[0].visionBytes).toBeUndefined();
  });
});

describe('findVisionFile — preference order F16 → BF16 → first mmproj*', () => {
  const f = (path: string, size: number) => ({ path, size, sha256: null });
  // Real shape: unsloth/gemma-3-12b-it-GGUF ships all three (verified against
  // the live Hugging Face tree listing on 2026-09-05).
  const bf16 = f('mmproj-BF16.gguf', 854_200_448);
  const f16 = f('mmproj-F16.gguf', 854_200_448);
  const f32 = f('mmproj-F32.gguf', 1_676_341_376);

  it('prefers F16 even when BF16 and F32 are listed first', () => {
    expect(findVisionFile([bf16, f32, f16])?.path).toBe('mmproj-F16.gguf');
  });

  it('falls back to BF16 when there is no F16', () => {
    expect(findVisionFile([f32, bf16])?.path).toBe('mmproj-BF16.gguf');
  });

  it('falls back to the FIRST mmproj* when neither is present', () => {
    expect(findVisionFile([f32, f('mmproj-Q8_0.gguf', 1)])?.path).toBe('mmproj-F32.gguf');
  });

  it('BF16 is never mistaken for F16 by substring', () => {
    // 'mmproj-BF16.gguf' contains the letters F16; only a separator-anchored
    // match keeps it out of the top rank.
    expect(findVisionFile([bf16])?.path).toBe('mmproj-BF16.gguf');
    expect(findVisionFile([bf16, f16])?.path).toBe('mmproj-F16.gguf');
  });

  it('handles the long lowercase naming real repos also use', () => {
    // ggml-org/Qwen2.5-VL-7B-Instruct-GGUF ships exactly this (verified against
    // the live tree listing on 2026-09-05) — the model name sits between the
    // 'mmproj' prefix and the precision, and the precision is lowercase. It must
    // still rank as the F16 file, not fall through to "first mmproj*".
    const real = f('mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf', 1_000);
    expect(findVisionFile([f('mmproj-other.gguf', 1), real])?.path)
      .toBe('mmproj-Qwen2.5-VL-7B-Instruct-f16.gguf');
  });

  it('matches on the BASENAME, keeps the full path, and carries size + sha', () => {
    const sub = { path: 'vision/MMPROJ-f16.gguf', size: 42, sha256: 'b'.repeat(64) };
    expect(findVisionFile([sub])).toEqual({ path: 'vision/MMPROJ-f16.gguf', size: 42, sha256: 'b'.repeat(64) });
  });

  it('matches the token after a separator, not only at the start', () => {
    // mradermacher / Mungert shapes — real, surveyed 2026-09-05.
    expect(findVisionFile([f('gemma-3-12b-it.mmproj-f16.gguf', 854_200_448)])?.path)
      .toBe('gemma-3-12b-it.mmproj-f16.gguf');
    expect(findVisionFile([f('google_gemma-3-4b-it-mmproj-f16.gguf', 1)])?.path)
      .toBe('google_gemma-3-4b-it-mmproj-f16.gguf');
    // A separator is still REQUIRED, so a chat model whose name merely contains
    // the letters cannot be mistaken for a projector.
    expect(findVisionFile([f('nommproj-Q4_K_M.gguf', 1)])).toBeNull();
  });

  it('is null for a repo with no projector — mtp- drafts are not projectors', () => {
    expect(findVisionFile([f('M-Q4_K_M.gguf', 1), f('MTP/mtp-M-Q4_0.gguf', 1)])).toBeNull();
  });
});

describe('quantDescription', () => {
  it('maps quant families to plain language', () => {
    expect(quantDescription('Q8_0')).toMatch(/highest quality/i);
    expect(quantDescription('UD-Q4_K_XL')).toMatch(/recommended/i);
    expect(quantDescription('IQ2_XXS')).toMatch(/smallest/i);
    expect(quantDescription('F16')).toMatch(/original/i);
    expect(quantDescription('MXFP4')).toMatch(/native/i);
    expect(quantDescription('MXFP4_MOE')).toMatch(/native/i);
  });
});

// Roadmap (local-models, 2026-09-05): whole publishers were invisible in search.
// Cause 1 — a DOT before the quant. Real listings, verbatim, measured 2026-09-23:
// TheBloke/Llama-2-7B-Chat-GGUF (12 files, 0 offered) and
// mradermacher/gemma-3-12b-it-GGUF (13 files, 0 offered — its projectors stay off).
describe('dot before the quant (TheBloke, mradermacher)', () => {
  const f = (path: string, size = 1) => ({ path, size, sha256: null });
  it('parses <name>.<QUANT>.gguf', () => {
    expect(parseGgufName('llama-2-7b-chat.Q4_K_M.gguf')).toEqual({
      base: 'llama-2-7b-chat', quant: 'Q4_K_M', dynamic: false, part: null,
    });
    expect(parseGgufName('gemma-3-12b-it.IQ4_XS.gguf')?.quant).toBe('IQ4_XS');
    // A dot INSIDE the model name is not a separator for the quant.
    expect(parseGgufName('Llama-3.1-8B-Instruct-Q4_K_M.gguf')?.base).toBe('Llama-3.1-8B-Instruct');
  });
  it('offers every TheBloke quant', () => {
    const names = ['Q2_K', 'Q3_K_L', 'Q3_K_M', 'Q3_K_S', 'Q4_0', 'Q4_K_M', 'Q4_K_S', 'Q5_0', 'Q5_K_M', 'Q5_K_S', 'Q6_K', 'Q8_0'];
    const opts = groupQuantOptions(names.map((q) => f(`llama-2-7b-chat.${q}.gguf`)));
    expect(opts.map((o) => o.quant).sort()).toEqual([...names].sort());
  });
  it('offers mradermacher quants and still keeps its dotted projectors off the list', () => {
    const files = ['IQ4_XS', 'Q2_K', 'Q3_K_L', 'Q3_K_M', 'Q3_K_S', 'Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q5_K_S', 'Q6_K', 'Q8_0']
      .map((q) => f(`gemma-3-12b-it.${q}.gguf`))
      .concat([f('gemma-3-12b-it.mmproj-Q8_0.gguf'), f('gemma-3-12b-it.mmproj-f16.gguf')]);
    const opts = groupQuantOptions(files);
    expect(opts).toHaveLength(11);
    expect(opts.every((o) => !o.files.some((p) => /mmproj/.test(p)))).toBe(true);
    expect(opts[0].visionFile?.path).toBe('gemma-3-12b-it.mmproj-f16.gguf');
  });
});

// Cause 2 — lowercase quants, including Mungert's "double" quants (f16 output
// tensors + q8_0 weights). Mungert/gemma-3-4b-it-gguf's real listing, verbatim
// (2026-09-23): 24 .gguf files, 0 offered before this fix.
describe('lowercase and double quants (Mungert)', () => {
  const f = (path: string, size = 1) => ({ path, size, sha256: null });
  const mungert = [
    'gemma-3-4b-it-bf16-q8_0.gguf', 'gemma-3-4b-it-f16-q6_k.gguf', 'gemma-3-4b-it-f16-q8_0.gguf',
    'google_gemma-3-4b-it-bf16-q8.gguf', 'google_gemma-3-4b-it-bf16.gguf', 'google_gemma-3-4b-it-f16-q8.gguf',
    'google_gemma-3-4b-it-iq3_xs.gguf', 'google_gemma-3-4b-it-iq4_nl.gguf', 'google_gemma-3-4b-it-iq4_xs.gguf',
    'google_gemma-3-4b-it-mmproj-bf16.gguf', 'google_gemma-3-4b-it-mmproj-f16.gguf', 'google_gemma-3-4b-it-mmproj-f32.gguf',
    'google_gemma-3-4b-it-mmproj-q8.gguf', 'google_gemma-3-4b-it-q3_k_m.gguf', 'google_gemma-3-4b-it-q3_k_s.gguf',
    'google_gemma-3-4b-it-q4_0.gguf', 'google_gemma-3-4b-it-q4_1.gguf', 'google_gemma-3-4b-it-q4_k_m.gguf',
    'google_gemma-3-4b-it-q4_k_s.gguf', 'google_gemma-3-4b-it-q5_k_m.gguf', 'google_gemma-3-4b-it-q5_k_s.gguf',
    'google_gemma-3-4b-it-q6_k_m.gguf', 'google_gemma-3-4b-it-q8.gguf', 'mmproj.gguf',
  ];
  it('keeps the quant exactly as the file writes it', () => {
    expect(parseGgufName('google_gemma-3-4b-it-q4_k_m.gguf')).toEqual({
      base: 'google_gemma-3-4b-it', quant: 'q4_k_m', dynamic: false, part: null,
    });
    expect(parseGgufName('gemma-3-4b-it-f16-q8_0.gguf')).toEqual({
      base: 'gemma-3-4b-it', quant: 'f16-q8_0', dynamic: false, part: null,
    });
  });
  it('offers all 19 model files as distinct options and none of the 5 projectors', () => {
    const opts = groupQuantOptions(mungert.map((p) => f(p)));
    expect(opts).toHaveLength(19);
    expect(new Set(opts.map((o) => o.quant)).size).toBe(19);
    expect(opts.some((o) => o.files.some((p) => /mmproj/.test(p)))).toBe(false);
  });
  it('describes a lowercase or double quant by its weight precision', () => {
    expect(quantDescription('q4_k_m')).toBe(quantDescription('Q4_K_M'));
    expect(quantDescription('f16-q8_0')).toBe(quantDescription('Q8_0'));
    expect(quantDescription('bf16')).toBe(quantDescription('BF16'));
    expect(quantDescription('iq3_xs')).toBe(quantDescription('IQ3_XS'));
  });
  it('still rejects files that are not model quants', () => {
    expect(parseGgufName('mmproj.gguf')).toBeNull();
    expect(parseGgufName('RVN-BF16-mtp.gguf')).toBeNull();
    expect(parseGgufName('ggml-vocab-llama-bpe.gguf')).toBeNull();
    expect(parseGgufName('imatrix.gguf')).toBeNull();
  });
});
