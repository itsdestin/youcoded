const ANSI_ESCAPE = /\u001b\[[0-9;]*[a-zA-Z]/g;

const TITLE_OVERRIDES: Record<string, string> = {
  'trust': 'Trust This Folder?',
  'dark mode': 'Choose a Theme',
  'login method': 'Select Login Method',
  'dangerously-skip-permissions': 'Skip Permissions Warning',
  'skip all permission': 'Skip Permissions Warning',
  // Resume session prompt — shown when resuming a stale/large session
  'resuming from a summary': 'Resume Session',
  // Usage-limit prompt — shown when the user hits their plan's usage cap.
  // Key on "limit to reset" (unique to option 1) rather than the generic
  // "What do you want to do?" title to avoid false matches on future menus.
  'limit to reset': 'Usage Limit Reached',
  // Auto-mode opt-in prompt (CC v2.1.83+) — 4-option confirmation menu:
  // "Yes, and make it my default mode" / "Yes, enable auto mode" /
  // "No, go back" / "No, don't ask again". Anchor on a body-text phrase
  // ("Auto mode lets Claude…") rather than the "Enable auto mode?" title
  // because the body description is word-wrapped, and individual wrapped
  // lines can fall under extractTitle's < 80-char fallback and be returned
  // as the title verbatim.
  'auto mode lets claude': 'Enable auto mode?',
};

export interface ParsedMenu {
  id: string;
  title: string;
  options: string[];
  selectedIndex: number;
  description?: string; // Contextual text above the menu (e.g., resume trade-off explanation)
}

export interface PromptButton {
  label: string;
  input: string;
}

function stripAnsi(line: string): string {
  return line.replace(ANSI_ESCAPE, '');
}

/**
 * Strip leading numbering ("1. ", "2. ") from an option label if present.
 */
function stripNumbering(text: string): string {
  // Match both period ("1. ") and colon ("1: ") numbered formats
  return text.replace(/^\d+[.:]\s+/, '');
}

/**
 * Measure the leading whitespace of a raw line (before any trimming).
 */
function indentOf(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/**
 * Checks if a line looks like a menu option sibling:
 * - non-empty
 * - similar indentation to the reference (within +/-2 columns)
 * - not a box-drawing or decorative line
 * - starts with a number prefix ("1. ", "2. ", etc.)
 *
 * The numbered-line requirement prevents contextual text (descriptions,
 * warnings, paths) from being collected as menu options. This is important
 * because Ink menus in Claude Code use numbered options, and on Windows
 * ConPTY the selector character is ">" (not "❯"), so indentation alone
 * isn't enough to distinguish options from surrounding text.
 */
function isOptionLine(line: string, referenceIndent: number): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[─┌┐└┘│╭╮╯╰┬┴├┤┼╔╗╚╝║═]+$/.test(trimmed)) return false;
  // Match both period ("1. ") and colon ("1: ") numbered formats — the resume
  // session prompt uses colon-numbered options while other Ink menus use periods
  if (!/^\d+[.:]\s+/.test(trimmed)) return false;
  const indent = indentOf(line);
  return Math.abs(indent - referenceIndent) <= 2;
}

/**
 * Parse an Ink select menu from rendered terminal screen text.
 *
 * Handles both numbered ("1. Yes") and unnumbered ("Yes") option formats.
 * Detection strategy:
 * 1. Finds the ❯ selector character (bottom-up scan)
 * 2. Extracts the selected option's text and indentation
 * 3. Walks up/down from the selector to find sibling option lines
 *    at matching indentation
 * 4. Strips optional numbering from all options
 */
