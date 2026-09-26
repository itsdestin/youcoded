// kept-card-binding.ts — may a KEPT card answer the menu that is on screen?
//
// A kept card is a permission card whose hook socket died while Claude Code's
// own menu may still be live (chat-reducer PERMISSION_EXPIRED 'hook-closed').
// Its buttons type a row number into that menu. The danger (review 2026-09-23,
// F1/P1): the card's ask may already have been answered in the terminal, and
// the menu now on screen belongs to the NEXT ask (a parallel tool call). So the
// card offers buttons only when the menu's own prompt box shows THIS call —
// its full file path, its whole command, its MCP server/tool and arguments —
// in the layout Claude Code uses for that tool. Anything it cannot confirm:
// no buttons (Dismiss and the terminal remain).
//
// What this CANNOT tell apart: two asks for the same tool with the same
// visible input (e.g. the same command twice in parallel). The prompt looks
// identical, so a kept card for the first may answer the second. It is the
// same request, but it is a different call — stated here rather than claimed
// away.
//
// Layouts, measured on Claude Code 2.1.281 (tests/fixtures/plan-menu/
// app-screen-* and cc-2.1.281-prompt-*.json):
//   Write   "Create file" / "Overwrite file", then the path on its own line —
//           relative to the session folder when inside it
//   Edit    "Edit file", then the path on its own line
//   Bash    "Bash command", then the command (wrapped lines may carry a "│"
//           gutter), then the description line
//   MCP     "Tool use", then "<server> — <Tool Title>: (MCP)", then one
//           `key: "value"` line per argument
// ASSUMED (not triggerable on 2.1.281 — Grep/Glob are not separate tools
// there, a personal Skill ran without a prompt, NotebookEdit was not tried):
//   NotebookEdit like Edit; any other tool shows its name, case-insensitive,
//   and each short string argument somewhere in its box.

import { parseInkSelect, rebindButtons, type PromptButton } from './ink-select-parser';

const clean = (l: string) => l.replace(/^\s*│\s?/, '').trim();
const squash = (t: string) => t.replace(/\s+/g, '');
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const slash = (p: string) => p.replace(/\\/g, '/');

/** The path the way Claude Code prints it: relative to the session folder
 *  when the file is inside it, else as given. */
function shownPaths(file: string, cwd: string | undefined): string[] {
  const f = slash(file);
  const out = [f];
  const c = cwd ? slash(cwd).replace(/\/+$/, '') : '';
  if (c && f.startsWith(c + '/')) out.unshift(f.slice(c.length + 1));
  return out;
}

/** The box line that follows `header` (the first non-empty one). */
function lineAfter(lines: string[], header: RegExp): string | null {
  const i = lines.findIndex((l) => header.test(clean(l)));
  if (i < 0) return null;
  for (let k = i + 1; k < lines.length; k++) if (clean(lines[k])) return clean(lines[k]);
  return null;
}

function fileMatches(lines: string[], header: RegExp, file: string, cwd: string | undefined): boolean {
  const shown = lineAfter(lines, header);
  // The WHOLE line must be the path: "hello.txt" must not match "sub/hello.txt".
  return !!shown && shownPaths(file, cwd).includes(slash(shown));
}

function bashMatches(lines: string[], command: string, description: string): boolean {
  const i = lines.findIndex((l) => /^bash command$/i.test(clean(l)));
  if (i < 0 || !command) return false;
  // Everything between the header and the question line, gutters removed.
  const end = lines.findIndex((l, k) => k > i && /^do you want\b/i.test(clean(l)));
  const body = squash(lines.slice(i + 1, end < 0 ? lines.length : end).map(clean).join(' '));
  const cmd = squash(command);
  // The WHOLE command, then nothing but its own description (if any): a
  // prefix like "rm -rf x" must not match a prompt for "rm -rf x y".
  if (!body.startsWith(cmd)) return false;
  const rest = body.slice(cmd.length);
  return rest === '' || rest === squash(description) || rest === squash('Run shell command');
}

function argsShown(lines: string[], input: Record<string, unknown> | undefined): boolean {
  const text = squash(lines.map(clean).join(' ')).toLowerCase();
  for (const v of Object.values(input ?? {})) {
    if (typeof v !== 'string' || v.length > 80) continue; // long values may be cut short on screen
    if (!text.includes(squash(v).toLowerCase())) return false;
  }
  return true;
}

function mcpMatches(lines: string[], toolName: string, input: Record<string, unknown> | undefined): boolean {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!m) return false;
  const [, server, tool] = m;
  const words = tool.split(/[_\-\s]+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const esc = server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^${esc}\\s+[—-]\\s+${words.join('[\\s_-]*')}\\b.*\\(MCP\\)$`, 'i');
  if (!lines.some((l) => head.test(clean(l)))) return false;
  // Each short argument on its own `key: "value"` line, as Claude Code prints it.
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v !== 'string' || v.length > 80) continue;
    if (!lines.some((l) => clean(l) === `${k}: ${JSON.stringify(v)}`)) return false;
  }
  return true;
}

/** Does the menu's own prompt box show THIS tool call?
 *  WHY not exported: only keptCardButtons below calls it; the export tipped the
 *  combined branches over the knip ratchet (combined-branch fix). */
function promptShowsCall(
  lines: string[],
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string | undefined,
): boolean {
  const file = str(input?.file_path) || str(input?.notebook_path);
  if (toolName === 'Bash') return bashMatches(lines, str(input?.command).trim(), str(input?.description));
  if (toolName === 'Write') return !!file && fileMatches(lines, /^(create|overwrite) file$/i, file, cwd);
  if (toolName === 'Edit' || toolName === 'MultiEdit') return !!file && fileMatches(lines, /^edit file$/i, file, cwd);
  if (toolName === 'NotebookEdit') return !!file && fileMatches(lines, /^edit( notebook| file)?\b/i, file, cwd);
  if (toolName.startsWith('mcp__')) return mcpMatches(lines, toolName, input);
  // Any other tool: its name (any case, as a whole word) and its arguments.
  const name = new RegExp(`\\b${toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return lines.some((l) => name.test(clean(l))) && argsShown(lines, input);
}

/** Buttons for a kept card, or null when the menu cannot be confirmed as its own. */
export function keptCardButtons(
  screen: string | null,
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd?: string,
): PromptButton[] | null {
  const menu = screen ? parseInkSelect(screen) : null;
  const buttons = rebindButtons(menu, toolName);
  if (!menu || !buttons || !menu.promptLines) return null;
  const lines = menu.promptLines;
  return promptShowsCall(lines, toolName, input, cwd) ? buttons : null;
}
