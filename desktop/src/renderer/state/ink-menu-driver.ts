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

export type InkMenuIO = PlanDriverIO;

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

function readMenu(io: InkMenuIO, signature: string): ParsedMenu | 'absent' | 'other' {
  const screen = io.read();
  const menu = screen ? parseInkSelect(screen) : null;
  if (!menu) return 'absent';
  return menu.signature === signature ? menu : 'other';
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
 */
export async function answerInkMenu(
  pick: { signature: string; index: number; label: string },
  io: InkMenuIO,
): Promise<InkMenuResult> {
  const fail = (reason: InkMenuFailure, typed: boolean): InkMenuResult => ({ ok: false, reason, typed });

  const start = readMenu(io, pick.signature);
  if (start === 'absent') return fail('menu-gone', false);
  if (start === 'other') return fail('menu-changed', false);
  if (start.options[pick.index] !== pick.label) return fail('menu-changed', false);

  let typed = false;
  // At most one full lap: the cursor can never need more steps than rows.
  for (let step = 0; step <= start.options.length; step++) {
    const now = readMenu(io, pick.signature);
    if (typeof now !== 'object') return fail(now === 'absent' ? 'menu-gone' : 'menu-changed', typed);
    if (now.selectedIndex === pick.index) break;
    if (step === start.options.length) return fail('not-taken', typed);
    const from = now.selectedIndex;
    const expected = pick.index > from ? from + 1 : from - 1;
    io.write(pick.index > from ? DOWN : UP);
    typed = true;
    const moved = await waitFor(io, INK_MENU_TIMING.reactMs, () => {
      const m = readMenu(io, pick.signature);
      return typeof m === 'object' && m.selectedIndex === expected;
    });
    if (!moved) return fail('not-taken', true);
  }

  // The loop only breaks on a read (just now, nothing awaited since) showing
  // this exact option set with the cursor on the target — and the label at the
  // target was checked against the button before the first key. So Enter goes
  // only where the button's label is.
  io.write('\r');

  // Gone = this option set has been off screen continuously for goneForMs.
  const end = io.now() + INK_MENU_TIMING.leaveMs;
  let goneSince: number | null = null;
  for (;;) {
    const m = readMenu(io, pick.signature);
    if (typeof m !== 'object') {
      goneSince ??= io.now();
      if (io.now() - goneSince >= INK_MENU_TIMING.goneForMs) return { ok: true };
    } else {
      goneSince = null;
    }
    if (io.now() >= end) return fail('not-taken', true);
    await io.settle(80);
  }
}
