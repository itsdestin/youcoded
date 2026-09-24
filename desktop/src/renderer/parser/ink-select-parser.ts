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
  // The bypass warning's own heading on CC 2.1.281 ("WARNING: Claude Code
  // running in Bypass Permissions mode"). Neither key above appears in that
  // dialog any more, which is part of why it never got a card (2026-09-24).
  'running in bypass permissions mode': 'Skip Permissions Warning',
  // Project MCP-server approval (a folder with .mcp.json, CC 2.1.281): "New MCP
  // server found in this project: <name>" / "MCP servers may execute code or
  // access system resources…". Without this the title fell to the generic
  // heuristic — the body's last line, "more in the MCP documentation."
  'mcp servers may execute code': 'New MCP Server Found',
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

// Overrides keyed on the WHOLE option set, for dialogs whose single labels are
// too generic to key on alone ("Yes, I accept" could belong to anything). The
// bypass warning's heading wraps and its body runs longer than the title
// lookback on a narrow terminal, so its option pair is the dependable anchor.
// Keyed on the sorted, lower-cased labels joined with '|'.
const OPTION_SET_TITLE_OVERRIDES: Record<string, string> = {
  'no, exit|yes, i accept': 'Skip Permissions Warning',
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
  /** The first line of the prompt's own box ("Accessing workspace:", "New MCP
   *  server found in this project: demo"), wrapped rows joined — the dialog's
   *  real heading, which the generic startup card shows as its title. */
  heading?: string;
  /** True when Claude Code's dialog footer ("Enter to confirm · Esc to
   *  cancel") sits under the options: a live dialog, not text that merely
   *  looks like a list. */
  dialog?: boolean;
  /** Identity of the option set (labels in order, not the cursor). What a
   *  verified-navigation answer re-checks before every keystroke. */
  signature?: string;
}

/** How far above the options the prompt's box top is searched for. */
const PROMPT_SCAN_LINES = 120;

export interface PromptButton {
  label: string;
  input: string;
  /** A SECOND pty write, sent after `input` with a gap (see
   *  state/prompt-input.ts). Only ever set by an older build or by Android's
   *  native detector; this parser no longer produces it (see menuToButtons). */
  submitInput?: string;
  /** Answer by VERIFIED navigation instead of a fixed keystroke: the option at
   *  `index` of the menu whose `signature` this is. Set for menus whose options
   *  carry no printed number (CC 2.1.281's trust and bypass dialogs), where no
   *  single keystroke picks an option. state/ink-menu-driver.ts moves the cursor
   *  one arrow per write, confirms each move on screen, and sends Enter alone
   *  only once the cursor sits on exactly this label. */
  pick?: { signature: string; index: number };
}

/** Claude Code's dialog footer: "Enter to confirm · Esc to cancel" (trust,
 *  bypass, MCP approval), "Space to select · Esc to reject all" (multi-select).
 *  Measured on 2.1.281 (tests/fixtures/startup-dialogs/). */
const DIALOG_FOOTER = /(enter to confirm|esc to (cancel|exit|reject)|space to select)/i;

/** A checkbox row of a multi-select dialog ("[✔] demo"). Picking one means
 *  toggling with Space and then confirming a separate row — not modelled, so
 *  such a dialog is never turned into buttons (see parseUnnumbered). */
const CHECKBOX_ROW = /^\[[ ✔✓x×]\]\s/;

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

  // CC 2.1.281 draws its trust, bypass and MCP-approval dialogs with NO
  // numbers ("❯ No, exit" / "  Yes, I trust this folder"). The numbered walk
  // below can never see those options, so they get their own, stricter reader
  // (2026-09-24 — the reason new sessions sat on "Initializing session…").
  if (numberOf(selectorLine.replace(/^\s*[❯>]\s*/, '').trim()) === null) {
    return parseUnnumbered(lines, selectorIdx);
  }

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

  const lastOptionLine = firstOptionLine + options.length - 1;
  return {
    id, title, options, selectedIndex, description, optionNumbers, promptLines,
    heading: readHeading(lines, promptTop, firstOptionLine, 0),
    dialog: hasFooterBelow(lines, lastOptionLine),
    signature: signatureOf(options),
  };
}

/** Identity of an option set — labels in order. */
function signatureOf(options: string[]): string {
  return options.join('␞');
}

/**
 * Is Claude Code's dialog footer within a few non-empty lines under the options?
 * (Continuation rows of a wrapped label sit between, so allow a short gap.)
 */
function hasFooterBelow(lines: string[], lastOptionLine: number): boolean {
  let seen = 0;
  for (let i = lastOptionLine + 1; i < lines.length && seen < 4; i++) {
    const t = stripAnsi(lines[i]).trim();
    if (!t) continue;
    seen++;
    if (DIALOG_FOOTER.test(t) && t.length < 100) return true;
  }
  return false;
}

