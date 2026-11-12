// Which licence notice a model download needs (card #45, Destin 2026-11-12: "a short confirmation popup after
// clicking download/continue, that offers cancel/download buttons").
//
// SOURCES, checked 2026-11-12 (not from memory):
//  - huggingface.co/unsloth/gemma-4-E4B-it-GGUF, .../gemma-4-12b-it-GGUF and .../gemma-4-26B-A4B-it-GGUF — the three Gemma builds
//    curated-models.ts offers — each list "License: apache-2.0".
//  - huggingface.co/google/gemma-4-E4B-it names the same licence and links ai.google.dev/gemma/docs/gemma_4_license, which is
//    the plain Apache License 2.0 text (no prohibited-use policy, no extra clauses).
//  So Gemma 4 is NOT under the older "Gemma Terms of Use" that the card's first note assumed.
//  - UNCONFIRMED: other Gemma builds (Gemma 1 to 3, picked through "Add from Hugging Face"). They were published under Google's
//    separate Gemma Terms of Use, but nothing here checked the page of the exact build, so their wording says so.

export type GemmaNotice =
  | { kind: 'apache'; licenceUrl: string }   // confirmed above
  | { kind: 'unchecked' };                    // a Gemma build whose terms were not checked

const GEMMA_4_LICENCE_URL = 'https://ai.google.dev/gemma/docs/gemma_4_license';

/** The notice for a model repo id (e.g. "unsloth/gemma-4-E4B-it-GGUF"), or null when it is not a Gemma build. */
export function gemmaNoticeFor(repo: string): GemmaNotice | null {
  const r = repo.toLowerCase();
  if (!r.includes('gemma')) return null;
  // "gemma-4-…", "gemma4-…", "gemma_4": the Gemma 4 family only.
  if (/gemma[-_ ]?4(?![0-9])/.test(r)) return { kind: 'apache', licenceUrl: GEMMA_4_LICENCE_URL };
  return { kind: 'unchecked' };
}
