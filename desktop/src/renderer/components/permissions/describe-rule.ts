import type { PermissionRule } from '../../../shared/permission-types';
import { describeBashPattern } from '../../../shared/bash-grant-shapes';

export interface RuleDescription {
  /** Plain-language action, e.g. "Run" or "Create or overwrite". For a scoped
   *  Bash grant this carries the WHOLE sentence ("Pushing to master") and
   *  `subject` is absent. */
  verb: string;
  /** The thing acted on. Absent for a tool-wide grant, for MCP tools (whose
   *  subject is folded into `verb`), and for a scoped Bash grant. */
  subject?: string;
  /** How much this rule covers.
   *  'exact'     — one literal command or path, byte-for-byte
   *  'wide'      — a pattern grant, e.g. pushes to one branch
   *  'tool-wide' — no pattern at all; every use of that tool
   *  The UI must render 'tool-wide' as visibly broader than the other two.
   *  Replaced a `broad: boolean` in M5 2c: an exact grant and a scoped one are
   *  both "not broad" while covering wildly different amounts. */
  width: 'exact' | 'wide' | 'tool-wide';
}

// WHY a lookup rather than the raw tool name: the store speaks in tool ids
// (Bash / Edit / Write), and YouCoded is built for non-developers — "Create or
// overwrite src/a.ts" is a sentence, "Write: src/a.ts" is a log line.
const VERBS: Record<string, string> = {
  Bash: 'Run',
  Edit: 'Edit',
  Write: 'Create or overwrite',
  Read: 'Read',
  Glob: 'Search for files in',
  Grep: 'Search the contents of',
  WebFetch: 'Fetch',
  WebSearch: 'Search the web for',
  Skill: 'Load the skill',
  NotebookEdit: 'Edit the notebook',
  TodoWrite: 'Update the to-do list',
  // A '*' rule is what Full-auto writes at the baseline. Nothing on this screen
  // should ever render the literal asterisk — that is rule syntax, and the
  // screen is written for people who have never seen a glob.
  '*': 'Do anything',
};

// Human-facing specialist label — mirrors SpecialistDefinition.displayName in
// src/main/harness/specialists/registry.ts, which this renderer file cannot
// import at runtime (main-process code; the Node/browser boundary — see
// desktop/CLAUDE.md — means only type-only imports cross that line). Same
// tradeoff specialists/names.ts already accepts for its own ROLE_LABELS table
// (its own comment explains why): agentType strings are the only thing the
// two need to agree on, and the registry's own test suite pins those.
//
// Fix (Finding 3): every other user-facing site names a specialist by its
// displayName ("Worker" — see tools/task.ts's error copy), never the raw
// internal agentType id ("worker"). This table was missing here, so a
// specialist-keyed rule rendered the bare id instead.
const SPECIALIST_DISPLAY_NAMES: Record<string, string> = {
  explorer: 'Explorer',
  researcher: 'Researcher',
  reviewer: 'Reviewer',
  worker: 'Worker',
};

/** Falls back to capitalizing the raw id rather than throwing/blanking, so a
 *  future specialist added to the registry but not yet mirrored here still
 *  reads as a name instead of breaking the permissions screen. */
function specialistDisplayName(agentType: string): string {
  return SPECIALIST_DISPLAY_NAMES[agentType] ?? agentType.charAt(0).toUpperCase() + agentType.slice(1);
}

export function describeRule(rule: PermissionRule): RuleDescription {
  const described = describeRuleBody(rule);
  // Task 11: a specialist-keyed rule is a grant a SPECIALIST holds while
  // working, never the assistant itself — the screen must say so in plain
  // language (project constraint), not bury it in a badge or omit it. Reuses
  // the ordinary tool verb rather than inventing specialist-specific copy, so
  // this stays a thin wrapper instead of a second vocabulary to keep in sync
  // with VERBS above.
  if (rule.specialist === undefined) return described;
  const lowered = described.verb.charAt(0).toLowerCase() + described.verb.slice(1);
  return { ...described, verb: `Let the ${specialistDisplayName(rule.specialist)} specialist ${lowered}` };
}

