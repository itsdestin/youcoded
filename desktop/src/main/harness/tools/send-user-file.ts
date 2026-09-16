// SendUserFile — the native mirror of Claude Code's built-in (spec 2026-08-25
// §6). Same name and inputs, so the renderer needs ONE Deliverables card.
// Stateless on purpose: it validates the paths and reports. The renderer owns
// the card, the auto-open rule and its one-render-per-reply limit
// (renderer/state/deliverable-auto-open.ts) — enforcing that here would have
// needed per-turn state plus a flag threaded through the result event.
import * as fs from 'fs';
import { z } from 'zod';
import { defineTool } from './registry';
import { resolveP, toPosix } from './guards';

export const SEND_USER_FILE_DESCRIPTION = [
  'Send finished files to the user — a report, a mockup, a screenshot, a built page — as a "Deliverables" card with previews they can open.',
  'Use it for deliverables the user will want to look at, not scratch or intermediate files, and do not re-send a file that has not changed.',
  'display: "render" asks to show ONE file immediately; only the first such request in a reply is honored. Everything else attaches to the card.',
  'Paths resolve against the working directory; "~" is not expanded, so use absolute paths for files outside the project.',
].join(' ');

/** Narrow an unknown catch value to a Node errno code without a blind cast —
 *  `fs.statSync` throws `NodeJS.ErrnoException`, but the catch type is
 *  `unknown` and nothing guarantees `code` is set (a non-fs error could reach
 *  here too), so check shape before reading it. */
function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return undefined;
}

export const SendUserFileTool = defineTool({
  name: 'SendUserFile',
  // Pause handoff §1 (WHY): may reach outside this computer, so a plan never repeats it by itself.
  effect: 'external',
  description: SEND_USER_FILE_DESCRIPTION,
  // Compact form for small local models (simplified presentation, spec §4.2).
  shortDescription: 'Hand finished files to the user as a Deliverables card. display: "render" shows one file now (first request per reply).',
  inputSchema: z.object({
    files: z.array(z.string()).min(1).describe('File paths to send — absolute, or relative to the working directory.'),
    caption: z.string().optional().describe('One line of context for the files.'),
    status: z.enum(['normal', 'proactive']).optional().describe('Accepted for parity with Claude Code; ignored.'),
    display: z.enum(['render', 'attach']).optional().describe('"render": show the first file immediately (first request per reply only). "attach" or omitted: just the card.'),
  }).strict(), // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
  // Reads nothing, writes nothing — it names files the user should look at.
  // No path subject, so checkPathGuard's cwd jail does not apply: a chart in
  // /tmp must go through. The viewer applies its own read guards on open.
  permissionSubject: () => undefined,
  async execute(args, ctx) {
    const problems: string[] = [];
    for (const raw of args.files) {
      if (raw.startsWith('~')) {
        problems.push(`${raw}: "~" is not expanded here; use an absolute path`);
        continue;
      }
      const abs = resolveP(raw, ctx.cwd);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);            // follows symlinks: a link to a file is a file
      } catch (err) {
        // Surface the REAL errno, never a guessed cause (docs/error-message-
        // standards.md): this tool has no cwd jail (see permissionSubject
        // below), so the model routinely names paths outside the workspace,
        // where a parent directory it can't traverse (EACCES) is normal and
        // the file is NOT missing — telling the model "does not exist" would
        // send it off to recreate a file that's already there.
        const code = errnoCode(err);
        if (code === 'ENOENT') {
          problems.push(`${toPosix(abs)}: does not exist`);
        } else if (code) {
          problems.push(`${toPosix(abs)}: cannot be read (${code})`);
        } else {
          // No errno at all — admit we don't know rather than invent a cause.
          problems.push(`${toPosix(abs)}: could not be checked`);
        }
        continue;
      }
      if (st.isDirectory()) { problems.push(`${toPosix(abs)}: is a directory`); continue; }
      if (!st.isFile()) problems.push(`${toPosix(abs)}: is not a regular file`);
    }
    if (problems.length) {
      // The WHOLE call fails: half-delivering would leave the model believing
      // the missing file reached the user.
      return { text: `SendUserFile failed — nothing was sent:\n${problems.map((p) => `- ${p}`).join('\n')}`, isError: true };
    }
    const n = args.files.length;
    return { text: `Sent ${n} file${n === 1 ? '' : 's'} to the user.` };
  },
});