export function parseInkSelect(screenText: string): ParsedMenu | null {
  const clean = stripAnsi(screenText);
  const lines = clean.split('\n');

  // Find the line with the ❯ selector (search bottom-up for the most recent)
  let selectorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[❯>]/.test(lines[i])) { selectorIdx = i; break; }
  }
  if (selectorIdx < 0) return null;

  const selectorLine = lines[selectorIdx];
  // The selected option text is everything after ❯ and whitespace
  const selectedText = stripNumbering(selectorLine.replace(/^\s*[❯>]\s*/, '').trim());
  if (!selectedText) return null;

  // Determine the reference indentation for non-selected options.
  // Non-selected lines use spaces where ❯ appears on the selected line.
  // Example:  "  ❯ Yes"  ->  selected indent = 4 (after ❯ + space)
  //           "    No"   ->  sibling indent = 4 (matching spaces)
  // We use the indentation of the text AFTER the ❯ to find siblings.
  const afterSelector = selectorLine.replace(/^\s*[❯>]/, ' ');
  const referenceIndent = indentOf(afterSelector);

  const options: string[] = [];
  let selectedIndex = 0;

  // Walk backward to find options above the selector
  for (let i = selectorIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) break;
    if (!isOptionLine(lines[i], referenceIndent)) break;
    // Don't include lines that look like titles (end with ? or :)
    if (/[?:]$/.test(trimmed) && !/^\d+[.:]\s+/.test(trimmed)) break;
    options.unshift(stripNumbering(trimmed));
  }

  // Insert the selected option
  selectedIndex = options.length;
  options.push(selectedText);

  // Walk forward to find options below the selector
  for (let i = selectorIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) break;
    if (!isOptionLine(lines[i], referenceIndent)) break;
    options.push(stripNumbering(trimmed));
  }

  if (options.length < 2) return null;
  if (options.some((o) => o.length > 200)) return null;

  // Extract title from lines above the menu
  const firstOptionLine = selectorIdx - selectedIndex;
  const title = extractTitle(lines, Math.max(0, firstOptionLine));

  const id = 'menu_' + options.map((o) => o.slice(0, 10)).join('_')
    .toLowerCase().replace(/[^a-z0-9_]/g, '');

  // Extract contextual description from lines above the menu (e.g., resume
  // session trade-off text: session age, token count, usage warning)
  const description = extractDescription(lines, Math.max(0, firstOptionLine), title);

  return { id, title, options, selectedIndex, description };
}

/**
 * Extract a title for the menu by examining lines above the first option.
 * TITLE_OVERRIDES are checked against only the nearby lines (not the full
 * screen text) to prevent stale content from earlier prompts from matching —
 * e.g., after answering a trust prompt, the word "trust" remains in the
 * terminal buffer and would incorrectly title all subsequent menus.
 */
function extractTitle(lines: string[], firstOptionLine: number): string {
  const searchStart = Math.max(0, firstOptionLine - 10);
  const nearbyText = lines.slice(searchStart, firstOptionLine).join(' ').toLowerCase();

  for (const [keyword, title] of Object.entries(TITLE_OVERRIDES)) {
    if (nearbyText.includes(keyword)) return title;
  }
  for (let i = firstOptionLine - 1; i >= searchStart; i--) {
    const clean = stripAnsi(lines[i]).trim();
    if (!clean) continue;
    if (clean.endsWith('?') || clean.endsWith(':')) {
      return clean.replace(/[:?]$/, '').trim() + (clean.endsWith('?') ? '?' : '');
    }
    if (clean.length >= 3 && clean.length <= 80) return clean;
  }

  return 'Select an Option';
}

/**
 * Extract descriptive text from lines above the menu options, between the
 * title region and the first option. Used to surface contextual info like
 * the resume prompt's session-age and usage-limit trade-off explanation.
 * Skips box-drawing, empty lines, and lines that match the extracted title.
 */
function extractDescription(lines: string[], firstOptionLine: number, title: string): string | undefined {
  const searchStart = Math.max(0, firstOptionLine - 15);
  const descLines: string[] = [];

  for (let i = searchStart; i < firstOptionLine; i++) {
    const clean = stripAnsi(lines[i]).trim();
    if (!clean) continue;
    // Skip box-drawing / decorative lines
    if (/^[─┌┐└┘│╭╮╯╰┬┴├┤┼╔╗╚╝║═━]+$/.test(clean)) continue;
    // Skip the line that became the title (avoid duplication)
    if (clean.replace(/[:?]$/, '').trim() === title.replace(/[:?]$/, '').trim()) continue;
    // Skip footer instructions (e.g., "Enter to confirm - Esc to cancel")
    if (/enter to confirm/i.test(clean)) continue;
    descLines.push(clean);
  }

  if (descLines.length === 0) return undefined;
  return descLines.join(' ');
}

export function menuToButtons(menu: ParsedMenu): PromptButton[] {
  const UP = '\u001b[A';
  const DOWN = '\u001b[B';

  // Anchor-then-navigate: always overshoot UP to snap Ink's cursor to the top
  // of the menu (Ink clamps arrow-up at index 0), THEN press DOWN to reach the
  // target. This makes the keystroke sequence independent of cursor state at
  // click time — previously we computed a relative offset from the parsed
  // selectedIndex, which went stale the moment the user arrowed in the
  // terminal view or Ink re-rendered (same menu.id, so usePromptDetector
  // doesn't re-emit SHOW_PROMPT). Stale offset was the root cause of
  // "clicked option N, got option M" bugs on the Resume Session menu.
  const anchorUps = UP.repeat(menu.options.length + 2);

  return menu.options.map((label, index) => ({
    label,
    input: anchorUps + DOWN.repeat(index) + '\r',
  }));
}
