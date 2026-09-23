// plan-menu-parser.ts — read Claude Code's REAL plan-approval menu off the screen.
//
// WHY this exists (2026-09-23): the plan card used to draw four FIXED buttons
// and send "down-arrow × index, then Enter". Claude Code's real menu varies plan
// to plan — a "Yes, clear context …" row appears first when that setting is on,
// an Ultraplan row can appear, the keep-context row's wording changes with the
// session's modes, and "Tell Claude what to change" is a TEXT INPUT row, not a
// button. So "No, refine plan" could land on "Yes, manually approve edits" and
// APPROVE the plan. The card now builds its buttons from this parse, using
// Claude Code's own wording, and each button types the NUMBER printed next to
// its own row — so a click can only ever pick the row it is labelled with.
//
// Measured on Claude Code 2.1.281 (fixtures: tests/fixtures/plan-menu/, captured
// by test-conpty/capture-plan-menu.mjs). The screen text is what
// terminal-registry.getScreenText produces: xterm rows, wrapped rows joined,
// trailing spaces trimmed, EMPTY ROWS DROPPED. A real frame looks like:
//
//    Claude has written up a plan and is ready to execute. Would you like to proceed?
//    ❯ 1. Yes, clear context (5% used) and auto-accept edits
//      2. Yes, auto-accept edits
//      3. Yes, manually approve edits
//      4. Tell Claude what to change
//         shift+tab to approve with this feedback
//    ctrl+g to edit in nano · ~/.claude/plans/….md
//
// On a narrow terminal Claude Code itself wraps a long row onto extra lines
// indented to the label column — those are joined back with one space.
//
// FAIL-SAFE CONTRACT: anything this parser is not sure of comes back as
// 'unreadable', never as a best guess. The card then says so and points at the
// terminal view; it never falls back to fixed buttons or positions.

