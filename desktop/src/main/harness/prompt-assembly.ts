// Assembled ONCE per session (spec §2.2): the <env> values are a SNAPSHOT at
// session start, labeled as such — the model uses tools for current state.
// Byte-stable by construction; do NOT add anything that changes between turns.
//
// WHY not reuse project-context.ts / context-discovery.ts: the former is a pure
// mapper over pre-computed basenames and the latter only scans the exact project
// dir + .claude (async, for the context UI). Neither does the session-start
// walk-up-to-git-root that the assembled prompt needs, so this owns its own IO.
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { PromptVariant } from './capability-profile';
import { variantOverlay } from './prompts/variants';
import { fitProjectInstructions } from './injection/injection-budget';
import { sharedDoctrine } from './prompts/shared-doctrine';

// promptVariant is the capability-profile steering overlay (see prompts/variants.ts).
// Optional so pre-variant callers assemble byte-identically; only local-small adds text.
// hasTools defaults true; a tool-less model (profile.supportsTools === false, e.g.
// Gemma 3n) sets it false so the assembled prompt drops BOTH the tool-guidance line
// and the variant overlay — every overlay references tools the model doesn't have.
// instructionBudgetTokens bounds the project-instruction file (see below). It is
// optional so pre-budget callers and tests assemble unchanged; the ONE production
// caller (native-session-host) always passes the session profile's real value.
// The default matches CLOUD_DEFAULT.injectionBudgetTokens — a frontier-sized
// allowance, i.e. "assume roomy" for a caller that never told us the model.
const DEFAULT_INSTRUCTION_BUDGET_TOKENS = 20_000;

// supportsParallelToolCalls (profile.supportsParallelToolCalls) gates the
// batching rule in the shared doctrine; default false so pre-existing callers
// (and the evaluator, which passes no profile) never tell a model to batch.
// audience: 'parent' for a specialist (its reader is the parent model, not the
// person) — drops the writing-for-the-user block. Default 'user'.
// presetName is LABEL-ONLY: it names the preset in the session-context panel and
// never reaches the model, so passing it cannot change a single byte of the
// assembled prompt. Optional so every existing caller assembles unchanged.
export interface PromptInputs { presetBody: string; cwd: string; appVersion: string; promptVariant?: PromptVariant; hasTools?: boolean; instructionBudgetTokens?: number; supportsParallelToolCalls?: boolean; audience?: 'user' | 'parent'; presetName?: string }

function gitSnapshot(cwd: string): string {
  try {
    // stdio ignores stderr so a non-git cwd doesn't spam the main-process log
    // with `fatal: not a repository`; stdout is still captured, catch still fires.
    const branch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return `Git branch: ${branch}${dirty ? ` (${dirty.split('\n').length} uncommitted change(s))` : ' (clean)'}`;
  } catch { return 'Git: not a repository'; }
}

/** The root instruction file this cwd resolves to, if any: its absolute path and
 *  its FULL text. Split out from projectInstructions() (2026-09-10) so the
 *  session-context panel can name and re-read the same file the prompt was built
 *  from, rather than repeating the walk-up and risking a different answer.
 *
 *  Walk up from cwd to the git root (or filesystem root), first hit wins:
 *  AGENTS.md is the cross-tool standard; CLAUDE.md read as fallback (§3.4). */
export function findProjectInstructions(cwd: string): { path: string; name: string; text: string } | null {
  let dir = cwd;
  while (true) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const p = path.join(dir, name);
      // Read inside the existsSync branch and tolerate a failure: a file that
      // exists but cannot be read (a permission bite, a race with an editor)
      // must not take the whole session down before it opens.
      if (fs.existsSync(p)) {
        try { return { path: p, name, text: fs.readFileSync(p, 'utf8') }; } catch { return null; }
      }
    }
    // .git check runs AFTER trying the files, so a root-level AGENTS.md is found
    // before we stop; then break so the walk never escapes the repo.
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function projectInstructions(cwd: string, budgetTokens: number): string | null {
  const found = findProjectInstructions(cwd);
  if (!found) return null;
  // The budget bounds the FILE BODY only — the wrapping tag is added after,
  // so a cut can never leave <project-instructions> unterminated. Until
  // 2026-08-10 this was `.slice(0, 20_000)`: characters not tokens, the same
  // for every model, cut at a byte offset, and silent. See fitProjectInstructions.
  const { text: body } = fitProjectInstructions(found.text, budgetTokens, found.name);
  // NOT sanitizing: repo instruction files are trusted-by-design input. The
  // tag is a labeling convention, not a security boundary — a file with a
  // literal </project-instructions> can escape it, and that's acceptable here.
  return `<project-instructions source="${found.name}">\n${body}\n</project-instructions>`;
}

