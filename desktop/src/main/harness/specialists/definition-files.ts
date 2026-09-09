// Pure (disk-free) loaders that turn a specialist definition file's raw text
// into a SpecialistDefinition plus plain-English warnings. Two formats are
// supported: YouCoded's own personal format (~/.youcoded/specialists/*.md)
// and Claude Code's `.claude/agents/*.md` dialect, mapped onto the smaller
// native tool set (spec §3.2). Task 3 wraps these in a catalog that actually
// reads the three folders from disk — this module never touches the
// filesystem, so every rule here is a unit test, not an integration test.
import * as path from 'path';
import { parseFrontmatter, type FrontmatterValue } from './frontmatter';
import { wrapSpecialistPrompt } from './builtins';
import { createHash } from 'crypto';
import { type SpecialistDefinition } from './registry';
import { MAX_DESCRIPTION_CHARS } from './limits';

// The full native tool set a child session can ever hold — 'Task' is
// deliberately absent (see stripTaskAndAgent below): depth-by-omission is
// the depth guard, so a specialist can never re-delegate to another one.
export const NATIVE_CHILD_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'] as const;

// What a specialist gets when its file doesn't list `tools:` at all — read
// access only, never a shell or an editor, so an unconfigured file can't
// accidentally hold write/execute power.
export const READ_ONLY_DEFAULT_TOOLS = ['Read', 'Glob', 'Grep'];

export const DEFAULT_REPORT_BUDGET_TOKENS = 2000;

export type LoadedDefinition = {
  definition: SpecialistDefinition;
  warnings: string[];
  // Only set when the description was actually cut for MAX_DESCRIPTION_CHARS
  // — Settings shows this; the Task tool never sees it.
  fullDescription?: string;
};
export type DefinitionLoad = { ok: true; value: LoadedDefinition } | { ok: false; error: string };

const NATIVE_TOOL_SET = new Set<string>(NATIVE_CHILD_TOOLS);

function toolWord(count: number): string {
  return count === 1 ? 'tool' : 'tools';
}