function describeRuleBody(rule: PermissionRule): RuleDescription {
  // WHY not just `pattern === undefined`: an exact grant and a scoped wide grant
  // both HAVE a pattern but cover wildly different amounts, and the screen has to
  // tell them apart. A missing `match` means a legacy rule, which PermissionStore
  // normalizes to 'exact' on read — so anything still missing it here is exact too.
  const width: RuleDescription['width'] =
    rule.pattern === undefined ? 'tool-wide' : rule.match === 'glob' ? 'wide' : 'exact';

  // MCP grants are per-tool and namespaced `mcp__{server}__{tool}`. Split on the
  // FIRST '__' after the prefix: a server id may itself contain '__', and the
  // tool name is whatever remains.
  //
  // Never 'tool-wide', even though an MCP rule has no pattern: the pattern axis does
  // not exist for MCP tools, so its absence is not a widening. The grant already
  // names one exact tool on one exact connection. Reporting it as "covers every
  // use" would put a scary badge on EVERY MCP row and teach the user to ignore
  // the badge on the tool-wide grants where it is true.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(rule.tool);
  if (mcp) {
    return { verb: `Use the ${mcp[2]} tool from the ${mcp[1]} connection`, width: 'exact' };
  }

  // WHY Task gets its own branch instead of falling into VERBS+pattern below:
  // its pattern is not a literal path or command — task.ts's permissionSubject
  // mints a charter-scoped envelope key (`${charter}:${work_dir}`, e.g.
  // "read-only:/home/x/proj"). Rendering that raw ("Use Task —
  // read-only:/home/x/proj") would both leak internal rule syntax onto a
  // screen built for non-developers and say "Task" out loud, which is
  // model-facing vocabulary — the spec calls this "specialists" everywhere a
  // user reads it. Strip the charter prefix and speak the user's word instead.
  if (rule.tool === 'Task') {
    if (rule.pattern === undefined) {
      return { verb: 'Let specialists work anywhere in this project', width: 'tool-wide' };
    }
    // D2 (2026-08-26): a grant on a FILE-DEFINED helper carries the helper's
    // own id and a content hash — `read-only:file:code-reviewer@a1b2c3d4e5f6`
    // (grants everywhere) or `read-write:/home/x/proj:file:repo-worker@…`
    // (that folder only). Rendered by the two branches below it read as a
    // DIRECTORY named "file:code-reviewer@a1b2c3…", which named no helper the
    // user recognises, leaked hash syntax onto this screen, and described the
    // everywhere-grant as if it were scoped to a place. Handled first, since
    // both shapes still start with a charter prefix.
    // The hash part is `[^@]+`, not `[0-9a-f]+`: tools/task.ts substitutes the
    // literal 'unverified' when a definition somehow carries no fingerprint, and
    // under the tighter regex that subject fell through to the plain-charter
    // branch below and rendered as a DIRECTORY literally named
    // "file:docs-writer@unverified" — raw syntax on a screen for non-developers.
    // Anything after the final '@' is the fingerprint; it is never shown, only
    // used to end the id, so widening it costs nothing and keeps the sentence.
    const filed = /^(read-only|read-write):(?:(.*):)?file:([^@]+)@[^@]+$/.exec(rule.pattern);
    if (filed) {
      const [, charter, dir, id] = filed;
      const verb = charter === 'read-write'
        ? `Let the ${id} specialist edit files`
        : `Let the ${id} specialist work`;
      // No directory in the pattern IS the cross-project grant — that is what
      // omitting the work dir means (tools/task.ts). Say so, rather than
      // leaving the sentence to trail off into nothing.
      return dir
        ? { verb: `${verb} in`, subject: dir, width: 'exact' }
        : { verb: `${verb} in every project`, width: 'exact' };
    }
    if (rule.pattern.startsWith('read-only:')) {
      return { verb: 'Let a read-only specialist work in', subject: rule.pattern.slice('read-only:'.length), width: 'exact' };
    }
    if (rule.pattern.startsWith('read-write:')) {
      return { verb: 'Let a specialist edit files in', subject: rule.pattern.slice('read-write:'.length), width: 'exact' };
    }
    // No charter prefix: task.ts's permissionSubject only produces this for an
    // unresolvable agent name, which execute() already refuses before ever
    // spawning — so this is an ask that's about to be declined, never a real
    // standing grant. Still render something sane rather than raw syntax.
    return { verb: 'Let a specialist work in', subject: rule.pattern, width: 'exact' };
  }

  // A scoped Bash grant already IS a sentence — "Pushing to master" — built by
  // the same module that built the rule. Rendering it as verb + subject would put
  // the raw pattern (asterisk and all) on a screen written for people who have
  // never seen a glob. A pattern this module did not produce falls through to the
  // generic rendering below rather than getting an invented sentence.
  if (rule.tool === 'Bash' && width === 'wide' && rule.pattern !== undefined) {
    const phrase = describeBashPattern(rule.pattern);
    if (phrase) return { verb: phrase, width };
  }

  const base = VERBS[rule.tool] ?? `Use ${rule.tool}`;
  // Nothing writes a deny rule today, but PermissionRule permits one — render it
  // as a block rather than silently as a grant.
  const verb = rule.action === 'deny' ? (rule.tool === 'Bash' ? 'Never run' : `Never ${base.toLowerCase()}`) : base;
  return { verb, subject: rule.pattern, width };
}

