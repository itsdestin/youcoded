// Dropping the OLDEST part of a terminal byte stream without breaking the terminal (2026-10-04, review rounds 2-3).
//
// WHY: two places keep only the newest N characters of a stream nobody could draw yet (main: output waiting
// for a terminal to mount; the renderer: a hidden/minimised window's backlog). Cutting at an arbitrary chunk
// boundary has two failure modes: (1) it can land in the middle of an escape sequence, so the rest prints as
// text ("38;5;12m"); (2) it loses terminal STATE that programs set once and never repeat — bracketed paste,
// cursor visibility, mouse modes, the alternate screen — so after a cut a multi-line paste could submit line
// by line. (Visible text is not at risk: xterm keeps 1,000 lines of scrollback, far less than the 4 M kept.)
//
// So a cut (a) lands just after a newline (or, in a newline-free progress stream, a carriage return) that is not
// inside an escape/OSC/DCS string, and (b) is followed by a short restore string: SGR reset + the LAST value of
// every sticky mode the dropped text touched.
//
// Restored (last value seen in the dropped text):
//   DEC private modes 1 application cursor keys, 7 auto-wrap, 12 cursor blink, 25 cursor visible,
//   1000/1002/1003 mouse reporting, 1004 focus reports, 1005/1006/1015/1016 mouse encodings, 2004 bracketed paste;
//   the alternate screen as ONE state (modes 47/1047/1049): ON -> the mode that turned it on is replayed, OFF ->
//   `CSI ? 1047 l` (leaves the alternate screen if the terminal is in it, a no-op otherwise, and — unlike 1049 l —
//   never restores a cursor position that was not saved: xterm runs a cursor RESTORE for 1049 l even from the
//   normal screen, which threw the cursor to a stale spot);
//   the scroll region (DECSTBM, `CSI t ; b r`, last one);
//   the kitty keyboard mode (CSI > flags u push, CSI < n u pop, CSI = flags u set) while it is left pushed.
// NOT restorable from a dropped region: cursor position, tab stops, charset shifts, colours other than the SGR
// reset. Programs that redraw with RELATIVE cursor moves (Claude Code's Ink UI) are therefore repainted by a
// size nudge after a cut (see the callers), not by this module.
// 8-bit C1 introducers (U+009B CSI, U+009D OSC, U+0090 DCS, U+009F APC, U+009E PM, U+0098 SOS) are recognised as
// escape starts. A CSI or two-character escape longer than 4,096 characters, or a string sequence (OSC/DCS/APC/PM/SOS)
// longer than 65,536, is treated as finished — real sequences are far shorter, and a cut inside a payload that
// large is the lesser harm to waiting forever.

const STICKY = new Set([1, 7, 12, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 2004]);
const ALT = new Set([47, 1047, 1049]);

export interface StickyModes {
  priv: Map<number, boolean>;
  alt: { on: boolean; kind: number } | null;
  region: string | null;
  kittyDepth: number;
  kittyLast: string | null;
}
export const newModes = (): StickyModes => ({ priv: new Map(), alt: null, region: null, kittyDepth: 0, kittyLast: null });

