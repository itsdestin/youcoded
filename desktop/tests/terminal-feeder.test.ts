// Terminal flow control, renderer half (terminal-feeder.ts).
// What must hold: every character written is acknowledged exactly once after xterm parses it; a visible
// terminal is written through with no delay and no reordering; a hidden terminal passes a burst, then
// only HIDDEN_RATE per second, and loses nothing; becoming visible writes the backlog at once; dispose
// releases whatever is still owed; where there is no upstream brake nothing is held back.
import { describe, it, expect } from 'vitest';
import { createTerminalFeeder, HIDDEN_BURST, HIDDEN_RATE, HIDDEN_QUEUE_MAX } from '../src/renderer/hooks/terminal-feeder';

function rig(opts: { hidden?: boolean; throttleHidden?: boolean } = {}) {
  let t = 0;
  let hidden = opts.hidden ?? false;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const written: string[] = [];
  const pendingDone: (() => void)[] = [];
  const acks: number[] = [];
  const feeder = createTerminalFeeder({
    write: (d, done) => { written.push(d); pendingDone.push(done); },
    ack: (n) => acks.push(n),
    isHidden: () => hidden,
    throttleHidden: opts.throttleHidden ?? true,
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex(x => x.id === h); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    feeder, written, acks,
    setHidden: (h: boolean) => { hidden = h; },
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
    r.advance(60_000);
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
});
