// Dev-only. A frozen Claude Code screen for the UI Workbench's terminal view.
//
// The workbench has no PTY, so the terminal used to render as an empty pane —
// the ui-review rig's `terminal-view-no-pty` shot was blank, which made the
// terminal's surface treatment impossible to judge (ledger P-20.1 / P-20.2).
// TerminalView writes this ONCE after its initial fit, so the rules and the
// prompt box wrap to the real column count. Only reached through a dynamic
// import behind `import.meta.env.DEV && isWorkbenchMode()`, so this module is
// never part of the production bundle.
//
// The block cursor is drawn as a reverse-video cell rather than left to xterm:
// TerminalView sets `cursorInactiveStyle: 'none'`, and a headless screenshot
// tab never has focus, so xterm's own cursor would be invisible in the shot.

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
// Claude Code's logo orange (the TUI uses a truecolor sequence for it).
const ORANGE = `${ESC}38;2;215;119;87m`;
const GREEN = `${ESC}32m`;
const CURSOR = `${ESC}7m ${RESET}`;

/** Builds the screen for a grid of `cols` × `rows`. Everything above the prompt
 *  box is content; blank lines are padded in so the prompt box and the status
 *  line land at the bottom like the real Ink TUI. Returns `rows` lines joined
 *  with CRLF and NO trailing newline, so nothing scrolls off. */
export function renderTerminalScreen(cols = 80, rows = 24): string {
  const width = Math.max(40, Math.min(cols, 200));
  const height = Math.max(20, rows);
  const rule = '─'.repeat(width - 2);
  const boxLine = (text: string) => {
    // Pad the visible text so the right border sits on the last column.
    // Strip ANSI sequences for the width calculation.
    const visible = text.replace(/\x1b\[[0-9;]*m/g, '').length;
    return `│${text}${' '.repeat(Math.max(0, width - 2 - visible))}│`;
  };

  const content = [
    `${ORANGE} ▐▛███▜▌${RESET}   ${BOLD}Claude Code v2.1.14${RESET}`,
    `${ORANGE}▝▜█████▛▘${RESET}  Opus 4.1 · Claude Max`,
    `${ORANGE}  ▘▘ ▝▝${RESET}    /home/destin/youcoded-dev/youcoded`,
    '',
    `${DIM}> can you check why the sidebar flickers on theme change?${RESET}`,
    '',
    `${GREEN}●${RESET} I'll look at the theme switch path first.`,
    '',
    `${GREEN}●${RESET} ${BOLD}Read${RESET}(src/renderer/state/theme-context.tsx)`,
    `  ${DIM}⎿  Read 212 lines${RESET}`,
    '',
    `${GREEN}●${RESET} ${BOLD}Search${RESET}(pattern: "data-theme", path: "src/renderer")`,
    `  ${DIM}⎿  Found 6 files${RESET}`,
    '',
    `${GREEN}●${RESET} The flicker is two writes to <html data-theme> in one frame:`,
    '  theme-engine sets it, then ThemeProvider sets it again after its own',
    '  state update. Batching them into one commit removes the extra paint.',
    '',
  ];

  // WHY (coverage batch B): the plan-approval card in the chat reads Claude Code's real plan menu off
  // this very screen (usePlanMenu), so a photo of the card with its buttons needs the menu drawn here.
  // `?planMenu=1` swaps the prompt box for the menu Claude Code 2.1.281 prints (tests/fixtures/plan-menu/).
  const planMenu = typeof location !== 'undefined' && new URLSearchParams(location.search).get('planMenu') === '1';
  const footer = planMenu ? [
    '─'.repeat(width),
    ' Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '',
    ` ${BOLD}❯ 1. Yes, clear context (5% used) and auto-accept edits${RESET}`,
    '   2. Yes, auto-accept edits',
    '   3. Yes, manually approve edits',
    '   4. Tell Claude what to change',
    `      ${DIM}shift+tab to approve with this feedback${RESET}`,
    '',
    ` ${DIM}ctrl+g to edit in Vim · ~/.claude/plans/fix-the-flicker.md${RESET}`,
  ] : [
    `╭${rule}╮`,
    boxLine(` › ${CURSOR}`),
    `╰${rule}╯`,
    `  ${DIM}? for shortcuts${RESET}`,
  ];

  // Pad so the footer sits on the bottom rows. If the grid is shorter than
  // the content (a very short pane), the top scrolls into scrollback, which is
  // what the real TUI does too.
  const padding = Math.max(0, height - content.length - footer.length);
  const lines = [...content, ...Array<string>(padding).fill(''), ...footer];
  return lines.join('\r\n');
}
