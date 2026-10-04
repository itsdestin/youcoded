// Dropping the oldest terminal text safely (shared/pty-trim.ts): never inside an escape sequence, and the
// terminal's sticky state (bracketed paste, cursor, mouse, alt screen, kitty keyboard) is restored after a cut.
import { describe, it, expect } from 'vitest';
import { trimOldest, scanModes, restoreString, newModes, openEscapeStart, type Chunk, type TrimMemo } from '../src/shared/pty-trim';

const chunks = (...a: string[]): Chunk[] => a.map((s) => ({ s }));
const text = (q: Chunk[]) => q.map((c) => c.s).join('');

describe('trimOldest', () => {
  it('does nothing at or under the cap', () => {
    const q = chunks('a\n'.repeat(10));
    expect(trimOldest(q, 100, 50)).toEqual({ removed: 0, added: 0 });
    expect(text(q)).toBe('a\n'.repeat(10));
  });

  it('cuts just after a newline, so the kept text starts at a line start', () => {
    const q = chunks('line-0\nline-1\nline-2\nline-3\nline-4\n');
    const r = trimOldest(q, 20, 14);
    const kept = text(q).replace(/^\x1b\[0m/, '');
    expect(kept.startsWith('line-')).toBe(true);
    expect(kept.endsWith('line-4\n')).toBe(true);
    expect(r.removed).toBeGreaterThan(0);
  });

  it('never cuts inside an escape sequence, even one split across chunks (the leftover "38;5;12m" bug)', () => {
    // The only newlines sit inside/after an unfinished colour sequence at the natural cut point.
    const q = chunks('aaaa\nbbbb\x1b[38;5', ';12mcccc\ndddd\n', 'eeee\n');
    trimOldest(q, 12, 6);
    const kept = text(q);
    expect(kept).not.toMatch(/^(\x1b\[0m)?[0-9;]+m/);          // no orphaned "38;5;12m"
    // every ESC in the kept text still has its terminator
    expect(kept.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')).not.toContain('\x1b');
  });

  it('does not cut inside an OSC string (title) either', () => {
    const q = chunks('x\n', '\x1b]0;my\ntitle\x07after\n', 'tail\n');
    trimOldest(q, 8, 4);
    expect(text(q)).not.toMatch(/^(\x1b\[0m)?title/);
  });

  it('restores the sticky modes the dropped text set (bracketed paste, hidden cursor, mouse, alt screen)', () => {
    const dropped = '\x1b[?2004h\x1b[?25l\x1b[?1049h\x1b[?1000h\x1b[?1006h' + 'x\n'.repeat(50);
    const q = chunks(dropped, 'newest line\n');
    trimOldest(q, 40, 20);
    const kept = text(q);
    for (const seq of ['\x1b[?2004h', '\x1b[?25l', '\x1b[?1049h', '\x1b[?1000h', '\x1b[?1006h']) expect(kept).toContain(seq);
    expect(kept.startsWith('\x1b[0m')).toBe(true);
    expect(kept.endsWith('newest line\n')).toBe(true);
  });

  it('restores only the LAST value of a mode (set then reset = reset)', () => {
    const q = chunks('\x1b[?2004h\x1b[?25l\x1b[?25h\x1b[?2004l' + 'y\n'.repeat(50), 'z\n');
    trimOldest(q, 40, 10);
    const kept = text(q);
    expect(kept).toContain('\x1b[?2004l');
    expect(kept).not.toContain('\x1b[?2004h');
    expect(kept).toContain('\x1b[?25h');
  });

  it('restores the kitty keyboard mode while it is pushed, and not after it is popped', () => {
    const pushed = chunks('\x1b[>1u' + 'a\n'.repeat(50), 'k\n');
    trimOldest(pushed, 40, 10);
    expect(text(pushed)).toContain('\x1b[>1u');
    const popped = chunks('\x1b[>1u\x1b[<u' + 'a\n'.repeat(50), 'k\n');
    trimOldest(popped, 40, 10);
    expect(text(popped)).not.toContain('\x1b[>1u');
  });

  it('a stream that is one huge line with no newline waits (up to twice the cap), then falls back to a surrogate-safe cut', () => {
    const q = chunks('😀'.repeat(30));                          // 60 units, no newline
    expect(trimOldest(q, 50, 20).removed).toBe(0);              // within 2x the cap: wait for a boundary
    const big = chunks('😀'.repeat(60));                        // 120 units > 2x cap
    const r = trimOldest(big, 50, 21);
    expect(r.removed).toBeGreaterThan(0);
    const first = text(big).replace(/^\x1b\[0m/, '').charCodeAt(0);
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);     // never starts on a lone low surrogate
  });

  it('a lone oversized chunk is cut down instead of being kept whole', () => {
    const q = chunks(('row\n').repeat(100_000));                // 400 K in ONE chunk
    trimOldest(q, 100_000, 75_000);
    expect(text(q).length).toBeLessThan(100_001);
  });
});

describe('modes', () => {
  it('scanModes/restoreString: nothing tracked means just an SGR reset', () => {
    const m = newModes(); scanModes(m, 'plain text\n');
    expect(restoreString(m)).toBe('\x1b[0m');
  });
});

// Round 3 (2026-10-04): alternate screen is ONE state, never a cursor-restoring exit on a terminal that is not in it.
describe('alternate screen across a cut', () => {
  const kept = (q: Chunk[]) => text(q);
  it('entered AND left in the dropped head: never replays 1049 l (xterm would restore a cursor that was never saved)', () => {
    const q = chunks('\x1b[?1049h' + 'frame\n'.repeat(40) + '\x1b[?1049l' + 'after\n'.repeat(20), 'newest\n');
    trimOldest(q, 60, 20);
    expect(kept(q)).not.toContain('\x1b[?1049l');
    expect(kept(q)).toContain('\x1b[?1047l');                // leaves the alt screen if the terminal is in it; a no-op otherwise
    expect(kept(q)).not.toContain('\x1b[?1049h');
  });
  it('entered in the dropped head and still on: the alt screen is turned on again', () => {
    const q = chunks('\x1b[?1049h' + 'frame\n'.repeat(40), 'newest\n');
    trimOldest(q, 60, 20);
    expect(kept(q)).toContain('\x1b[?1049h');
    expect(kept(q)).not.toContain('1047l');
  });
  it('two successive cuts: on after the first, off after the second — still no cursor-restoring exit', () => {
    const q = chunks('\x1b[?1049h' + 'frame\n'.repeat(40), 'mid\n'.repeat(10));
    trimOldest(q, 60, 20);
    expect(kept(q).startsWith('\x1b[0m\x1b[?1049h')).toBe(true);
    q.push({ s: '\x1b[?1049l' + 'main\n'.repeat(40) });
    q.push({ s: 'newest\n' });
    trimOldest(q, 60, 20);
    expect(kept(q)).not.toContain('\x1b[?1049l');
    expect(kept(q)).toContain('\x1b[?1047l');
  });
  it('the last scroll region set in the dropped text is restored', () => {
    const q = chunks('\x1b[3;20r' + 'x\n'.repeat(40) + '\x1b[5;18r' + 'y\n'.repeat(40), 'newest\n');
    trimOldest(q, 60, 20);
    expect(kept(q)).toContain('\x1b[5;18r');
    expect(kept(q)).not.toContain('\x1b[3;20r');
  });
});

describe('streams with no newline', () => {
  it('a carriage-return-only progress stream of 10 M characters is cut at a \\r and the scan work stays bounded', () => {
    const memo: TrimMemo = { skipUntil: 0, scans: 0 };
    const q: Chunk[] = [];
    const piece = ('progress 50%\r').repeat(5000);                // ~65 K
    const cap = 4 * 1024 * 1024;
    let pushes = 0;
    for (let n = 0; n < 10_000_000; n += piece.length) { q.push({ s: piece }); pushes++; trimOldest(q, cap, cap * 0.75, memo); }
    const all = text(q).replace(/^\x1b\[0m/, '');
    expect(all.length).toBeLessThanOrEqual(cap);
    expect(all.startsWith('progress 50%\r')).toBe(true);        // the kept text starts at a whole progress line
    expect(memo.scans).toBeLessThanOrEqual(10);                  // not one scan per push (~150 pushes)
  });

  it('a stream with neither \\n nor \\r waits up to twice the cap, rescanning only after ~256 K more arrives', () => {
    const memo: TrimMemo = { skipUntil: 0, scans: 0 };
    const q: Chunk[] = [];
    const cap = 1024 * 1024;
    for (let n = 0; n < 2 * cap - 70_000; n += 65_536) { q.push({ s: 'x'.repeat(65_536) }); trimOldest(q, cap, cap * 0.75, memo); }
    expect(memo.scans).toBeLessThanOrEqual(6);
    expect(text(q).length).toBeGreaterThan(cap);               // nothing was cut: no boundary exists yet
  });

  it('the over-twice-the-cap fallback never cuts inside an escape sequence', () => {
    const q = chunks('a'.repeat(120) + '\x1b[38;5', ';12m' + 'b'.repeat(48));   // the target point falls between ";1" and "2m"
    trimOldest(q, 60, 50);
    const rest = text(q).replace(/^\x1b\[0m/, '');
    expect(rest.startsWith('2m')).toBe(false);
    expect(rest.startsWith('\x1b[38;5;12m')).toBe(true);        // backed off to before the sequence
  });

  it('the fallback never leaves a lone low surrogate at the start of the kept text', () => {
    for (let pad = 0; pad < 3; pad++) {
      const q = chunks('a'.repeat(pad) + '😀'.repeat(100));
      trimOldest(q, 40, 21);
      const first = text(q).replace(/^\x1b\[0m/, '').charCodeAt(0);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
    }
  });
});

describe('openEscapeStart', () => {
  it('knows 8-bit C1 introducers', () => {
    expect(openEscapeStart('ab\u009b38;5', 8)).toBe(2);
    expect(openEscapeStart('ab\u009b38;5m', 9)).toBe(-1);
    expect(openEscapeStart('ab\u009d0;title', 10)).toBe(2);
    expect(openEscapeStart('ab\u009d0;title\u009c', 11)).toBe(-1);
  });
  it('a big OSC payload with newlines inside is still open at 10 K, and treated as finished past 64 K', () => {
    const osc = '\x1b]1337;File=' + 'A\n'.repeat(5000);
    expect(openEscapeStart(osc, osc.length)).toBe(0);
    const huge = '\x1b]1337;File=' + 'A'.repeat(70_000);
    expect(openEscapeStart(huge, huge.length)).toBe(-1);
  });
});
