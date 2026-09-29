// How pty-worker actually writes to the PTY (2026-09-05).
//
// This exists because a fix aimed at ONE write changed every write. The shell
// session's initial command carries no trailing `\r` (the user presses Enter),
// so it takes the passthrough path — and chunking that path to protect the
// command turned an ordinary 10 KB terminal paste into 179 writes 30 ms apart,
// ~5.4 s with the input queue blocked behind it. A source-text pin would not
// have caught that: the cost is in the NUMBER of writes, so the number of
// writes is what this file counts.
//
// HOW: pty-worker.js is a plain CommonJS script with no exports — it just
// registers process listeners. Rather than importing it (which attaches
// listeners to the real process, and whose `require('node-pty')` escapes
// vi.mock and spawns a REAL shell), the real file is read and evaluated with a
// fake `require` and a fake `process`. Nothing is spawned, nothing global is
// touched, and the code under test is the shipped file byte for byte.
//
// The loader itself lives in tests/helpers/pty-worker-harness.ts (extracted
// for T7/compose-ref.test.ts, which reuses it for its own PTY-submit round
// trip — test-suite-hygiene.md: shared setup lives in tests/helpers/).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadWorker, drain } from './helpers/pty-worker-harness';

describe('Claude Code specialist model launch default', () => {
  it('defaults subagents to Sonnet instead of inheriting an expensive conversation model', () => {
    expect(loadWorker().spawnedEnv.CLAUDE_CODE_SUBAGENT_MODEL).toBe('sonnet');
  });

  it('preserves an explicit subagent model from the launch environment', () => {
    expect(loadWorker('sonnet').spawnedEnv.CLAUDE_CODE_SUBAGENT_MODEL).toBe('sonnet');
  });
});