const ANSI = /\u001b\[[0-9;?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b./g;

/** The closing question of the plan dialog — the anchor the option block hangs off. */
const PLAN_MENU_QUESTION = 'would you like to proceed?';
/** Placeholder Claude Code shows in the feedback row while it is empty. */
export const PLAN_FEEDBACK_PLACEHOLDER = 'Tell Claude what to change';
/** Dim hint Claude Code prints under the feedback row (absent when approvals are withheld). */
const PLAN_FEEDBACK_HINT = 'shift+tab to approve with this feedback';
/** Body line of the EMPTY-plan variant ("Exit plan mode?" Yes/No). Recognised
 *  only so the card can say "answer in the terminal" instead of "no menu". */
const EMPTY_PLAN_BODY = 'claude wants to exit plan mode';

export interface PlanMenuOption {
  /** The digit Claude Code printed in front of the row. Typing it picks this row. */
  number: number;
  /** Claude Code's own wording, wrapped lines joined. For the feedback row this is
   *  the placeholder (or whatever is typed into it in the terminal). */
  label: string;
  /** 'feedback' = the free-text row; picking it focuses a text box, it never submits. */
  kind: 'choice' | 'feedback';
}

export interface PlanMenu {
  options: PlanMenuOption[];
  /** Number of the row the terminal cursor (❯) is on. */
  selectedNumber: number;
  /** Text already typed into the feedback row in the terminal ('' when the placeholder shows). */
  feedbackDraft: string;
  /** Identity of the option set (numbers + kinds + labels, not the cursor) — what
   *  a click re-checks right before it types anything. */
  signature: string;
}

export type PlanMenuRead =
  | { status: 'ready'; menu: PlanMenu }
  /** No plan question on screen at all. */
  | { status: 'absent' }
  /** The plan question is on screen but the options could not be read with
   *  certainty (mid-redraw, an unfamiliar layout, a new Claude Code version). */
  | { status: 'unreadable'; reason: string };

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// "   ❯ 1. Yes, auto-accept edits" / "     2. Yes, manually approve edits".
// Windows ConPTY renders the cursor as ">" (see ink-select-parser.ts).
const OPTION_LINE = /^(\s*)([❯>])?(\s*)(\d{1,2})\.\s(.*)$/;

interface RawOption {
  number: number;
  selected: boolean;
  labelCol: number;
  parts: string[];
}

export function parsePlanMenu(screenText: string | null | undefined): PlanMenuRead {
  if (!screenText) return { status: 'absent' };
  const lines = screenText.replace(ANSI, '').replace(/\r/g, '').split('\n');

  // 1. Find the LAST occurrence of the closing question. It wraps on narrow
  //    terminals ("… Would you" / "like to proceed?"), so test a short window of
  //    lines joined, anchored on a line that ends the sentence.
  let questionEnd = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/proceed\?\s*$/i.test(lines[i])) continue;
    const window = norm(lines.slice(Math.max(0, i - 3), i + 1).join(' '));
    if (window.endsWith(PLAN_MENU_QUESTION)) { questionEnd = i; break; }
  }
  if (questionEnd < 0) {
    // The empty-plan variant ("Exit plan mode?" / "Claude wants to exit plan
    // mode" / Yes / No) is a real plan prompt with no reliable anchor for its
    // options — say "unreadable" so the card points at the terminal rather than
    // pretending nothing is being asked.
    const tail = norm(lines.slice(-30).join(' '));
    if (tail.includes(EMPTY_PLAN_BODY)) return { status: 'unreadable', reason: 'empty-plan-variant' };
    return { status: 'absent' };
  }

  // 2. Walk the option block directly under the question: numbered rows, plus
  //    continuation rows indented exactly to the current row's label column.
  const raw: RawOption[] = [];
  for (let i = questionEnd + 1; i < lines.length; i++) {
    const line = lines[i];
    const m = OPTION_LINE.exec(line);
    if (m) {
      const labelCol = line.length - m[5].length;
      raw.push({ number: Number(m[4]), selected: !!m[2], labelCol, parts: [m[5].trim()] });
      continue;
    }
    const cur = raw[raw.length - 1];
    if (cur) {
      const indent = (/^(\s*)/.exec(line) ?? ['', ''])[1].length;
      if (indent === cur.labelCol && line.trim()) {
        cur.parts.push(line.trim());
        continue;
      }
    }
    break; // first line that is neither a row nor its continuation ends the block
  }

  if (raw.length === 0) return { status: 'unreadable', reason: 'no-options' };

  // 3. Every certainty check. Any failure = unreadable, never a guess.
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].number !== k + 1) return { status: 'unreadable', reason: 'numbering' };
  }
  const selected = raw.filter((r) => r.selected);
  if (selected.length !== 1) return { status: 'unreadable', reason: 'cursor' };

  const hint = norm(PLAN_FEEDBACK_HINT);
  const placeholder = norm(PLAN_FEEDBACK_PLACEHOLDER);
  const options: PlanMenuOption[] = [];
  let feedbackDraft = '';
  let feedbackRows = 0;
  for (const r of raw) {
    const text = r.parts.join(' ').replace(/\s+/g, ' ').trim();
    const t = text.toLowerCase();
    if (!text || text.length > 400) return { status: 'unreadable', reason: 'label' };
    if (t.endsWith(hint)) {
      // The feedback row: its text is the placeholder, or what is typed into it.
      feedbackRows++;
      const body = text.slice(0, text.length - PLAN_FEEDBACK_HINT.length).trim();
      if (!body) return { status: 'unreadable', reason: 'label' };
      const isPlaceholder = norm(body) === placeholder;
      feedbackDraft = isPlaceholder ? '' : body;
      options.push({ number: r.number, label: isPlaceholder ? PLAN_FEEDBACK_PLACEHOLDER : body, kind: 'feedback' });
    } else if (norm(text) === placeholder) {
      // Approvals-withheld variant: the feedback row with no hint under it.
      feedbackRows++;
      options.push({ number: r.number, label: PLAN_FEEDBACK_PLACEHOLDER, kind: 'feedback' });
    } else {
      options.push({ number: r.number, label: text, kind: 'choice' });
    }
  }

  // Claude Code always draws the feedback row LAST. Requiring it is what makes a
  // half-drawn frame (rows 1–2 painted, the rest not yet) unreadable instead of
  // a short menu with rows missing.
  if (feedbackRows !== 1 || options[options.length - 1].kind !== 'feedback') {
    return { status: 'unreadable', reason: 'feedback-row' };
  }

  const signature = options.map((o) => `${o.number}:${o.kind}:${o.kind === 'feedback' ? '' : o.label}`).join('|');
  return {
    status: 'ready',
    menu: { options, selectedNumber: selected[0].number, feedbackDraft, signature },
  };
}

/** The feedback row of a ready menu (there is always exactly one). */
export function feedbackOption(menu: PlanMenu): PlanMenuOption {
  return menu.options.find((o) => o.kind === 'feedback')!;
}
