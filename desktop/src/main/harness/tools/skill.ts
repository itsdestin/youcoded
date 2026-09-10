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
import { defineTool } from './registry';
import type { NativeTool, ToolContext, ToolResultPayload } from './types';
import type { SkillCatalog } from '../skills/skill-catalog';

const schema = z.object({
  skill: z.string().describe("The id of the skill to load, exactly as listed in this tool's description."),
  // G-12 (2026-08-26 tools investigation): same shape as Claude Code's Skill
  // tool, so a model can hand a skill what the user asked for.
  args: z.string().optional().describe('Optional arguments to pass through to the skill.'),
}).strict(); // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)

type SkillArgs = z.infer<typeof schema>;

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

  return defineTool<SkillArgs>({
    ...(maxChars != null ? { caps: { maxChars } } : {}),
    name: 'Skill',
    description:
      "Load a named skill's instructions and follow them. Use this when the user asks for "
      + 'something one of these skills covers. Available skills:\n'
      + installed.map((s) => `- ${s.id}: ${s.description}`).join('\n'),
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
    async execute(args: SkillArgs, _ctx: ToolContext): Promise<ToolResultPayload> {
      try {
        const skill = catalog.load(args.skill);
        // G-12 delivery mirrors Claude Code: a SKILL.md that names `$ARGUMENTS`
        // gets them substituted in place; otherwise they ride a final
        // "Arguments:" line. With no args the body is delivered verbatim — a
        // literal `$ARGUMENTS` left standing tells the model the skill expected
        // something, which blanking it out would hide.
        let body = skill.body;
        if (args.args !== undefined) {
          body = body.includes('$ARGUMENTS')
            ? body.split('$ARGUMENTS').join(args.args)
            : `${body}\nArguments: ${args.args}`;
        }
        return { text: `<skill-instructions name="${skill.id}">\n${body}\n</skill-instructions>` };
      } catch (err: any) {
        // RETURNED, not thrown: defineTool's catch would prefix "Skill failed:" and
        // bury the recovery information these errors carry — the list of skills that
        // DO exist, or the real filesystem reason. Both are the actionable part.
        return { text: err?.message ?? String(err), isError: true };
      }
    },
  });
}
