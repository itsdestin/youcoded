// Terminal flow control, renderer half (terminal-feeder.ts).
// What must hold: every character written is acknowledged exactly once after xterm parses it; a visible
// terminal is written through with no delay and no reordering; a hidden terminal passes a burst, then
// only HIDDEN_RATE per second, and loses nothing; becoming visible writes the backlog at once; dispose
// releases whatever is still owed; where there is no upstream brake nothing is held back.
import { describe, it, expect } from 'vitest';
import { createTerminalFeeder, HIDDEN_BURST, HIDDEN_RATE, HIDDEN_QUEUE_MAX, DOC_HIDDEN_CAP } from '../src/renderer/hooks/terminal-feeder';

function rig(opts: { hidden?: boolean; throttleHidden?: boolean } = {}) {
  let t = 0;
  let hidden = opts.hidden ?? false;
  let docHidden = false;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const written: string[] = [];
  const pendingDone: (() => void)[] = [];
  const acks: number[] = [];
  const feeder = createTerminalFeeder({
    write: (d, done) => { written.push(d); pendingDone.push(done); },
    ack: (n) => acks.push(n),
    isHidden: () => hidden,
    isDocHidden: () => docHidden,
    throttleHidden: opts.throttleHidden ?? true,
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex(x => x.id === h); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    feeder, written, acks,
    setHidden: (h: boolean) => { hidden = h; },
    setDocHidden: (h: boolean) => { docHidden = h; feeder.docVisibilityChanged(); },
    parseAll: () => { while (pendingDone.length) pendingDone.shift()!(); },
    advance: (ms: number) => {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        t = next.at; timers.shift(); next.fn();
      }
      t = end;
    },
    timerCount: () => timers.length,
    advanceClockOnly: (ms: number) => { t += ms; },
  };
}
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('terminal feeder', () => {
  it('writes a visible terminal straight through, in order, and acknowledges each write once parsed', () => {
    const r = rig();
    r.feeder.push('abc'); r.feeder.push('defg');
    expect(r.written).toEqual(['abc', 'defg']);
    expect(r.acks).toEqual([]);            // not parsed yet: nothing is owed back
    r.parseAll();
    expect(r.acks).toEqual([3, 4]);
  });

  it('a hidden terminal passes a burst instantly', () => {
    const r = rig({ hidden: true });
    r.feeder.push('x'.repeat(HIDDEN_BURST - 10));
    expect(r.written.length).toBe(1);
    expect(r.feeder.queued()).toBe(0);
  });

  it('a braked hidden flood is fed at about HIDDEN_RATE over time, in order, byte for byte', () => {
    const r = rig({ hidden: true });
    const text = Array.from({ length: 3000 }, (_, i) => `line-${i}\n`).join('');   // ~ 30 KB distinct text
    // Enough of it to exceed the burst: repeat to ~2.5 MB, in ~250 KB pushes (what the worker sends).
    const big = text.repeat(Math.ceil((2.5 * 1024 * 1024) / text.length));
    const pushes: string[] = [];
    for (let i = 0; i < big.length; i += 250 * 1024) pushes.push(big.slice(i, i + 250 * 1024));
    for (const p of pushes) r.feeder.push(p);
    expect(r.written.join('')).toBe(big.slice(0, r.written.join('').length));   // what has passed so far is a prefix, in order
    const before = sum(r.written.map(w => w.length));
    r.advance(1000);
    const after = sum(r.written.map(w => w.length));
    const fedInOneSecond = after - before;
    expect(fedInOneSecond).toBeGreaterThan(HIDDEN_RATE * 0.8);
    expect(fedInOneSecond).toBeLessThan(HIDDEN_RATE * 1.3);
    for (let i = 0; i < 1200; i++) { r.advance(50); r.parseAll(); }   // xterm keeps confirming as it parses
    expect(r.written.join('')).toBe(big);        // everything, exactly, eventually
    expect(r.feeder.queued()).toBe(0);
    r.parseAll();
    expect(sum(r.acks)).toBe(big.length);        // and every character acknowledged exactly once
  });

  it('becoming visible writes the whole backlog at once, in order', () => {
    const r = rig({ hidden: true });
    const parts = ['A'.repeat(HIDDEN_BURST), 'B'.repeat(1000), 'C'.repeat(2000)];
    for (const p of parts) r.feeder.push(p);
    expect(r.written.join('')).toBe(parts[0]);   // B and C are held back
    r.setHidden(false);
    r.feeder.wake();
    expect(r.written.join('')).toBe(parts.join(''));
    expect(r.feeder.queued()).toBe(0);
    expect(r.timerCount()).toBe(0);
  });

  it('new output while visible never jumps ahead of a hidden backlog', () => {
    const r = rig({ hidden: true });
    r.feeder.push('1'.repeat(HIDDEN_BURST));
    r.feeder.push('2'.repeat(10));
    r.setHidden(false);
    r.feeder.push('3'.repeat(10));            // no wake() call: push itself must drain first
    expect(r.written.join('')).toBe('1'.repeat(HIDDEN_BURST) + '2'.repeat(10) + '3'.repeat(10));
  });

  it('never cuts a surrogate pair when it hands a hidden backlog over in slices', () => {
    const r = rig({ hidden: true });
    r.feeder.push('a'.repeat(HIDDEN_BURST));  // spends the allowance
    r.feeder.push('😀'.repeat(400_000));       // 800 000 UTF-16 units, every unit boundary is odd/even sensitive
    r.advance(60_000);
    for (const w of r.written) {
      const last = w.charCodeAt(w.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);   // never ends on a lone high surrogate
    }
    expect(r.written.join('').length).toBe(HIDDEN_BURST + 800_000);
  });

  it('where there is no upstream brake (remote browser, phone app) nothing is ever held back', () => {
    const r = rig({ hidden: true, throttleHidden: false });
    for (let i = 0; i < 20; i++) r.feeder.push('z'.repeat(HIDDEN_BURST));
    expect(r.written.length).toBe(20);
    expect(r.feeder.queued()).toBe(0);
  });

  it('safety valve: a hidden backlog that outgrows HIDDEN_QUEUE_MAX is written through, not left to grow', () => {
    const r = rig({ hidden: true });
    r.feeder.push('s'.repeat(HIDDEN_BURST));
    r.feeder.push('t'.repeat(HIDDEN_QUEUE_MAX + 5));
    expect(r.feeder.queued()).toBe(0);
    expect(sum(r.written.map(w => w.length))).toBe(HIDDEN_BURST + HIDDEN_QUEUE_MAX + 5);
  });

  it('dispose releases everything still owed (written but unparsed, and queued) exactly once', () => {
    const r = rig({ hidden: true });
    r.feeder.push('p'.repeat(HIDDEN_BURST));   // written, never parsed
    r.feeder.push('q'.repeat(500));            // queued
    r.feeder.dispose();
    expect(r.acks).toEqual([HIDDEN_BURST + 500]);
    r.parseAll();                              // late callbacks after dispose must not double-release
    expect(r.acks).toEqual([HIDDEN_BURST + 500]);
    r.feeder.push('more');                     // and a disposed feeder takes nothing
    expect(r.written.join('').length).toBe(HIDDEN_BURST);
  });

  // A minimised / hidden WINDOW: the browser stretches timers to ~1 s, so xterm's "drawn" confirmations cannot
  // pace anything. Confirm on receipt, keep memory bounded, lose nothing that matters, catch up on return.
  describe('window hidden or minimised', () => {
    it('confirms on receipt (the program is not slowed by throttled timers) and never confirms twice', () => {
      const r = rig();
      r.feeder.push('a'.repeat(100));                    // visible: written, not yet drawn
      r.setDocHidden(true);                              // window minimised: what is in flight is confirmed now
      expect(sum(r.acks)).toBe(100);
      r.feeder.push('b'.repeat(200));
      expect(sum(r.acks)).toBe(300);                     // confirmed on receipt
      r.parseAll();                                      // xterm's late callbacks must not confirm again
      expect(sum(r.acks)).toBe(300);
    });

    it('keeps only the newest DOC_HIDDEN_CAP un-drawn characters, resets colours after a cut, and confirms what it cut once', () => {
      const r = rig();
      r.setDocHidden(true);
      r.feeder.push('s'.repeat(HIDDEN_BURST));           // spends the burst allowance
      const chunk = ('c'.repeat(1023) + '\n').repeat(512);   // 512 K of whole lines
      const pushes = Math.ceil((DOC_HIDDEN_CAP * 2) / chunk.length);
      for (let i = 0; i < pushes; i++) r.feeder.push(chunk);
      expect(r.feeder.queued()).toBeLessThanOrEqual(DOC_HIDDEN_CAP);
      expect(sum(r.acks)).toBe(HIDDEN_BURST + pushes * chunk.length);   // every character confirmed exactly once on receipt
      for (let i = 0; i < 2000; i++) { r.advance(50); r.parseAll(); }
      expect(r.written.some((w) => w.startsWith('\x1b[0m'))).toBe(true);
      expect(r.feeder.queued()).toBe(0);
    });

    it('returning to the window writes everything still held, at once, in order', () => {
      const r = rig();
      r.setDocHidden(true);
      r.feeder.push('1'.repeat(HIDDEN_BURST)); r.feeder.push('2'.repeat(1000)); r.feeder.push('3'.repeat(1000));
      expect(r.feeder.queued()).toBe(2000);
      r.setDocHidden(false);
      expect(r.feeder.queued()).toBe(0);
      expect(r.written.join('')).toBe('1'.repeat(HIDDEN_BURST) + '2'.repeat(1000) + '3'.repeat(1000));
    });

    it('does nothing special where there is no upstream brake (remote browser)', () => {
      const r = rig({ throttleHidden: false });
      r.setDocHidden(true);
      r.feeder.push('x'.repeat(1000));
      expect(r.acks).toEqual([]);                        // acks come only from xterm's callbacks
      r.parseAll();
      expect(sum(r.acks)).toBe(1000);
    });
  });

  // Chromium stretches chained timers in a long-hidden window to about once a minute; IPC events are not
  // stretched. The backlog must drain from push() alone, and xterm must never be fed far ahead of its own
  // (equally throttled) parsing.
  describe('hidden window with timers that never fire', () => {
    it('drains the backlog from pushes alone at about the allowed rate (the queue does not grow past the cap)', () => {
      const r = rig();
      r.setDocHidden(true);
      const chunk = ('l'.repeat(1023) + '\n').repeat(64);       // 64 K of lines, arriving at ~1 MB/s for 20 simulated seconds
      let maxQueued = 0;
      for (let ms = 0; ms < 20_000; ms += 64) {
        r.advanceClockOnly(64);                                  // time passes; NO timer callback ever runs
        r.feeder.push(chunk);
        r.parseAll();
        maxQueued = Math.max(maxQueued, r.feeder.queued());
      }
      const written = sum(r.written.map((w) => w.length));
      expect(written).toBeGreaterThan(HIDDEN_BURST + 15 * HIDDEN_RATE * 0.8);   // it kept draining by itself
      expect(maxQueued).toBeLessThanOrEqual(DOC_HIDDEN_CAP);
    });

    it('does not hand xterm more than ~2 M un-parsed characters, however much arrives', () => {
      const r = rig();
      r.setDocHidden(true);
      const chunk = ('m'.repeat(1023) + '\n').repeat(256);       // 256 K
      for (let i = 0; i < 40; i++) { r.advanceClockOnly(2000); r.feeder.push(chunk); }   // plenty of allowance, xterm never answers
      expect(sum(r.written.map((w) => w.length))).toBeLessThanOrEqual(2 * 1024 * 1024 + 256 * 1024 + 200);
      expect(r.feeder.queued()).toBeLessThanOrEqual(DOC_HIDDEN_CAP);
    });
  });
});
