// The shareable harness unit (marketplace item kind 'harness' arrives in
// Phase 3). Phase 2 ships TWO built-in presets — personality profiles, not
// capability tiers (spec decision 8): both carry the full eleven-tool suite;
// they differ in prompt personality and permission posture. The Chat preset
// is CUT — legacy harnessId:'chat' headers resolve to Assistant on resume
// (preset-registry.ts). tools[] stays in the schema for Phase 3 custom harnesses.
import type { ModelBinding } from './provider-types';

export interface HarnessManifest {
  schema: 1;
  id: string; name: string; description?: string;
  systemPrompt: string;                  // fallback one-liner; the real body is a main-side prompt asset
  tools: string[];                       // CC-compatible names (ADR 009)
  /** A string sets the session's STARTING permission mode (the modeFor seed);
   *  a Record maps to presetRules (Phase 3 custom harnesses — unused in v1).
   *  WARNING to future harness authors: presetRules are the LOWEST permission
   *  layer, so mode rules, the destructive deny-list, and remembered user rules
   *  ALL override them. A preset `{ Bash: 'deny' }` is NOT enforced under
   *  full-auto (the mode's `*: allow` wins) and only degrades to a prompt under
   *  ask/auto-edit — it is a default posture, never a hard guard. */
  permissionPolicy: 'ask' | 'auto-edit' | 'full-auto' | Record<string, 'allow' | 'ask' | 'deny'>;
  defaultBinding?: ModelBinding;
  /** Per-preset skill allowlist. `undefined` = every installed skill is offered;
   *  an array restricts the Skill tool's catalog to those ids. Consumed by
   *  harness-session.buildAiTools (M3 item 1). Declared since Phase 2 with no
   *  consumer until then. */
  skills?: string[];
  /** RESERVED — still no consumer. The MCP pass (M3 item 4, its own plan) lands
   *  one. Left declared rather than deleted so that plan does not have to
   *  re-litigate the manifest shape. */
  mcp?: string[];
  limits?: { maxSteps?: number; maxTokens?: number };
}

export const NATIVE_TOOL_NAMES = [
  'Read', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'SendUserFile', 'SendUserLink',
] as const;

/** Tools attached at RUNTIME, per session, when conditions allow — deliberately
 *  NOT in NATIVE_TOOL_NAMES.
 *
 *  `Skill` (M3 item 1) exists only when the capability profile says the window can
 *  afford its catalog AND at least one skill is installed. Advertising it in a
 *  preset would do exactly what the registry↔manifest guard exists to prevent:
 *  tell the model about a tool that, on a small local model or a machine with no
 *  skills installed, is not attached. The model learns about it the only reliable
 *  way — from the tool schema buildAiTools() actually sends.
 *
 *  `Task` (Task 6, spec decision 4) exists only when profile.canDelegate is
 *  true AND the session is not itself a specialist child — a weak/unverified
 *  orchestrator or a specialist attempting depth-2 delegation must never even
 *  see the tool on its schema, same reasoning as Skill above.
 *
 *  `ModelSearch` (Task 14) rides the identical gate as `Task` and only ever
 *  exists alongside it (harness-session.ts's syncTaskTool attaches/detaches
 *  both together) — it exists to name a specific model for a Task
 *  delegation, so a session that cannot delegate has nothing for it to do. */
export const CONDITIONAL_TOOL_NAMES = ['Skill', 'Task', 'ModelSearch'] as const;

// Fix: with `limits.maxTokens` left undefined, streamText omits `max_tokens`
// from the request entirely — and OpenRouter's fallback for an uncapped
// request is to reserve the MODEL's own advertised max output against the
// account balance up front (65,536 for Claude Opus 5), for EVERY message,
// even a one-line reply. That's what was producing "exceed your available
// credits given your current in-flight requests" 402s far more often than
// real spend justified: two ordinary overlapping requests could each try to
// reserve 65k+ tokens' worth of credit. The battery runner hit the same
// defect in 2026-08-10 and got its own cap (BATTERY_MAX_OUTPUT_TOKENS,
// eval/run-case.ts) — this is the equivalent fix for real app sessions,
// which that incident's note explicitly left uncapped as out of scope.
// 16,000 tokens (~12,000 words) comfortably covers any single real reply
// (measured single-step outputs in that incident topped out near 2,200
// tokens) while cutting the reservation to a fraction of a frontier model's
// full advertised max.
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

export const ASSISTANT_PRESET: HarnessManifest = {
  schema: 1,
  id: 'assistant',
  name: 'Assistant',
  description: 'Research, write, and get answers — asks before consequential actions.',
  systemPrompt: 'You are a helpful, careful assistant inside YouCoded.',
  tools: [...NATIVE_TOOL_NAMES],
  permissionPolicy: 'ask',
  // Ordinary roots add maxSteps only from their persisted creation snapshot.
  limits: { maxTokens: DEFAULT_MAX_OUTPUT_TOKENS },
};

export const CODER_PRESET: HarnessManifest = {
  schema: 1,
  id: 'coder',
  name: 'Coder',
  description: 'Agentic coding — plans with todos, edits confidently, runs and verifies.',
  systemPrompt: 'You are a capable coding agent inside YouCoded.',
  tools: [...NATIVE_TOOL_NAMES],
  permissionPolicy: 'auto-edit',
  // Ordinary roots add maxSteps only from their persisted creation snapshot.
  limits: { maxTokens: DEFAULT_MAX_OUTPUT_TOKENS },
};

export const PRESETS: HarnessManifest[] = [ASSISTANT_PRESET, CODER_PRESET];
