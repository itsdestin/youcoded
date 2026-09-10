// desktop/src/shared/model-ids.ts
//
// The canonical Claude Code alias list, plus the two helpers that read a raw
// transcript model id. Shared because main AND renderer both parse
// `message.model` off a transcript: session-browser (the Resume Browser's model
// chip), useActiveSessionModel (the status-bar pill's drift reconciliation),
// and AssistantTurnBubble (the per-turn metadata strip). Three copies of this
// logic had already drifted apart — one lowercased its input and one didn't —
// which is how the `<synthetic>` bug survived in two of them after being fixed
// in the third.

/**
 * Aliases sent to the CC CLI via `/model <alias>`, in picker order.
 *
 * `opus[1m]` keeps the bracket form so CC selects Opus's 1M-context variant;
 * claudeAliasForModelId strips the `[...]` before substring-matching a raw id,
 * so a bare `fable` alias slots in with no collision. StatusBar's MODELS and
 * ModelPicker's CLAUDE_MODELS both derive from this — do not re-declare it.
 */
export const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus[1m]', 'fable'] as const;
export type ClaudeAlias = typeof CLAUDE_ALIASES[number];

/**
 * Human-facing name for each alias — the single source StatusBar's model chip
 * AND the typed `/model <alias>` chat-timeline confirmation marker both read,
 * so the two can never drift the way the header comment above describes.
 */
export const CLAUDE_ALIAS_LABELS: Record<ClaudeAlias, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus',
  fable: 'Fable',
};

/**
 * True for Claude Code's bracketed placeholder model ids (`<synthetic>`).
 *
 * CC stamps these on assistant lines IT composed rather than a model — "You've
 * hit your session limit", "You're out of usage credits", "Please run /login ·
 * API Error: 401". They say nothing about which model a conversation ran on,
 * and they land LAST, so any "walk backwards for the most recent model" scan
 * finds them first unless it skips them.
 *
 * Matches the SHAPE, not the literal string: CC brackets its placeholders and
 * no real model id is bracketed, so this covers any future one. Verified
 * 2026-08-26 against 2,933 local transcripts — `<synthetic>` is the only
 * bracketed value present, and every API-error assistant line carries it.
 */
export function isPlaceholderModelId(id: string): boolean {
  return /^<.*>$/.test(id.trim());
}

/**
 * Map a raw Claude Code model id onto one of the aliases above, or null.
 *
 * WHY: a transcript records the CONCRETE model a turn ran on
 * (`claude-opus-5`, `claude-sonnet-4-6-20260401`), and occasionally the bare
 * alias the user typed (`sonnet`). Every surface that displays or acts on a
 * model works in aliases, so this is the bridge.
 *
 * Matched on the FAMILY word, not an id table: Anthropic ships new dated ids
 * continuously, and a table would silently stop matching every time one landed.
 * Unknown ids — including placeholders — return null, which callers must treat
 * as "no opinion", never as a licence to substitute a default.
 *
 * Note: `opus` maps to `opus[1m]` because that is the only Opus alias the app
 * offers; Settings can only ever hold one of these four.
 */
export function claudeAliasForModelId(modelId: string): ClaudeAlias | null {
  const id = modelId.toLowerCase();
  for (const alias of CLAUDE_ALIASES) {
    // 'opus[1m]' -> 'opus'; the bracketed suffix is a context-window variant,
    // not part of the family name a transcript id carries.
    if (id.includes(alias.replace(/\[.*$/, ''))) return alias;
  }
  return null;
}
