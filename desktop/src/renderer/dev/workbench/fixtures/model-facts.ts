// Facts for the fixture model list (fixtures/providers.ts), so the workbench can
// show the model-list tags against REAL numbers rather than invented ones.
//
// Taken on 2026-09-11 (docs/active/design/2026-09-11-model-picker-tags/):
//   · prices: OpenRouter's /api/v1/models, US dollars per million tokens;
//   · intelligence: Epoch AI's Capabilities Index, put on 0-100 with 0 at an
//     index of 100 (the tiniest models of 2023-24) and 100 at the top model,
//     GPT-6 Astra (166.57);
//   · value: each priced model against the others at its own intelligence level
//     (80 and up, 50 to 79, under 50), cheapest third great, priciest third poor,
//     over the 120 models with both a score and a price;
//   · price level (priced, unscored): thirds of the 335 priced OpenRouter models,
//     low under $0.45, high over $1.56, counting what you send three times as
//     much as what comes back;
//   · coding / science / facts: the best DeepSWE, GPQA Diamond and SimpleQA
//     Verified results in Epoch's download for that model;
//   · following instructions: LMArena's instruction_following ranking of
//     2026-09-02, 399 models.
// Claude plan aliases are scored as the model each alias runs today.
//
// Speeds: the two Qwen 3.x rows are Destin's own measurements on the Strix Halo
// (docs/roadmap/local-models.md, 2026-09-05: 31 and 5.3 tokens a second, about
// 23 and 4 words). The other two local rows are ILLUSTRATIVE estimates for a
// mid-size and a small model, marked `estimated` exactly as the real estimate
// will be — the workbench has no engine to measure.
import type { ModelFactsSnapshot } from '../../../../shared/model-facts';

const IF_OF = 399;

export function modelFacts(): ModelFactsSnapshot {
  return {
    topModel: 'GPT-6 Astra',
    asOf: '2026-09-11',
    models: {
      // ── Claude plan ───────────────────────────────────────────────────────
      'claude:haiku': { billing: 'subscription', intelligence: { score: 64, scoredAs: 'Claude Haiku 4.5', benchmarks: { science: 0.712, facts: 0.132, instructions: { rank: 83, of: IF_OF } } } },
      'claude:sonnet': { billing: 'subscription', intelligence: { score: 84, scoredAs: 'Claude Sonnet 5', benchmarks: { coding: 0.538, science: 0.905, facts: 0.337, instructions: { rank: 40, of: IF_OF } } } },
      'claude:opus[1m]': { billing: 'subscription', intelligence: { score: 94, scoredAs: 'Claude Opus 5', benchmarks: { coding: 0.736, science: 0.939, facts: 0.599, instructions: { rank: 2, of: IF_OF } } } },
      'claude:fable': { billing: 'subscription', intelligence: { score: 96, scoredAs: 'Claude Fable 5.1', benchmarks: { facts: 0.708, instructions: { rank: 5, of: IF_OF } } } },

      // ── OpenRouter ────────────────────────────────────────────────────────
      'openrouter:anthropic/claude-sonnet-4-6': { price: { in: 3, out: 15 }, value: 'poor', intelligence: { score: 79, benchmarks: { coding: 0.299, science: 0.874, facts: 0.355, instructions: { rank: 18, of: IF_OF } } } },
      'openrouter:openai/gpt-5': { price: { in: 1.25, out: 10 }, value: 'poor', intelligence: { score: 75, benchmarks: { science: 0.862, facts: 0.501, instructions: { rank: 127, of: IF_OF } } } },
      // No longer sold on OpenRouter: a score and no price, so no value tag (S-1).
      'openrouter:x-ai/grok-4': { intelligence: { score: 70, benchmarks: { science: 0.87, instructions: { rank: 131, of: IF_OF } } } },
      'openrouter:deepseek/deepseek-v3.2': { price: { in: 0.27, out: 0.4 }, value: 'great', intelligence: { score: 69 } },
      'openrouter:deepseek/deepseek-r1': { price: { in: 0.7, out: 2.5 }, value: 'fair', intelligence: { score: 59, benchmarks: { science: 0.717, instructions: { rank: 161, of: IF_OF } } } },
      // Priced but unscored: the price-level tag (F-3).
      'openrouter:google/gemini-3.8-flash': { price: { in: 0.75, out: 3.75 }, priceLevel: 'mid' },

      // ── ChatGPT plan ──────────────────────────────────────────────────────
      'chatgpt:gpt-5.6-sol': { billing: 'subscription', intelligence: { score: 93, benchmarks: { coding: 0.727, science: 0.935, facts: 0.697, instructions: { rank: 19, of: IF_OF } } } },
      'chatgpt:gpt-5.6-terra': { billing: 'subscription', intelligence: { score: 89, benchmarks: { coding: 0.696, science: 0.933, facts: 0.432, instructions: { rank: 39, of: IF_OF } } } },
      'chatgpt:gpt-5.6-luna': { billing: 'subscription', intelligence: { score: 85, benchmarks: { coding: 0.672, science: 0.916, facts: 0.41, instructions: { rank: 56, of: IF_OF } } } },
      'chatgpt:gpt-5.5': { billing: 'subscription', intelligence: { score: 89, benchmarks: { coding: 0.67, science: 0.907, facts: 0.63, instructions: { rank: 14, of: IF_OF } } } },

      // ── On this computer ──────────────────────────────────────────────────
      'local-engine:qwen2.5-coder:14b': { billing: 'local', intelligence: { score: 24, scoredAs: 'Qwen2.5 Coder 14B', borrowed: true }, speed: { wordsPerSecond: 13, estimated: true } },
      'local-engine:llama3.1:8b': { billing: 'local', intelligence: { score: 25, scoredAs: 'Llama 3.1 8B', borrowed: true, benchmarks: { science: 0.27, instructions: { rank: 311, of: IF_OF } } }, speed: { wordsPerSecond: 27, estimated: true } },
      // No public score for either original yet: "Not rated".
      'local-engine:qwen3.6-35b-a3b': { billing: 'local', speed: { wordsPerSecond: 23, estimated: false } },
      'local-engine:qwen3.8-27b': { billing: 'local', speed: { wordsPerSecond: 4, estimated: false } },
    },
  };
}
