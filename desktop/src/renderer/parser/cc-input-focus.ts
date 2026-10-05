// cc-input-focus.ts — where does a keystroke typed into Claude Code go right
// now: into its ordinary message box, or into something else?
//
// WHY: the app types chat messages (and a lost-message Enter) into the PTY. If
// a Claude Code pop-up has the keyboard, the message is swallowed — or its
// Enter answers the pop-up. The hook system reports ordinary permission asks,
// but Claude Code has ~90 dialogs and keeps adding more (the auto-mode setup
// offer, a classifier-billing notice that opened mid-reply, …) that no hook
// reports. Recognising them by title needs a code change for every new one;
// this reads the SHAPE instead: every pop-up replaces the message box, and a
// reply that merely quotes a menu leaves the box in place.
//
// Measured, not guessed: tests/popup-detector-bench.test.ts replays 104 real
// captures (classic and fullscreen renderer, YouCoded's status line, the
// stand-in API and real Sonnet turns) and requires this to call every moment
// correctly. test-conpty/check-popup-drift.mjs repeats that against each new
// Claude Code release (.github/workflows/cc-popup-drift.yml).

export type InputFocus =
  /** Claude Code's ordinary message box — a send lands there. */
  | { kind: 'message-box' }
  /** A pop-up, dialog or full-screen view holds the keyboard (the box is gone). */
  | { kind: 'popup'; heading: string }
  /** The box is drawn but the keyboard belongs to another mode: history
   *  search (ctrl+r), or the agents view (←), whose box starts a NEW session. */
  | { kind: 'other-view'; view: 'history-search' | 'agents' }
  /** Nothing readable (no terminal yet, blank screen) — no verdict. */
  | { kind: 'unknown' };

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** A full-width rule drawn at column 0 — the edges of Claude Code's message
 *  box, and the top edge of a classic-renderer pop-up. Rules inside replies,
 *  code blocks and pop-up bodies are indented, so they never match. */
// 10, not more: a phone-width terminal draws a short box (review F11).
const EDGE = /^[─━]{10,}\s*$/;

/** The first row inside the message box: the prompt mark, or bash mode's "!". */
const INPUT_ROW = /^(❯|!)(\s|$)/;

// Modes that keep a box on screen but take the keyboard away from the
// message. Wording, unavoidably — the box looks identical — so the drift check
// captures both every day and fails if this stops matching.
const HISTORY_SEARCH = /^\s*search prompts:/m;
const AGENTS_VIEW = /enter to return · space to reply|describe a task for a new session/;

/** A pop-up's own footer hints, for its heading (display only). */
const FOOTER = /\b(esc|enter|tab|space)\b.{0,24}\bto\s+\w+/i;

function rowsOf(screen: string): string[] {
  return screen.replace(ANSI, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
}

/**
 * Is the LAST column-0 rule on screen the bottom edge of the message box?
 * That is: the nearest column-0 rule above it has the input row directly under
 * it. Nothing is assumed about the rows BELOW the box — the slash-command and
 * @-file suggestion lists hang 20+ rows there, and status lines sit there.
 * A classic pop-up draws ONE column-0 rule with its indented body under it; a
 * fullscreen pop-up draws a ▔ edge and no rule at all.
 */
function boxAt(rows: string[]): number {
  let last = -1;
  for (let i = rows.length - 1; i >= 0; i--) if (EDGE.test(rows[i])) { last = i; break; }
  if (last < 0) return -1;
  // A tall multi-line draft sits between the rules — look well up (F11).
  for (let i = last - 1; i >= Math.max(0, last - 200); i--) {
    if (EDGE.test(rows[i])) return i + 1 < last && INPUT_ROW.test(rows[i + 1]) ? last : -1;
  }
  return -1;
}

/** The pop-up's first line of text: the row under its top edge, if any. */
function headingOf(rows: string[]): string {
  let top = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (EDGE.test(rows[i]) || /^▔{20,}\s*$/.test(rows[i])) { top = i; break; }
  }
  const row = top >= 0 ? rows[top + 1] : undefined;
  const text = (row ?? '').trim();
  return text && !FOOTER.test(text) && text.length <= 100 ? text : '';
}

export function readInputFocus(screen: string | null | undefined): InputFocus {
  if (!screen) return { kind: 'unknown' };
  const rows = rowsOf(screen);
  if (!rows.length) return { kind: 'unknown' };
  const box = boxAt(rows);
  if (box < 0) return { kind: 'popup', heading: headingOf(rows) };
  // Only the rows under the box (status line) and the box itself say which
  // mode owns it; history above could quote these phrases.
  const tail = rows.slice(Math.max(0, box - 2), box + 8).join('\n');
  if (HISTORY_SEARCH.test(tail)) return { kind: 'other-view', view: 'history-search' };
  if (AGENTS_VIEW.test(tail)) return { kind: 'other-view', view: 'agents' };
  return { kind: 'message-box' };
}

/** True when a keystroke typed now would NOT reach the message box. */
export function inputIsBlocked(focus: InputFocus): boolean {
  return focus.kind === 'popup' || focus.kind === 'other-view';
}

/**
 * True when the screen is "no picture yet" rather than a pop-up: nothing drawn, or a few stray rows and NOT ONE
 * edge rule. WHY (2026-10-05): a re-mounted terminal is empty (or shows one status row) until the program repaints, and
 * readInputFocus reads "no message box" as a pop-up. Every real Claude Code pop-up draws an edge (a column-0 rule in
 * the classic renderer, a ▔ edge in fullscreen) and has a body and footer, so requiring "no edge AND at most 3 rows"
 * keeps every genuine pop-up blocked. Callers must treat this as UNKNOWN, never as permission to type blindly
 * forever: they ask for a repaint and chat-state pending-interaction checks still guard real prompts.
 */
export function screenIsUnpainted(screen: string | null | undefined): boolean {
  if (!screen) return true;
  const rows = rowsOf(screen);
  if (rows.length === 0) return true;
  if (rows.length > 3) return false;
  // ANY row with 10+ box-drawing characters counts as a drawn edge (rounded corners, double rules and titled rules
  // do not match EDGE, but they are still a frame being drawn): conservative, so such a screen is never "unpainted".
  return !rows.some((r) => EDGE.test(r) || /^▔{20,}\s*$/.test(r) || (r.match(/[\u2500-\u257F\u2594\u2581]/g)?.length ?? 0) >= 10);
}
