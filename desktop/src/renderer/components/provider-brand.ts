// src/renderer/components/provider-brand.ts
//
// Derives a brand color (and optional icon) for a model chip from the model's
// id and/or its provider type. This is the ONE place that maps "which company
// made this model" → "what color does its status-bar chip read as", so both the
// Claude Code alias chips and the native-runtime chips pull from the same
// palette.
//
// Design: chips now use the standard `bg-panel border-edge-dim` surface (same as
// every other status-bar chip — usage, theme, version, etc.) but keep a
// brand-colored TEXT color and a matching colored BORDER outline. This makes
// the model chip family read as part of the status bar while still being
// identifiable at a glance by provider.
//
// Provider detection is keyword-based against the model id (and the provider
// type as a fallback). OpenRouter ids carry the org prefix (`openai/gpt-4o`,
// `anthropic/claude-sonnet-5`, `qwen/qwen3-coder`), local GGUF filenames
// typically name the model (`qwen2.5-coder:14b`, `gemma-3-27b.gguf`), and
// direct-key providers send the raw API model id (`gpt-4o`, `claude-sonnet-5`,
// `gemini-2.5-flash`). A single regex sweep per brand covers all of these.

/** A resolved brand for a model chip. `color` is a hex string (used for text
 *  + border via inline style); `icon` is an optional inline SVG key. */
export interface ModelBrand {
  /** Brand color as a hex string (e.g. '#10A37F'). Used for the chip's text
   *  and border. Chipped via inline style, not a CSS class, because the colors
   *  are brand-specific and theme-independent (per the "status colors stay
   *  hardcoded" rule in CLAUDE.md). */
  color: string;
  /** Short brand name for the icon's title/aria. */
  brandName: string;
  /** Optional icon key — rendered by `<ProviderIcon>` in StatusBar. */
  icon?: ProviderIconKey;
}

export type ProviderIconKey =
  | 'openai'
  | 'anthropic'
  | 'claudecode'
  | 'google'
  | 'qwen'
  | 'grok'
  | 'kimi'
  | 'deepseek'
  | 'meta'
  | 'mistral'
  | 'cohere'
  | 'perplexity'
  // The two sign-in marks setup needed (first-run deck R-3, 2026-10-04): Claude's own
  // spark (not Anthropic's "A") and OpenRouter's, for their "Log in with" buttons.
  | 'claude'
  | 'openrouter';

// --- Brand palettes --------------------------------------------------------
//
// Colors map to CSS custom properties defined in globals.css per theme
// (--brand-*), ensuring crisp contrast (≥ 4.5:1) on both Light and Dark
// surfaces while keeping each vendor's signature brand identity intact.

/** OpenAI's signature green — adaptive CSS variable. */
const OPENAI_COLOR = 'var(--brand-openai)';
/** Anthropic's brand orange/terracotta — adaptive CSS variable. */
const ANTHROPIC_COLOR = 'var(--brand-claude)';
/** Qwen's brand purple — adaptive CSS variable. */
const QWEN_COLOR = 'var(--brand-qwen)';
/** Google's AI blue — adaptive CSS variable. */
const GOOGLE_COLOR = 'var(--brand-google)';
/** Grok / xAI monochrome slate/silver — adaptive CSS variable. */
const GROK_COLOR = 'var(--brand-grok)';
/** Kimi / Moonshot cyan-teal — adaptive CSS variable. */
const KIMI_COLOR = 'var(--brand-kimi)';
/** DeepSeek signature blue — adaptive CSS variable. */
const DEEPSEEK_COLOR = 'var(--brand-deepseek)';
/** Meta / Llama blue — adaptive CSS variable. */
const META_COLOR = 'var(--brand-meta)';
/** Mistral signature orange — adaptive CSS variable. */
const MISTRAL_COLOR = 'var(--brand-mistral)';
/** Cohere coral/amber — adaptive CSS variable. */
const COHERE_COLOR = 'var(--brand-cohere)';
/** Perplexity teal — adaptive CSS variable. */
const PERPLEXITY_COLOR = 'var(--brand-perplexity)';

// --- Detection patterns ----------------------------------------------------
//
// Each brand is a list of regexes matched against the LOWERCASED model id
// (with the org prefix still attached — `openai/gpt-4o` must match OpenAI).
// First match wins; order matters: more specific brands (Qwen) before generic
// ones, and we try providerType as a fallback when the id alone is ambiguous.

interface BrandRule {
  color: string;
  brandName: string;
  icon?: ProviderIconKey;
  /** Regexes tested against the lowercased model id (including org prefix). */
  idPatterns: RegExp[];
  /** Provider types that definitively identify this brand (fallback when the
   *  id doesn't match any pattern — e.g. a direct-key Anthropic provider with
   *  a model id we don't recognize but the provider type tells us). */
  providerTypes?: string[];
}