describe('pty-worker handoff stop', () => {
  it('bounds the parent acknowledgment wait and exits on failed send or disconnect', async () => {
    vi.useFakeTimers();
    try {
      const timed = loadWorker();
      timed.deliver({ type: 'stop-for-handoff' });
      timed.exitPty();
      expect(timed.fakeProcess.exit).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(timed.fakeProcess.exit).toHaveBeenCalledWith(1);
      const failed = loadWorker();
      failed.deliver({ type: 'stop-for-handoff' });
      failed.exitPty();
      failed.fakeProcess.send.mock.lastCall?.[1](new Error('IPC closed'));
      expect(failed.fakeProcess.exit).toHaveBeenCalledWith(1);
      const disconnected = loadWorker();
      disconnected.deliver({ type: 'stop-for-handoff' });
      disconnected.exitPty();
      disconnected.fakeProcess.emit('disconnect');
      expect(disconnected.fakeProcess.exit).toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('parent receipt wins if it arrives before the transport callback', () => {
    const { deliver, fakeProcess, exitPty } = loadWorker();
    deliver({ type: 'stop-for-handoff' });
    exitPty();
    deliver({ type: 'handoff-exit-received' });
    fakeProcess.send.mock.lastCall?.[1](new Error('late callback'));
    expect(fakeProcess.exit.mock.calls).toEqual([[0]]);
  });

  it('never fabricates an exit acknowledgment if PTY kill throws', () => {
    const { deliver, fakePty, fakeProcess } = loadWorker();
    fakePty.kill.mockImplementationOnce(() => { throw new Error('PTY kill failed'); });
    expect(() => deliver({ type: 'stop-for-handoff' })).toThrow('PTY kill failed');
    expect(fakeProcess.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'exit' }), expect.anything());
  });

  it('waits for onExit and for exit IPC flush before exiting, refusing late input', async () => {
    const { deliver, writes, fakePty, fakeProcess, exitPty } = loadWorker();
    deliver({ type: 'input', data: 'queued turn\r' });
    deliver({ type: 'stop-for-handoff' });
    deliver({ type: 'input', data: 'late turn\r' });
    await Promise.resolve();
    expect(writes).toEqual([]);
    expect(fakePty.kill).toHaveBeenCalledTimes(1);
    expect(fakeProcess.exit).not.toHaveBeenCalled();
    exitPty();
    expect(fakeProcess.send).toHaveBeenCalledWith({ type: 'exit', exitCode: 0 }, expect.any(Function));
    expect(fakeProcess.exit).not.toHaveBeenCalled();
    fakeProcess.send.mock.lastCall?.[1](null);
    // IPC send callback only confirms enqueue/flush, not receipt by main.
    expect(fakeProcess.exit).not.toHaveBeenCalled();
    deliver({ type: 'handoff-exit-received' });
    expect(fakeProcess.exit).toHaveBeenCalledWith(0);
    deliver({ type: 'handoff-exit-received' });
    expect(fakeProcess.exit).toHaveBeenCalledTimes(1);
  });
});

describe('pty-worker writes', () => {
  let deliver: (msg: any) => void;
  let writes: string[];

  beforeEach(() => { ({ deliver, writes } = loadWorker()); });

  it('a 10 KB paste is ONE write, as it always was', async () => {
    // A terminal paste ends in the bracketed-paste terminator, not \r, so it
    // takes the passthrough. Chunking it there was the regression: 179 writes,
    // 30 ms apart, with everything else queued behind them.
    const paste = '\x1b[200~' + 'x'.repeat(10_000) + '\x1b[201~';
    deliver({ type: 'input', data: paste });
    await drain();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(paste);
  });

  it('a keystroke is still one write', async () => {
    deliver({ type: 'input', data: 'a' });
    await drain(50);
    expect(writes).toEqual(['a']);
  });

  it('an arrow key escape is not split', async () => {
    deliver({ type: 'input', data: '\x1b[A' });
    await drain(50);
    expect(writes).toEqual(['\x1b[A']);
  });

  it('a short submit is still one atomic write', async () => {
    deliver({ type: 'input', data: 'hello\r' });
    await drain(50);
    expect(writes).toEqual(['hello\r']);
  });

  // 2026-09-16 (claude-code-integration.md): the thresholds are BYTES on the pipe,
  // and the checks counted UTF-16 units. 30 CJK characters is 90 bytes — over the
  // 64-byte paste threshold — so the atomic path would have turned its Enter into
  // a literal newline. It must take the echo-driven path: the body goes first
  // (chunked under 56 bytes apiece), and the `\r` waits for the echo.
  it('a short-looking non-ASCII submit that is over 56 BYTES is not written atomically', async () => {
    const body = '你好世界'.repeat(8);        // 32 chars, 96 bytes
    deliver({ type: 'input', data: body + '\r' });
    await drain(300);
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.join('')).toBe(body);      // the \r is held for the echo, which never comes here
    for (const w of writes) expect(Buffer.byteLength(w, 'utf8')).toBeLessThanOrEqual(56);
  });

  it('a submit that is short in BYTES stays atomic even with non-ASCII in it', async () => {
    const text = 'héllo wörld\r';          // 14 bytes
    deliver({ type: 'input', data: text });
    await drain(50);
    expect(writes).toEqual([text]);
  });

  describe('the chunked channel, which only a shell session\'s initial command uses', () => {
    it('splits a long command so ConPTY cannot truncate it', async () => {
      const command = 'sudo install '.repeat(40);   // ~520 chars
      deliver({ type: 'input-chunked', data: command });
      await drain(1200);
      expect(writes.length).toBeGreaterThan(1);
      expect(writes.join('')).toBe(command);
      for (const w of writes) expect(w.length).toBeLessThanOrEqual(56);
    });

    it('a short command is still a single write', async () => {
      deliver({ type: 'input-chunked', data: 'sudo pacman -S rocm' });
      await drain(50);
      expect(writes).toEqual(['sudo pacman -S rocm']);
    });

    it('never splits a surrogate pair', async () => {
      // slice() cuts UTF-16 code units. A boundary inside an emoji or a non-BMP
      // path character would send two broken halves, and the shell would show
      // garbage in the command the user is about to press Enter on.
      const command = 'x'.repeat(55) + '\u{1F600}'.repeat(30);
      deliver({ type: 'input-chunked', data: command });
      await drain(1200);
      expect(writes.join('')).toBe(command);
      for (const w of writes) {
        const last = w.charCodeAt(w.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);   // no trailing lone high half
        const first = w.charCodeAt(0);
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false); // no leading lone low half
      }
    });
  });
});
