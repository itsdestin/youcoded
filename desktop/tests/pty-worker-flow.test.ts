// PTY output batching + flow control in pty-worker.js (2026-10-04).
//
// WHY THIS EXISTS: a program that printed faster than the terminal could draw (a `cat` of a huge file) had
// its output forwarded instantly and without limit; xterm then silently threw most of it away — including
// the final lines and the prompt — while the app's main process stalled and the worker's memory grew.
// The fix is a brake in the worker: it counts characters handed to main that the terminal has not yet
// confirmed, stops reading the PTY above a high mark (so the program blocks, as on a slow real terminal)
// and resumes below a low mark. Part 1 drives the real file against a fake PTY with fake timers (exact,
// fast). Part 2 forks the real worker over a REAL node-pty and a real producer (Linux/macOS), to prove the
// kernel actually blocks the program and that the final bytes survive.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { loadWorker } from './helpers/pty-worker-harness';

const SMALL = { YOUCODED_PTY_FLOW_HIGH: '1000', YOUCODED_PTY_FLOW_LOW: '300', YOUCODED_PTY_FLOW_STALL_MS: '5000' };
const dataSent = (w: ReturnType<typeof loadWorker>) =>
  w.fakeProcess.send.mock.calls.filter((c: any[]) => c[0]?.type === 'data').map((c: any[]) => c[0].data as string);

describe('pty-worker output batching', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('sends the first chunk after a quiet moment immediately (a keystroke echo pays nothing)', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.emitData('echo');
    expect(dataSent(w)).toEqual(['echo']);
  });

  it('merges chunks that follow within a few milliseconds, in order, and sends the batch on the timer', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.emitData('a');
    w.emitData('b'); w.emitData('c'); w.emitData('d');
    expect(dataSent(w)).toEqual(['a']);
    vi.advanceTimersByTime(4);
    expect(dataSent(w)).toEqual(['a', 'bcd']);
  });

  it('flushes at once when a batch reaches its size cap (no waiting on the timer)', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.emitData('x');
    w.emitData('y'.repeat(150 * 1024));
    expect(dataSent(w).length).toBe(1);
    w.emitData('z'.repeat(150 * 1024));
    expect(dataSent(w).length).toBe(2);
    expect(dataSent(w)[1].length).toBe(300 * 1024);
  });

  it('never splits or drops a character: what was sent is exactly what was read', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    const parts = ['😀', 'é', '\x1b[31m', 'red', '\x1b[0m', '字'.repeat(1000), 'tail'];
    for (const p of parts) { w.emitData(p); vi.advanceTimersByTime(1); }
    vi.advanceTimersByTime(10);
    expect(dataSent(w).join('')).toBe(parts.join(''));
  });
});

