// The Browser tools for NATIVE sessions — thin adapters. Names, schemas and
// descriptions come from assistant-browser/browser-tool-specs.ts and the work
// happens in the Browser's worker (browser-tool-runners.ts), so a native session
// and a Claude Code session get the same results byte for byte (spec §2).
//
// Conditional (CONDITIONAL_TOOL_NAMES): attached by harness-session.ts's
// syncBrowserTools only when the host injected `services.browser` (desktop),
// the session is not a specialist child, and the profile isn't a small model's
// simplified presentation. No permissionSubject: the Browser asks the person
// with its own card (one policy engine for both session kinds — design
// review 1 #1); every Browser tool is in every mode's always-allowed set.
import { BROWSER_TOOL_NAMES, BROWSER_TOOL_SPECS, type BrowserToolName } from '../../assistant-browser/browser-tool-specs';
import { defineTool } from './registry';
import type { NativeTool } from './types';

/** Whatever's left after the Browser's own 24k-character outline cap is the
 *  pipeline's 30k safety net — the outline already says how to continue. */
const MORE_HINT = 'call BrowserSnapshot with the `from` position the result names to read the rest of the page';

function makeTool(name: BrowserToolName): NativeTool {
  const spec = BROWSER_TOOL_SPECS[name];
  return defineTool({
    name,
    description: spec.description,
    shortDescription: spec.shortDescription,
    inputSchema: spec.schema as NativeTool['inputSchema'],
    moreHint: MORE_HINT,
    permissionSubject: () => undefined,
    async execute(args, ctx) {
      const browser = ctx.services?.browser;
      if (!browser) return { text: 'The browser isn\'t available in this session.', isError: true };
      const r = await browser.callTool(ctx.sessionId, name, args, { signal: ctx.signal, vision: ctx.supportsVision ?? false });
      return {
        text: r.text,
        ...(r.isError ? { isError: true } : {}),
        ...(r.imagePath ? { images: [r.imagePath], imageLabels: ['Browser screenshot'] } : {}),
      };
    },
  });
}

/** Add or remove the Browser tools on a session's tool map. `wanted` needs all
 *  three gates (harness-session.ts buildAiTools): the host injected
 *  `services.browser` (desktop only), the session isn't a specialist child
 *  (children share the parent's tabs and have a fixed tool list), and the
 *  profile isn't a small model's simplified presentation (the extra Browser schemas
 *  crowd out a weak model's attention). Run per buildAiTools like Skill: a model
 *  swap can flip the profile either way; has()/delete() keep both directions idempotent. */
export function syncBrowserTools(toolByName: Map<string, NativeTool>, wanted: boolean): void {
  for (const t of browserTools()) {
    if (!wanted) toolByName.delete(t.name);
    else if (!toolByName.has(t.name)) toolByName.set(t.name, t);
  }
}

let built: NativeTool[] | null = null;

/** One instance per tool for the process (they hold no per-session state). */
export function browserTools(): NativeTool[] {
  if (!built) built = BROWSER_TOOL_NAMES.map(makeTool);
  return built;
}
