const ANSI_ESCAPE = /\u001b\[[0-9;]*[a-zA-Z]/g;

// Canonical title the parser assigns to CC's folder-trust prompt. Exported so
// TrustGate can exact-match against it — a substring match on 'trust' there
// once hijacked any prompt whose title contained the word.
export const TRUST_PROMPT_TITLE = 'Trust This Folder?';

// Every key here is matched as a bare substring against the ~10 lines of
// terminal text ABOVE the menu — which includes arbitrary conversation output,
// not just the prompt's own body. Keys must therefore be phrases distinctive
// enough that normal conversation can't plausibly contain them right above a
// menu. A single common word is never acceptable: the old 'trust' key
// relabeled the Fable 5 model-safeguard prompt (and would relabel ANY menu)
// whenever "trust" appeared in nearby text.
const TITLE_OVERRIDES: Record<string, string> = {
  // Folder-trust prompt — anchored on the "Quick safety check:" opener of the
  // CC ~2.1.2xx rewrite. The previous anchor ('files you trust', from the old
  // "Important: Only use Claude Code with files you trust…" note) no longer
  // appears in this dialog at all; the only remaining occurrence of that
  // sentence in the 2.1.220 bundle belongs to the external-CLAUDE.md-imports
  // dialog below, so keeping it here both missed the real prompt and hijacked
  // the wrong one (2026-07-26).
  'quick safety check': TRUST_PROMPT_TITLE,
  // Same dialog, second anchor — the body varies (optional "This folder
  // pre-approves N tool permissions" / "This folder adds …" lines), and this
  // sentence sits closer to the options, inside extractTitle's lookback window.
  'execute files here': TRUST_PROMPT_TITLE,
  // External CLAUDE.md imports — the dialog that inherited the old
  // "…files you trust…" security note. Anchored on its own body sentence
  // because the generic heuristic would otherwise title it "security risks"
  // (the last body line before the options).
  'imports files outside the current working directory': 'Allow External Imports?',
  // Model-safeguard fallback prompt (CC + Fable 5) — "This model's safeguards
  // flagged this message…" with "Switch to <model> and continue" /
  // "Edit prompt and retry with <model>" options. The phrase appears in every
  // wording variant of the prompt body.
  'safeguards flagged this message': 'Message Flagged',
  // Theme select — anchored on its heading ("Choose the text style that looks
  // best with your terminal"). The old 'dark mode' key was conversation-prone:
  // any chat about dark mode above a menu relabeled it 'Choose a Theme'.
  'text style that looks best': 'Choose a Theme',
  // Login select — anchored on its "Select login method:" heading (the old
  // bare 'login method' key matched conversation text too).
  'select login method': 'Select Login Method',
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

// Overrides keyed on an OPTION LABEL rather than on body text above the menu.
// Body text is fragile: extractTitle only looks 10 lines up, and CC's dialogs
// grow and shrink optional body lines (the folder-trust dialog adds
// "This folder pre-approves N tool permissions" / "This folder adds …" when the
// project ships settings), which can push the distinctive phrase out of range.
// Option labels are the prompt's own vocabulary and survive every body rewrite,
// so they must be exact whole-label matches — a substring would be as
// collision-prone as the old bare 'trust' key.
const OPTION_TITLE_OVERRIDES: Record<string, string> = {
  // Present in BOTH the old ("Do you trust the files in this folder?") and the
  // CC ~2.1.2xx ("Accessing workspace: … Quick safety check:") trust dialogs.
  'yes, i trust this folder': TRUST_PROMPT_TITLE,
};

export interface ParsedMenu {
  id: string;
  title: string;
  options: string[];
  selectedIndex: number;
  description?: string; // Contextual text above the menu (e.g., resume trade-off explanation)
  /** The number CC prints in front of each option ("1. Yes" → 1), index-aligned
   *  with `options`. This is what menuToButtons sends: typing the digit is the
   *  only cursor-independent way to pick an option (see menuToButtons). */
  optionNumbers?: (number | null)[];
  /** Every line of the prompt's OWN box above the options — from the nearest
   *  box rule, up to PROMPT_SCAN_LINES above (not the 15-line window the title
   *  and description use). What a kept card binds against: a long Bash command
   *  can wrap to many lines (kept-card-binding.ts). */
  promptLines?: string[];
}

/** How far above the options the prompt's box top is searched for. */
const PROMPT_SCAN_LINES = 120;

export interface PromptButton {
  label: string;
  input: string;
  /** A SECOND pty write, sent after `input` with a gap (see
   *  state/prompt-input.ts), for the arrow-navigation fallback only. Arrows and
   *  `\r` must never share one write — CC discards the arrows and acts on the
   *  Enter alone (see menuToButtons). */
  submitInput?: string;
}

/** A horizontal rule / box border — the top edge of CC's prompt box, and the
 *  boundary between the prompt's own body and whatever the session printed
 *  before it. `│` is deliberately absent: it's a SIDE border that appears on
 *  body lines, not a boundary. */
const PROMPT_BOUNDARY = /^[─═━┌┐└┘╭╮╯╰├┤┬┴┼╔╗╚╝]{8,}$/;

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
 * Read the option's printed number ("2. Resume full session as-is" → 2).
 * Returns null if the line carries none — menuToButtons then falls back to
 * arrow navigation for that option.
 */
function numberOf(text: string): number | null {
  const m = text.match(/^(\d+)[.:]\s+/);
  return m ? Number(m[1]) : null;
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
  // Index-aligned with `options` — the digit CC printed for each one.
  const optionNumbers: (number | null)[] = [];
  let selectedIndex = 0;

  // A long option label that Claude Code wrapped continues on the next line(s),
  // indented DEEPER than the option numbers and carrying no number of its own:
  //    2. Yes, and switch to accept edits (auto-approve file edits and common file
  //       commands) for this session (shift+tab)
  //    3. No
  // Treating that line as the end of the menu cut the label short AND lost every
  // option after it — found 2026-09-23 when a kept permission card offered
  // "Yes" and half of option 2, with no "No" (CC 2.1.281, 80 columns).
  const isContinuation = (line: string) =>
    !!line.trim() && !/^\s*\d+[.:]\s+/.test(line) && !/^\s*[❯>]/.test(line)
    && indentOf(line) > referenceIndent + 2;

  // Walk backward to find options above the selector. Continuation lines met on
  // the way up belong to the option found ABOVE them.
  let carry: string[] = [];
  for (let i = selectorIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) break;
    if (isContinuation(lines[i])) { carry.unshift(trimmed); continue; }
    if (!isOptionLine(lines[i], referenceIndent)) break;
    // Don't include lines that look like titles (end with ? or :)
    if (/[?:]$/.test(trimmed) && !/^\d+[.:]\s+/.test(trimmed)) break;
    options.unshift([stripNumbering(trimmed), ...carry].join(' '));
    optionNumbers.unshift(numberOf(trimmed));
    carry = [];
  }

  // Insert the selected option
  selectedIndex = options.length;
  options.push(selectedText);
  // The number came off the selector line, before ❯ was stripped — re-read it
  // from the raw line rather than from the already-stripped label.
  optionNumbers.push(numberOf(selectorLine.replace(/^\s*[❯>]\s*/, '').trim()));

  // Walk forward to find options below the selector (continuations join the
  // option just above them).
  for (let i = selectorIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) break;
    if (isContinuation(lines[i])) { options[options.length - 1] += ' ' + trimmed; continue; }
    if (!isOptionLine(lines[i], referenceIndent)) break;
    options.push(stripNumbering(trimmed));
    optionNumbers.push(numberOf(trimmed));
  }

  if (options.length < 2) return null;
  if (options.some((o) => o.length > 200)) return null;

  const firstOptionLine = Math.max(0, selectorIdx - selectedIndex);

  // Where the prompt's OWN body starts. CC draws its prompt inside a box whose
  // top edge is a horizontal rule; above that rule is unrelated session output
  // (on a resumed session, the entire replayed transcript tail). Bounding both
  // extractors at the rule is what stops "❄ Churned for 3m 44s ● API Error…"
  // from being rendered as the prompt's description, and stops TITLE_OVERRIDES
  // from matching a phrase that belongs to the conversation (2026-07-26).
  const bodyStart = findBodyStart(lines, firstOptionLine);

  // Extract title from the prompt's own body lines
  const title = extractTitle(lines, firstOptionLine, options, bodyStart);

  const id = 'menu_' + options.map((o) => o.slice(0, 10)).join('_')
    .toLowerCase().replace(/[^a-z0-9_]/g, '');

  // Extract contextual description from the prompt's own body (e.g., resume
  // session trade-off text: session age, token count, usage warning)
  const description = extractDescription(lines, firstOptionLine, title, bodyStart);

  let promptTop = Math.max(0, firstOptionLine - 15);
  for (let i = firstOptionLine - 1; i >= Math.max(0, firstOptionLine - PROMPT_SCAN_LINES); i--) {
    if (PROMPT_BOUNDARY.test(stripAnsi(lines[i]).trim())) { promptTop = i + 1; break; }
  }
  const promptLines = lines.slice(promptTop, firstOptionLine).map((l) => stripAnsi(l).replace(/\s+$/, ''));

  return { id, title, options, selectedIndex, description, optionNumbers, promptLines };
}