const BRAND_RULES: BrandRule[] = [
  {
    color: ANTHROPIC_COLOR,
    brandName: 'Claude',
    icon: 'anthropic',
    providerTypes: ['anthropic'],
    idPatterns: [
      /claude/i,
      /anthropic/i,
      /opus/i,
      /sonnet/i,
      /haiku/i,
      /fable/i,
    ],
  },
  {
    color: OPENAI_COLOR,
    brandName: 'OpenAI',
    icon: 'openai',
    providerTypes: ['openai'],
    idPatterns: [
      /openai/i,
      /gpt/i,
      /\bo\d+\b/i,         // o1, o3, o4
      /chatgpt/i,
      /dall-?e/i,
    ],
  },
  {
    color: DEEPSEEK_COLOR,
    brandName: 'DeepSeek',
    icon: 'deepseek',
    idPatterns: [
      /deepseek/i,
      /\br1\b/i,
      /\bv3\b/i,
    ],
  },
  {
    color: GOOGLE_COLOR,
    brandName: 'Google',
    icon: 'google',
    providerTypes: ['google'],
    idPatterns: [
      /gemini/i,
      /gemma/i,
      /palm/i,
      /bard/i,
      /google/i,
    ],
  },
  {
    color: QWEN_COLOR,
    brandName: 'Qwen',
    icon: 'qwen',
    idPatterns: [
      /qwen/i,
      /qwq/i,
    ],
  },
  {
    color: MISTRAL_COLOR,
    brandName: 'Mistral',
    icon: 'mistral',
    idPatterns: [
      /mistral/i,
      /mixtral/i,
      /codestral/i,
      /pixtral/i,
      /ministral/i,
    ],
  },
  {
    color: META_COLOR,
    brandName: 'Meta',
    icon: 'meta',
    idPatterns: [
      /meta-llama/i,
      /\bllama/i,
    ],
  },
  {
    color: GROK_COLOR,
    brandName: 'Grok',
    icon: 'grok',
    providerTypes: ['xai'],
    idPatterns: [
      /grok/i,
      /x-?ai/i,
    ],
  },
  {
    color: KIMI_COLOR,
    brandName: 'Kimi',
    icon: 'kimi',
    providerTypes: ['moonshot'],
    idPatterns: [
      /kimi/i,
      /moonshot/i,
    ],
  },
  {
    color: PERPLEXITY_COLOR,
    brandName: 'Perplexity',
    icon: 'perplexity',
    idPatterns: [
      /perplexity/i,
      /sonar/i,
    ],
  },
  {
    color: COHERE_COLOR,
    brandName: 'Cohere',
    icon: 'cohere',
    idPatterns: [
      /cohere/i,
      /command-r/i,
    ],
  },
];

/**
 * Resolve the brand for a model chip from its id + provider type.
 *
 * @param modelId   The raw model id (OpenRouter slug, API model id, GGUF
 *                  filename — whatever the session is bound to). May include
 *                  an org prefix (`anthropic/claude-sonnet-5`).
 * @param providerType  Optional ProviderType from provider-types.ts. Used as
 *                  a fallback when the id alone doesn't match — e.g. a direct
 *                  Anthropic provider with an unrecognized model id still
 *                  gets Claude orange.
 * @returns The brand, or null if no brand matches (caller falls back to the
 *          default native chip color).
 */
export function resolveModelBrand(
  modelId: string | undefined | null,
  providerType?: string | undefined | null,
): ModelBrand | null {
  if (!modelId && !providerType) return null;

  // Pass 0: the Claude Code RUNTIME is its own identity, not "a Claude model".
  // It has to win BEFORE the id sweep, because a CC model id (`claude-opus-5`)
  // also matches the Anthropic rule's /claude/i — which is exactly how the
  // resume browser's card line ended up showing the Anthropic mark next to a
  // row whose own Model picker showed the Claude Code mascot (reported
  // 2026-09-04 with a screenshot). ModelPicker (runtime === 'claude') and the
  // All Sessions row (session-runtime-label.ts) already pin the mascot; this
  // is the one caller that only has the persisted ref, whose providerType
  // noteModelUsed writes as 'claude-code' (ipc-handlers.ts).
  if (providerType === 'claude-code') {
    return { color: ANTHROPIC_COLOR, brandName: 'Claude Code', icon: 'claudecode' };
  }

  const id = (modelId ?? '').toLowerCase();

  // Pass 1: match on the model id.
  for (const rule of BRAND_RULES) {
    if (id && rule.idPatterns.some((re) => re.test(id))) {
      return { color: rule.color, brandName: rule.brandName, icon: rule.icon };
    }
  }

  // Pass 2: fall back to the provider type.
  if (providerType) {
    for (const rule of BRAND_RULES) {
      if (rule.providerTypes?.includes(providerType)) {
        return { color: rule.color, brandName: rule.brandName, icon: rule.icon };
      }
    }
  }

  return null;
}
