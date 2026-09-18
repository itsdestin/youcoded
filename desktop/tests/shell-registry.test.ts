// ShellRegistry (G-1 background Bash): the one owner of every command that
// outlives its call. Process tests need /bin/bash and skip on Windows; the
// Windows kill path is unit-mocked in shell-registry-win-kill.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ShellRegistry, MAX_EXPLICIT_RUNNING, RING_LINES, WIRE_TAIL_LINES, READ_MAX_BYTES, LONG_RUN_NOTICE_MS, EXIT_DRAIN_GRACE_MS,
  formatElapsed, formatFinishedNotice, formatLongRunningNotice, stateText, spawnDetached,
} from '../src/main/harness/shell-registry';
import { spillRoot, sweepOldSpillFiles } from '../src/main/harness/tools/spill-paths';
import { CWD_SENTINEL, ENV_SENTINEL, stripSentinelLines, normalizeNewlines } from '../src/main/harness/tools/shell-text';

const posix = process.platform !== 'win32';
const BASH = { shellCmd: '/bin/bash', shellArgs: ['-c'] };

function startSpec(command: string, cwd: string, toolUseId = 'tu-1') {
  return { toolUseId, command, cwd, ...BASH, env: { ...process.env, NO_COLOR: '1' } };
}
function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  return new Promise((res, rej) => {
    const tick = () => { if (cond()) return res(); if (Date.now() - start > ms) return rej(new Error('waitFor timed out')); setTimeout(tick, 25); };
    tick();
  });
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

describe('formatElapsed / stateText / formatFinishedNotice', () => {
  it('formats the way the card does: seconds, m ss, whole minutes, hours', () => {
    expect(formatElapsed(12_000)).toBe('12s');
    expect(formatElapsed(182_000)).toBe('3m 02s');
    expect(formatElapsed(702_000)).toBe('11m 42s');
    expect(formatElapsed(2_400_000)).toBe('40m');
    expect(formatElapsed(3_900_000)).toBe('1h 5m');
  });
  it('stateText names running / exited N / stopped (by whom)', () => {
    const base: any = { startedAt: 1_000, endedAt: 183_000 };
    expect(stateText({ ...base, status: 'running', endedAt: undefined }, 183_000)).toBe('running · 3m 02s');
    expect(stateText({ ...base, status: 'exited', exitCode: 0 })).toBe('exited 0 · 3m 02s');
    expect(stateText({ ...base, status: 'stopped', stopReason: 'user' })).toBe('stopped (by you) · 3m 02s');
    expect(stateText({ ...base, status: 'stopped', stopReason: 'assistant' })).toBe('stopped (by KillShell) · 3m 02s');
  });
  it('the finished notice is one block: header, $ command, tail, log path', () => {
    const run: any = { shellId: 'sh-9c10', command: './gradlew assembleDebug', status: 'exited', exitCode: 0, startedAt: 0, endedAt: 702_000, logPath: '/tmp/x/bash-1.txt' };
    expect(formatFinishedNotice(run, 'BUILD SUCCESSFUL')).toBe(
      '[Background command sh-9c10 finished · exit 0 · 11m 42s]\n$ ./gradlew assembleDebug\nBUILD SUCCESSFUL\nFull log: /tmp/x/bash-1.txt',
    );
    const stopped: any = { ...run, status: 'stopped', stopReason: 'user', endedAt: 192_000 };
    expect(formatFinishedNotice(stopped, '')).toBe(
      '[Background command sh-9c10 stopped by you · after 3m 12s]\n$ ./gradlew assembleDebug\n(no output)\nFull log: /tmp/x/bash-1.txt',
    );
  });
  it('stripSentinelLines drops only the probe lines', () => {
    expect(stripSentinelLines(`a\n${CWD_SENTINEL}/x\nb\n${ENV_SENTINEL}/tmp/e\n`)).toBe('a\nb\n');
    expect(stripSentinelLines('plain')).toBe('plain');
  });
  it('normalizeNewlines turns a redrawing progress bar into lines, and leaves CRLF alone', () => {
    // A \r-redrawn progress bar is ONE endless line otherwise — the ring never
    // trims it and `partial` grows without bound (review 2026-08-28).
    expect(normalizeNewlines('10%\r50%\r100%\n')).toBe('10%\n50%\n100%\n');
    expect(normalizeNewlines('a\r\nb\r\n')).toBe('a\nb\n');
  });
});