describe('pty-worker repaint nudge (after output was cut from a backlog)', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('shrinks the PTY by one column and puts the real size back', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.deliver({ type: 'bounce' });
    expect(w.fakePty.resize).toHaveBeenLastCalledWith(79, 24);
    vi.advanceTimersByTime(130);
    expect(w.fakePty.resize).toHaveBeenLastCalledWith(80, 24);
  });
  it('does not fight a real resize that lands in between', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.deliver({ type: 'bounce' });
    w.deliver({ type: 'resize', cols: 100, rows: 30 });
    vi.advanceTimersByTime(130);
    expect(w.fakePty.cols).toBe(100);                       // the user's size stands, the stale restore never ran
    expect(w.fakePty.resize).not.toHaveBeenCalledWith(80, 24);
  });
  it('overlapping requests narrow only once and the restore goes back to the ORIGINAL size (never stuck one column narrow)', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.deliver({ type: 'bounce' });
    vi.advanceTimersByTime(50);
    w.deliver({ type: 'bounce' });                           // a second request inside the window: ignored
    vi.advanceTimersByTime(200);
    expect(w.fakePty.resize.mock.calls).toEqual([[79, 24], [80, 24]]);
    expect(w.fakePty.cols).toBe(80);
    w.deliver({ type: 'bounce' });                           // and a later one works again
    vi.advanceTimersByTime(200);
    expect(w.fakePty.cols).toBe(80);
  });
  it('a viewer on another device resizing between the two halves keeps its size (the nudge never overrides it)', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.deliver({ type: 'bounce' });
    w.deliver({ type: 'resize', cols: 50, rows: 20 });        // what a phone's session:resize becomes in the worker
    vi.advanceTimersByTime(200);
    expect(w.fakePty.cols).toBe(50);
    expect(w.fakePty.rows).toBe(20);
  });
  it('even a real resize to the nudged width itself wins (flagged, not guessed from the size)', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.deliver({ type: 'bounce' });
    w.deliver({ type: 'resize', cols: 79, rows: 24 });
    vi.advanceTimersByTime(200);
    expect(w.fakePty.cols).toBe(79);
  });
  it('the child exiting inside the nudge window: no restore is attempted, nothing throws', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.deliver({ type: 'bounce' });
    w.fakePty.resize.mockImplementation(() => { throw new Error('ioctl(2) failed, EBADF'); });   // the fd is closed now
    w.exitPty();
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(w.fakePty.resize).toHaveBeenCalledTimes(1);        // only the narrowing; the restore never ran
  });
  it('a first half that throws leaves the nudge usable afterwards (state is set only after it succeeds)', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.fakePty.resize.mockImplementationOnce(() => { throw new Error('EBADF'); });
    expect(() => w.deliver({ type: 'bounce' })).not.toThrow();
    w.deliver({ type: 'bounce' });                             // not blocked by a stale in-progress flag
    vi.advanceTimersByTime(200);
    expect(w.fakePty.cols).toBe(80);
  });
  it('a failing restore is swallowed (no worker crash)', () => {
    vi.useFakeTimers();
    const w = loadWorker();
    w.deliver({ type: 'bounce' });
    w.fakePty.resize.mockImplementation(() => { throw new Error('EBADF'); });
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
  });
  it('no nudge during a hand-off stop or after the PTY exited; and a plain resize after exit does not throw', () => {
    vi.useFakeTimers();
    const h = loadWorker();
    h.deliver({ type: 'stop-for-handoff' });
    h.deliver({ type: 'bounce' });
    expect(h.fakePty.resize).not.toHaveBeenCalled();
    const e = loadWorker();
    e.exitPty();
    e.deliver({ type: 'bounce' });
    e.fakePty.resize.mockImplementation(() => { throw new Error('EBADF'); });
    expect(() => e.deliver({ type: 'resize', cols: 90, rows: 30 })).not.toThrow();
    expect(e.fakePty.resize).not.toHaveBeenCalled();
  });
  it('never on Windows (ConPTY re-emits its buffer on every resize)', () => {
    vi.useFakeTimers();
    const w = loadWorker(undefined, {}, 'win32');
    w.deliver({ type: 'bounce' });
    vi.advanceTimersByTime(130);
    expect(w.fakePty.resize).not.toHaveBeenCalled();
  });
});

