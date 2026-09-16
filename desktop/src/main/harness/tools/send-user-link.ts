// SendUserLink — the link-side mirror of SendUserFile (spec 2026-09-02,
// slice A). Same shape and philosophy as send-user-file.ts: stateless, it
// validates the URLs and reports; the RENDERER owns the Deliverables card.
//
// NOTHING here opens a link. deliverable-auto-open.ts (the display:"render"
// rule) deliberately still matches SendUserFile only — a file opens in the
// app's own side panel, while a link would launch an external browser, and
// nobody has signed off on the model doing that unasked. `display` is accepted
// and ignored until that decision is made.
//
// WHY a separate tool rather than a "links:" field on SendUserFile: the two
// produce different TILES in the Deliverables card (a link has no artifact
// preview and opens in the browser, never the artifact viewer), and a mixed
// call would blur one card's status/error handling. Keeping "is this a file
// tile or a link tile" a property of the TOOL NAME is also what lets the
// renderer draw the same tile for the Claude Code MCP tool
// (main/claude-code-mcp.ts), which carries the identical `links` input.
import { z } from 'zod';
import { defineTool } from './registry';
import { SEND_USER_LINK_BASE_DESCRIPTION, SEND_USER_LINK_TOOL } from '../../../shared/send-user-link';

// One description, shared verbatim with the Claude Code MCP tool
// (shared/send-user-link.ts) so the model behaves identically in both session
// types. It deliberately says NOTHING about `display`: nothing opens a link
// automatically yet, and a tool that describes behaviour it does not have
// teaches the next session to assume the feature exists.
export const SEND_USER_LINK_DESCRIPTION = SEND_USER_LINK_BASE_DESCRIPTION;

/** Narrow an unknown catch value to an Error message without a blind cast —
 *  `new URL()` throws TypeError/URIError with a `message` we can surface, but
 *  the catch type is `unknown`, so check shape before reading it. */
function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'not a URL';
}

export const SendUserLinkTool = defineTool({
  name: SEND_USER_LINK_TOOL,
  // Pause handoff §1 (WHY): a message to the user counts as reaching outside,
  // so a plan never repeats it by itself.
  effect: 'external',
  description: SEND_USER_LINK_DESCRIPTION,
  // Compact form for small local models (same reasoning as SendUserFile's).
  shortDescription: 'Hand finished URLs to the user as a Deliverables card. http:// and https:// only; localhost and LAN IPs are fine.',
  inputSchema: z.object({
    links: z.array(z.object({
      url: z.string().describe('The full URL to open — http:// or https://. localhost and LAN IPs are allowed.'),
      label: z.string().optional().describe('Optional short label shown on the tile instead of the bare URL.'),
    })).min(1),
    caption: z.string().optional().describe('One line of context for the links.'),
    status: z.enum(['normal', 'proactive']).optional().describe('Accepted for parity with SendUserFile; ignored.'),
    display: z.enum(['render', 'attach']).optional().describe('Accepted for parity with SendUserFile; ignored — a link is never opened for the user without their click.'),
  }).strict(), // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
  // Opens nothing — it names URLs the user should visit; the click is user-
  // initiated and goes through shell.openExternal's own scheme allowlist.
  // No path subject, so checkPathGuard's cwd jail does not apply.
  permissionSubject: () => undefined,
  async execute(args, ctx) {
    const problems: string[] = [];
    for (const link of args.links) {
      const raw = link.url;
      // new URL() is the parser: it accepts relative-looking strings as
      // "file:" (or "" scheme) URLs, so we must BOTH parse AND require an
      // explicit http/https scheme — bare "localhost:5173" is not a URL and
      // can't be opened safely.
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch (err) {
        // Surface the REAL parse reason, never a guessed cause
        // (docs/error-message-standards.md): a malformed URL fails differently
        // from an unsupported scheme and the model has to be able to tell which.
        problems.push(`${raw}: ${messageOf(err)}`);
        continue;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        problems.push(`${raw}: only http:// and https:// URLs can be sent`);
        continue;
      }
    }
    if (problems.length) {
      // The WHOLE call fails: half-delivering would leave the model believing
      // the bad link reached the user (mirrors SendUserFile's whole-call rule).
      return { text: `SendUserLink failed — nothing was sent:\n${problems.map((p) => `- ${p}`).join('\n')}`, isError: true };
    }
    const n = args.links.length;
    return { text: `Sent ${n} link${n === 1 ? '' : 's'} to the user.` };
  },
});