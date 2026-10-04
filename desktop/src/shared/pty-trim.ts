// Dropping the OLDEST part of a terminal byte stream without breaking the terminal (2026-10-04, review round 2).
//
// WHY: two places keep only the newest N characters of a stream nobody could draw yet (main: output waiting
// for a terminal to mount; the renderer: a hidden/minimised window's backlog). Cutting at an arbitrary chunk
// boundary has two failure modes: (1) it can land in the middle of an escape sequence, so the rest prints as
// text ("38;5;12m"); (2) it loses terminal STATE that programs set once and never repeat — bracketed paste,
// cursor visibility, mouse modes, the alternate screen — so after a cut a multi-line paste could submit line
// by line. (Visible text is not at risk: xterm keeps 1,000 lines of scrollback, far less than the 4 M kept.)
//
// So a cut (a) lands just after a newline that is not inside an escape/OSC/DCS string, and (b) is followed by a
// short restore string: SGR reset + the LAST value of every sticky mode the dropped text touched.
//
// Sticky modes restored (DEC private modes, last set/reset seen in the dropped text):
//   1 application cursor keys, 7 auto-wrap, 12 cursor blink, 25 cursor visible, 47/1047/1049 alternate screen,
//   1000/1002/1003 mouse reporting, 1004 focus reports, 1005/1006/1015/1016 mouse encodings, 2004 bracketed paste.
// Plus the kitty keyboard protocol (CSI > flags u push, CSI < n u pop, CSI = flags u set): the most recent
// push/set is restored if the dropped text left it pushed. NOT restored (cannot be known from a dropped
// region): cursor position, scroll region, tab stops, charset shifts, colours other than the SGR reset.

const STICKY = new Set([1, 7, 12, 25, 47, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049, 2004]);

export interface StickyModes { priv: Map<number, boolean>; kittyDepth: number; kittyLast: string | null; }
export const newModes = (): StickyModes => ({ priv: new Map(), kittyDepth: 0, kittyLast: null });

/** Fold the sticky-mode changes in `text` into `m` (later values win). */
export function scanModes(m: StickyModes, text: string): void {
  if (text.indexOf('\x1b[') < 0) return;
  const priv = /\x1b\[\?([0-9;]+)([hl])/g;
  let r: RegExpExecArray | null;
  while ((r = priv.exec(text)) !== null) {
    for (const p of r[1].split(';')) { const n = Number(p); if (STICKY.has(n)) m.priv.set(n, r[2] === 'h'); }
  }
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
  for (const [n, on] of m.priv) s += `\x1b[?${n}${on ? 'h' : 'l'}`;
  if (m.kittyDepth > 0 && m.kittyLast) s += m.kittyLast;
  return s;
}

/**
 * Is position `end` of `text` inside an unfinished escape sequence? Only the last ESC within `lookback`
 * characters matters: anything older either finished or is so long it is not a real sequence.
 */
function insideEscape(text: string, end: number, lookback = 4096): boolean {
  const esc = text.lastIndexOf('\x1b', end - 1);
  if (esc < 0 || end - esc > lookback) return false;
  const next = text.charCodeAt(esc + 1);
  if (Number.isNaN(next)) return true;                       // a lone ESC at the very end
  const ch = text[esc + 1];
  if (ch === '[') {                                          // CSI: ends at a final byte 0x40-0x7e
    for (let i = esc + 2; i < end; i++) { const c = text.charCodeAt(i); if (c >= 0x40 && c <= 0x7e) return false; }
    return true;
  }
  if (ch === ']' || ch === 'P' || ch === '_' || ch === '^' || ch === 'X') {   // OSC/DCS/APC/PM/SOS: BEL or ESC \
    for (let i = esc + 2; i < end; i++) {
      const c = text.charCodeAt(i);
      if (c === 7 || (c === 0x1b && text[i + 1] === '\\' && i + 1 < end)) return false;
    }
    return true;
  }
  return end <= esc + 1;                                      // two-character escapes (ESC 7, ESC =, ...)
}

export interface Chunk { s: string; }

/**
 * Drop the oldest text from `queue` (mutated) until about `target` characters remain, if it holds more than
 * `cap`. Returns characters removed and added (the restore string rides at the head of the first kept chunk).
 * Never cuts inside an escape sequence; cuts after a newline; falls back to a plain surrogate-safe cut only
 * when the stream has no usable newline at all and is over twice the cap (binary output).
 */
export function trimOldest(queue: Chunk[], cap: number, target: number): { removed: number; added: number } {
  let total = 0;
  for (const c of queue) total += c.s.length;
  if (total <= cap) return { removed: 0, added: 0 };
  const need = total - target;
  // Locate the chunk holding offset `need`.
  let idx = 0, before = 0;
  while (idx < queue.length - 1 && before + queue[idx].s.length < need) { before += queue[idx].s.length; idx++; }
  let local = Math.max(0, need - before), cutIdx = -1, cutLocal = 0;
  for (let i = idx; i < queue.length && cutIdx < 0; i++) {
    const text = queue[i].s;
    // Context for the escape check: the tail of the previous chunk, then this one.
    const prevTail = i > 0 ? queue[i - 1].s.slice(-4096) : '';
    let from = i === idx ? local : 0;
    for (;;) {
      const nl = text.indexOf('\n', from);
      if (nl < 0) break;
      if (!insideEscape(prevTail + text, prevTail.length + nl + 1)) { cutIdx = i; cutLocal = nl + 1; break; }
      from = nl + 1;
    }
  }
  if (cutIdx < 0) {
    if (total <= cap * 2) return { removed: 0, added: 0 };   // no safe boundary yet: wait for one
    cutIdx = idx; cutLocal = local;
    const c = queue[idx].s.charCodeAt(Math.max(0, cutLocal - 1));
    if (c >= 0xd800 && c <= 0xdbff) cutLocal++;
  }
  let dropped = '';
  for (let i = 0; i < cutIdx; i++) dropped += queue[i].s;
  dropped += queue[cutIdx].s.slice(0, cutLocal);
  const modes = newModes();
  scanModes(modes, dropped);
  const restore = restoreString(modes);
  const rest = queue[cutIdx].s.slice(cutLocal);
  queue.splice(0, cutIdx);
  queue[0].s = restore + rest;
  return { removed: dropped.length, added: restore.length };
}