describe('pty-worker flow control', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('pauses the PTY above the high mark and resumes only below the low mark', () => {
    vi.useFakeTimers();
    const w = loadWorker(undefined, SMALL);
    w.emitData('a'.repeat(600)); vi.advanceTimersByTime(10);
    expect(w.fakePty.pause).not.toHaveBeenCalled();
    w.emitData('b'.repeat(600)); vi.advanceTimersByTime(10);      // 1200 owed >= 1000
    expect(w.fakePty.pause).toHaveBeenCalledTimes(1);
    w.deliver({ type: 'ack', n: 700 });                            // 500 owed: still above LOW
    expect(w.fakePty.resume).not.toHaveBeenCalled();
    w.deliver({ type: 'ack', n: 300 });                            // 200 owed: below LOW
    expect(w.fakePty.resume).toHaveBeenCalledTimes(1);
  });

  it('does not pause again while already paused, and an over-acknowledgement never goes negative', () => {
    vi.useFakeTimers();
    const w = loadWorker(undefined, SMALL);
    w.emitData('a'.repeat(1200)); vi.advanceTimersByTime(10);
    w.emitData('b'.repeat(500)); vi.advanceTimersByTime(10);       // a read already in flight after the pause
    expect(w.fakePty.pause).toHaveBeenCalledTimes(1);
    w.deliver({ type: 'ack', n: 99999 });
    expect(w.fakePty.resume).toHaveBeenCalledTimes(1);
    w.emitData('c'.repeat(900)); vi.advanceTimersByTime(10);       // owed starts from 0, not from a negative
    expect(w.fakePty.pause).toHaveBeenCalledTimes(1);
  });

  it('a lost acknowledgement cannot freeze the session: after the stall time it lets more through and re-arms', () => {
    vi.useFakeTimers();
    const w = loadWorker(undefined, SMALL);
    w.emitData('a'.repeat(1200)); vi.advanceTimersByTime(10);
    expect(w.fakePty.pause).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4900);
    expect(w.fakePty.resume).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(w.fakePty.resume).toHaveBeenCalledTimes(1);
    w.emitData('b'.repeat(1200)); vi.advanceTimersByTime(10);      // and the brake comes back on
    expect(w.fakePty.pause).toHaveBeenCalledTimes(2);
  });

  it('an acknowledgement keeps the stall clock from running out (a slow but alive terminal is not "stalled")', () => {
    vi.useFakeTimers();
    const w = loadWorker(undefined, SMALL);
    w.emitData('a'.repeat(2000)); vi.advanceTimersByTime(10);
    for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(4000); w.deliver({ type: 'ack', n: 10 }); }
    expect(w.fakePty.resume).not.toHaveBeenCalled();
  });

  it('keystrokes and Ctrl+C reach the PTY while output is braked (input never waits behind output)', async () => {
    vi.useFakeTimers();
    const w = loadWorker(undefined, SMALL);
    w.emitData('a'.repeat(5000)); vi.advanceTimersByTime(10);
    expect(w.fakePty.pause).toHaveBeenCalledTimes(1);
    w.deliver({ type: 'input', data: '\x03' });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.writes).toContain('\x03');
  });

  it('on exit the waiting batch is sent BEFORE the exit message and a paused PTY is let go', () => {
    vi.useFakeTimers();
    const w = loadWorker(undefined, SMALL);
    w.emitData('a'.repeat(1200)); vi.advanceTimersByTime(10);      // paused
    w.emitData('LAST LINES');                                      // sits in the batch
    w.exitPty();
    const types = w.fakeProcess.send.mock.calls.map((c: any[]) => c[0].type + (c[0].data === 'LAST LINES' ? ':last' : ''));
    expect(types.indexOf('data:last')).toBeGreaterThan(-1);
    expect(types.indexOf('data:last')).toBeLessThan(types.indexOf('exit'));
    expect(w.fakePty.resume).toHaveBeenCalled();
    w.emitData('b'.repeat(5000)); vi.advanceTimersByTime(10);      // never brakes again once exiting
    expect(w.fakePty.pause).toHaveBeenCalledTimes(1);
  });

  it('notices the child exiting while paused and lets the rest out (node-pty drops unread bytes 200 ms after exit)', () => {
    vi.useFakeTimers();
    const w = loadWorker(undefined, SMALL);
    w.emitData('a'.repeat(1200)); vi.advanceTimersByTime(10);
    expect(w.fakePty.resume).not.toHaveBeenCalled();
    (w.fakePty as any)._boundClose = true;                          // node-pty's "child exited, draining" flag
    vi.advanceTimersByTime(50);
    expect(w.fakePty.resume).toHaveBeenCalledTimes(1);
  });

  it('kill and handoff release a paused PTY so the exit is not held open', () => {
    vi.useFakeTimers();
    const k = loadWorker(undefined, SMALL);
    k.emitData('a'.repeat(1200)); vi.advanceTimersByTime(10);
    k.deliver({ type: 'kill' });
    expect(k.fakePty.resume).toHaveBeenCalledTimes(1);
    const h = loadWorker(undefined, SMALL);
    h.emitData('a'.repeat(1200)); vi.advanceTimersByTime(10);
    h.deliver({ type: 'stop-for-handoff' });
    expect(h.fakePty.resume).toHaveBeenCalledTimes(1);
  });
});

// ── Part 2: the real worker over a real PTY ─────────────────────────────────────────────────────
const WORKER = path.join(__dirname, '..', 'src', 'main', 'pty-worker.js');
const canRun = process.platform !== 'win32';

// The producer: writes `lines` numbered lines as fast as the terminal accepts, then a marker. A real
// blocking write(), like `cat` or a compiler — it stalls when the kernel's pty buffer is full.
const PRODUCER = `
const fs = require('fs');
const lines = Number(process.argv[1]);
let buf = '', i = 0;
while (i < lines) {
  buf = '';
  for (let k = 0; k < 4000 && i < lines; k++, i++) buf += 'L' + i + ' ' + 'x'.repeat(40) + '\\n';
  const b = Buffer.from(buf); let off = 0;
  while (off < b.length) { try { off += fs.writeSync(1, b, off, b.length - off); } catch (e) { if (e.code !== 'EAGAIN') throw e; } }
}
fs.writeSync(1, 'DONE-MARKER\\n');
`;
const expected = (lines: number) => {
  let s = '';
  for (let i = 0; i < lines; i++) s += 'L' + i + ' ' + 'x'.repeat(40) + '\r\n';   // the tty turns \n into \r\n
  return s + 'DONE-MARKER\r\n';
};