/**
 * First line of the prompt's own body: one past the nearest box border above
 * the options, or a 15-line window when the prompt isn't boxed (older CC
 * dialogs, and the hand-written screens in tests).
 */
function findBodyStart(lines: string[], firstOptionLine: number): number {
  const floor = Math.max(0, firstOptionLine - 15);
  for (let i = firstOptionLine - 1; i >= floor; i--) {
    if (PROMPT_BOUNDARY.test(stripAnsi(lines[i]).trim())) return i + 1;
  }
  return floor;
}

/**
 * Extract a title for the menu by examining lines above the first option.
 * TITLE_OVERRIDES are checked against the prompt's own body only (never the
 * full screen text) to prevent stale content from earlier prompts, or ordinary
 * conversation text, from matching — e.g., after answering a trust prompt the
 * word "trust" remains in the terminal buffer and would incorrectly title all
 * subsequent menus.
 */
function extractTitle(
  lines: string[],
  firstOptionLine: number,
  options: string[] = [],
  bodyStart = Math.max(0, firstOptionLine - 10),
): string {
  // Option-label overrides win: they don't depend on how far the prompt's body
  // text happens to sit above the menu (see OPTION_TITLE_OVERRIDES).
  for (const option of options) {
    const title = OPTION_TITLE_OVERRIDES[option.trim().toLowerCase()];
    if (title) return title;
  }

  // Never look above the prompt's own box, and never further than 10 lines.
  const searchStart = Math.max(bodyStart, firstOptionLine - 10);
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
 * Extract descriptive text from the prompt's own body — the lines between the
 * box's top edge (`bodyStart`) and the first option. Used to surface contextual
 * info like the resume prompt's session-age and usage-limit trade-off text.
 *
 * The `bodyStart` bound is load-bearing: this used to SKIP box borders and keep
 * walking, so on a resumed session it swallowed the replayed transcript tail and
 * rendered it as the prompt's description (2026-07-26 report — a card whose body
 * read "…❄ Churned for 3m 44s ● API Error: ENOTIMP…" before the real text).
 */