/** One labelled piece of the assembled prompt.
 *
 *  WHY this exists (Destin, review-5 G-2): "i want to be fully transparent about
 *  what models load in with." The panel's System tab shows the prompt in the
 *  pieces it was built from, because one wall of text answers "how much" but not
 *  "what". The labels are the user's vocabulary, not the code's — this is read by
 *  someone who does not write software.
 *
 *  `id` is stable and machine-readable; the panel keys off it (`project` gets its
 *  own tab and is filtered out of System). */
export interface PromptPart { id: 'identity' | 'preset' | 'env' | 'project' | 'doctrine' | 'steering'; label: string; text: string }

/** The pieces `assembleSystemPrompt` joins, in order.
 *
 *  WHY assembleSystemPrompt is defined as the JOIN of this rather than the two
 *  being written side by side: a panel that claims to show the system prompt must
 *  show THE system prompt. Two parallel implementations would drift, silently, and
 *  the drift would be invisible precisely because it lives in the thing meant to
 *  make the prompt visible. Guard: prompt-assembly.test.ts pins the join.
 */
export function assembleSystemPromptParts(i: PromptInputs): PromptPart[] {
  // Tool-less model (profile.supportsTools === false → buildAiTools() returns {}):
  // it runs as plain chat, so telling it to "prefer dedicated tools" or to "call
  // one tool at a time" (the variant overlay) is nonsense guidance for tools it
  // was never given. Drop both. Everything else (identity, preset, env, project
  // instructions) is tool-agnostic and stays. Default true → unchanged behavior.
  const hasTools = i.hasTools !== false;
  const parts: Array<PromptPart | null> = [
    {
      id: 'identity',
      label: 'Who it is',
      // WHY the second sentence (Destin, 2026-09-04): the same prompt serves every
      // model the user can pick, and a model that assumes it is a specific vendor's
      // product answers questions about itself wrongly and reaches for that
      // vendor's conventions.
      text: 'You are the YouCoded assistant, an agentic AI running inside the YouCoded app. You may be running on any model the user chose, cloud or local — Claude, GPT, Grok, Gemini, Qwen, Gemma and others.',
    },
    { id: 'preset', label: i.presetName ? `Its preset — ${i.presetName}` : 'Its preset', text: i.presetBody },
    {
      id: 'env',
      label: 'This computer and folder',
      text: [
        '<env note="snapshot at session start — use tools (Bash, Read) for current state">',
        `Working directory: ${i.cwd}`,
        `Platform: ${process.platform} (${process.arch})`,
        `Date: ${new Date().toDateString()}`,
        gitSnapshot(i.cwd),
        `YouCoded version: ${i.appVersion}`,
        '</env>',
      ].join('\n'),
    },
    partOrNull('project', 'Your project instructions', projectInstructions(i.cwd, i.instructionBudgetTokens ?? DEFAULT_INSTRUCTION_BUDGET_TOKENS)),
    {
      id: 'doctrine',
      label: 'How it works',
      // Shared doctrine (prompts/shared-doctrine.ts) replaced the single
      // tool-guidance line on 2026-09-04: how to finish, what to trust, how to
      // write, what the app's envelope messages mean. Composed by capability so a
      // tool-less model still gets the honesty and writing rules, a small local
      // model gets the compact form, and only a parallel-capable model is told to
      // batch. The "Prefer dedicated tools over shell" sentence lives inside it.
      text: sharedDoctrine({
        audience: i.audience ?? 'user',
        tools: hasTools,
        batching: hasTools && i.supportsParallelToolCalls === true && i.promptVariant !== 'local-small',
        compact: i.promptVariant === 'local-small',
      }),
    },
    // Capability-steering overlay, appended LAST: personality (preset body) and
    // tool-calling steering (variant) are orthogonal axes composed by append. The
    // no-op variants return '' and are dropped by the empty-text filter below,
    // keeping default/anthropic/gpt byte-identical to a call with no variant. A
    // tool-less model skips it entirely (all overlays are tool-calling steering).
    partOrNull('steering', 'Extra steering for this model', hasTools ? variantOverlay(i.promptVariant) : ''),
  ];
  // The SAME filter the joined prompt has always applied — a null (no project
  // instructions file) or an empty string (no-op variant) contributes nothing and
  // must not leave a blank part behind, in the prompt OR in the panel.
  return parts.filter((p): p is PromptPart => p !== null && p.text !== '');
}

function partOrNull(id: PromptPart['id'], label: string, text: string | null): PromptPart | null {
  return text === null || text === '' ? null : { id, label, text };
}

export function assembleSystemPrompt(i: PromptInputs): string {
  return assembleSystemPromptParts(i).map((p) => p.text).join('\n\n');
}