/** Fold the sticky-mode changes in `text` into `m` (later values win). */
export function scanModes(m: StickyModes, text: string): void {
  if (text.indexOf('\x1b[') < 0) return;
  const priv = /\x1b\[\?([0-9;]+)([hl])/g;
  let r: RegExpExecArray | null;
  while ((r = priv.exec(text)) !== null) {
    for (const p of r[1].split(';')) {
      const n = Number(p), on = r[2] === 'h';
      if (ALT.has(n)) m.alt = { on, kind: on ? n : (m.alt?.kind ?? n) };
      else if (STICKY.has(n)) m.priv.set(n, on);
    }
  }
  const region = /\x1b\[(\d*)(?:;(\d*))?r/g;
  while ((r = region.exec(text)) !== null) m.region = r[0];
  const kitty = /\x1b\[([<>=])([0-9;]*)u/g;
  while ((r = kitty.exec(text)) !== null) {
    if (r[1] === '>') { m.kittyDepth++; m.kittyLast = r[0]; }
    else if (r[1] === '<') { m.kittyDepth = Math.max(0, m.kittyDepth - (Number(r[2]) || 1)); if (m.kittyDepth === 0) m.kittyLast = null; }
    else m.kittyLast = r[0];
  }
}

/** What to write before the kept text so the terminal's state matches the dropped region's end. */
export function restoreString(m: StickyModes): string {
  let s = '\x1b[0m';
  if (m.alt) s += m.alt.on ? `\x1b[?${m.alt.kind}h` : '\x1b[?1047l';
  for (const [n, on] of m.priv) s += `\x1b[?${n}${on ? 'h' : 'l'}`;
  if (m.region) s += m.region;
  if (m.kittyDepth > 0 && m.kittyLast) s += m.kittyLast;
  return s;
}

const C1_CSI = '\u009b', C1_STRINGS = ['\u009d', '\u0090', '\u009f', '\u009e', '\u0098'];
const CSI_LIMIT = 4096, STRING_LIMIT = 65536;

/**
 * Start index of an escape sequence that is still unfinished at position `end` of `text`, or -1.
 * Only the last introducer matters: anything earlier either finished or is longer than the limits above.
 */
export function openEscapeStart(text: string, end: number): number {
  let intro = text.lastIndexOf('\x1b', end - 1);
  for (const c of [C1_CSI, ...C1_STRINGS]) { const i = text.lastIndexOf(c, end - 1); if (i > intro) intro = i; }
  if (intro < 0) return -1;
  const c0 = text[intro];
  let kind: 'csi' | 'string' | 'two';
  let bodyStart = intro + 1;
  if (c0 === '\x1b') {
    if (intro + 1 >= end) return intro;                      // a lone ESC at the very end
    const n = text[intro + 1];
    bodyStart = intro + 2;
    kind = n === '[' ? 'csi' : (n === ']' || n === 'P' || n === '_' || n === '^' || n === 'X') ? 'string' : 'two';
  } else kind = c0 === C1_CSI ? 'csi' : 'string';
  if (kind === 'two') return end <= intro + 1 ? intro : -1;
  if (end - intro > (kind === 'csi' ? CSI_LIMIT : STRING_LIMIT)) return -1;
  if (kind === 'csi') {
    for (let i = bodyStart; i < end; i++) { const c = text.charCodeAt(i); if (c >= 0x40 && c <= 0x7e) return -1; }
    return intro;
  }
  for (let i = bodyStart; i < end; i++) {                    // BEL, ESC \ or U+009C ends a string
    const c = text.charCodeAt(i);
    if (c === 7 || c === 0x9c || (c === 0x1b && text[i + 1] === '\\' && i + 1 < end)) return -1;
  }
  return intro;
}

export interface Chunk { s: string; }
/** Remembers that a scan found no boundary, so the next one waits for ~256 K more text (a `\r`-only stream is not rescanned per push). */
export interface TrimMemo { skipUntil: number; scans: number; }
const RESCAN_AFTER = 256 * 1024;

/**
 * Drop the oldest text from `queue` (mutated) until about `target` characters remain, if it holds more than
 * `cap`. Returns characters removed and added (the restore string rides at the head of the first kept chunk).
 * Never cuts inside an escape sequence; cuts after a newline, else after a carriage return; waits (up to twice
 * the cap) when the stream has neither; past that falls back to a cut that backs off before an unfinished
 * sequence and never starts the kept text on a lone low surrogate.
 */
export function trimOldest(queue: Chunk[], cap: number, target: number, memo?: TrimMemo): { removed: number; added: number } {
  let total = 0;
  for (const c of queue) total += c.s.length;
  if (total <= cap) return { removed: 0, added: 0 };
  if (memo && total < memo.skipUntil) return { removed: 0, added: 0 };
  if (memo) memo.scans++;
  const need = total - target;
  let idx = 0, before = 0;
  while (idx < queue.length - 1 && before + queue[idx].s.length < need) { before += queue[idx].s.length; idx++; }
  const local = Math.max(0, need - before);

  const find = (ch: string): [number, number] | null => {
    for (let i = idx; i < queue.length; i++) {
      const text = queue[i].s;
      const prevTail = i > 0 ? queue[i - 1].s.slice(-CSI_LIMIT) : '';
      let from = i === idx ? local : 0;
      for (;;) {
        const at = text.indexOf(ch, from);
        if (at < 0) break;
        const after = at + 1;
        const next = after < text.length ? text[after] : (queue[i + 1]?.s[0] ?? '');
        if ((ch !== '\r' || next !== '\n') && openEscapeStart(prevTail + text, prevTail.length + after) < 0) return [i, after];
        from = after;
      }
    }
    return null;
  };
  let cut = find('\n') ?? find('\r');
  if (!cut) {
    if (total <= cap * 2) { if (memo) memo.skipUntil = total + RESCAN_AFTER; return { removed: 0, added: 0 }; }
    // Over twice the cap with no boundary at all (binary output): cut at the target point, but never inside a sequence
    // and never leaving a lone low surrogate at the start of what is kept.
    let ci = idx, cl = local;
    const prevTail = ci > 0 ? queue[ci - 1].s.slice(-CSI_LIMIT) : '';
    const open = openEscapeStart(prevTail + queue[ci].s, prevTail.length + cl);
    if (open >= 0) { if (open >= prevTail.length) cl = open - prevTail.length; else { ci = Math.max(0, ci - 1); cl = queue[ci].s.length - (prevTail.length - open); } }
    const lo = queue[ci].s.charCodeAt(cl);
    if (cl > 0 && lo >= 0xdc00 && lo <= 0xdfff) cl--;
    cut = [ci, cl];
  }
  const [cutIdx, cutLocal] = cut;
  let dropped = '';
  for (let i = 0; i < cutIdx; i++) dropped += queue[i].s;
  dropped += queue[cutIdx].s.slice(0, cutLocal);
  if (dropped.length === 0) return { removed: 0, added: 0 };
  const modes = newModes();
  scanModes(modes, dropped);
  const restore = restoreString(modes);
  const rest = queue[cutIdx].s.slice(cutLocal);
  queue.splice(0, cutIdx);
  queue[0].s = restore + rest;
  if (memo) memo.skipUntil = 0;
  return { removed: dropped.length, added: restore.length };
}
