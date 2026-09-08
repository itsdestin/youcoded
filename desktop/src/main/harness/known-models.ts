// Curated known-model capability registry (spec §4.1, decision 4). Keyed by model
// FAMILY via a case-insensitive regex on the modelId — this is the ONLY place a
// model name influences behavior. Carries the BEHAVIORAL tuning that GGUF metadata
// can't (prompt variant, doom-loop, parallel safety, presentation, tool support).
// Context windows are NOT the source of truth here — a later task reads the real
// window from the engine; maxContextWindow below is only a documented sanity ceiling.
//
// NOT exhaustive by design: the families people actually run, everything else falls
// to the fallback. The FACTUAL fields (maxContextWindow, supportsTools) are VERIFIED
// in a later task from model cards + GGUF metadata — the seed values here are the
// conservative behavioral tuning we can reason about now.
export interface KnownModelEntry {
  match: string;                         // case-insensitive regex tested against modelId
  label: string;                         // human name (logs/UI)
  maxToolPresentation?: import('./capability-profile').ToolPresentation;
  promptVariant?: import('./capability-profile').PromptVariant;
  doomLoopThreshold?: number;
  supportsParallelToolCalls?: boolean;
  supportsTools?: boolean;               // verified in a later task
  maxContextWindow?: number;             // documented trained max (sanity ceiling; discovery wins)
  /** Can this model accept image input? Overrides the provider default both ways,
   *  which is the point: OpenRouter serves vision and text-only models from one
   *  endpoint, so the transport cannot answer this and the modelId must. */
  supportsVision?: boolean;
}