describe.skipIf(!posix)('ShellRegistry (POSIX processes)', () => {
  let dir: string;
  let reg: ShellRegistry;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-reg-')); reg = new ShellRegistry(`t-${path.basename(dir)}`); });
  afterEach(async () => { await reg.killAll('app-quit', { graceMs: 0 }); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

  it('start: mints an sh- id, logs from the first byte, exits with the real code, emits exit once', async () => {
    const exits: any[] = [];
    reg.on('exit', (r) => exits.push(r));
    const r = reg.start(startSpec('echo hello; exit 3', dir));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.shellId).toMatch(/^sh-[0-9a-f]{4}$/);
    expect(r.run.explicit).toBe(true);
    expect(r.runningExplicit).toBe(1);
    await r.run.exited;
    expect(r.run.status).toBe('exited');
    expect(r.run.exitCode).toBe(3);
    expect(r.run.endedAt).toBeGreaterThanOrEqual(r.run.startedAt);
    await reg.read(r.run.shellId);   // flushes the log
    expect(fs.readFileSync(r.run.logPath, 'utf8')).toBe('hello\n');
    expect(exits).toHaveLength(1);
    expect(reg.list().map((x) => x.shellId)).toEqual([r.run.shellId]);
  });

  it('read: returns only what arrived since the last read', async () => {
    const r = reg.start(startSpec('echo one; sleep 0.5; echo two', dir));
    if (!r.ok) throw new Error('start failed');
    await waitFor(() => reg.tailText(r.run, 5).includes('one'));
    const first = await reg.read(r.run.shellId);
    expect(first!.text).toBe('one\n');
    await r.run.exited;
    const second = await reg.read(r.run.shellId);
    expect(second!.text).toBe('two\n');
    const third = await reg.read(r.run.shellId);
    expect(third!.text).toBe('');
  });

  it('cap: the 6th explicit start is refused naming the running ids; adopt still succeeds', async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_EXPLICIT_RUNNING; i++) {
      const r = reg.start(startSpec('sleep 5', dir, `tu-${i}`));
      if (!r.ok) throw new Error('start failed');
      ids.push(r.run.shellId);
    }
    const sixth = reg.start(startSpec('sleep 5', dir));
    expect(sixth).toEqual({ ok: false, reason: 'cap', running: ids });
    const child = spawnDetached('/bin/bash', ['-c', 'sleep 5'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const adopted = reg.adopt({ toolUseId: 'tu-h', command: 'sleep 5', cwd: dir, child, startedAt: Date.now(), seedLog: '', recent: '', logPath: null, logStream: null, captureEnv: false });
    expect(adopted.detached).toBe(true);
    expect(adopted.explicit).toBe(false);
    expect(reg.runningExplicitIds()).toEqual(ids);
    expect(reg.list()).toHaveLength(MAX_EXPLICIT_RUNNING + 1);
  });

  it('kill reaches the grandchild (sleep 30 & wait) and records the reason', async () => {
    const r = reg.start(startSpec('sleep 30 & echo "PID=$!"; wait', dir));
    if (!r.ok) throw new Error('start failed');
    await waitFor(() => /PID=\d+/.test(reg.tailText(r.run, 5)));
    const pid = Number(/PID=(\d+)/.exec(reg.tailText(r.run, 5))![1]);
    expect(alive(pid)).toBe(true);
    const killed = await reg.kill(r.run.shellId, 'assistant');
    expect(killed.ok).toBe(true);
    expect(r.run.status).toBe('stopped');
    expect(r.run.stopReason).toBe('assistant');
    await waitFor(() => !alive(pid), 4_000);
    expect(alive(pid)).toBe(false);
    // A second kill reports the current state instead of pretending.
    expect((await reg.kill(r.run.shellId, 'user')).ok).toBe(false);
    expect((await reg.kill('sh-nope', 'user')).ok).toBe(false);
  });

  it('killAll stops every running command with the given reason', async () => {
    const a = reg.start(startSpec('sleep 5', dir, 'a'));
    const b = reg.start(startSpec('sleep 5', dir, 'b'));
    if (!a.ok || !b.ok) throw new Error('start failed');
    await reg.killAll('conversation-closed');
    expect(a.run.status).toBe('stopped');
    expect(b.run.stopReason).toBe('conversation-closed');
  });

  it('ring keeps 200 lines, the wire view carries 40, change events are debounced', async () => {
    const views: any[] = [];
    reg.on('change', (v) => views.push(v));
    const r = reg.start(startSpec('seq 1 300', dir));
    if (!r.ok) throw new Error('start failed');
    await r.run.exited;
    await new Promise((res) => setTimeout(res, 300));   // let a trailing debounce fire
    expect(r.run.tail).toHaveLength(RING_LINES);
    expect(r.run.tail[0]).toBe('101');
    const last = views[views.length - 1];
    expect(last.status).toBe('exited');
    expect(last.tail.split('\n')).toHaveLength(WIRE_TAIL_LINES);
    expect(last.tail.endsWith('300')).toBe(true);
    expect(last.toolUseId).toBe('tu-1');
    expect(last.logPath).toBe(r.run.logPath);
    // 300 lines arrived in well under a second: far fewer than 300 events.
    expect(views.length).toBeLessThan(20);
  });

  it('sentinel lines are filtered on read and in the tail, kept in the raw log; the env file is unlinked', async () => {
    const envFile = path.join(dir, 'env-dump');
    fs.writeFileSync(envFile, 'FOO=1\0');
    const child = spawnDetached('/bin/bash', ['-c', `echo out; printf '\\n${CWD_SENTINEL}%s\\n' "$PWD"; printf '\\n${ENV_SENTINEL}%s\\n' "${envFile}"`], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = reg.adopt({ toolUseId: 'tu-h', command: 'echo out', cwd: dir, child, startedAt: Date.now(), seedLog: 'head\n', recent: 'head\n', logPath: null, logStream: null, captureEnv: true });
    await run.exited;
    const read = await reg.read(run.shellId);
    expect(read!.text).not.toContain(CWD_SENTINEL);
    expect(read!.text).not.toContain(ENV_SENTINEL);
    expect(read!.text).toContain('head\nout');
    expect(reg.tailText(run, 50)).not.toContain(ENV_SENTINEL);
    expect(fs.readFileSync(run.logPath, 'utf8')).toContain(CWD_SENTINEL);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("an adopted run's seeded head is ANSI-stripped like everything that follows it", async () => {
    // bash.ts keeps headBuf RAW and strips only at write time (bash.ts's own
    // spill does `stripAnsi(headBuf)`), so the registry must strip it too —
    // otherwise the first half of a handed-off log is colour codes and the
    // second half is clean, and BashOutput hands the model `\x1b[1m\x1b[30m RUN`.
    const child = spawnDetached('/bin/bash', ['-c', 'echo tail-part'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const run = reg.adopt({ toolUseId: 'tu-a', command: 'x', cwd: dir, child, startedAt: Date.now(), seedLog: '\x1b[1mBOLD\x1b[0m head\n', recent: '', logPath: null, logStream: null, captureEnv: false });
    await run.exited;
    const read = await reg.read(run.shellId);
    expect(read!.text).toBe('BOLD head\ntail-part\n');
    expect(fs.readFileSync(run.logPath, 'utf8')).not.toContain('\x1b');
  });

  it('a redrawing progress bar cannot grow the partial line without bound', async () => {
    const r = reg.start(startSpec(`printf 'p 1\\rp 2\\rp 3\\n'`, dir));
    if (!r.ok) throw new Error('start failed');
    await r.run.exited;
    expect(r.run.tail).toEqual(['p 1', 'p 2', 'p 3']);
    expect(r.run.partial).toBe('');
  });

  it('output written in the last instant before exit is never lost (settles on close, not exit)', async () => {
    // WHY twenty runs: the loss is a race between the child's `exit` event and the
    // last stdout chunk. One run passes most of the time; twenty make the old
    // exit-based settle fail reliably on a 2-core runner, and cost under a second.
    for (let i = 0; i < 20; i++) {
      const r = reg.start(startSpec(`printf 'p 1\\rp 2\\rp 3\\n'`, dir, `tu-drain-${i}`));
      if (!r.ok) throw new Error('start failed');
      await r.run.exited;
      expect(r.run.tail).toEqual(['p 1', 'p 2', 'p 3']);
      expect(r.run.partial).toBe('');
    }
  });

  it('a chunk delivered AFTER the exit event still lands in the tail (the exact CI order, staged)', async () => {
    // WHY a staged child: the real race needs a slow runner and never fired on the
    // 32-core dev machine. Node's documented order is exit → last data → close;
    // this fake replays it deterministically, so the fix is proven everywhere.
    const { EventEmitter } = await import('events');
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null; child.signalCode = null; child.pid = 999_999_999;
    child.kill = () => true;
    // What the finished notice quotes is the tail AT the exit event — snapshot it there.
    let atExit: string[] | null = null;
    reg.on('exit', (r) => { if (r.toolUseId === 'tu-staged') atExit = [...r.tail]; });
    const run = reg.adopt({ toolUseId: 'tu-staged', command: 'x', cwd: dir, child, startedAt: Date.now(), seedLog: null, recent: '', logPath: null, logStream: null, captureEnv: false });
    child.stdout.emit('data', 'p 1\n');
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.stdout.emit('data', 'p 2\n');
    child.emit('close', 0, null);
    await run.exited;
    expect(atExit).toEqual(['p 1', 'p 2']);
    expect(run.exitCode).toBe(0);
  });

  it('a grandchild holding stdout open cannot hold the run open past the grace', async () => {
    // `sleep 30 &` inherits the pipe; with a pure `close` settle the run would
    // wait the full 30 s for it. WHY no clock assertion (test-suite-hygiene: never
    // wall clock): the proof is that the run settled while the grandchild that
    // holds the pipe is STILL alive — only the EXIT_DRAIN_GRACE_MS timer can do that.
    const r = reg.start(startSpec('sleep 30 & echo $!; echo done', dir, 'tu-grace'));
    if (!r.ok) throw new Error('start failed');
    await r.run.exited;
    const pid = Number(r.run.tail[0]);
    try {
      expect(r.run.tail).toEqual([String(pid), 'done']);
      expect(alive(pid)).toBe(true);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('read() is bounded: a huge log returns only the last READ_MAX_BYTES, and says nothing false about it', async () => {
    // 7 MB of output must not become a 7 MB string in the main process.
    const r = reg.start(startSpec(`for i in $(seq 1 200000); do echo "line-$i-padding-padding-padding"; done`, dir));
    if (!r.ok) throw new Error('start failed');
    await r.run.exited;
    const read = await reg.read(r.run.shellId);
    expect(read!.text.length).toBeLessThanOrEqual(READ_MAX_BYTES);
    expect(read!.truncated).toBe(true);
    expect(read!.text.endsWith('line-200000-padding-padding-padding\n')).toBe(true);
    // The cursor still advances to the END of the file, so the next read is
    // "since your last look" and not a replay of the same tail.
    expect((await reg.read(r.run.shellId))!.text).toBe('');
  }, 60_000);

  it('toView is the ShellRunView shape the card renders', async () => {
    const r = reg.start(startSpec('echo v', dir));
    if (!r.ok) throw new Error('start failed');
    await r.run.exited;
    const v = reg.toView(r.run);
    expect(Object.keys(v).sort()).toEqual(['detached', 'endedAt', 'exitCode', 'logPath', 'shellId', 'startedAt', 'status', 'stopReason', 'tail', 'toolUseId']);
    expect(v.detached).toBe(false);
  });
});

describe('spill retention sweep (moved out of bash.ts so background logs are swept too)', () => {
  it('deletes files past the TTL and leaves fresh ones, in any session folder', async () => {
    const sess = path.join(spillRoot(), `sweep-test-${process.pid}`);
    fs.mkdirSync(sess, { recursive: true });
    const old = path.join(sess, 'bash-old.txt');
    const fresh = path.join(sess, 'bash-fresh.txt');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
    await sweepOldSpillFiles();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(sess, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });
});

// 2026-09-16 (docs/roadmap/native-harness.md → tools): the proactive half of
// the anti-poll rule. A run still going at the 5- and 15-minute marks is
// announced once per mark; the host turns the event into an idle-boundary
// notice. Marks are a test seam here so the suite does not wait five minutes.
describe('still-running marks (LONG_RUN_NOTICE_MS)', () => {
  // WHY a tolerance: a mark fires from a timer armed at `startedAt`, and the elapsed
  // it reports is a second Date.now() read. libuv rounds timers to its own tick, so a
  // 60 ms mark can report 59 (Ubuntu CI, 2026-09-16, run 35089626563). What the
  // assertions pin is that each mark measures from the run's OWN start, not the
  // adopt time — a few milliseconds of clock jitter does not touch that.
  const JITTER_MS = 5;
  let dir: string;
  let reg: ShellRegistry;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-reg-long-')); reg = new ShellRegistry(`t-${path.basename(dir)}`, { longRunNoticeMs: [60, 140] }); });
  afterEach(async () => { await reg.killAll('app-quit', { graceMs: 0 }); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }); });

  it('the production marks are 5 and 15 minutes', () => {
    expect(LONG_RUN_NOTICE_MS).toEqual([5 * 60_000, 15 * 60_000]);
  });

  it('the notice names the run, how long it has run, and what to do — and says not to poll', () => {
    const text = formatLongRunningNotice({ shellId: 'sh-9c10', command: './gradlew assembleDebug' }, 5 * 60_000);
    expect(text).toMatch(/^\[Background command sh-9c10 has been running for 5m\]\n\$ \.\/gradlew assembleDebug\n/);
    expect(text).toContain('ignore this message');
    expect(text).toContain('BashOutput');
    expect(text).toContain('KillShell');
    expect(text).toContain('do not poll');
  });

  it.skipIf(!posix)('a run still going at each mark emits long-running once per mark, elapsed measured from its own start', async () => {
    const marks: Array<{ shellId: string; ms: number }> = [];
    reg.on('long-running', (run, ms) => marks.push({ shellId: run.shellId, ms }));
    const r = reg.start(startSpec('sleep 5', dir));
    if (!r.ok) throw new Error('start failed');
    await waitFor(() => marks.length === 2);
    expect(marks.map((m) => m.shellId)).toEqual([r.run.shellId, r.run.shellId]);
    expect(marks[0].ms).toBeGreaterThanOrEqual(60 - JITTER_MS);
    expect(marks[1].ms).toBeGreaterThanOrEqual(140 - JITTER_MS);
    expect(r.run.status).toBe('running');
  });

  it.skipIf(!posix)('a run that finishes before a mark emits nothing, and its pending marks are cleared on exit', async () => {
    const marks: number[] = [];
    reg.on('long-running', (_run, ms) => marks.push(ms));
    const r = reg.start(startSpec('echo hi', dir));
    if (!r.ok) throw new Error('start failed');
    expect(r.run.longRunTimers).toHaveLength(2);
    await r.run.exited;
    // The exit path clears the timers — the structural guard that nothing can
    // fire later for a run that is no longer running.
    expect(r.run.longRunTimers).toHaveLength(0);
    expect(marks).toHaveLength(0);
  });

  it.skipIf(!posix)('an adopted hand-off counts the time it already ran in the foreground', async () => {
    const marks: number[] = [];
    reg.on('long-running', (_run, ms) => marks.push(ms));
    const child = spawnDetached('/bin/bash', ['-c', 'sleep 5'], { cwd: dir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    // Started 100 ms ago as far as the run is concerned: the 60 ms mark is
    // already past (fires at once), the 140 ms mark is 40 ms away.
    reg.adopt({ toolUseId: 'tu-adopt', command: 'sleep 5', cwd: dir, child, startedAt: Date.now() - 100, seedLog: null, recent: '', logPath: null, logStream: null, captureEnv: false });
    await waitFor(() => marks.length === 2);
    expect(marks[0]).toBeGreaterThanOrEqual(100 - JITTER_MS);
    expect(marks[1]).toBeGreaterThanOrEqual(140 - JITTER_MS);
  });
});