function extractDescription(
  lines: string[],
  firstOptionLine: number,
  title: string,
  bodyStart = Math.max(0, firstOptionLine - 15),
): string | undefined {
  const descLines: string[] = [];

  for (let i = bodyStart; i < firstOptionLine; i++) {
    const clean = stripAnsi(lines[i]).trim();
    if (!clean) continue;
    // Skip side borders and short decorative runs inside the box
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

/**
 * Turn a parsed menu into clickable buttons: each one types the option's NUMBER.
 *
 * Why not arrow keys — two facts measured against the real CC CLI (2.1.220) on
 * 2026-07-26, both of which break every arrow-based scheme:
 *
 *  1. **Arrows in a write that ends with `\r` are discarded.** CC acts on the
 *     Enter alone, confirming whatever option is currently highlighted. Measured
 *     on the /model menu: cursor at index 1, sending `UP×5 + DOWN×N + \r`
 *     committed index 1 for N = 0,1,2,3. This is the bug Destin reported — every
 *     button on the Resume Session card confirmed option 1 ("Resume from
 *     summary"), which runs /compact, so every option compacted the session. It
 *     is also why the earlier "as-is sends from-summary" report never got fixed.
 *  2. **These menus WRAP, they do not clamp.** `UP×5` on the 3-option resume
 *     prompt moves index 0 → 1, not → 0. So the "anchor to the top by
 *     overshooting UP" trick this function used was wrong on its own terms; the
 *     comment claiming "Ink clamps arrow-up at index 0" was simply false.
 *
 * A bare digit selects AND submits in one byte, with no dependency on where the
 * cursor happens to be — verified on the /model menu, the real Resume Session
 * prompt, and the folder-trust prompt. It never sends `\r`, so there is nothing
 * for CC to collapse. `pty-worker.js` routes it down the passthrough path.
 */
export function menuToButtons(menu: ParsedMenu): PromptButton[] {
  const DOWN = '\u001b[B';
  const count = menu.options.length;

  return menu.options.map((label, index) => {
    const number = menu.optionNumbers?.[index] ?? null;

    // Single-digit numbers cover every CC menu we have seen (the parser requires
    // a numeric prefix to recognise an option line at all, so this is the path
    // that actually runs).
    if (number !== null && number >= 1 && number <= 9) {
      return { label, input: String(number) };
    }

    // Fallback for a menu whose options carry no usable digit: step DOWN from
    // the cursor position parsed at SHOW_PROMPT time, then submit in a SEPARATE
    // write (state/prompt-input.ts adds the gap). Relative DOWN steps are
    // wrap-correct (fact 2 above), and the `\r` has to be its own write (fact 1) —
    // split that way the arrows DO all land, measured 2026-07-26. Best-effort
    // only: `selectedIndex` goes stale if the user arrows in the terminal view
    // after the card appears.
    const steps = (((index - menu.selectedIndex) % count) + count) % count;
    return { label, input: DOWN.repeat(steps), submitInput: '\r' };
  });
}

/**
 * Buttons for a KEPT card (its hook socket died while Claude Code's menu may
 * still be live — ToolCard's ExpiredApprovalActions), or null when that is not
 * safe. Ported from PR #278 (2026-07-30 permission-ask-timeout spec §3).
 *
 * Only when EVERY row carries a printed number: a digit picks its row with no
 * dependence on the cursor, while the arrow fallback depends on a cursor
 * position nobody is keeping current for a dead card. Labels always come from
 * THIS parse of the live screen — never matched to the old card by position.
 * AskUserQuestion never rebinds: Claude Code's own UI for it is sequential and
 * multi-select with a free-text row this card does not model. ExitPlanMode
 * never reaches here — PlanApprovalCard keeps answering it by typing.
 * WHY not exported: only the kept-card check below calls it; the export tipped
 * the combined branches over the knip ratchet (combined-branch fix).
 */
function rebindButtons(menu: ParsedMenu | null, toolName: string): PromptButton[] | null {
  if (!menu) return null;
  if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return null;
  const buttons = menuToButtons(menu);
  if (buttons.some((b) => b.submitInput !== undefined)) return null;
  return buttons;
}
