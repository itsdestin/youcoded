// Skill — load a named skill's instructions into the conversation.
//
// Claude Code performs this step implicitly: it reads the skill's SKILL.md and
// follows it. The native harness has no such step, so a skill is exposed as a
// tool whose OUTPUT is the instructions. The model then follows them the same way
// it follows any tool result.
//
// Deliberately NOT `interactive`: that flag (harness-session.ts) skips guards AND
// the permission decision. Correct for AskUserQuestion — asking permission to ask
// a question is absurd — and wrong here, because a skill's instructions can drive
// real side effects, so this goes through decide() like every other tool.
import { z } from 'zod';
import { defineTool, DEFAULT_CAPS } from './registry';
import { truncateOutput } from './truncate';
import type { NativeTool, ToolContext, ToolResultPayload } from './types';
import type { SkillCatalog } from '../skills/skill-catalog';

const schema = z.object({
  skill: z.string().describe("The id of the skill to load, exactly as listed in this tool's description."),
  // WHY no `args` (Destin, 2026-09-23): G-12 gave this tool Claude Code's optional
  // pass-through `args`, but in practice models used it as a diary — GPT "sol"
  // models wrote a third-person status note into it on 83–100% of their calls
  // ("User asks '?': clarify current progress…"), which was then glued onto the
  // skill's instructions as an "Arguments:" line. The model already has the
  // user's words in the conversation, so the field bought nothing. The USER's
  // `/skill-name some words` is a separate path (skill-invocation.ts) and keeps
  // its arguments.
}).strict(); // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)

type SkillArgs = z.infer<typeof schema>;

/** Destin's wording, 2026-09-23. Exported so tests pin the exact text. */
export function alreadyLoadedNotice(id: string): string {
  return `The ${id} skill is already loaded earlier in this conversation and still applies. `
    + 'Keep following those instructions. Do not try to load it again.';
}

const DESC_HEAD = 300;
const DESC_TAIL = 200;

/** Cap one skill's listed description at ~500 characters: the first 300 and the
 *  last 200, joined by " … ". WHY both ends (Destin, 2026-09-23): the opening
 *  says what the skill is, and long descriptions put their trigger phrases
 *  ("brief me on…", "deep search…") at the END — a head-only cut would drop
 *  exactly the words that make the model pick the skill. Cuts land on a word
 *  boundary. The listing rides every turn; the full SKILL.md is unaffected. */
export function clipDescription(desc: string): string {
  const d = desc.trim();
  if (d.length <= DESC_HEAD + DESC_TAIL) return d;
  const head = d.slice(0, DESC_HEAD).replace(/\s+\S*$/, '');
  const tail = d.slice(-DESC_TAIL).replace(/^\S*\s+/, '');
  return `${head} … ${tail}`;
}

/** `maxChars` is the session's injection budget in characters. WHY it is passed
 *  rather than left to defineTool's flat 30,000-char default (2026-09-10): that
 *  default is the same number for every model, so on a 32k-window model — the
 *  smallest window that gets this tool at all — one skill could return roughly a
 *  quarter of everything the model can hold, while the SAME skill reached by
 *  typing /name was fitted to the session's budget. One skill, two sizes,
 *  depending only on who asked for it. The cap rides defineTool's own bounds
 *  machinery, so the widening advice stays this tool's (see moreHint) rather
 *  than hand-written truncation prose. */
export function createSkillTool(catalog: SkillCatalog, maxChars?: number): NativeTool<SkillArgs> {
  // Snapshotted ONCE at construction: buildAiTools() reads these strings on every
  // turn, and re-scanning the filesystem per turn would be a real cost for a list
  // that only changes when the user installs something (which rebuilds the session's
  // tool set anyway).
  const installed = catalog.list();
  const caps = maxChars != null ? { maxChars } : DEFAULT_CAPS;

  return defineTool<SkillArgs>({
    caps,
    name: 'Skill',
    // WHY the usage rules live HERE rather than in shared-doctrine.ts (Destin asked
    // for "our system instructions", 2026-09-23): this description is attached only
    // when the Skill tool is, and the tool comes and goes with the model
    // (exposeSkillCatalog, re-synced on setBinding) while the system prompt is
    // fixed at session start. Here the rule can never talk about a tool the model
    // was not given. The rule targets what transcripts showed: skills loaded on
    // "ok"/"continue", and the same skill loaded up to 33 times in one chat.
    description:
      "Load a named skill's instructions and follow them. Load a skill only when the task clearly "
      + 'calls for what it covers, not because it is listed or loosely related. Once loaded, a skill '
      + "stays in effect for the rest of the conversation; don't load it again. Available skills:\n"
      + installed.map((s) => `- ${s.id}: ${clipDescription(s.description)}`).join('\n'),
    // Simplified presentation (small local models): ids only. The full one-liners
    // are the bulk of the text and a weak model does better with a short list.
    shortDescription: "Load a named skill's instructions. Skills: " + installed.map((s) => s.id).join(', '),
    inputSchema: schema,
    // The skill id is the permission subject, so "always allow the journal skill"
    // is expressible as a rule — same as a Bash command string.
    permissionSubject: (a) => a.skill,
    // Fix: execute() below returns catalog.load(id).body VERBATIM — no offset/limit
    // param exists on `schema` (just `skill`), and there is no in-tool way to read
    // only part of a SKILL.md, so a file over defineTool's 30,000-char pipeline cap
    // used to reach composeNotice's no-advice branch with zero widening vocabulary.
    // This is the STATIC fallback (types.ts NativeTool.moreHint) for exactly that
    // case; it names only the `skill` param this schema actually has, per the
    // guard in tests/tool-registry-manifest.test.ts that fails the build on a tool
    // advising a parameter its own zod schema lacks.
    moreHint: 'load a narrower or different skill instead, or ask the user to split this oversized SKILL.md into smaller skills',
    async execute(args: SkillArgs, ctx: ToolContext): Promise<ToolResultPayload> {
      try {
        const skill = catalog.load(args.skill);
        // Repeat guard (Destin, 2026-09-23). The body is already in the
        // conversation, so a second copy only fills the window — one GPT session
        // loaded the same skill 33 times. Keyed by the RESOLVED id, so "brainstorming"
        // and "superpowers:brainstorming" are one skill. The session forgets the
        // set wherever history is cut (compaction, prune, /clear, resume — same
        // sites as servedReads), so this reply never claims a copy that is gone.
        // Not an isError: models retry errors, which is the behavior being stopped.
        if (ctx.servedSkills?.has(skill.id)) {
          return { text: alreadyLoadedNotice(skill.id) };
        }
        const text = `<skill-instructions name="${skill.id}">\n${skill.body}\n</skill-instructions>`;
        // Only a WHOLE delivery counts as loaded. defineTool cuts this text to
        // the same caps after we return, and a skill longer than the budget
        // (several real ones exceed 24k chars on a mid-size local model) would
        // otherwise be vouched for as "already loaded" while its middle was never
        // shown — the one thing this notice must never claim.
        if (!truncateOutput(text, caps).truncated) ctx.servedSkills?.add(skill.id);
        return { text };
      } catch (err: any) {
        // RETURNED, not thrown: defineTool's catch would prefix "Skill failed:" and
        // bury the recovery information these errors carry — the list of skills that
        // DO exist, or the real filesystem reason. Both are the actionable part.
        return { text: err?.message ?? String(err), isError: true };
      }
    },
  });
}