/**
 * Greedy word-wrap test: is `row` the wrapped remainder of `prevRow`? Ink moves
 * a word to the next row only when it does not fit, so if the row's first word
 * WOULD have fit after `prevRow` within `width`, the row cannot be a wrap.
 * The 2 columns below `width` are 'ambiguous' — the dialog's right padding is
 * not on screen — and callers treat ambiguous as "can't be sure".
 */
function wrapsInto(prevRow: string, row: string, width: number): 'yes' | 'no' | 'ambiguous' {
  if (!width) return 'ambiguous';
  const word = row.trim().split(/\s+/)[0] ?? '';
  const need = prevRow.replace(/\s+$/, '').length + 1 + word.length;
  if (need > width) return 'yes';
  if (need <= width - 2) return 'no';
  return 'ambiguous';
}

/**
 * The first line of the prompt's box, with rows Claude Code wrapped onto the
 * next line joined back ("New MCP server found in this" + "project: demo" on a
 * 40-column terminal). `width` 0 = unknown: no joining.
 */
function readHeading(lines: string[], top: number, firstOptionLine: number, width: number): string | undefined {
  let i = top;
  while (i < firstOptionLine && !stripAnsi(lines[i]).trim()) i++;
  if (i >= firstOptionLine) return undefined;
  let heading = stripAnsi(lines[i]).trim();
  let prevRow = stripAnsi(lines[i]);
  for (let j = i + 1; j < firstOptionLine && width; j++) {
    const row = stripAnsi(lines[j]);
    if (!row.trim() || /[.:?!]$/.test(heading)) break;
    if (wrapsInto(prevRow, row, width) === 'no') break;
    heading += ' ' + row.trim();
    prevRow = row;
  }
  return heading || undefined;
}

/**
 * Read a dialog whose options carry NO printed number (CC 2.1.281: folder
 * trust, bypass warning, single-server MCP approval — captured in
 * tests/fixtures/startup-dialogs/). Much stricter than the numbered walk,
 * because without digits almost any indented text could pass for an option:
 *
 *  • Claude Code's dialog FOOTER must sit under the options ("Enter to
 *    confirm · Esc to cancel") and its box RULE above them — proof it is a
 *    live dialog, not a quoted list in the conversation.
 *  • An option row starts at EXACTLY the cursor row's label column. ("Security
 *    guide" one column left of the options, and the footer, are not options.)
 *  • A label too long for the terminal wraps onto the next row at that same
 *    column, so every such row is tested with the greedy-wrap rule against the
 *    dialog's width (its rule's length). If any row is too close to call, the
 *    whole dialog is refused — a wrong split would put a button on screen that
 *    matches no real option.
 *  • Checkbox rows ("[✔] demo") are a multi-select dialog, which picks with
 *    Space plus a separate confirm row; never modelled as buttons.
 *
 * Anything short of certain returns null. The safety net
 * (readStartupDialog + usePromptDetector) then says "answer in terminal view".
 */
function parseUnnumbered(lines: string[], selectorIdx: number): ParsedMenu | null {
  const selectorLine = stripAnsi(lines[selectorIdx]);
  const m = /^(\s*)([❯>])(\s+)(\S.*)$/.exec(selectorLine);
  if (!m) return null;
  const labelCol = m[1].length + m[2].length + m[3].length;
  const colOf = (l: string) => indentOf(l);

  // Box rule above → the dialog's width, and the top of its body.
  let top = -1;
  let width = 0;
  for (let i = selectorIdx - 1; i >= Math.max(0, selectorIdx - PROMPT_SCAN_LINES); i--) {
    const t = stripAnsi(lines[i]).trim();
    if (PROMPT_BOUNDARY.test(t)) { top = i + 1; width = t.length; break; }
  }
  if (top < 0) return null;

  // Walk up to the first option row.
  let first = selectorIdx;
  for (let i = selectorIdx - 1; i >= top; i--) {
    const l = stripAnsi(lines[i]);
    if (!l.trim() || colOf(l) !== labelCol || /^\s*[❯>]/.test(l)) break;
    first = i;
  }

  const rows: { text: string; lastRow: string; cursor: boolean }[] = [];
  let last = selectorIdx;
  for (let i = first; i < lines.length; i++) {
    const raw = stripAnsi(lines[i]);
    if (!raw.trim()) { if (rows.length && i > selectorIdx) break; continue; }
    const isCursor = i === selectorIdx;
    if (!isCursor && (colOf(raw) !== labelCol || DIALOG_FOOTER.test(raw))) break;
    const text = isCursor ? m[4].trim() : raw.trim();
    const prev = rows[rows.length - 1];
    if (prev && !isCursor) {
      const wrap = wrapsInto(prev.lastRow, raw, width);
      if (wrap === 'ambiguous') return null;
      if (wrap === 'yes') { prev.text += ' ' + text; prev.lastRow = raw; last = i; continue; }
    }
    rows.push({ text, lastRow: raw, cursor: isCursor });
    last = i;
  }

  // The selected row's own label may have wrapped too — but a row that follows
  // the cursor row and would have fit is the next option, handled above; one
  // that wraps is merged above. Nothing more to do here.
  const options = rows.map((r) => r.text);
  const selectedIndex = rows.findIndex((r) => r.cursor);
  if (options.length < 2 || selectedIndex < 0) return null;
  if (options.some((o) => o.length > 200)) return null;
  if (options.some((o) => CHECKBOX_ROW.test(o))) return null;
  if (!hasFooterBelow(lines, last)) return null;

  const firstOptionLine = first;
  const title = extractTitle(lines, firstOptionLine, options, top, true);
  const description = extractDescription(lines, firstOptionLine, title, top);
  const promptLines = lines.slice(top, firstOptionLine).map((l) => stripAnsi(l).replace(/\s+$/, ''));
  const id = 'menu_' + options.map((o) => o.slice(0, 10)).join('_')
    .toLowerCase().replace(/[^a-z0-9_]/g, '');
  return {
    id,
    title,
    options,
    selectedIndex,
    description,
    optionNumbers: options.map(() => null),
    promptLines,
    heading: readHeading(lines, top, firstOptionLine, width),
    dialog: true,
    signature: signatureOf(options),
  };
}

