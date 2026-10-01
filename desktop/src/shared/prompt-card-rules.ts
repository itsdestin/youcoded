// prompt-card-rules.ts — which terminal menus become a card, and the timings of showing and dismissing one.
//
// WHY (2026-10-01 one-core R5-4b): these lived in the renderer's usePromptDetector, which read each screen's own copy of the terminal. The
// computer now reads every Claude Code terminal itself (main/session-screens.ts) and publishes the card once, so the rules moved here where
// main and the renderer's remaining startup-dialog check can both use them. Pure.
import type { ParsedMenu } from './ink-select-parser';

/**
 * How long to wait before showing a menu-detected card, giving the hook system time to deliver a PermissionRequest through the named-pipe relay.
 * Hook events typically arrive 100-200ms after the Ink menu renders.
 */
export const PROMPT_DEBOUNCE_MS = 350;

/**
 * Only these setup prompts become cards. Permission prompts (Yes/No/Always Allow) are handled exclusively by the hook system through the permission
 * card; showing them here too causes duplication. This also stops numbered lists in Claude's output that the Ink parser misreads as menus.
 */
const SETUP_PROMPT_TITLES = new Set([
  'Trust This Folder?',
  'Choose a Theme',
  'Select Login Method',
  'Skip Permissions Warning',
  'Resume Session', // Stale session resume — lets user choose summary vs full resume
  'Usage Limit Reached', // /rate-limit-options menu — Upgrade / Stop and wait
  'Enable auto mode?', // CC v2.1.83+ first-run opt-in: 4-option auto-mode confirmation
  'Message Flagged', // Fable 5 model-safeguard fallback — Switch model / Edit prompt and retry
  // Startup dialog when CLAUDE.md imports files outside the cwd. Previously it was mislabeled 'Trust This Folder?' by the stale trust anchor
  // and hijacked TrustGate's full-screen takeover; now it gets its own card (2026-07-26).
  'Allow External Imports?',
  // Project MCP-server approval (a folder with .mcp.json), CC 2.1.281.
  'New MCP Server Found',
]);

/**
 * The card title for a menu, or null to skip it.
 *
 * A known setup prompt keeps its canonical title. While the session is still STARTING (no hook event yet — Claude Code runs none until every startup
 * dialog is answered), any menu that is plainly a live Claude Code dialog (its "Enter to confirm · Esc to cancel" footer under the options) is shown
 * too, titled with the dialog's own heading: a dialog nobody has taught the app about must never again leave a new session on "Initializing
 * session…" (2026-09-24). Outside startup the known-titles gate stays strict — there, permission menus belong to the hook cards and numbered lists in
 * replies are not menus.
 */
export function cardTitleFor(menu: ParsedMenu, starting: boolean): string | null {
  if (SETUP_PROMPT_TITLES.has(menu.title)) return menu.title;
  if (starting && menu.dialog) {
    const heading = (menu.heading ?? '').replace(/:\s*$/, '').trim();
    return heading || menu.title;
  }
  return null;
}

/**
 * After a permission response clears the last live ask, suppress menu detection for this long. Prevents the PTY briefly redrawing the Ink menu while
 * Claude processes the response from being read as a "new" menu once the guard is cleared.
 */
export const POST_PERMISSION_COOLDOWN_MS = 800;

/** How long a menu must be absent before it counts as gone. Prevents a brief screen flicker (clear -> redraw) from resetting duplicate detection. */
export const DISMISS_DEBOUNCE_MS = 600;

/**
 * How long an ANSWERED card's identical dialog must stay on screen before it is treated as a new question and given a fresh card. Longer than a
 * digit answer's menu takes to leave, so a normal answer never re-shows.
 */
export const REISSUE_MS = 1000;
