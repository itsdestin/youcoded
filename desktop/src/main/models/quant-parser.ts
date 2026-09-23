// GGUF filename → quant metadata (spec §4.2). PURE — no fs/network — so the
// unsloth fixture tests pin every naming family we claim to support:
//   standard  …-Q4_K_M.gguf / …-Q8_0.gguf / …-IQ2_XXS.gguf / …-F16.gguf
//   unsloth   …-UD-Q4_K_XL.gguf (dynamic quants, often in a subfolder)
//   mxfp4     …-MXFP4.gguf / …-MXFP4_MOE.gguf (gpt-oss / MoE native 4-bit)
//   splits    …-00001-of-000NN.gguf (downloaded as a set, addressed via part 1)
// Aux files (mmproj* vision projectors, mtp-* draft models) are DENYLISTED —
// they are not chat models (Amendment 2026-07-14 E).
// WHY the projector is still reported (2026-09-05, design §E1): a projector is
// not a quant, so it stays off the pick list — but the app still needs to know
// it EXISTS, or it can never download one or tell the user the model can see.
// groupQuantOptions therefore hangs it off every QuantOption of the repo, since
// whichever quant the user picks, the same projector pairs with it.
import type { ManifestVisionFile, QuantOption } from '../../shared/model-manager-types';

export interface ParsedGgufName {
  base: string;
  quant: string;               // includes the UD- prefix for dynamic quants
  dynamic: boolean;            // unsloth dynamic (UD-) quant
  part: { index: number; of: number } | null;
}

// Quant token grammar: optional UD- prefix, then (I)Q<digit>_SUFFIX, a raw
// float type, or MXFP4(_MOE) (gpt-oss / MoE native 4-bit), optionally led by a
// float type for "double" quants (below). Anchored to a separator and the .gguf
// extension so model names containing 'q4' mid-word can't false-match.
//
// WHY case-INsensitive (2026-09-23): an earlier comment here said lowercase
// tokens never appear in real chat-model filenames — they do. Mungert
// (`…-q4_k_m.gguf`), ggml-org (`gemma-3-1b-it-f16.gguf`), Google's own QAT repos
// (`…-qat-q4_0.gguf`) and bartowski's bf16 files were all invisible. Measured on
// 1,568 files across 89 popular GGUF repos: no existing label changes. What it
// adds beyond chat models is other whole model repos search already returns
// (speech, embedding) whose UPPERCASE-named siblings were already offered — the
// file name was never the chat/non-chat gate. Non-model files (projectors,
// `-mtp` drafts, vocab, imatrix) still fail to match. The quant is returned
// exactly as written, because manifests and backfill need Hugging Face's own
// string.
//
// WHY the optional leading float (Mungert's `gemma-3-4b-it-f16-q8_0.gguf` = f16
// output tensors + q8_0 weights): without it the quant is just `q8_0`, and the
// repo's bf16-q8_0 and f16-q8_0 files collide on one key and are dropped as an
// "incomplete split set". The lazy base makes the longest quant win.
//
// WHY '[-.]' and not just '-' (2026-09-23): TheBloke and mradermacher — two of
// the largest GGUF publishers — write `<name>.Q4_K_M.gguf` with a DOT, so every
// one of their repos offered nothing. A dot inside the model name ('Llama-3.1-…')
// cannot false-match: the text after it must be a whole quant token running
// to '.gguf'. Their dotted projectors ('…it.mmproj-Q8_0.gguf') are still caught
// by the separator-anchored denylist below before this pattern runs.
const NAME_RE = /^(.+?)[-.](UD-)?((?:(?:BF16|F16|F32)-)?(?:(?:I?Q\d+_[A-Z0-9_]+)|Q\d+|F16|F32|BF16|MXFP4_MOE|MXFP4))(?:-(\d{5})-of-(\d{5}))?\.gguf$/i;