// Seed entries — behavioral tuning only; a later task verifies/fills the factual fields.
//
// Facts below verified 2026-07-16 against official model cards. `match` uses \W?/optional
// separators so llama.cpp GGUF id conventions (dots dropped, hyphens vs underscores, vendor
// prefixes) still resolve — quant-makers are not consistent about punctuation.
export const KNOWN_MODELS: KnownModelEntry[] = [
  // Qwen 3.6 MoE (35B-A3B, 256 experts / 8 routed + 1 shared): capable — full presentation,
  // standard doom-loop. Native 262,144-token context (YaRN-extensible to ~1,010,000; ceiling
  // below uses the native/default trained max per task instructions). Tool calling confirmed:
  // model card documents --tool-call-parser qwen3_coder for vLLM/SGLang, and Qwen-Agent for
  // agentic workflows; llama.cpp --jinja tool calling verified working against this GGUF
  // family (e.g. `llama-server --jinja -hf unsloth/Qwen3.6-...-GGUF`).
  // source: https://huggingface.co/Qwen/Qwen3.6-35B-A3B
  { match: 'qwen\\W?3\\.?6.*(35b|moe|a\\d+b)', label: 'Qwen 3.6 MoE', maxToolPresentation: 'full', doomLoopThreshold: 3, supportsTools: true, maxContextWindow: 262144 },
  // Qwen 3.5 dense small (9B, confirmed dense — no MoE routing): simplified presentation,
  // tighter doom-loop. Native 262,144-token context (YaRN-extensible to ~1,010,000).
  // Tool calling confirmed via model card's Agentic Usage section (qwen3_coder parser).
  // source: https://huggingface.co/Qwen/Qwen3.5-9B
  { match: 'qwen\\W?3\\.?5.*9b', label: 'Qwen 3.5 9B', maxToolPresentation: 'simplified', doomLoopThreshold: 2, supportsTools: true, maxContextWindow: 262144 },
  // Reviewed 27B local class for plan authoring. It remains a distinct registry
  // row so eligibility can fail closed for lookalike/unknown local model ids.
  { match: 'qwen\\W?3\\.?5.*27b', label: 'Qwen 3.5 27B', maxToolPresentation: 'full', doomLoopThreshold: 3, supportsTools: true, maxContextWindow: 262144 },
  // Qwen 3.5 small (≤4B). Exists for a specific reason: without an entry, a 2B
  // fell through to the window-only fallback, which read the `-c 128000` it was
  // launched with, judged it a full-capability model, and handed it the whole
  // skill catalog — which it spent a turn reciting (Destin, 2026-07-28).
  // Confirmed to exist by being run here as `Qwen3.5-2B-Q8_0`.
  // UNVERIFIED — two separate things, both needing a check against a model card:
  //   (a) maxContextWindow is INHERITED from the 9B entry's documented 262,144,
  //       not read for this variant. It can only ever clamp DOWN, so an
  //       over-estimate is inert; an under-estimate would wrongly shrink a real
  //       window, which is why it is not guessed lower.
  //   (b) 'simplified' is a capability judgment from parameter count, not a
  //       sourced claim about this model's tool-calling.
  { match: 'qwen\\W?3\\.?5(?:(?!\\d+b).)*[0-4]b', label: 'Qwen 3.5 (small, ≤4B)', maxToolPresentation: 'simplified', doomLoopThreshold: 2, supportsTools: true, maxContextWindow: 262144 },
  // Qwen 3.5 "large": CORRECTED from the seed assumption of dense — research found no dense
  // Qwen 3.5 variant above 27B. The actual large-end release is 122B-A10B, an MoE model
  // (122B total / 10B active, 256 experts). Keeping "70b" in the match pattern as a tolerant
  // fallback in case a dense ~70B variant ships later; only 122B-A10B is confirmed to exist
  // today. Native 262,144-token context; tool calling confirmed (model card's dedicated
  // "Tool Use"/"Tool Call" sections, BFCL-V4 benchmarked).
  // source: https://huggingface.co/Qwen/Qwen3.5-122B-A10B
  { match: 'qwen\\W?3\\.?5.*(70b|122b)', label: 'Qwen 3.5 (large, MoE 122B-A10B)', maxToolPresentation: 'full', doomLoopThreshold: 3, supportsTools: true, maxContextWindow: 262144 },
  // Gemma 4, E2B/E4B (on-device "effective"-parameter variants, PLE-based): simplified
  // presentation + tighter doom-loop, matching the treatment given to other small/on-device
  // entries in this registry. 128K native context per the official model card. Native
  // function-calling is documented, but llama.cpp integration was rocky at launch (the
  // upstream `llama_chat_message` struct only carries role/content, so the vendor Jinja
  // template's tool/properties/required objects failed to evaluate); a template + PEG-grammar
  // tool-call-parsing fix landed in llama-server (referenced as PR #21326 in community
  // trackers). Recording supportsTools: true per the model's documented capability, but this
  // is the one fact in this registry that depends on the user's llama.cpp build being recent
  // enough to include that fix — flagging for acceptance-time re-check against Destin's actual
  // build/quant.
  // source: https://ai.google.dev/gemma/docs/core/model_card_4
  // UNVERIFIED: llama.cpp tool-call support for this family depends on a llama-server fix
  // (community-tracked as PR #21326) being present in the installed llama.cpp build; not
  // independently confirmed against Destin's local build.
  { match: 'gemma\\W?4.*e[24]b', label: 'Gemma 4 (E2B/E4B)', maxToolPresentation: 'simplified', doomLoopThreshold: 2, supportsTools: true, maxContextWindow: 131072 },
  // Gemma 4, 12B / 26B-A4B / 31B: full presentation. 256K native context per the official
  // model card. Same llama.cpp tool-calling caveat as the E2B/E4B entry above.
  // source: https://ai.google.dev/gemma/docs/core/model_card_4
  // UNVERIFIED: see llama.cpp tool-call caveat on the Gemma 4 E2B/E4B entry above — applies
  // identically here.
  { match: 'gemma\\W?4', label: 'Gemma 4', maxToolPresentation: 'full', doomLoopThreshold: 3, supportsTools: true, maxContextWindow: 262144 },
  // Gemma 3n (E2B/E4B effective; distinct, earlier family from Gemma 4 — both happen to reuse
  // the E2B/E4B naming convention, so this pattern requires the "3n" version token specifically
  // to avoid colliding with the Gemma 4 E2B/E4B entries above): tiny — simplified, tightest
  // doom-loop. Official model card documents a 32K-token total input context (not 128K/256K
  // like Gemma 4) — do not conflate the two families' context ceilings.
  // source: https://huggingface.co/google/gemma-3n-E4B-it
  // UNVERIFIED: the official Gemma 3n model card makes no mention of function/tool calling
  // anywhere (unlike Gemma 4, which has a dedicated function-calling doc page). Treating as
  // conservatively unsupported (supportsTools: false) given the absence of documented support,
  // rather than guessing. Re-verify if Destin's actual GGUF quant ships a tool-call chat
  // template.
  { match: 'gemma\\W?3n', label: 'Gemma 3n (E2B/E4B)', maxToolPresentation: 'simplified', doomLoopThreshold: 2, supportsTools: false, maxContextWindow: 32768 },
];

export function matchKnownModel(modelId: string, registry: KnownModelEntry[] = KNOWN_MODELS): KnownModelEntry | undefined {
  return registry.find((e) => { try { return new RegExp(e.match, 'i').test(modelId); } catch { return false; } });
}
