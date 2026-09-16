// Prompt STEERING OVERLAYS by capability profile (spec §4.3). Appended AFTER the
// preset body + tool guidance; they steer HOW a model tier calls tools, orthogonal
// to the preset's personality. Only local-small carries content in v1 (decision
// 10) — cloud frontier models need no extra steering; the four-way type is kept as
// a hook so per-family steering can be added later. POLICY: original prose.
import type { PromptVariant } from '../capability-profile';

const LOCAL_SMALL = `You are running on a smaller local model. Work in small, deliberate steps:
- Make a short plan with TodoWrite before multi-step work, and update it as you finish each item.
- Call one tool at a time and read its result before deciding the next call. Do not batch calls.
- Prefer the dedicated tools (Read, Glob, Grep) over shell commands.
- Once the task is done, answer in plain text — you do not have to call a tool to finish.

Example — read a file:
Read {"file_path": "src/index.ts"}
Example — find where something is defined:
Grep {"pattern": "function handleClick", "output_mode": "files_with_matches"}`;

const OVERLAYS: Record<PromptVariant, string> = { 'default': '', 'anthropic': '', 'gpt': '', 'local-small': LOCAL_SMALL };
export function variantOverlay(v: PromptVariant | undefined): string { return v ? (OVERLAYS[v] ?? '') : ''; }