// Aux-file denylist (Amendment 2026-07-14 E): vision projectors ('mmproj',
// UPPERCASE in real repos) and MTP speculative-decode draft models ('mtp-',
// often in an 'MTP/' subfolder — the basename check catches both). These are
// NOT chat models and must never appear as downloadable quants. Matched on the
// BASENAME, case-insensitively.
//
// WHY it anchors on a SEPARATOR and not on the start of the name (2026-09-05):
// the token does not always come first. Several publishers put the model name
// ahead of it — 'gemma-3-12b-it.mmproj-Q8_0.gguf',
// 'google_gemma-3-4b-it-mmproj-f16.gguf' — and a start-anchored denylist let
// those straight onto the pick list AS A QUANT. On mradermacher/gemma-3-12b-it-GGUF
// the 590 MB projector was the ONLY option the app offered, labelled 'Q8_0 —
// highest quality quantization'; picking it downloaded a file that cannot load.
const AUX_BASENAME_RE = /(^|[-_.])(mmproj|mtp-)/i;

export function parseGgufName(fileName: string): ParsedGgufName | null {
  const base = fileName.split('/').pop() ?? fileName; // callers may pass repo-relative paths
  if (AUX_BASENAME_RE.test(base)) return null;        // projector / draft model — skip
  const m = NAME_RE.exec(base);
  if (!m) return null;
  return {
    base: m[1],
    quant: `${m[2] ?? ''}${m[3]}`,
    dynamic: m[2] !== undefined, // 'UD-' in either case (the pattern is case-insensitive)
    part: m[4] ? { index: Number(m[4]), of: Number(m[5]) } : null,
  };
}

/** Plain-language quality/size description per quant family (spec §4.2). */
export function quantDescription(quant: string): string {
  // Case-folded and stripped of a double quant's leading float type, so
  // `f16-q8_0` reads as the Q8_0 it mostly is and `q4_k_m` as Q4_K_M.
  const q = quant.replace(/^UD-/i, '').replace(/^(BF16|F16|F32)-(?=.)/i, '').toUpperCase();
  if (/^MXFP4/.test(q)) return 'Native 4-bit — the format this model ships in, recommended';
  if (/^(F16|F32|BF16)$/.test(q)) return 'Original precision — largest download, no quality loss';
  if (/^Q8/.test(q)) return 'Highest quality quantization — near-original output';
  if (/^Q6/.test(q)) return 'Very high quality — slightly smaller than Q8';
  if (/^Q5/.test(q)) return 'High quality — a good step down in size';
  if (/^Q4/.test(q)) return quant.startsWith('UD-')
    ? 'Recommended — unsloth dynamic quant, best quality for the size'
    : 'Recommended balance of quality and size';
  if (/^(I?Q3)/.test(q)) return 'Compact — noticeable quality loss on hard tasks';
  return 'Smallest — significant quality loss, fits tight machines';
}

interface TreeFile { path: string; size: number; sha256: string | null; }

// A repo's vision projector, by BASENAME (subfolders keep their path). Real
// repos ship these UPPERCASE next to the chat model, so match case-insensitively
// — the same way AUX_BASENAME_RE denylists them from the quant list, and
// separator-anchored for the same reason: 'gemma-3-12b-it.mmproj-f16.gguf' is a
// real 854 MB projector, and a start-anchored test would report that publisher's
// vision models as text-only forever.
const MMPROJ_BASENAME_RE = /(^|[-_.])mmproj.*\.gguf$/i;

/** Is this file a vision projector rather than a model? Exported because the
 *  CACHE SCAN has to ask the same question of files on disk (design §E2): a
 *  projector sits in the model's folder, and counting it as one of the split
 *  parts would both invent a spare model row and make a half-fetched projector
 *  read as a published part. One regex, so disk and repo can never disagree.
 *  Accepts a bare basename or a repo-relative path. */
export function isVisionProjectorFile(fileNameOrPath: string): boolean {
  const base = fileNameOrPath.split('/').pop() ?? fileNameOrPath;
  return MMPROJ_BASENAME_RE.test(base);
}