// Subject-verb agreement for the "N tools ... don't/doesn't exist" and
// "N tools ... was/were removed" warnings below — a single stripped tool
// must not read "1 tool ... don't exist", which is what a plural-only
// template would produce.
function agree(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

// WHY: Task/Agent are stripped everywhere, unconditionally — depth-by-omission
// is the depth guard for this whole feature. A specialist that could hire
// another specialist would let one hire fan out without limit or parent
// visibility.
const TASK_STRIPPED_WARNING = 'specialists can’t hire specialists — Task was removed';

function stripTaskAndAgent(tools: string[]): { kept: string[]; hadTaskOrAgent: boolean } {
  const kept: string[] = [];
  let hadTaskOrAgent = false;
  for (const tool of tools) {
    if (tool === 'Task' || tool === 'Agent') {
      hadTaskOrAgent = true;
    } else {
      kept.push(tool);
    }
  }
  return { kept, hadTaskOrAgent };
}

function asStringList(value: FrontmatterValue | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    // Fix (review): a blank scalar (`tools:` with nothing after the colon —
    // a plausible half-finished edit) must read as OMITTED, not as an
    // explicit empty list. Returning [] here made every caller's
    // `=== undefined` fallback check never fire, so a blank `tools:` line
    // silently produced a specialist with no tools and no warning at all.
    // A genuinely explicit `tools: []` never reaches this branch — the
    // frontmatter parser already turns `[]` into a real array, handled above.
    if (value.trim() === '') return undefined;
    // CC's `tools:` is a comma-separated string (`tools: Read, Grep, Bash`);
    // also accept a value the frontmatter parser already turned into a list.
    return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return undefined; // { nested: true } — not a usable tool list
}

function asString(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseNumeric(value: FrontmatterValue | undefined): number | undefined {
  const str = asString(value);
  if (str === undefined || str.trim() === '') return undefined;
  const n = Number(str);
  return Number.isFinite(n) ? n : undefined;
}

// charter is DERIVED from the mapped tools, never declared. WHY: spec §3 —
// a file must not be able to claim read-only while holding a shell. Any of
// Write/Edit/Bash makes the specialist read-write; everything else is
// read-only.
export function deriveCharter(tools: readonly string[]): 'read-only' | 'read-write' {
  return tools.some((t) => t === 'Write' || t === 'Edit' || t === 'Bash') ? 'read-write' : 'read-only';
}

export function slugifyId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function filenameStem(filePath: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

// Cuts a description to MAX_DESCRIPTION_CHARS with a trailing ellipsis, only
// when it actually exceeds the cap. WHY: every offered description is text
// in the Task tool on every turn, and a repo's file controls it.
function capDescription(description: string): { description: string; fullDescription?: string; warning?: string } {
  if (description.length <= MAX_DESCRIPTION_CHARS) {
    return { description };
  }
  const cut = description.slice(0, MAX_DESCRIPTION_CHARS - 1) + '…';
  return {
    description: cut,
    fullDescription: description,
    warning: "description shortened to 300 characters for the assistant's tool list — the full text is here",
  };
}

function mapModelPreference(
  raw: string | undefined,
  normalize: (v: string) => 'parent' | 'budget' | 'frontier' | undefined,
): { modelPreference: 'parent' | 'budget' | 'frontier'; warning?: string } {
  if (raw === undefined || raw.trim() === '') {
    return { modelPreference: 'parent' };
  }
  const mapped = normalize(raw.trim());
  if (mapped !== undefined) {
    return { modelPreference: mapped };
  }
  return {
    modelPreference: 'parent',
    // WHY: "using the default (parent)" is meaningless to a reader who
    // hasn't seen this codebase's internal name for the setting — spell out
    // what "parent" means, the same gloss the starter file uses.
    warning: `model: "${raw.trim()}" isn't recognized — using the default: the same model your main assistant is already running on`,
  };
}

// ---------------------------------------------------------------------------
// Personal format (~/.youcoded/specialists/*.md)
// ---------------------------------------------------------------------------

/** D2 (2026-08-26): the definition file's identity for permission purposes.
 *  Hashed from the EXACT bytes that were parsed, not from mtime/size — a
 *  touch must not invalidate a grant, and an edit that changes one character
 *  of `tools:` must. Truncated to 12 hex chars: this is a change detector, not
 *  a secret, and it has to sit inside a subject a human may read in Settings.
 *  A collision would have to be deliberately constructed by someone who can
 *  already write the file, at which point they can simply edit it in place. */
export function definitionFingerprint(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12);
}

export function loadPersonalDefinition(filePath: string, raw: string): DefinitionLoad {
  const parsed = parseFrontmatter(raw);
  if ('error' in parsed) {
    return { ok: false, error: parsed.error };
  }
  const { data, body } = parsed;
  const warnings: string[] = [];

  if (body.trim() === '') {
    return { ok: false, error: 'no instructions below the frontmatter' };
  }

  const descriptionRaw = asString(data.description);
  if (descriptionRaw === undefined || descriptionRaw.trim() === '') {
    return { ok: false, error: 'this file needs a `description:` — the assistant reads it to decide whether to hire this specialist' };
  }

  const stem = filenameStem(filePath);
  const name = asString(data.name) ?? stem;
  // Fix (review, same shape as the blank `tools:` bug above): a blank `id:`
  // (nothing after the colon) parses to the empty string via parseFrontmatter,
  // and asString('') stays '' rather than undefined — so the filename-stem
  // fallback below never fired, and a half-finished `id:` line silently
  // produced `id: ''` with no warning. Treat a blank explicit id the same as
  // an omitted one.
  const explicitIdRaw = asString(data.id);
  const explicitId = explicitIdRaw !== undefined && explicitIdRaw.trim() === '' ? undefined : explicitIdRaw;
  const idSource = explicitId ?? stem;
  const id = slugifyId(idSource);
  // WHY: every other transform in this file warns when it changes what the
  // user typed — a silently-rewritten id broke that pattern. The id has to
  // stay slugified (it becomes part of a permission key and shows up in the
  // model's tool list, so it has to be a safe string), but only warn when
  // slugifying actually changed something the user explicitly set, not the
  // filename-stem fallback.
  if (explicitId !== undefined && id !== explicitId) {
    warnings.push(
      `id: "${explicitId}" was changed to "${id}" — ids can only use lowercase letters, numbers, and dashes, since this becomes part of a permission name and shows up in your assistant's tool list. Edit the file if you'd rather use something else.`,
    );
  }

  // --- tools ---
  const requestedTools = asStringList(data.tools);
  let allowedTools: string[];
  if (requestedTools === undefined) {
    allowedTools = [...READ_ONLY_DEFAULT_TOOLS];
    warnings.push('no tools listed — read-only by default; add `tools:` to widen');
  } else {
    const { kept: withoutTaskAgent, hadTaskOrAgent } = stripTaskAndAgent(requestedTools);
    if (hadTaskOrAgent) warnings.push(TASK_STRIPPED_WARNING);
    const kept: string[] = [];
    const unknown: string[] = [];
    for (const tool of withoutTaskAgent) {
      if (NATIVE_TOOL_SET.has(tool)) kept.push(tool);
      else unknown.push(tool);
    }
    if (unknown.length > 0) {
      warnings.push(
        `${unknown.length} ${toolWord(unknown.length)} this file asked for ${agree(unknown.length, 'doesn’t', 'don’t')} exist here and ${agree(unknown.length, 'was', 'were')} removed: ${unknown.join(', ')}`,
      );
    }
    allowedTools = kept;
  }

  // charter is derived, never declared — warn if the file tried to set one.
  if (data.charter !== undefined) {
    warnings.push('charter is not a setting — it follows the tools');
  }
  const charter = deriveCharter(allowedTools);

  // --- model ---
  const { modelPreference, warning: modelWarning } = mapModelPreference(asString(data.model), (v) =>
    v === 'budget' || v === 'frontier' || v === 'parent' ? v : undefined,
  );
  if (modelWarning) warnings.push(modelWarning);

  // Legacy `stepCap` is intentionally ignored so existing personal files keep
  // loading after the per-specialist step-limit contract was removed.
  let reportBudgetTokens = DEFAULT_REPORT_BUDGET_TOKENS;
  if (data.reportBudgetTokens !== undefined) {
    const n = parseNumeric(data.reportBudgetTokens);
    if (n !== undefined) {
      reportBudgetTokens = n;
    } else {
      warnings.push(`reportBudgetTokens must be a number — using the default (${DEFAULT_REPORT_BUDGET_TOKENS})`);
    }
  }

  // --- description cap ---
  const { description, fullDescription, warning: descWarning } = capDescription(descriptionRaw.trim());
  if (descWarning) warnings.push(descWarning);

  const definition: SpecialistDefinition = {
    id,
    displayName: name,
    description,
    systemPrompt: wrapSpecialistPrompt(body),
    allowedTools,
    charter,
    modelPreference,
    reportBudgetTokens,
    source: 'personal',
    // ~/.youcoded/specialists/ is the user's own folder by construction, so a
    // grant on it is allowed to travel across projects (D2).
    grantScope: 'user',
    fingerprint: definitionFingerprint(raw),
  };

  return { ok: true, value: { definition, warnings, fullDescription } };
}

// ---------------------------------------------------------------------------
// Claude Code format (.claude/agents/*.md, user-level and project-level)
// ---------------------------------------------------------------------------

// `grantScope` is REQUIRED and has no default on purpose: this one loader reads
// both ~/.claude/agents (the user's own -> 'user') and <cwd>/.claude/agents
// (shipped inside a repo -> 'project'), and only the caller knows which folder
// it opened. A default here would silently pick a width for the wrong folder.
export function loadClaudeCodeDefinition(
  filePath: string,
  raw: string,
  grantScope: 'user' | 'project',
): DefinitionLoad {
  const parsed = parseFrontmatter(raw);
  if ('error' in parsed) {
    return { ok: false, error: parsed.error };
  }
  const { data, body } = parsed;
  const warnings: string[] = [];

  if (body.trim() === '') {
    return { ok: false, error: 'no instructions below the frontmatter' };
  }

  const name = asString(data.name);
  if (name === undefined || name.trim() === '') {
    return { ok: false, error: 'Claude Code agent files need a `name:`' };
  }
  const id = slugifyId(name.trim());

  const descriptionRaw = asString(data.description) ?? '';

  // --- tools (§3.2 mapping table) ---
  const requestedTools = asStringList(data.tools);
  let allowedTools: string[];
  if (requestedTools === undefined) {
    allowedTools = [...READ_ONLY_DEFAULT_TOOLS];
    warnings.push('no tools listed — read-only by default; add `tools:` to widen');
  } else {
    const { kept: withoutTaskAgent, hadTaskOrAgent } = stripTaskAndAgent(requestedTools);
    if (hadTaskOrAgent) warnings.push(TASK_STRIPPED_WARNING);

    // Anything past this point that isn't native and isn't MultiEdit covers
    // both the §3.2-named tools (NotebookEdit, KillShell, BashOutput,
    // SlashCommand, Skill, ExitPlanMode, AskUserQuestion, ListMcpResources,
    // any mcp__*) and any other CC tool name this file might use — a helper
    // here has no skills/MCP and asks route to the parent, so none of them
    // can ever be honored.
    let hadMultiEdit = false;
    const kept: string[] = [];
    const unavailable: string[] = [];
    for (const tool of withoutTaskAgent) {
      if (tool === 'MultiEdit') {
        hadMultiEdit = true;
      } else if (NATIVE_TOOL_SET.has(tool)) {
        kept.push(tool);
      } else {
        unavailable.push(tool);
      }
    }
    if (hadMultiEdit) warnings.push('MultiEdit was removed — Edit covers it');
    if (unavailable.length > 0) {
      warnings.push(
        `${unavailable.length} ${toolWord(unavailable.length)} this file asked for ${agree(unavailable.length, 'isn’t', 'aren’t')} available to helpers here and ${agree(unavailable.length, 'was', 'were')} removed: ${unavailable.join(', ')}`,
      );
    }

    // disallowedTools: subtracted after mapping.
    const disallowed = new Set(asStringList(data.disallowedTools) ?? []);
    allowedTools = kept.filter((t) => !disallowed.has(t));
  }

  // --- model ---
  const { modelPreference, warning: modelWarning } = mapModelPreference(asString(data.model), (v) => {
    if (v === 'inherit' || v === 'sonnet') return 'parent';
    if (v === 'haiku') return 'budget';
    if (v === 'opus') return 'frontier';
    return undefined;
  });
  if (modelWarning) warnings.push(modelWarning);

  // Legacy `maxTurns` is intentionally ignored so existing Claude Code agent
  // files keep loading after the per-specialist step-limit contract was removed.

  // reportBudgetTokens has no CC frontmatter equivalent — always the default.
  const reportBudgetTokens = DEFAULT_REPORT_BUDGET_TOKENS;

  // --- ignored/warned-about fields ---
  // permissionMode: any value is ignored, but silently honoring it would let
  // a file's `bypassPermissions` look respected when it isn't — warn instead.
  if (data.permissionMode !== undefined) {
    warnings.push('permissionMode is ignored — helpers ask through the assistant, and approving the hire is the grant');
  }
  // color/memory: ignored silently — purely cosmetic/CC-internal, nothing a
  // native specialist can honor or that changes its behavior.
  if (data.hooks !== undefined || data.skills !== undefined) {
    warnings.push('hooks/skills in this file don’t run for helpers');
  }

  // --- description cap ---
  const { description, fullDescription, warning: descWarning } = capDescription(descriptionRaw.trim());
  if (descWarning) warnings.push(descWarning);

  const definition: SpecialistDefinition = {
    id,
    displayName: name.trim(),
    description,
    systemPrompt: wrapSpecialistPrompt(body),
    allowedTools,
    charter: deriveCharter(allowedTools),
    modelPreference,
    reportBudgetTokens,
    source: 'claude-code',
    grantScope,
    fingerprint: definitionFingerprint(raw),
  };

  return { ok: true, value: { definition, warnings, fullDescription } };
}

// ---------------------------------------------------------------------------
// Starter file — written into ~/.youcoded/specialists/ the first time that
// folder is created (Task 3, via NativeHome.ensureTextFile). Its job is
// dual: it's a working example that loads with zero warnings, AND it's the
// plain-English documentation for every field this format accepts, since
// the frontmatter parser has no comment syntax to hang inline notes off of
// — so the explanation lives in the body instead, ahead of the placeholder
// instructions.
// ---------------------------------------------------------------------------

export const STARTER_FILE_NAME = 'example.md';

export const STARTER_FILE_CONTENTS = `---
name: Example Specialist
description: A short, one-line summary of what this helper is for. The assistant reads this to decide when to hire it — keep it under 300 characters.
tools: [Read, Glob, Grep]
model: parent
reportBudgetTokens: 2000
id: example
version: 1
author: you
---
This is an example specialist file. Edit it to make your own, or delete it — it's just a starting point.

What each field above does:
- name: the display name shown when this helper is hired.
- description: the one-line summary the assistant reads to decide when to hire this helper.
- tools: what this helper is allowed to use. Options are Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, TodoWrite. Leave this out entirely and the helper gets read-only access (Read, Glob, Grep) — no editing files, no running commands.
- model: which model tier runs this helper. "parent" uses the same model as your main assistant, "budget" uses your configured cheaper model, "frontier" uses your configured stronger model.
- reportBudgetTokens: roughly how long this helper's final report is allowed to be.
- id, version, author: optional bookkeeping fields, safe to leave as-is or remove.

Everything below this point is this helper's actual job instructions — replace this paragraph with what you want it to do. For example: "Read the files you're pointed at, summarize what they do, and report back with file paths and a short explanation for each."
`;
