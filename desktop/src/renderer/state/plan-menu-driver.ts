// plan-menu-driver.ts — answer Claude Code's plan-approval menu by typing into
// the terminal, checking the screen before and after every keystroke.
//
// WHY keystrokes and not the hook answer: most of the menu's choices ("clear
// context", which permission mode to continue in, the typed feedback) do not
// exist in the PermissionRequest hook's allow/deny. Typing is the only way to
// pick them. What makes typing SAFE is the checking:
//
//   • A choice is picked by typing the digit Claude Code printed next to it —
//     a digit selects AND submits that row no matter where the cursor is
//     (measured on 2.1.281; same rule as ink-select-parser.menuToButtons).
//     Right before typing, the screen is re-read and the row must still carry
//     the SAME number and the SAME wording the button showed. Anything else and
//     nothing is typed.
//   • One exception to "digits pick rows": when the cursor sits on the feedback
//     row, that row is a live text box and a digit would be TYPED INTO IT. So
//     the cursor is first moved off it (one up-arrow, its own write) and the
//     screen must confirm the move before the digit goes.
//   • Feedback is typed only after the screen shows the cursor on the feedback
//     row with an EMPTY box, and Enter is sent only after the screen shows
//     exactly the typed text in that box. If either check fails, Enter is never
//     sent — the worst case is unsent text sitting in the terminal's box.
//   • Arrows and Enter never share a write (pty-io.md: Claude Code drops arrows
//     that arrive in the same write as an Enter and confirms the highlighted row).
//
// Success is "the menu has left the screen and stayed gone" — only then does the
// card release the hook socket (with NO decision, which Claude Code ignores; see
// PlanApprovalCard) and resolve itself.

import { parsePlanMenu, feedbackOption, type PlanMenu } from '../parser/plan-menu-parser';

export type PlanAnswer =
  | { kind: 'choice'; number: number; label: string }
  | { kind: 'feedback'; text: string }
  /** Esc — Claude Code's own cancel: the plan is rejected and Claude stops. */
  | { kind: 'reject' };

export type PlanAnswerFailure =
  /** The options on screen are no longer the ones the card showed. Nothing typed. */
  | 'menu-changed'
  /** The plan menu is gone (answered elsewhere, or never readable). Nothing typed. */
  | 'menu-gone'
  /** Something is already typed into the terminal's feedback box. Nothing typed. */
  | 'draft-in-terminal'
  /** Keys were typed but Claude Code did not react as expected in time. */
  | 'not-taken'
  /** Feedback text was typed but the box did not show it exactly; Enter NOT sent. */
  | 'text-mismatch';

export type PlanAnswerResult = { ok: true } | { ok: false; reason: PlanAnswerFailure; typed: boolean };

export interface PlanDriverIO {
  /** The session's current screen text (terminal-registry.getVisibleScreenText). */
  read(): string | null;
  /** One PTY write (window.claude.session.sendInput). */
  write(data: string): void;
  /** Resolve on the next terminal update or after `ms`, whichever is first. */
  settle(ms: number): Promise<void>;
  now(): number;
}

export const PLAN_TIMING = {
  /** How long a keystroke may take to show up on screen. */
  reactMs: 3000,
  /** How long the menu must stay off screen before it counts as answered —
   *  long enough that a clear-then-redraw (resize) is never mistaken for it. */
  goneForMs: 400,
  /** How long to wait for the menu to leave after the answering key. */
  leaveMs: 6000,
  /** Feedback is typed in chunks this size (below Claude Code's paste threshold). */
  chunk: 32,
  /** Longest feedback the card will type (see PlanApprovalCard's counter). */
  maxFeedback: 2000,
};

const UP = '\u001b[A';

/** Newlines/tabs/control characters → spaces; runs of spaces collapsed. The text
 *  box is one line, and verification compares what Claude Code echoes back. */
export function sanitizeFeedback(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Split feedback into writes of at most PLAN_TIMING.chunk UTF-16 units that
 *  never cut a character in half — an emoji or accented letter split across
 *  two PTY writes can arrive as two broken halves (review 2026-09-23). Splits
 *  on grapheme clusters where the runtime can, else on code points. */
export function feedbackChunks(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ segment: string }> } }).Segmenter;
  const units = Seg
    ? Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text), (x) => x.segment)
    : Array.from(text);
  const out: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length > PLAN_TIMING.chunk) { out.push(cur); cur = ''; }
    cur += u;
  }
  if (cur) out.push(cur);
  return out;
}

const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

function readMenu(io: PlanDriverIO): PlanMenu | 'absent' | 'unreadable' {
  const r = parsePlanMenu(io.read());
  return r.status === 'ready' ? r.menu : r.status;
}

async function waitFor(io: PlanDriverIO, ms: number, ok: (m: PlanMenu | 'absent' | 'unreadable') => boolean): Promise<boolean> {
  const end = io.now() + ms;
  for (;;) {
    if (ok(readMenu(io))) return true;
    if (io.now() >= end) return false;
    await io.settle(80);
  }
}

