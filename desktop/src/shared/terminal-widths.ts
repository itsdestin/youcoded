// terminal-widths.ts — teach an xterm terminal to count joined emoji the way Claude Code draws them.
//
// WHY (Destin, 2026-10-22: a family emoji garbled the terminal, then the app said "Claude Code is waiting on something"
// and held his messages): Claude Code lays its screen out counting each emoji CLUSTER as one 2-column character. xterm's
// Unicode 11 widths count the parts: 👨‍👩‍👧 is 6 columns, 👍🏽 is 4, ❤️ and 1️⃣ are 1. Every redraw after such a character
// then lands a few columns off and leaves junk behind — in the visible terminal AND in the computer's hidden copy that
// session-screens.ts reads to find the message box. With the box outline broken, the app (and the queue) believed a
// question was open. Measured against CLI 2.1.309: test-conpty/probe-terminal-widths.mjs + check-terminal-widths.mjs.
//
// The rules, on top of Unicode 11 (which already handles CJK, accents, flags and Persian/Hindi joiners correctly):
//   - a zero-width joiner after an emoji joins the NEXT emoji into the same 2-column cluster;
//   - VS16 (U+FE0F) after an emoji or a keycap base (0-9 # *) makes the cluster 2 columns;
//   - a skin-tone modifier after an emoji is part of it (no extra columns).
// A joiner between letters (Persian, Hindi) is untouched: only clusters that START with an emoji are changed.
import type { Terminal as XTerm } from '@xterm/xterm';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';

type Provider = { readonly version: string; wcwidth(codepoint: number): 0 | 1 | 2; charProperties(codepoint: number, preceding: number): number };

// xterm's packed character properties (UnicodeService): kind/state << 3 | width << 1 | shouldJoin.
const pack = (state: number, width: number, join: boolean) => ((state & 0xffffff) << 3) | ((width & 3) << 1) | (join ? 1 : 0);
const widthOf = (value: number) => (value >> 1) & 3;
const stateOf = (value: number) => value >> 3;

const EMOJI = 1;       // the cluster started with an emoji
const KEYCAP_BASE = 2; // the cluster started with 0-9, # or * (a keycap when VS16/U+20E3 follow)
const AFTER_ZWJ = 4;   // the cluster's last character was a zero-width joiner

const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// WHY a lookup table: this runs for every character the terminal draws, and Claude Code's screen is full of box-drawing
// lines (U+2500…). Nothing below U+00A9 is pictographic; each other code point is tested once, then remembered.
const BMP_SEEN = new Uint8Array(0x10000); // 0 = not yet tested, 1 = no, 2 = yes
const ASTRAL_SEEN = new Map<number, boolean>();
function isEmoji(cp: number): boolean {
  if (cp < 0xa9) return false;
  if (cp < 0x10000) {
    let seen = BMP_SEEN[cp];
    if (seen === 0) { seen = PICTOGRAPHIC.test(String.fromCharCode(cp)) ? 2 : 1; BMP_SEEN[cp] = seen; }
    return seen === 2;
  }
  let yes = ASTRAL_SEEN.get(cp);
  if (yes === undefined) { yes = PICTOGRAPHIC.test(String.fromCodePoint(cp)); if (ASTRAL_SEEN.size < 4096) ASTRAL_SEEN.set(cp, yes); }
  return yes;
}
const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isKeycapBase = (cp: number) => (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a;

/** The Unicode 11 provider, taken through the add-on's own public activate() so no xterm internals are touched. */
function unicode11(): Provider {
  let captured: Provider | undefined;
  new Unicode11Addon().activate({ unicode: { register: (p: Provider) => { captured = p; } } } as never);
  if (!captured) throw Error('Unicode 11 provider unavailable');
  return captured;
}

function claudeCodeWidths(base: Provider = unicode11()): Provider {
  return {
    version: 'claude-code',
    wcwidth: (cp) => base.wcwidth(cp),
    charProperties(cp, preceding) {
      const state = stateOf(preceding);
      const prevWidth = widthOf(preceding);
      if (preceding !== 0 && state & EMOJI) {
        if (cp === ZWJ) return pack(EMOJI | AFTER_ZWJ, prevWidth, true);
        if ((state & AFTER_ZWJ && isEmoji(cp)) || isSkinTone(cp)) return pack(EMOJI, Math.max(prevWidth, 2), true);
      }
      if (preceding !== 0 && cp === VS16 && state & (EMOJI | KEYCAP_BASE)) return pack(state & ~AFTER_ZWJ, 2, true);
      const value = base.charProperties(cp, preceding);
      // A mark joined onto the cluster keeps the cluster's state; a new character starts its own.
      if (value & 1) return pack(state & ~AFTER_ZWJ, widthOf(value), true);
      return pack(isEmoji(cp) ? EMOJI : isKeycapBase(cp) ? KEYCAP_BASE : 0, widthOf(value), false);
    },
  };
}

/** Use Claude Code's widths in this terminal (the visible one, or the computer's hidden copy). Never breaks the terminal:
 *  if the table cannot be set up it falls back to plain Unicode 11 widths, exactly what the app used before. */
export function applyClaudeCodeWidths(term: Pick<XTerm | HeadlessTerminal, 'unicode' | 'loadAddon'>): void {
  try {
    term.unicode.register(claudeCodeWidths());
    term.unicode.activeVersion = 'claude-code';
  } catch {
    try { term.loadAddon(new Unicode11Addon() as never); term.unicode.activeVersion = '11'; } catch { /* default widths */ }
  }
}
