// ink-menu-driver.ts — answer a Claude Code menu whose options carry NO printed
// number, by moving its cursor and checking the screen after every keystroke.
//
// WHY: Claude Code 2.1.281 draws its startup dialogs (folder trust, the
// bypass-permissions warning, MCP-server approval) without "1." / "2." — and a
// typed digit does nothing on them (fixture `untrusted-digit-ignored`). The
// only way to pick an option is to move the ❯ cursor and press Enter, and on
// these dialogs a wrong Enter can trust a folder or switch off every approval.
// So nothing here is typed blind:
//
//   • Before the first key, the screen must show the SAME option set the card
//     showed (its signature). Anything else — nothing is typed.
//   • The cursor moves ONE arrow per write, toward the target, and each move
//     must show up on screen (same menu, cursor on the next row) before the
//     next key. The menus wrap, so the direction is chosen from where the
//     cursor really is, never assumed.
//   • Enter is sent as its OWN write (pty-io.md: Claude Code drops arrows that
//     share a write with Enter and confirms the highlighted row), and only once
//     the screen shows the cursor on exactly the target label.
//   • Success = that menu has left the screen and stayed gone.
//
// Same IO contract and checking discipline as plan-menu-driver.ts, which
// answers the plan-approval menu the same way.

import { parseInkSelect, type ParsedMenu } from '../parser/ink-select-parser';
import type { PlanDriverIO } from './plan-menu-driver';

export type InkMenuIO = PlanDriverIO & {
  /** How many times the terminal has been written to (optional). Lets the
   *  driver tell "Claude Code redrew after our Enter" from "nothing happened". */
  outputCount?(): number;
};

type InkMenuFailure =
  /** The options on screen are not the ones the card showed. Nothing typed. */
  | 'menu-changed'
  /** The menu is no longer on screen. Nothing typed. */
  | 'menu-gone'
  /** A key was typed but Claude Code did not react as expected; Enter NOT sent
   *  (or, if it was, the menu did not leave). */
  | 'not-taken';

export type InkMenuResult = { ok: true } | { ok: false; reason: InkMenuFailure; typed: boolean };

export const INK_MENU_TIMING = {
  /** How long one arrow may take to show on screen. */
  reactMs: 3000,
  /** How long the menu must stay off screen to count as answered. */
  goneForMs: 400,
  /** How long to wait for the menu to leave after Enter. */
  leaveMs: 6000,
};

const DOWN = '\u001b[B';
const UP = '\u001b[A';

function readMenu(io: InkMenuIO): ParsedMenu | null {
  const screen = io.read();
  return screen ? parseInkSelect(screen) : null;
}

/** The words of the question itself (heading + body), which tell apart two
 *  dialogs that happen to offer the same options (review F5, 2026-09-24). */
function questionOf(m: ParsedMenu): string {
  return `${m.heading ?? ''}\u241f${m.description ?? ''}`;
}

async function waitFor(io: InkMenuIO, ms: number, ok: () => boolean): Promise<boolean> {
  const end = io.now() + ms;
  for (;;) {
    if (ok()) return true;
    if (io.now() >= end) return false;
    await io.settle(80);
  }
}

/**
 * Pick option `index` of the menu whose option set is `signature`, confirming
 * on screen that its label is `label`.
 *
 * Every check below is its own line on purpose — each is pinned by a test that
 * fails without it (tests/startup-dialogs.test.ts, "the startup-dialog driver
 * never guesses"; review F3, 2026-09-24).
 */
export async function answerInkMenu(
  pick: { signature: string; index: number; label: string },
  io: InkMenuIO,
): Promise<InkMenuResult> {
  const fail = (reason: InkMenuFailure, typed: boolean): InkMenuResult => ({ ok: false, reason, typed });

  const start = readMenu(io);
  if (!start) return fail('menu-gone', false);
  if (start.signature !== pick.signature) return fail('menu-changed', false);
  if (start.options[pick.index] !== pick.label) return fail('menu-changed', false);
  // THIS dialog: the same options AND the same question. A dialog that follows
  // with the same options but different words is a different dialog.
  const question = questionOf(start);
  const ours = (m: ParsedMenu | null): m is ParsedMenu =>
    !!m && m.signature === pick.signature && questionOf(m) === question;

  let typed = false;
  // At most one full lap: the cursor can never need more steps than rows.
  for (let step = 0; step <= start.options.length; step++) {
    const now = readMenu(io);
    // Option-set check at the top of every step: the screen may have changed
    // since the last confirmed move.
    if (!now) return fail('menu-gone', typed);
    if (!ours(now)) return fail('menu-changed', typed);
    if (now.selectedIndex === pick.index) break;
    if (step === start.options.length) return fail('not-taken', typed);
    const from = now.selectedIndex;
    // Exactly ONE row toward the target — a cursor that lands anywhere else
    // (a jump, a redraw that reset it) is not the move we made.
    const expected = pick.index > from ? from + 1 : from - 1;
    io.write(pick.index > from ? DOWN : UP);
    typed = true;
    const moved = await waitFor(io, INK_MENU_TIMING.reactMs, () => {
      const m = readMenu(io);
      // Option-set check inside the wait: a different menu whose cursor
      // happens to sit on the expected row is not a confirmed move.
      if (!ours(m)) return false;
      return m.selectedIndex === expected;
    });
    if (!moved) return fail('not-taken', true);
  }

  // The loop only breaks on a read (just now, nothing awaited since) showing
  // this exact dialog with the cursor on the target — and the label at the
  // target was checked against the button before the first key. So Enter goes
  // only where the button's label is.
  const outputBefore = io.outputCount?.() ?? 0;
  io.write('\r');

  // Answered = THIS dialog has been off screen continuously for goneForMs
  // (a following, different dialog counts as "off screen"). One exception:
  // Claude Code redrew the screen after our Enter and an IDENTICAL dialog is
  // there — Ink always acts on an Enter that arrives, so that is the next
  // dialog, not ours ignoring the key (review F5). The detector then gives the
  // new one a fresh card rather than reusing this one.
  const end = io.now() + INK_MENU_TIMING.leaveMs;
  let goneSince: number | null = null;
  for (;;) {
    const m = readMenu(io);
    if (!ours(m)) {
      goneSince ??= io.now();
      if (io.now() - goneSince >= INK_MENU_TIMING.goneForMs) return { ok: true };
    } else {
      goneSince = null;
      if (io.outputCount && io.outputCount() > outputBefore && m.selectedIndex !== pick.index) return { ok: true };
    }
    if (io.now() >= end) return fail('not-taken', true);
    await io.settle(80);
  }
}