// Preference order the design pins: mmproj-F16 first, then BF16, then whatever
// mmproj file came first in the repo listing. WHY F16 over BF16: they are the
// same size and the same weights, and F16 is the one llama.cpp's own tooling
// emits, so it is the file most repos actually keep current. F32 (real — unsloth
// ships all three) is twice the download for no visible gain, so it only wins
// when it is the ONLY projector.
// The rank is matched on a SEPARATOR-anchored token so 'mmproj-BF16.gguf' can
// never be mistaken for the F16 file by a bare substring test, and so a repo
// naming it 'mmproj-model-f16.gguf' still ranks correctly.
function projectorRank(basename: string): number {
  if (/[-_.]F16\.gguf$/i.test(basename)) return 0;
  if (/[-_.]BF16\.gguf$/i.test(basename)) return 1;
  return 2;
}

/** The repo's vision projector, or null for a text-only repo. Exported for the
 *  tests that pin the preference order; callers get it off each QuantOption. */
export function findVisionFile(files: TreeFile[]): ManifestVisionFile | null {
  let best: { file: TreeFile; rank: number } | null = null;
  for (const f of files) {
    const base = f.path.split('/').pop() ?? f.path;
    if (!isVisionProjectorFile(base)) continue;
    const rank = projectorRank(base);
    // Strictly-better only, so ties keep the repo listing's own order — that is
    // what "then the first mmproj*" means.
    if (best === null || rank < best.rank) best = { file: f, rank };
  }
  return best === null ? null : { path: best.file.path, size: best.file.size, sha256: best.file.sha256 };
}

/** Group a repo's GGUF files into downloadable quant options. Multi-part sets
 *  are ordered by part index and must be COMPLETE — a set missing any part is
 *  dropped (downloading it would produce an unloadable model).
 *
 *  When the repo ships a vision projector, every option carries it as
 *  `visionFile` + `visionBytes`. It is deliberately NOT a member of `files`:
 *  `files` means "the split parts of THIS quant, complete 1..N", and later code
 *  judges a download finished by that list alone — adding the projector to it
 *  would let a half-downloaded projector read as a finished model. */
export function groupQuantOptions(files: TreeFile[]): QuantOption[] {
  // Found BEFORE the loop below, which still skips every mmproj file: the
  // denylist is what keeps a projector off the pick list, and it stays.
  const visionFile = findVisionFile(files);
  const byQuant = new Map<string, { files: { path: string; size: number; sha256: string | null; part: number }[]; of: number }>();
  for (const f of files) {
    const parsed = parseGgufName(f.path);
    if (!parsed) continue;
    const entry = byQuant.get(parsed.quant) ?? { files: [], of: parsed.part?.of ?? 1 };
    entry.of = Math.max(entry.of, parsed.part?.of ?? 1);
    entry.files.push({ path: f.path, size: f.size, sha256: f.sha256, part: parsed.part?.index ?? 1 });
    byQuant.set(parsed.quant, entry);
  }
  const out: QuantOption[] = [];
  for (const [quant, entry] of byQuant) {
    entry.files.sort((a, b) => a.part - b.part);
    const indices = entry.files.map((f) => f.part);
    const complete = indices.length === entry.of && indices.every((idx, i) => idx === i + 1);
    if (!complete) continue; // incomplete split set — undownloadable, skip
    out.push({
      quant,
      description: quantDescription(quant),
      files: entry.files.map((f) => f.path),
      totalSizeBytes: entry.files.reduce((s, f) => s + f.size, 0),
      sha256ByFile: Object.fromEntries(entry.files.map((f) => [f.path, f.sha256])),
      // Every quant of the repo, because whichever one the user picks, the same
      // projector pairs with it. A text-only repo leaves both keys absent, so
      // nothing downstream has to distinguish "no projector" from "not looked".
      ...(visionFile ? { visionFile, visionBytes: visionFile.size } : {}),
    });
  }
  // Small-to-large reads naturally in the picker UI.
  return out.sort((a, b) => a.totalSizeBytes - b.totalSizeBytes);
}