/**
 * Is Claude Code showing a dialog right now — its footer at the bottom of the
 * screen — whatever its options look like? For the startup safety net: when a
 * new session is waiting on a dialog this parser cannot turn into buttons (a
 * multi-select, a layout nobody has seen yet), the app must say so at once
 * rather than sit on "Initializing session…". Returns the dialog's heading, or
 * null when no dialog footer is on screen.
 */
export function readStartupDialog(screenText: string): { heading: string } | null {
  const lines = stripAnsi(screenText).split('\n');
  let footer = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    const t = lines[i].trim();
    if (DIALOG_FOOTER.test(t) && t.length < 100) { footer = i; break; }
  }
  if (footer < 0) return null;
  let top = Math.max(0, footer - 40);
  let width = 0;
  for (let i = footer - 1; i >= Math.max(0, footer - 40); i--) {
    const t = lines[i].trim();
    if (PROMPT_BOUNDARY.test(t)) { top = i + 1; width = t.length; break; }
  }
  return { heading: readHeading(lines, top, footer, width) ?? '' };
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
  boxed = false,
): string {
  // Option-label overrides win: they don't depend on how far the prompt's body
  // text happens to sit above the menu (see OPTION_TITLE_OVERRIDES).
  for (const option of options) {
    const title = OPTION_TITLE_OVERRIDES[option.trim().toLowerCase()];
    if (title) return title;
  }
  const setTitle = OPTION_SET_TITLE_OVERRIDES[options.map((o) => o.trim().toLowerCase()).sort().join('|')];
  if (setTitle) return setTitle;

  // Never look above the prompt's own box, and never further than 10 lines —
  // unless the box's top rule was actually found (`boxed`): then everything
  // from it down IS the prompt's own text, and a long dialog on a narrow
  // terminal (the bypass warning at 50 columns) pushes its heading well past
  // 10 lines up.
  const searchStart = boxed ? bodyStart : Math.max(bodyStart, firstOptionLine - 10);
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
 * prompt, and (up to CC 2.1.2xx) the folder-trust prompt. It never sends `\r`,
 * so there is nothing for CC to collapse. `pty-worker.js` routes it down the
 * passthrough path.
 *
 * A menu with NO printed numbers (CC 2.1.281's trust, bypass and MCP dialogs —
 * where a typed digit does nothing at all, fixture `untrusted-digit-ignored`)
 * gets `pick` buttons instead: no fixed keystroke, but the option's index in
 * this exact option set, answered by state/ink-menu-driver.ts one verified
 * arrow at a time. The old fallback here — "DOWN × steps from the cursor seen
 * when the card appeared, then Enter" — was blind: if the cursor had moved
 * since (a click in terminal view, a redraw) it confirmed the WRONG option,
 * and on these dialogs the wrong option can mean trusting a folder.
 */
export function menuToButtons(menu: ParsedMenu): PromptButton[] {
  const signature = menu.signature ?? signatureOf(menu.options);
  return menu.options.map((label, index) => {
    const number = menu.optionNumbers?.[index] ?? null;
    if (number !== null && number >= 1 && number <= 9) {
      return { label, input: String(number) };
    }
    return { label, input: '', pick: { signature, index } };
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
 */
export function rebindButtons(menu: ParsedMenu | null, toolName: string): PromptButton[] | null {
  if (!menu) return null;
  if (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode') return null;
  const buttons = menuToButtons(menu);
  if (buttons.some((b) => b.submitInput !== undefined || b.pick !== undefined)) return null;
  return buttons;
}