// ── Grouping vocabulary ─────────────────────────────────────────────────────
//
// WHY this lives HERE and not in the component: the tool table above is already
// the one place that knows what a tool id means. A second tool→something map in
// PermissionsSection.tsx would be a table that silently disagrees with this one
// the first time a tool is added to only one of them.

/** Which group an approval is filed under in Settings → Permissions.
 *
 *  The management screen sorts by what an approval lets the assistant DO, not by
 *  tool id: someone scanning "Commands" and "File changes" can find the thing
 *  they regret approving without knowing that Bash and Edit are different
 *  things. `other` is the catch-all so a tool added later still lands somewhere
 *  visible instead of vanishing from the list. */
export type RuleKind = 'commands' | 'files' | 'connections' | 'other';

/** Render order — broadest consequence first. A remembered command runs on the
 *  machine, an edit changes a file, a connection only talks to something
 *  outside, and everything else is mostly reads. */
export const RULE_KIND_ORDER: readonly RuleKind[] = ['commands', 'files', 'connections', 'other'];

/** Group headings. Plain nouns, no tool ids — same audience as the verbs above. */
export const RULE_KIND_LABEL: Record<RuleKind, string> = {
  commands: 'Commands',
  files: 'File changes',
  connections: 'Connections',
  other: 'Other',
};

const KIND_BY_TOOL: Record<string, RuleKind> = {
  Bash: 'commands',
  Edit: 'files',
  Write: 'files',
  NotebookEdit: 'files',
  WebFetch: 'connections',
  WebSearch: 'connections',
  // A specialist can do everything its charter allows, up to and including
  // running commands and editing files (a read-write charter gets Write/Edit/
  // Bash — see child-permissions.ts's WRITE_TOOLS) — strictly broader than any
  // single file-changing tool, so it sits at the same "runs on the machine"
  // tier as Bash rather than under `files` or the `other` catch-all.
  Task: 'commands',
  // Read / Glob / Grep / Skill / TodoWrite fall through to `other` on purpose:
  // they never change anything, and rulesForMode already allows them at every
  // baseline, so a remembered rule for one is a rarity rather than a category.
  //
  // T8 review F1 (doc-comments build, 2026-09-27): the five comment-MUTATION
  // tools file under `files`, same as Edit/Write — permission-types.ts's
  // rulesForMode() baseline-allows a plain-text/markdown/code target for all
  // five (undefined permissionSubject, never prompts, so no "Always allow"
  // button can ever exist for that case), which means every REMEMBERED rule
  // a user can actually create for one of these tools is, by construction,
  // "let the assistant write into this specific Word/Excel file's real
  // bytes" — functionally identical to a remembered Edit/Write grant on that
  // same file, and someone auditing "File changes" should find it there, not
  // filed next to a specialist grant under `other`.
  ReplyToComment: 'files',
  ResolveComment: 'files',
  ReopenComment: 'files',
  AddComment: 'files',
  MoveComment: 'files',
  // ReadFileComments deliberately has NO entry, same as Read/Glob/Grep just
  // above: it never mutates anything, and rulesForMode() always allows it
  // (F1's own review confirmed a remembered rule for it should be rare to
  // nonexistent) — it falls through to `other` exactly like Read already does.
};

export function ruleKind(rule: PermissionRule): RuleKind {
  // Every MCP tool is a connection to something outside the app, whatever the
  // individual tool happens to do once it gets there.
  if (rule.tool.startsWith('mcp__')) return 'connections';
  return KIND_BY_TOOL[rule.tool] ?? 'other';
}

/** What a pattern-less grant actually covers, in the user's words.
 *
 *  `describeRule` only reports THAT a rule is tool-wide; the noun depends on the
 *  tool, which is why this reads the same table's vocabulary. */
export function broadNote(tool: string): string {
  if (tool === '*') return 'Covers everything the assistant can do, not just the one thing it first asked about.';
  if (tool === 'Bash') return 'Covers every command, not just the one it first asked about.';
  if (KIND_BY_TOOL[tool] === 'files' || tool === 'Read') {
    return 'Covers every file, not just the one it first asked about.';
  }
  return 'Covers every use of this tool, not just the one it first asked about.';
}