/** True once the menu has been absent continuously for PLAN_TIMING.goneForMs. */
async function waitGone(io: PlanDriverIO, ms: number, stillOurs: (m: PlanMenu) => boolean): Promise<boolean> {
  const end = io.now() + ms;
  let goneSince: number | null = null;
  for (;;) {
    const m = readMenu(io);
    const gone = m === 'absent' || (typeof m === 'object' && !stillOurs(m));
    if (gone) {
      goneSince ??= io.now();
      if (io.now() - goneSince >= PLAN_TIMING.goneForMs) return true;
    } else {
      goneSince = null;
    }
    if (io.now() >= end) return false;
    await io.settle(80);
  }
}

export async function answerPlanMenu(
  expectedSignature: string,
  answer: PlanAnswer,
  io: PlanDriverIO,
): Promise<PlanAnswerResult> {
  const fail = (reason: PlanAnswerFailure, typed: boolean): PlanAnswerResult => ({ ok: false, reason, typed });

  const start = readMenu(io);
  if (start === 'absent') return fail('menu-gone', false);
  if (start === 'unreadable' || start.signature !== expectedSignature) return fail('menu-changed', false);
  const sig = start.signature;
  const ours = (m: PlanMenu) => m.signature === sig;

  if (answer.kind === 'reject') {
    io.write('\u001b');
    return (await waitGone(io, PLAN_TIMING.leaveMs, ours)) ? { ok: true } : fail('not-taken', true);
  }

  const fb = feedbackOption(start);

  // Defence in depth for F3: only single-digit rows are ever typed (the parser
  // already refuses a menu with a row 10+).
  if (fb.number > 9 || (answer.kind === 'choice' && answer.number > 9)) return fail('menu-changed', false);

  if (answer.kind === 'choice') {
    const row = start.options.find((o) => o.number === answer.number);
    if (!row || row.kind !== 'choice' || row.label !== answer.label) return fail('menu-changed', false);
    if (start.selectedNumber === fb.number) {
      // Cursor is in the text box: a digit would be typed into it. Step off first.
      io.write(UP);
      const moved = await waitFor(io, PLAN_TIMING.reactMs, (m) => typeof m === 'object' && ours(m) && m.selectedNumber !== fb.number);
      if (!moved) return fail('not-taken', true);
    }
    // Re-check immediately before the digit: same menu, cursor not in the box.
    const now = readMenu(io);
    if (typeof now !== 'object' || !ours(now)) return fail('menu-changed', start.selectedNumber === fb.number);
    if (now.selectedNumber === fb.number) return fail('not-taken', true);
    io.write(String(answer.number));
    return (await waitGone(io, PLAN_TIMING.leaveMs, ours)) ? { ok: true } : fail('not-taken', true);
  }

  // Feedback.
  const text = sanitizeFeedback(answer.text).slice(0, PLAN_TIMING.maxFeedback);
  if (!text) return fail('menu-changed', false);
  if (start.feedbackDraft) return fail('draft-in-terminal', false);
  if (start.selectedNumber !== fb.number) {
    // The digit of the feedback row FOCUSES the box; with the box empty it
    // cannot submit anything (Claude Code ignores an empty "keep planning").
    io.write(String(fb.number));
    const focused = await waitFor(io, PLAN_TIMING.reactMs, (m) => typeof m === 'object' && ours(m) && m.selectedNumber === fb.number);
    if (!focused) return fail('not-taken', true);
  }
  const box = readMenu(io);
  if (typeof box !== 'object' || !ours(box) || box.selectedNumber !== fb.number) return fail('menu-changed', true);
  if (box.feedbackDraft) return fail('draft-in-terminal', true);

  const chunks = feedbackChunks(text);
  for (let i = 0; i < chunks.length; i++) {
    io.write(chunks[i]);
    if (i + 1 < chunks.length) await io.settle(15);
  }
  const echoed = await waitFor(io, PLAN_TIMING.reactMs + text.length * 2, (m) =>
    typeof m === 'object' && ours(m) && m.selectedNumber === fb.number && same(m.feedbackDraft, text));
  if (!echoed) return fail('text-mismatch', true);

  // Final check, then Enter as its OWN write.
  const last = readMenu(io);
  if (typeof last !== 'object' || !ours(last) || last.selectedNumber !== fb.number || !same(last.feedbackDraft, text)) {
    return fail('text-mismatch', true);
  }
  io.write('\r');
  // Gone = the menu left, or our text left the box (Claude Code took it and a
  // replanned menu may already be drawing).
  const took = await waitGone(io, PLAN_TIMING.leaveMs, (m) => ours(m) && same(m.feedbackDraft, text));
  return took ? { ok: true } : fail('not-taken', true);
}