function startReal(lines: number, env: Record<string, string>) {
  const child: ChildProcess = fork(WORKER, [], { env: { ...process.env, ...env }, silent: true, execArgv: [] });
  const state = { out: '', sent: 0, acked: 0, maxOwed: 0, messages: 0, exited: false, exitAfterLastData: false, auto: true };
  child.on('message', (m: any) => {
    if (m.type === 'data') {
      state.out += m.data; state.sent += m.data.length; state.messages++;
      state.maxOwed = Math.max(state.maxOwed, state.sent - state.acked);
      if (state.auto) setTimeout(() => { state.acked += m.data.length; child.connected && child.send({ type: 'ack', n: m.data.length }); }, 2);
    } else if (m.type === 'exit') { state.exited = true; }
  });
  child.send({ type: 'spawn', command: process.execPath, args: ['-e', PRODUCER, String(lines)], cwd: process.cwd(), cols: 120, rows: 30 });
  const until = (pred: () => boolean, ms: number) => new Promise<boolean>((resolve) => {
    const t0 = Date.now();
    const check = () => { if (pred()) return resolve(true); if (Date.now() - t0 > ms) return resolve(false); setTimeout(check, 50); };
    check();
  });
  return { child, state, until, ack: (n: number) => { state.acked += n; child.send({ type: 'ack', n }); } };
}

describe.skipIf(!canRun)('pty-worker flow control over a real PTY', () => {
  const kids: ChildProcess[] = [];
  afterEach(() => { for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* gone */ } } });

  it('delivers a large flood byte for byte, including the final line, with bounded memory in flight', async () => {
    const lines = 250_000;                                         // ~11 MB
    const r = startReal(lines, { YOUCODED_PTY_FLOW_HIGH: '200000', YOUCODED_PTY_FLOW_LOW: '50000' });
    kids.push(r.child);
    expect(await r.until(() => r.state.exited, 60000)).toBe(true);
    expect(r.state.out.length).toBe(expected(lines).length);
    expect(r.state.out).toBe(expected(lines));
    // Never more than the high mark plus the reads already in flight when the brake went on.
    expect(r.state.maxOwed).toBeLessThan(200_000 + 700_000);
  }, 90000);

  it('with no acknowledgements the program is actually blocked: output stops at the high mark', async () => {
    const lines = 250_000;
    const r = startReal(lines, { YOUCODED_PTY_FLOW_HIGH: '200000', YOUCODED_PTY_FLOW_LOW: '50000', YOUCODED_PTY_FLOW_STALL_MS: '600000' });
    kids.push(r.child);
    r.state.auto = false;
    await new Promise((res) => setTimeout(res, 2500));
    const frozenAt = r.state.sent;
    expect(frozenAt).toBeGreaterThan(100_000);
    expect(frozenAt).toBeLessThan(200_000 + 700_000);              // nowhere near the ~11 MB the program wants to print
    await new Promise((res) => setTimeout(res, 1000));
    expect(r.state.sent).toBe(frozenAt);                           // and it stays stopped
    // Releasing it lets the rest through, complete.
    r.state.auto = true;
    r.ack(frozenAt);
    expect(await r.until(() => r.state.exited, 60000)).toBe(true);
    expect(r.state.out).toBe(expected(lines));
  }, 90000);

  it('a program that exits while the brake is on still delivers its last lines (no acknowledgements at all)', async () => {
    // ~23 KB in all: more than HIGH (so the brake goes on) but small enough that whatever the worker has
    // not read yet fits in the kernel's pty buffer, so the program can finish writing and EXIT while the
    // worker is still paused. (A larger flood could not exit: it would be blocked in write(), which is the
    // brake working. The first version used ~94 KB and hung under machine load: the unread part no longer fit.)
    const lines = 500;
    const r = startReal(lines, { YOUCODED_PTY_FLOW_HIGH: '6000', YOUCODED_PTY_FLOW_LOW: '2000', YOUCODED_PTY_FLOW_STALL_MS: '600000' });
    kids.push(r.child);
    r.state.auto = false;
    expect(await r.until(() => r.state.exited, 30000)).toBe(true);
    expect(r.state.out).toBe(expected(lines));
  }, 60000);
});
