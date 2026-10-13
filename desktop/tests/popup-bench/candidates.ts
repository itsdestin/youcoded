// Candidate "is a Claude Code pop-up holding the keyboard?" detectors, scored
// against real captures by tests/popup-detector-bench.test.ts.
//
// WHY several: we want the one that catches every pop-up — known or not — and
// never fires on an ordinary screen (a reply that QUOTES a menu, a numbered
// list streaming in, a tool running). Each reads exactly what the app's
// detector reads: terminal-registry.getVisibleScreenText (rows joined, blank
// rows dropped).
import { parseInkSelect, readStartupDialog } from '../../src/shared/ink-select-parser';
import { readInputFocus, inputIsBlocked } from '../../src/shared/cc-input-focus';

export type Candidate = { name: string; describe: string; blocked: (screen: string) => boolean };

// The app's list of pop-ups it knows by title (usePromptDetector SETUP_PROMPT_TITLES).
const KNOWN_TITLES = new Set([
  'Trust This Folder?', 'Choose a Theme', 'Select Login Method', 'Skip Permissions Warning', 'Resume Session',
  'Usage Limit Reached', 'Enable auto mode?', 'Message Flagged', 'Allow External Imports?', 'New MCP Server Found',
]);

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const RULE = /^[─━═]{20,}$/;
/** The first row of Claude Code's message box: the prompt mark, or the bash-mode "!". */
const INPUT_ROW = /^(❯|!|>)(\s|$)/;
/** Footer hints Claude Code puts under a pop-up. Deliberately broad. */
const HINT = /\b(esc|enter|tab|space|ctrl\+\w|↑|↓)\b.{0,20}\bto\s+\w+/i;

function rows(screen: string): string[] {
  return screen.replace(ANSI, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
}

/**
 * Is Claude Code's ordinary message box on screen, near the bottom?
 * Shape: a rule, an input row ("❯ …", possibly followed by more typed lines),
 * a rule; then at most a handful of status rows (mode line, hints, the
 * slash-command suggestion list).
 */
export function hasMessageBox(screen: string, { maxBelow = 14, maxInput = 30 } = {}): boolean {
  const r = rows(screen);
  const n = r.length;
  // The closing rule of the box must be within maxBelow rows of the bottom.
  for (let j = n - 1; j >= Math.max(0, n - 1 - maxBelow); j--) {
    if (!RULE.test(r[j].trim())) continue;
    // Walk up to the opening rule; the row just under it must be the input row.
    for (let i = j - 1; i >= Math.max(0, j - maxInput); i--) {
      if (RULE.test(r[i].trim())) {
        if (i + 1 < j && INPUT_ROW.test(r[i + 1].trimStart())) return true;
        break;
      }
    }
  }
  return false;
}

/** A full-width rule drawn at column 0 — Claude Code's own box edges. Rules
 *  inside replies and inside pop-ups are indented, so they never match. */
const EDGE = /^[─━]{20,}\s*$/;

/**
 * v2: the box is the LAST column-0 rule on screen, with the rule above it and
 * the column-0 input row ("❯ …" / "! …") directly under that one. Nothing is
 * assumed about what is below it — the slash-command and @-file suggestion
 * lists hang 20+ rows under the box. A pop-up replaces the box with its own
 * single column-0 rule, and the row under THAT is the pop-up's indented body.
 */
export function hasMessageBoxV2(screen: string): boolean {
  const r = rows(screen);
  let last = -1;
  for (let i = r.length - 1; i >= 0; i--) if (EDGE.test(r[i])) { last = i; break; }
  if (last < 0) return false;
  for (let i = last - 1; i >= Math.max(0, last - 40); i--) {
    if (EDGE.test(r[i])) return i + 1 < last && /^(❯|!)(\s|$)/.test(r[i + 1]);
  }
  return false;
}

/** Modes that keep a box on screen but take the keyboard away from the
 *  message: history search (ctrl+r), and the agents view (←), whose box
 *  starts a NEW background session. Read from the rows under the box. */
const BOX_TAKEN = /^\s*search prompts:|enter to return · space to reply|describe a task for a new session/m;

function footerNearBottom(screen: string, within = 6): boolean {
  const r = rows(screen);
  return r.slice(-within).some((l) => HINT.test(l) && l.trim().length < 120);
}

export const CANDIDATES: Candidate[] = [
  {
    name: 'shipped',
    describe: 'What the app ships: src/shared/cc-input-focus.ts',
    blocked: (s) => inputIsBlocked(readInputFocus(s)),
  },
  {
    name: 'today',
    describe: 'What ships now: a numbered/cursor menu whose title is on the known list',
    blocked: (s) => { const m = parseInkSelect(s); return !!m && KNOWN_TITLES.has(m.title); },
  },
  {
    name: 'footer',
    describe: 'Claude Code\'s pop-up footer ("Esc to cancel"…) near the bottom (the startup safety net, used everywhere)',
    blocked: (s) => readStartupDialog(s) !== null,
  },
  {
    name: 'menu+footer',
    describe: 'A menu the parser reads, with the pop-up footer under it (startup rule for unknown dialogs)',
    blocked: (s) => !!parseInkSelect(s)?.dialog,
  },
  {
    name: 'no-box',
    describe: 'The ordinary message box is missing from the bottom of the screen',
    blocked: (s) => !hasMessageBox(s),
  },
  {
    name: 'no-box+hint',
    describe: 'Message box missing AND a keyboard hint ("Esc to…", "Enter to…") near the bottom',
    blocked: (s) => !hasMessageBox(s) && footerNearBottom(s),
  },
  {
    name: 'no-box-v2',
    describe: 'Message box missing (v2: last column-0 rule must close a box; suggestion lists allowed below)',
    blocked: (s) => !hasMessageBoxV2(s),
  },
  {
    name: 'no-box-v2+search',
    describe: 'v2, plus the two modes that keep a box but take the keyboard (ctrl+r search, ← agents view)',
    blocked: (s) => !hasMessageBoxV2(s) || BOX_TAKEN.test(rows(s).slice(-8).join('\n')),
  },
  {
    name: 'footer+no-box',
    describe: 'Known footer wording AND the message box missing',
    blocked: (s) => readStartupDialog(s) !== null && !hasMessageBox(s),
  },
];
